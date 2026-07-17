import { stat, writeFile } from "node:fs/promises";
import { Effect, Either, Layer, ManagedRuntime } from "effect";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ARTIFACT_NAMES, type ArtifactName, type FeatureStage, type FeatureState, type RunStage } from "../src/domain.ts";
import { isAmendNoEdit, namingPrefix, normalizeFeatureId, validateNamingCommand } from "../src/identity.ts";
import { composeContinuationContext } from "../src/plan.ts";
import { FeatureConfig, type ModelRoute } from "../src/config.ts";
import { FeatureStore, featureDir } from "../src/store.ts";
import { Workflow } from "../src/workflow.ts";
import { Planner } from "../src/planner.ts";
import { PiApi, piApiLayer } from "../src/pi-api.ts";
import { ASYNC_COMPLETE_EVENT } from "../src/subagents.ts";
import { MEMORY_GUIDELINES, WORKFLOW_GUIDELINES, featureStartRequest, planningKickoff, turnContext } from "../src/prompts.ts";

const POINTER_TYPE = "feature-flow-pointer";
const STATUS_KEY = "feature-flow";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

function splitArgs(raw: string): string[] {
  return raw.trim().match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}

function compactText(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLength) return oneLine;
  const prefix = oneLine.slice(0, Math.max(1, maxLength - 1));
  const wordBoundary = prefix.lastIndexOf(" ");
  const clipped = wordBoundary >= Math.floor(maxLength * 0.6) ? prefix.slice(0, wordBoundary) : prefix;
  return `${clipped.trimEnd()}…`;
}

async function pathExists(path: string | null | undefined): Promise<boolean> {
  if (!path) return false;
  try { await stat(path); return true; } catch { return false; }
}

export default function featureFlow(pi: ExtensionAPI): void {
  const appLayer = Layer.mergeAll(Workflow.Default, FeatureStore.Default, FeatureConfig.Default, Planner.Default).pipe(
    Layer.provide(piApiLayer(pi)),
  );
  const runtime = ManagedRuntime.make(appLayer);
  const run = <A>(effect: Effect.Effect<A, unknown, Workflow | FeatureStore | FeatureConfig | Planner | PiApi>): Promise<A> =>
    runtime.runPromise(
      effect.pipe(
        Effect.provideService(PiApi, pi),
        Effect.mapError((error) => error instanceof Error ? error : new Error(typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : String(error))),
      ) as Effect.Effect<A, Error, never>,
    );

  let activeFeatureId: string | null = null;
  let currentContext: ExtensionContext | null = null;
  let pendingFeatureRequest: string | null = null;

  const loadFeature = (featureId: string) => run(Effect.flatMap(FeatureStore, (store) => store.load(featureId)));
  const listFeatures = () => run(Effect.flatMap(FeatureStore, (store) => store.list()));
  const readArtifact = (featureId: string, artifact: ArtifactName) => run(Effect.flatMap(FeatureStore, (store) => store.readArtifact(featureId, artifact)));
  const appendArtifact = (featureId: string, artifact: ArtifactName, heading: string, body: string, author: string) =>
    run(Effect.flatMap(FeatureStore, (store) => store.appendArtifact(featureId, artifact, heading, body, author)));
  const appendLedger = (featureId: string, event: Record<string, unknown>) =>
    run(Effect.flatMap(FeatureStore, (store) => store.appendLedger(featureId, event)));
  const getConfig = () => run(Effect.map(FeatureConfig, (service) => service.config));

  function requireId(value: string): string {
    const normalized = normalizeFeatureId(value);
    if (Either.isLeft(normalized)) throw new Error(normalized.left.message);
    return normalized.right;
  }

  // ─── UI ────────────────────────────────────────────────────────────────────

  function updateUi(ctx: ExtensionContext, state?: FeatureState): void {
    if (!state) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(STATUS_KEY, undefined);
      return;
    }
    const gate = state.checkpoint.status === "pending" ? ` · gate:${state.checkpoint.kind}` : "";
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `◆ ${state.featureId}:${state.activeStage}${gate}`));
    ctx.ui.setWidget(STATUS_KEY, [
      `${ctx.ui.theme.fg("accent", "Feature")} ${compactText(state.title, 96)}`,
      `${ctx.ui.theme.fg("muted", "Stage")} ${state.activeStage}  ${ctx.ui.theme.fg("muted", "Status")} ${state.status}  ${ctx.ui.theme.fg("muted", "Rev")} ${state.revision}`,
    ], { placement: "belowEditor" });
  }

  async function switchMainModel(ctx: ExtensionContext, route: ModelRoute): Promise<void> {
    const [provider, ...rest] = route.model.split("/");
    const modelId = rest.join("/");
    if (!provider || !modelId) throw new Error(`Invalid model route '${route.model}'; expected provider/model.`);
    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Model ${route.model} is unavailable.`);
    if (!(await pi.setModel(model))) throw new Error(`No credentials for ${route.model}.`);
    pi.setThinkingLevel(route.thinking as never);
  }

  // ─── Session binding ───────────────────────────────────────────────────────

  function restorePointer(ctx: ExtensionContext): string | null {
    const entries = ctx.sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index] as { type?: string; customType?: string; data?: { featureId?: string } };
      if (entry.type === "custom" && entry.customType === POINTER_TYPE && entry.data?.featureId) {
        const normalized = normalizeFeatureId(entry.data.featureId);
        return Either.isRight(normalized) ? normalized.right : null;
      }
    }
    return null;
  }

  async function bindPiSession(featureId: string, stage: FeatureStage | "direct", ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId() ?? null;
    const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    const state = await loadFeature(featureId);
    const existing = state.sessions.some((session) => session.kind === "pi" && session.sessionId === sessionId && session.stage === stage && !session.endedAt);
    if (existing) return;
    const now = new Date().toISOString();
    await run(Effect.flatMap(FeatureStore, (store) =>
      store.update(featureId, (draft) => {
        for (const session of draft.sessions) {
          if (session.kind === "pi" && session.sessionId === sessionId && !session.endedAt) {
            session.endedAt = now;
            session.endReason = "stage-change";
          }
        }
        draft.sessions.push({
          kind: "pi", sessionId, sessionFile, transcriptPath: null, cwd: ctx.cwd, stage, role: "main",
          runId: null, asyncDir: null, startedAt: now, endedAt: null, endReason: null,
          parentSessionId: ctx.sessionManager.getHeader()?.parentSession ?? null,
        });
      })
    ));
    await appendLedger(featureId, { type: "session.started", sessionId, sessionFile, stage, cwd: ctx.cwd });
  }

  async function setActive(featureId: string, ctx: ExtensionContext): Promise<FeatureState> {
    const state = await loadFeature(featureId);
    activeFeatureId = state.featureId;
    pi.appendEntry(POINTER_TYPE, { featureId: state.featureId, featureRoot: featureDir(state.featureId), revision: state.revision });
    pi.setSessionName(`feature:${state.featureId}`);
    updateUi(ctx, state);
    await bindPiSession(state.featureId, state.activeStage, ctx);
    return state;
  }

  // ─── Turn snapshot (config-driven; compact by default) ─────────────────────

  async function turnSnapshot(featureId: string, ctx: ExtensionContext): Promise<void> {
    const config = await getConfig();
    if (config.turnSnapshot === "off") return;
    const branch = ctx.sessionManager.getBranch();
    const leafId = ctx.sessionManager.getLeafId();
    const status = await pi.exec("git", ["status", "--porcelain"], { timeout: 5000 });
    const head = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
    const changedFiles = status.code === 0 ? status.stdout.split("\n").filter(Boolean).map((line) => line.slice(3)) : [];
    await run(Effect.flatMap(FeatureStore, (store) =>
      store.update(featureId, (draft) => {
        draft.lastKnownGit = { cwd: ctx.cwd, head: head.code === 0 ? head.stdout.trim() : null, dirty: changedFiles.length > 0, changedFiles };
      })
    ));
    const event: Record<string, unknown> = {
      type: "turn.settled",
      leafId: leafId ?? null,
      sessionId: ctx.sessionManager.getSessionId() ?? null,
      changedFiles,
    };
    if (config.turnSnapshot === "full") {
      const messages = branch.filter((entry) => entry.type === "message" && "message" in entry) as Array<{ type: "message"; message: { role: string; content: unknown } }>;
      const lastUser = [...messages].reverse().find((entry) => entry.message.role === "user");
      const lastAssistant = [...messages].reverse().find((entry) => entry.message.role === "assistant");
      event.userExcerpt = lastUser ? textContent(lastUser.message.content).slice(0, 1500) : null;
      event.assistantExcerpt = lastAssistant ? textContent(lastAssistant.message.content).slice(0, 2000) : null;
    }
    await appendLedger(featureId, event);
  }

  // ─── Handoff sessions ──────────────────────────────────────────────────────

  async function buildContinuationContext(featureId: string): Promise<string> {
    const state = await loadFeature(featureId);
    const artifacts = {
      assumptions: await readArtifact(featureId, "assumptions"),
      decisions: await readArtifact(featureId, "decisions"),
      plan: await readArtifact(featureId, "plan"),
      threadLog: await readArtifact(featureId, "threadLog"),
    };
    const gitStatus = await pi.exec("git", ["status", "--short"], { timeout: 5000, cwd: state.project.cwd });
    const gitLog = await pi.exec("git", ["log", "-5", "--oneline"], { timeout: 5000, cwd: state.project.cwd });
    return `${composeContinuationContext(state, artifacts, { status: gitStatus.stdout.trim(), log: gitLog.stdout.trim() })}\n- Feature root: \`${featureDir(featureId)}\`\n`;
  }

  async function createHandoffSession(state: FeatureState, ctx: ExtensionCommandContext, task: string): Promise<void> {
    const handoff = await buildContinuationContext(state.featureId);
    const latestSession = [...state.sessions].reverse().find((session) => session.kind === "pi" && session.sessionFile);
    const parentSession = latestSession?.sessionFile && await pathExists(latestSession.sessionFile)
      ? latestSession.sessionFile
      : ctx.sessionManager.getSessionFile();
    const manager = SessionManager.create(state.project.cwd, undefined, { parentSession: parentSession ?? undefined });
    manager.appendCustomEntry(POINTER_TYPE, { featureId: state.featureId, featureRoot: featureDir(state.featureId), revision: state.revision });
    manager.appendCustomMessageEntry("feature-handoff", handoff, false, { featureId: state.featureId });
    manager.appendSessionInfo(`feature:${state.featureId}`);
    const sessionFile = manager.getSessionFile();
    const header = manager.getHeader();
    if (!sessionFile || !header) throw new Error(`Could not create a fresh handoff session for ${state.featureId}.`);
    await writeFile(sessionFile, [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await ctx.switchSession(sessionFile, {
      withSession: async (replacement) => {
        replacement.ui.setEditorText(task);
        replacement.ui.notify(`Fresh handoff session ready for ${namingPrefix(state)}.`, "info");
      },
    });
  }

  async function showFeatureSelector(ctx: ExtensionCommandContext): Promise<void> {
    const states = await listFeatures();
    if (states.length === 0) {
      ctx.ui.notify("No features recorded. Run /feature new to create one.", "info");
      return;
    }
    const choices = states.map((state) => `${namingPrefix(state)} · ${state.status}/${state.activeStage} · ${compactText(state.title, 64)} · ${state.project.cwd}`);
    const selected = await ctx.ui.select("Features — select one for a fresh handoff", choices);
    if (!selected) return;
    const state = states[choices.indexOf(selected)];
    if (!state) return;
    await createHandoffSession(state, ctx, `Continue work on ${namingPrefix(state)}.\n\n`);
  }

  // ─── Stage operations ──────────────────────────────────────────────────────

  async function beginIntegratedPlanning(featureId: string, ctx: ExtensionContext): Promise<void> {
    const config = await getConfig();
    const state = await loadFeature(featureId);
    await run(Effect.flatMap(FeatureStore, (store) =>
      store.update(featureId, (draft) => {
        draft.activeStage = "planning";
        draft.status = "planning";
        draft.checkpoint = { kind: "none", status: "none", updatedAt: new Date().toISOString() };
      })
    ));
    await switchMainModel(ctx, config.routes.interactivePlanning);
    await bindPiSession(featureId, "planning", ctx);
    const kickoff = planningKickoff(state);
    if (ctx.isIdle()) pi.sendUserMessage(kickoff);
    else pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
  }

  async function runPlanStage(featureId: string, ctx: ExtensionContext): Promise<string> {
    ctx.ui.notify("Running the integrated planner…", "info");
    const url = await run(Effect.flatMap(Workflow, (workflow) => workflow.runPlan(featureId, ctx.cwd, ctx.sessionManager.getSessionId() ?? null)));
    await appendArtifact(featureId, "threadLog", "Plan published", `- Artifact: ${url}`, "extension");
    ctx.ui.notify(`Review the plan: ${url}`, "info");
    updateUi(ctx, await loadFeature(featureId));
    return url;
  }

  async function publishStage(featureId: string, ctx: ExtensionContext): Promise<string> {
    ctx.ui.notify("Publishing the plan for review…", "info");
    const url = await run(Effect.flatMap(Workflow, (workflow) => workflow.publishPlan(featureId)));
    ctx.ui.notify(`Review the plan: ${url}`, "info");
    updateUi(ctx, await loadFeature(featureId));
    return url;
  }

  async function spawnStage(featureId: string, stage: RunStage, task: string, ctx: ExtensionContext | null): Promise<void> {
    const result = await run(Effect.flatMap(Workflow, (workflow) =>
      workflow.spawnStage(featureId, stage, task, ctx?.cwd ?? null, ctx?.sessionManager.getSessionId() ?? null)
    ));
    if (ctx) {
      ctx.ui.notify(`Started ${stage}${result.runId ? ` (${result.runId})` : ""}`, "info");
      updateUi(ctx, result.state);
    }
  }

  async function runReview(featureId: string, kind: "oracle" | "adversary", ctx: ExtensionContext): Promise<string> {
    if (kind === "adversary") {
      await spawnStage(featureId, "adversary", "Run a fresh adversarial review of the current plan.", ctx);
      return "Adversarial review started in a fresh context.";
    }
    const state = await loadFeature(featureId);
    const review = await run(Effect.flatMap(Planner, (planner) => planner.oracle(state)));
    await appendArtifact(featureId, "threadLog", "oracle review", review, "reviewer");
    return review;
  }

  async function decideCheckpoint(featureId: string, decision: "approve" | "reject", note: string, ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    const state = await loadFeature(featureId);
    const confirmed = await ctx.ui.confirm(
      `${decision === "approve" ? "Approve" : "Reject"} ${state.checkpoint.kind} checkpoint?`,
      note || `${state.title} · ${state.activeStage}`,
    );
    if (!confirmed) return;
    const updated = await run(Effect.flatMap(Workflow, (workflow) =>
      workflow.decideCheckpoint(featureId, decision, note, ctx.sessionManager.getSessionId() ?? null)
    ));
    if (decision === "approve" && updated.checkpoint.kind === "plan") {
      const config = await getConfig();
      await switchMainModel(ctx, config.routes.execution);
      updateUi(ctx, updated);
      await spawnStage(featureId, "implementation", "Implement the complete approved plan; validation will start automatically afterward.", ctx);
      return;
    }
    updateUi(ctx, await loadFeature(featureId));
  }

  async function showStatus(featureId: string, ctx: ExtensionContext): Promise<void> {
    const state = await loadFeature(featureId);
    updateUi(ctx, state);
    const latest = state.sessions.slice(-5).map((session) => `${session.kind}/${session.role}: ${session.stage} · ${session.runId || session.sessionId || "no id"}`).join("\n");
    ctx.ui.notify(
      `${state.title}\nstatus=${state.status} stage=${state.activeStage} checkpoint=${state.checkpoint.kind}/${state.checkpoint.status}\nplan=${state.planArtifact?.url ?? "not published"}\nexecutionLease=${state.executionLease ? `${state.executionLease.stage}/${state.executionLease.token}` : "none"}\nroot=${featureDir(featureId)}\n${latest}`,
      "info",
    );
  }

  // ─── /feature command ──────────────────────────────────────────────────────

  async function queueFeatureRequest(request: string): Promise<void> {
    pendingFeatureRequest = request;
    pi.sendMessage({ customType: "feature-start-request", content: featureStartRequest(), display: false }, { deliverAs: "nextTurn" });
    pi.sendUserMessage(request);
  }

  async function handleFeature(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    const args = splitArgs(rawArgs);
    if (args.length === 0) return showFeatureSelector(ctx);
    const command = args.shift()!.toLowerCase();
    if (command === "list") return showFeatureSelector(ctx);
    if (command === "new") {
      if (args.length > 0) throw new Error("/feature new does not accept parameters. Run it by itself and enter the request in the editor.");
      const request = await ctx.ui.editor("Describe the feature request", "");
      if (!request?.trim()) return;
      await queueFeatureRequest(request.trim());
      return;
    }
    let requestedId: string | null = null;
    const featureFlag = args.indexOf("--feature");
    if (featureFlag >= 0) {
      requestedId = args[featureFlag + 1] ?? null;
      args.splice(featureFlag, 2);
    } else if (["use", "status", "resume"].includes(command) && args[0]) {
      requestedId = args.shift()!;
    } else {
      requestedId = activeFeatureId;
    }
    if (!requestedId) throw new Error("No active feature. Use /feature new, /feature use <id>, or --feature <id>.");
    const featureId = requireId(requestedId);

    if (command === "use" || command === "resume") {
      const selectedState = await loadFeature(featureId);
      await createHandoffSession(selectedState, ctx, `Continue work on ${namingPrefix(selectedState)}.\n\n`);
      return;
    }
    const state = await setActive(featureId, ctx);

    if (command === "status") return showStatus(featureId, ctx);
    if (command === "plan") { const url = await runPlanStage(featureId, ctx); ctx.ui.setEditorText(`Review the plan: ${url}`); return; }
    if (command === "publish") { const url = await publishStage(featureId, ctx); ctx.ui.setEditorText(`Review the plan: ${url}`); return; }
    if (command === "oracle" || command === "adversary") { const review = await runReview(featureId, command, ctx); ctx.ui.setEditorText(review); return; }
    if (command === "implement") return spawnStage(featureId, "implementation", args.join(" ") || "Implement the complete approved plan.", ctx);
    if (command === "validate") return spawnStage(featureId, "validation", args.join(" ") || "Validate the actual diff against the approved plan.", ctx);
    if (command === "unlock") {
      const current = await loadFeature(featureId);
      if (!current.executionLease) throw new Error("No execution reservation is present.");
      const confirmed = await ctx.ui.confirm("Clear execution reservation?", `Only continue after checking that no worker is live. Reservation: ${current.executionLease.stage} ${current.executionLease.token}`);
      if (!confirmed) return;
      await run(Effect.flatMap(FeatureStore, (store) => store.releaseExecution(featureId, current.executionLease!.token, true)));
      await appendLedger(featureId, { type: "execution.unlocked", token: current.executionLease.token, stage: current.executionLease.stage });
      updateUi(ctx, await loadFeature(featureId));
      return;
    }
    if (command === "approve" || command === "reject") return decideCheckpoint(featureId, command, args.join(" "), ctx);
    if (command === "followup") {
      const task = args.join(" ") || `Continue work on ${namingPrefix(state)}.`;
      await createHandoffSession(state, ctx, `${task}\n\n`);
      return;
    }
    throw new Error("Usage: /feature (selector) or /feature <new|use|list|status|plan|publish|oracle|adversary|approve|reject|implement|validate|unlock|followup|resume>");
  }

  pi.registerCommand("feature", {
    description: "Open the feature selector, create a feature request, or use recovery controls",
    getArgumentCompletions: (prefix) =>
      ["new", "use", "list", "status", "plan", "publish", "oracle", "adversary", "approve", "reject", "implement", "validate", "unlock", "followup", "resume"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      try { await handleFeature(args, ctx); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });

  // ─── Tools ─────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "feature_workflow",
    label: "Feature Workflow",
    description: "Opt-in agent-facing controller for a feature workflow the user explicitly requested. After one explicit trigger, advance stages autonomously; slash commands are optional recovery controls.",
    promptSnippet: "Run the feature workflow only after the user explicitly triggers it; never activate it based on task size alone",
    promptGuidelines: WORKFLOW_GUIDELINES,
    parameters: Type.Object({
      action: StringEnum(["start", "plan", "publish", "request_approval", "reject", "implement", "validate", "review", "status"] as const),
      workItem: Type.Optional(Type.String()),
      title: Type.Optional(Type.String({ description: "Concise descriptive display title, at most 96 characters; never copy the complete request" })),
      package: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
      reviewKind: Type.Optional(StringEnum(["oracle", "adversary"] as const)),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === "start") {
        if (!params.workItem) throw new Error("workItem is required: Jira key, PR, or stable feature name.");
        const state = await run(Effect.flatMap(FeatureStore, (store) => store.create(params.workItem!, params.title || params.workItem!, ctx.cwd)));
        const initialRequest = pendingFeatureRequest;
        pendingFeatureRequest = null;
        await setActive(state.featureId, ctx);
        if (initialRequest) await appendArtifact(state.featureId, "assumptions", "Initial developer request", initialRequest, "user-via-feature-new");
        await appendArtifact(state.featureId, "decisions", "Required Git and PR naming", `Canonical work item: \`${namingPrefix(state)}\`. Branches start \`${namingPrefix(state)}-\`; commits and PR titles start \`${namingPrefix(state)} \`.`, "extension");
        await beginIntegratedPlanning(state.featureId, ctx);
        return { content: [{ type: "text", text: `Started integrated planning for ${namingPrefix(state)}. Interactive planning has been queued; do not ask the developer to run slash commands.` }], details: { featureId: state.featureId } };
      }
      if (!activeFeatureId) throw new Error("No active feature. Start one with action=start.");
      const featureId = activeFeatureId;
      if (params.action === "plan") {
        const url = await runPlanStage(featureId, ctx);
        return { content: [{ type: "text", text: `Plan published for human review: ${url}\nShow this URL to the user. The plan checkpoint remains pending.` }], details: { featureId, url } };
      }
      if (params.action === "publish") {
        const url = await publishStage(featureId, ctx);
        return { content: [{ type: "text", text: `Plan artifact published: ${url}\nShow this URL to the user.` }], details: { featureId, url } };
      }
      if (params.action === "request_approval" || params.action === "reject") {
        await decideCheckpoint(featureId, params.action === "reject" ? "reject" : "approve", params.note || "", ctx as ExtensionCommandContext);
        const state = await loadFeature(featureId);
        return { content: [{ type: "text", text: `Human checkpoint result: ${state.checkpoint.kind}/${state.checkpoint.status}.` }], details: { featureId, checkpoint: state.checkpoint } };
      }
      if (params.action === "implement") {
        await spawnStage(featureId, "implementation", params.package || "Implement the complete approved plan.", ctx);
        return { content: [{ type: "text", text: "Implementation worker started for the complete approved plan; validation will follow automatically." }], details: { featureId } };
      }
      if (params.action === "validate") {
        await spawnStage(featureId, "validation", params.note || "Validate the actual diff.", ctx);
        return { content: [{ type: "text", text: "Fresh validation worker started." }], details: { featureId } };
      }
      if (params.action === "review") {
        const review = await runReview(featureId, params.reviewKind || "oracle", ctx);
        return { content: [{ type: "text", text: review }], details: { featureId, reviewKind: params.reviewKind || "oracle" } };
      }
      const state = await loadFeature(featureId);
      return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }], details: { featureId, revision: state.revision } };
    },
  });

  pi.registerTool({
    name: "feature_memory",
    label: "Feature Memory",
    description: "Read or append the minimal durable feature memory: assumptions, architectural decisions, the plan, and thread activity. Git and the PR remain implementation evidence.",
    promptSnippet: "Read and append only important assumptions, decisions, plans, or thread context",
    promptGuidelines: MEMORY_GUIDELINES,
    parameters: Type.Object({
      action: StringEnum(["status", "read", "append"] as const),
      featureId: Type.Optional(Type.String()),
      artifact: Type.Optional(StringEnum([...ARTIFACT_NAMES] as unknown as string[])),
      heading: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const featureId = requireId(params.featureId || activeFeatureId || "");
      if (params.action === "status") {
        const state = await loadFeature(featureId);
        return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }], details: { featureId, revision: state.revision } };
      }
      if (params.action === "read") {
        if (!params.artifact) throw new Error("artifact is required for read.");
        const content = await readArtifact(featureId, params.artifact as ArtifactName);
        return { content: [{ type: "text", text: content.slice(0, 50_000) }], details: { featureId, artifact: params.artifact } };
      }
      if (params.action === "append") {
        if (!params.artifact || !params.content) throw new Error("artifact and content are required for append.");
        if (params.artifact === "plan") throw new Error("plan.md is planner-owned and cannot be appended. Re-run feature_workflow plan instead.");
        await appendArtifact(featureId, params.artifact as ArtifactName, params.heading || "Update", params.content, "main-agent");
        await appendLedger(featureId, { type: "artifact.appended", artifact: params.artifact, heading: params.heading || "Update", piSessionId: ctx.sessionManager.getSessionId() ?? null });
        return { content: [{ type: "text", text: `Appended ${params.artifact} for ${featureId}.` }], details: { featureId, artifact: params.artifact } };
      }
      throw new Error(`Unsupported feature_memory action: ${String(params.action)}`);
    },
  });

  // ─── Hooks ─────────────────────────────────────────────────────────────────

  pi.on("before_agent_start", async () => {
    if (!activeFeatureId) return;
    try {
      const state = await loadFeature(activeFeatureId);
      return { message: { customType: "feature-flow-context", content: turnContext(state), display: false } };
    } catch { return; }
  });

  pi.on("tool_call", async (event) => {
    if (!activeFeatureId) return;
    const state = await loadFeature(activeFeatureId);
    const prefix = namingPrefix(state);
    const input = event.input as Record<string, unknown>;
    if (event.toolName !== "bash") return;
    const command = String(input.command ?? "");
    const violation = validateNamingCommand(command, prefix);
    if (violation) return { block: true, reason: violation.reason };
    if (/\bgit\s+commit\b/i.test(command) && !isAmendNoEdit(command)) {
      const branchResult = await pi.exec("git", ["branch", "--show-current"], { timeout: 5000 });
      const currentBranch = branchResult.code === 0 ? branchResult.stdout.trim() : "";
      if (currentBranch && !currentBranch.startsWith(`${prefix}-`)) {
        return { block: true, reason: `Active work item ${prefix}: current branch '${currentBranch}' is not linked. Create or rename it to '${prefix}-short-kebab-description' before committing.` };
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!activeFeatureId || event.toolName !== "ask_user" || event.isError) return;
    const details = event.details as { cancelled?: boolean; questions?: Array<{ id: string; prompt: string }>; answers?: Array<{ id: string; labels: string[]; skipped: boolean }> } | undefined;
    if (!details || details.cancelled || !details.answers?.length) return;
    const lines = details.answers.map((answer) => {
      const prompt = details.questions?.find((question) => question.id === answer.id)?.prompt || answer.id;
      return `- **${prompt}**\n  - ${answer.skipped ? "Skipped" : answer.labels.join(", ")}`;
    }).join("\n");
    await appendArtifact(activeFeatureId, "assumptions", "Raw interview answers", lines, "user-via-ask_user");
    await appendLedger(activeFeatureId, { type: "questions.answered", toolCallId: event.toolCallId, piSessionId: ctx.sessionManager.getSessionId() ?? null });
  });

  pi.events.on(ASYNC_COMPLETE_EVENT, (raw) => {
    void (async () => {
      const event = raw as { runId?: string; id?: string; asyncDir?: string; results?: Array<{ sessionPath?: string; transcriptPath?: string; status?: string; agent?: string }> };
      const runId = event.runId || event.id;
      if (!runId) return;
      const completion = await run(Effect.flatMap(Workflow, (workflow) => workflow.completeRun(runId, event.results?.[0], event.asyncDir ?? null)));
      if (!completion) return;
      await appendArtifact(
        completion.featureId,
        "threadLog",
        `${completion.stage} run ${runId}`,
        `- Status: ${completion.succeeded ? "succeeded" : "failed"}${completion.validationPassed !== null ? `\n- Validator verdict: ${completion.validationPassed ? "PASS" : "BLOCKED"}` : ""}\n\nImplementation and validation evidence remains in the actual Git diff/history and child transcript (see ledger.jsonl for paths).`,
        "extension",
      );
      if (completion.autoValidate) {
        const matchingContext = currentContext && activeFeatureId === completion.featureId ? currentContext : null;
        await spawnStage(completion.featureId, "validation", "Automatically validate the complete implementation against the approved plan and actual Git diff.", matchingContext);
      }
      if (currentContext && activeFeatureId === completion.featureId) {
        const updated = await loadFeature(completion.featureId);
        updateUi(currentContext, updated);
        currentContext.ui.notify(
          updated.status === "complete" ? "Implementation and validation completed automatically." : updated.status === "blocked" ? (updated.lastError || "Workflow blocked.") : "Automatic validation started.",
          updated.status === "blocked" ? "warning" : "info",
        );
      }
    })().catch((error) => console.error("feature-flow async completion persistence failed", error));
  });

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    await run(Effect.flatMap(FeatureStore, (store) => store.ensureRoots()));
    activeFeatureId = restorePointer(ctx);
    if (!activeFeatureId) { updateUi(ctx); return; }
    try {
      const state = await loadFeature(activeFeatureId);
      updateUi(ctx, state);
      await bindPiSession(activeFeatureId, state.activeStage, ctx);
    } catch (error) {
      activeFeatureId = null;
      ctx.ui.notify(`Feature pointer could not be restored: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!activeFeatureId) return;
    await turnSnapshot(activeFeatureId, ctx).catch((error) => console.error("feature-flow snapshot failed", error));
  });

  pi.on("session_shutdown", async (event, ctx) => {
    currentContext = null;
    pendingFeatureRequest = null;
    if (!activeFeatureId) return;
    const now = new Date().toISOString();
    const sessionId = ctx.sessionManager.getSessionId() ?? null;
    await run(Effect.flatMap(FeatureStore, (store) =>
      store.update(activeFeatureId!, (draft) => {
        for (const session of draft.sessions) {
          if (session.kind === "pi" && session.sessionId === sessionId && !session.endedAt) {
            session.endedAt = now;
            session.endReason = event.reason;
          }
        }
      })
    )).catch(() => undefined);
    await appendLedger(activeFeatureId, { type: "session.ended", reason: event.reason, piSessionId: sessionId, targetSessionFile: event.targetSessionFile ?? null }).catch(() => undefined);
  });
}
