import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";

export const FEATURE_FLOW_ROOT = process.env.PI_FEATURE_FLOW_ROOT ?? join(homedir(), ".pi", "agent", "feature-flow");
export const FEATURES_ROOT = join(FEATURE_FLOW_ROOT, "features");
export const CONFIG_PATH = join(FEATURE_FLOW_ROOT, "config.json");

const ThinkingLevel = Schema.Literal("off", "minimal", "low", "medium", "high", "xhigh");

const ModelRoute = Schema.Struct({
  model: Schema.String,
  thinking: ThinkingLevel,
});
export type ModelRoute = typeof ModelRoute.Type;

const CliRoute = Schema.Struct({
  command: Schema.String,
  model: Schema.String,
  effort: Schema.Literal("low", "medium", "high"),
});
export type CliRoute = typeof CliRoute.Type;

const Routes = Schema.Struct({
  /** Main-session model while interviewing/refining assumptions. */
  interactivePlanning: Schema.optionalWith(ModelRoute, { default: () => ({ model: "openai-codex/gpt-5.6-sol", thinking: "high" as const }) }),
  /** Main-session model after plan approval. */
  execution: Schema.optionalWith(ModelRoute, { default: () => ({ model: "openai-codex/gpt-5.6-terra", thinking: "high" as const }) }),
  /** Subagent that implements the approved plan. */
  worker: Schema.optionalWith(ModelRoute, { default: () => ({ model: "openai-codex/gpt-5.6-terra", thinking: "high" as const }) }),
  /** Fresh-context validator subagent. */
  validator: Schema.optionalWith(ModelRoute, { default: () => ({ model: "openai-codex/gpt-5.6-terra", thinking: "high" as const }) }),
  /** Adversarial plan reviewer subagent. */
  adversary: Schema.optionalWith(ModelRoute, { default: () => ({ model: "openai-codex/gpt-5.6-sol", thinking: "high" as const }) }),
  /** External CLI used to produce the integrated plan (best-writer model). */
  planner: Schema.optionalWith(CliRoute, { default: () => ({ command: "claude", model: "fable", effort: "high" as const }) }),
  /** External CLI used for oracle architecture reviews. */
  oracle: Schema.optionalWith(CliRoute, { default: () => ({ command: "claude", model: "fable", effort: "high" as const }) }),
});

/**
 * Runtime configuration. Unlike the v2 prototype, this file is actually read:
 * every model reference in the extension resolves through these routes.
 */
const FeatureFlowConfig = Schema.Struct({
  version: Schema.optionalWith(Schema.Number, { default: () => 3 }),
  routes: Schema.optionalWith(Routes, { default: () => Schema.decodeUnknownSync(Routes)({}) }),
  planArtifact: Schema.optionalWith(
    Schema.Struct({
      /**
       * "claude-artifact": publish plan.md through the Claude CLI Artifact tool (tmux driver; brittle, best UX).
       * "file": copy plan.md to a local share directory and hand back a file:// URL (robust default).
       */
      publisher: Schema.optionalWith(Schema.Literal("claude-artifact", "file"), { default: () => "file" as const }),
    }),
    { default: () => ({ publisher: "file" as const }) },
  ),
  turnSnapshot: Schema.optionalWith(
    /** Per-settled-turn thread-log capture: off, compact (ids + changed files), full (adds message excerpts). */
    Schema.Literal("off", "compact", "full"),
    { default: () => "compact" as const },
  ),
  budgets: Schema.optionalWith(
    Schema.Struct({
      implementationMaxTurns: Schema.optionalWith(Schema.Number, { default: () => 18 }),
      validationMaxTurns: Schema.optionalWith(Schema.Number, { default: () => 10 }),
      spawnTimeoutMs: Schema.optionalWith(Schema.Number, { default: () => 900_000 }),
      rpcReplyTimeoutMs: Schema.optionalWith(Schema.Number, { default: () => 20_000 }),
    }),
    { default: () => ({ implementationMaxTurns: 18, validationMaxTurns: 10, spawnTimeoutMs: 900_000, rpcReplyTimeoutMs: 20_000 }) },
  ),
  archive: Schema.optionalWith(
    Schema.Struct({
      /** Private repository under the currently authenticated GitHub account, or an explicit owner/name. */
      repository: Schema.optionalWith(Schema.String, { default: () => "pi-feature-archives" }),
      branch: Schema.optionalWith(Schema.String, { default: () => "main" }),
      /** Roots inspected for feature-named Git worktrees. Keep this list narrow on very large home directories. */
      searchRoots: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [homedir()] }),
      /** Extra context-only files/directories. Supports {featureId} and {workItem}; relative paths use the feature project cwd. */
      extraPaths: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
    }),
    { default: () => ({ repository: "pi-feature-archives", branch: "main", searchRoots: [homedir()], extraPaths: [] }) },
  ),
});
export type FeatureFlowConfig = typeof FeatureFlowConfig.Type;

const decodeConfig = Schema.decodeUnknown(Schema.parseJson(FeatureFlowConfig));

export class FeatureConfig extends Effect.Service<FeatureConfig>()("FeatureConfig", {
  effect: Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(CONFIG_PATH, "utf8"),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
    const config: FeatureFlowConfig = raw === null
      ? yield* decodeConfig("{}").pipe(Effect.orDie)
      : yield* decodeConfig(raw).pipe(
        Effect.tapError((error) => Effect.logWarning(`feature-flow config.json invalid, using defaults: ${String(error)}`)),
        Effect.orElse(() => decodeConfig("{}").pipe(Effect.orDie)),
      );
    return { config };
  }),
}) {}
