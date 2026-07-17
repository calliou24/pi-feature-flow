import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { PublishFailed, type FeatureState } from "./domain.ts";
import { extractArtifactUrl } from "./plan.ts";
import { FeatureConfig } from "./config.ts";
import { PiApi, piExec } from "./pi-api.ts";
import { artifactPath, featureDir } from "./store.ts";
import { namingPrefix } from "./identity.ts";

const TMUX_PUBLISHER = join(import.meta.dirname, "..", "scripts", "publish-artifact.mjs");
const PUBLISH_TIMEOUT_MS = 330_000;

/**
 * Publishes plan.md for human review and returns a URL.
 *
 * Adapters (selected in config `planArtifact.publisher`):
 * - "file" (default): copies the plan into `<feature>/published/` and returns a
 *   `file://` URL. Zero external dependencies, never flakes.
 * - "claude-artifact": drives the interactive Claude CLI inside tmux to publish
 *   a real Claude Artifact. Best sharing UX, but inherently brittle — it is an
 *   isolated adapter precisely so its failure modes stay contained.
 */
export class PlanPublisher extends Effect.Service<PlanPublisher>()("PlanPublisher", {
  effect: Effect.gen(function* () {
    const { config } = yield* FeatureConfig;
    const pi = yield* PiApi;

    const publishFile = (state: FeatureState, planRevision: number): Effect.Effect<string, PublishFailed> =>
      Effect.tryPromise({
        try: async () => {
          const dir = join(featureDir(state.featureId), "published");
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const target = join(dir, `plan-rev${planRevision}.md`);
          await copyFile(artifactPath(state.featureId, "plan"), target);
          return pathToFileURL(target).href;
        },
        catch: (cause) => new PublishFailed({ reason: String(cause) }),
      });

    const publishClaudeArtifact = (state: FeatureState): Effect.Effect<string, PublishFailed> =>
      Effect.gen(function* () {
        let lastError = "Claude Artifact publication failed.";
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = yield* piExec("node", [
            "--experimental-strip-types",
            TMUX_PUBLISHER,
            artifactPath(state.featureId, "plan"),
            `${namingPrefix(state)} — ${state.title}`,
          ], { timeout: PUBLISH_TIMEOUT_MS }).pipe(Effect.provideService(PiApi, pi));
          const url = extractArtifactUrl(`${result.stdout}\n${result.stderr}`);
          if (result.code === 0 && url) return url;
          lastError = result.stderr.trim() || result.stdout.trim() || lastError;
        }
        return yield* Effect.fail(new PublishFailed({ reason: lastError }));
      });

    const publish = (state: FeatureState, planRevision: number): Effect.Effect<string, PublishFailed> =>
      config.planArtifact.publisher === "claude-artifact"
        ? publishClaudeArtifact(state)
        : publishFile(state, planRevision);

    return { publish };
  }),
  dependencies: [FeatureConfig.Default],
}) {}
