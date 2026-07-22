import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { PublishFailed, type FeatureState } from "./domain.ts";
import { FeatureConfig } from "./config.ts";
import { PiApi, piExec } from "./pi-api.ts";
import { artifactPath, featureDir } from "./store.ts";

const PUBLISH_TIMEOUT_MS = 15_000;

export function tailscaleDnsName(rawStatus: string): string | null {
  try {
    const status = JSON.parse(rawStatus) as { Self?: { DNSName?: string } };
    return status.Self?.DNSName?.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

export function normalizedServePath(value: string): string | null {
  const path = `/${value.trim().replace(/^\/+|\/+$/g, "")}`;
  return /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path) ? path : null;
}

/** Publishes the exact revisioned plan behind Tailscale Serve. */
export class PlanPublisher extends Effect.Service<PlanPublisher>()("PlanPublisher", {
  effect: Effect.gen(function* () {
    const { config } = yield* FeatureConfig;
    const pi = yield* PiApi;

    const publish = (state: FeatureState, planRevision: number): Effect.Effect<string, PublishFailed> =>
      Effect.gen(function* () {
        const servePath = normalizedServePath(config.planArtifact.servePath);
        if (!servePath) return yield* Effect.fail(new PublishFailed({ reason: `Invalid Tailscale serve path: ${config.planArtifact.servePath}` }));

        const featurePublishedRoot = join(featureDir(state.featureId), "published");
        const featureServePath = `${servePath}/${state.featureId}`;
        const fileName = `plan-rev${planRevision}.md`;
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(featurePublishedRoot, { recursive: true, mode: 0o700 });
            await copyFile(artifactPath(state.featureId, "plan"), join(featurePublishedRoot, fileName));
          },
          catch: (cause) => new PublishFailed({ reason: String(cause) }),
        });

        const serve = yield* piExec("tailscale", [
          "serve",
          "--bg",
          "--yes",
          "--set-path",
          featureServePath,
          featurePublishedRoot,
        ], { timeout: PUBLISH_TIMEOUT_MS }).pipe(Effect.provideService(PiApi, pi));
        if (serve.code !== 0) {
          return yield* Effect.fail(new PublishFailed({ reason: serve.stderr.trim() || serve.stdout.trim() || "tailscale serve failed." }));
        }

        const status = yield* piExec("tailscale", ["status", "--json"], { timeout: PUBLISH_TIMEOUT_MS }).pipe(Effect.provideService(PiApi, pi));
        const dnsName = status.code === 0 ? tailscaleDnsName(status.stdout) : null;
        if (!dnsName) return yield* Effect.fail(new PublishFailed({ reason: status.stderr.trim() || "Tailscale DNS name is unavailable." }));

        return `https://${dnsName}${featureServePath}/${encodeURIComponent(fileName)}`;
      });

    return { publish };
  }),
  dependencies: [FeatureConfig.Default],
}) {}
