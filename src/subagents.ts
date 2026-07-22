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

export interface ParallelTask {
  agent: string;
  task: string;
}

export interface ParallelCommon {
  model: string;
  thinking: string;
  cwd: string;
  maxTurns: number;
}

export interface SpawnResult {
  runId: string | null;
  asyncDir: string | null;
}

interface RpcReply {
  success: boolean;
  data?: { text?: string; details?: { runId?: string; asyncId?: string; asyncDir?: string } };
  error?: { message?: string };
}

/** Gateway to pi-subagents over its versioned in-process RPC. */
export class SubagentGateway extends Effect.Service<SubagentGateway>()("SubagentGateway", {
  effect: Effect.gen(function* () {
    const pi = yield* PiApi;
    const { config } = yield* FeatureConfig;

    const request = (params: Record<string, unknown>): Effect.Effect<SpawnResult, SpawnFailed> =>
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
          params,
        });
      });

    const spawn = (params: SpawnParams): Effect.Effect<SpawnResult, SpawnFailed> => request({
      agent: params.agent,
      task: params.task,
      context: "fresh",
      model: params.model,
      async: true,
      cwd: params.cwd,
      timeoutMs: config.budgets.spawnTimeoutMs,
      turnBudget: { maxTurns: params.maxTurns, graceTurns: 2 },
      toolBudget: { soft: 25, hard: 45, block: ["read", "grep", "find", "ls"] },
    });

    const spawnParallel = (
      tasks: Array<ParallelTask>,
      common: ParallelCommon,
      worktree: boolean,
    ): Effect.Effect<SpawnResult, SpawnFailed> => request({
      tasks: tasks.map((task) => ({ agent: task.agent, task: task.task, model: common.model })),
      worktree,
      async: true,
      cwd: common.cwd,
      concurrency: Math.min(tasks.length, 4),
      timeoutMs: config.budgets.spawnTimeoutMs,
      turnBudget: { maxTurns: common.maxTurns, graceTurns: 2 },
      toolBudget: { soft: 25, hard: 45, block: ["read", "grep", "find", "ls"] },
    });

    return { request, spawn, spawnParallel };
  }),
  dependencies: [FeatureConfig.Default],
}) {}
