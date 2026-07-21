import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SpawnFailed } from "./domain.ts";
import { FeatureConfig } from "./config.ts";
import { PiApi } from "./pi-api.ts";

export const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export interface SpawnParams {
  agent: string;
  task: string;
  model: string;
  thinking: string;
  cwd: string;
  maxTurns: number;
}

export interface SpawnResult {
  runId: string | null;
  asyncDir: string | null;
}

export interface RunResult extends SpawnResult {
  output: string;
  status: string;
  sessionPath: string | null;
  transcriptPath: string | null;
}

interface AsyncCompletionResult {
  status?: string;
  summary?: string;
  sessionPath?: string;
  transcriptPath?: string;
}

interface AsyncCompletionEvent {
  runId?: string;
  id?: string;
  asyncDir?: string;
  state?: string;
  results?: AsyncCompletionResult[];
}

interface RpcReply {
  success: boolean;
  data?: { text?: string; details?: { runId?: string; asyncId?: string; asyncDir?: string } };
  error?: { message?: string };
}

/**
 * Gateway to pi-subagents over its versioned in-process RPC.
 *
 * Failure semantics matter here: a timeout is an *unknown* outcome (the child
 * may have started even though the reply was lost), while a negative RPC reply
 * is *definitive*. Callers use `outcome` to decide whether an execution lease
 * may be rolled back automatically.
 */
export class SubagentGateway extends Effect.Service<SubagentGateway>()("SubagentGateway", {
  effect: Effect.gen(function* () {
    const pi = yield* PiApi;
    const { config } = yield* FeatureConfig;

    const request = (params: SpawnParams): Effect.Effect<SpawnResult, SpawnFailed> =>
      Effect.async<SpawnResult, SpawnFailed>((resume) => {
        const requestId = `feature-${randomUUID()}`;
        const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const unsubscribe = pi.events.on(replyEvent, (raw) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (typeof unsubscribe === "function") unsubscribe();
          const reply = raw as RpcReply;
          if (!reply.success) {
            resume(Effect.fail(new SpawnFailed({ reason: reply.error?.message || "Subagent stage failed to start.", outcome: "definitive" })));
            return;
          }
          const details = reply.data?.details;
          resume(Effect.succeed({ runId: details?.runId || details?.asyncId || null, asyncDir: details?.asyncDir ?? null }));
        });
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (typeof unsubscribe === "function") unsubscribe();
          resume(Effect.fail(new SpawnFailed({ reason: "Timed out waiting for pi-subagents RPC reply.", outcome: "unknown" })));
        }, config.budgets.rpcReplyTimeoutMs);
        pi.events.emit(RPC_REQUEST_EVENT, {
          version: 1,
          requestId,
          method: "spawn",
          source: { extension: "feature-flow" },
          params: {
            agent: params.agent,
            task: params.task,
            context: "fresh",
            model: params.model,
            async: true,
            cwd: params.cwd,
            timeoutMs: config.budgets.spawnTimeoutMs,
            turnBudget: { maxTurns: params.maxTurns, graceTurns: 2 },
            toolBudget: { soft: 25, hard: 45, block: ["read", "grep", "find", "ls"] },
          },
        });
      });

    const run = (params: SpawnParams): Effect.Effect<RunResult, SpawnFailed> =>
      Effect.async<RunResult, SpawnFailed>((resume) => {
        const requestId = `feature-${randomUUID()}`;
        const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;
        let runId: string | null = null;
        let asyncDir: string | null = null;
        let settled = false;
        let replyTimer: ReturnType<typeof setTimeout> | undefined;
        let completionTimer: ReturnType<typeof setTimeout> | undefined;
        let unsubscribeReply: (() => void) | void;
        let unsubscribeCompletion: (() => void) | void;
        const pendingCompletions = new Map<string, AsyncCompletionEvent>();

        const cleanup = () => {
          if (replyTimer) clearTimeout(replyTimer);
          if (completionTimer) clearTimeout(completionTimer);
          if (typeof unsubscribeReply === "function") unsubscribeReply();
          if (typeof unsubscribeCompletion === "function") unsubscribeCompletion();
        };
        const fail = (reason: string, outcome: "definitive" | "unknown") => {
          if (settled) return;
          settled = true;
          cleanup();
          resume(Effect.fail(new SpawnFailed({ reason, outcome })));
        };
        const complete = (event: AsyncCompletionEvent) => {
          if (settled || !runId) return;
          const result = event.results?.[0];
          const status = result?.status ?? event.state ?? "unknown";
          if (!["complete", "completed"].includes(status)) {
            fail(result?.summary?.trim() || `Subagent run ${runId} ended with status ${status}.`, "definitive");
            return;
          }
          const output = result?.summary?.trim() ?? "";
          if (!output || output === "(no output)") {
            fail(`Subagent run ${runId} completed without output.`, "definitive");
            return;
          }
          settled = true;
          cleanup();
          resume(Effect.succeed({
            runId,
            asyncDir: event.asyncDir ?? asyncDir,
            output,
            status,
            sessionPath: result?.sessionPath ?? null,
            transcriptPath: result?.transcriptPath ?? null,
          }));
        };

        unsubscribeCompletion = pi.events.on(ASYNC_COMPLETE_EVENT, (raw) => {
          const event = raw as AsyncCompletionEvent;
          const completedRunId = event.runId ?? event.id;
          if (!completedRunId) return;
          if (!runId) {
            pendingCompletions.set(completedRunId, event);
            return;
          }
          if (completedRunId === runId) complete(event);
        });
        unsubscribeReply = pi.events.on(replyEvent, (raw) => {
          if (settled) return;
          if (replyTimer) clearTimeout(replyTimer);
          const reply = raw as RpcReply;
          if (!reply.success) {
            fail(reply.error?.message || "Subagent stage failed to start.", "definitive");
            return;
          }
          const details = reply.data?.details;
          runId = details?.runId || details?.asyncId || null;
          asyncDir = details?.asyncDir ?? null;
          if (!runId) {
            fail("pi-subagents RPC returned no run id.", "definitive");
            return;
          }
          const pending = pendingCompletions.get(runId);
          if (pending) {
            complete(pending);
            return;
          }
          completionTimer = setTimeout(
            () => fail(`Timed out waiting for subagent run ${runId} to complete.`, "unknown"),
            config.budgets.spawnTimeoutMs + config.budgets.rpcReplyTimeoutMs,
          );
        });

        replyTimer = setTimeout(
          () => fail("Timed out waiting for pi-subagents RPC reply.", "unknown"),
          config.budgets.rpcReplyTimeoutMs,
        );
        pi.events.emit(RPC_REQUEST_EVENT, {
          version: 1,
          requestId,
          method: "spawn",
          source: { extension: "feature-flow" },
          params: {
            agent: params.agent,
            task: params.task,
            context: "fresh",
            model: params.model,
            async: true,
            cwd: params.cwd,
            timeoutMs: config.budgets.spawnTimeoutMs,
            turnBudget: { maxTurns: params.maxTurns, graceTurns: 2 },
            toolBudget: { soft: 25, hard: 45, block: ["read", "grep", "find", "ls"] },
          },
        });

        return Effect.sync(() => {
          settled = true;
          cleanup();
        });
      });

    const spawn = (params: SpawnParams): Effect.Effect<SpawnResult, SpawnFailed> => request(params);
    return { spawn, run };
  }),
  dependencies: [FeatureConfig.Default],
}) {}
