import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { PlannerFailed, PublishFailed, type FeatureState } from "./domain.ts";
import { FeatureConfig } from "./config.ts";
import { PiApi, piExec } from "./pi-api.ts";
import { artifactPath, featureDir } from "./store.ts";
import { oraclePrompt, plannerPrompt } from "./prompts.ts";
import { SubagentGateway } from "./subagents.ts";

const PLANNER_TIMEOUT_MS = 600_000;
const PUBLISH_TIMEOUT_MS = 15_000;

export interface PlanOutput {
  markdown: string;
  runId: string | null;
  asyncDir: string | null;
  sessionPath: string | null;
  transcriptPath: string | null;
}

function normalizePlanMarkdown(output: string): string {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

export function tailscaleDnsName(rawStatus: string): string | null {
  try {
    const status = JSON.parse(rawStatus) as { Self?: { DNSName?: string } };
    return status.Self?.DNSName?.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

function normalizedServePath(value: string): string | null {
  const path = `/${value.trim().replace(/^\/+|\/+$/g, "")}`;
  return /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path) ? path : null;
}

/**
 * Integrated planner and tailnet publisher. Planning runs through the
 * `feature-planner` Pi subagent; publication stages the exact plan behind
 * Tailscale Serve. The oracle remains an isolated external CLI route.
 */
export class Planner extends Effect.Service<Planner>()("Planner", {
  effect: Effect.gen(function* () {
    const { config } = yield* FeatureConfig;
    const gateway = yield* SubagentGateway;
    const pi = yield* PiApi;

    const runCli = (route: { command: string; model: string; effort: string }, prompt: string, root: string, json: boolean) =>
      piExec(route.command, [
        "-p",
        "--model", route.model,
        "--effort", route.effort,
        "--allowedTools", "Read,Grep,Glob",
        ...(json ? ["--output-format", "json"] : []),
        "--add-dir", root,
        "--",
        prompt,
      ], { timeout: PLANNER_TIMEOUT_MS }).pipe(Effect.provideService(PiApi, pi));

    const plan = (state: FeatureState, repositoryCwd: string): Effect.Effect<PlanOutput, PlannerFailed> =>
      gateway.run({
        agent: "feature-planner",
        task: plannerPrompt(state, repositoryCwd),
        model: config.routes.planner.model,
        thinking: config.routes.planner.thinking,
        cwd: repositoryCwd,
        maxTurns: config.budgets.planningMaxTurns,
      }).pipe(
        Effect.mapError((error) => new PlannerFailed({ reason: error.message })),
        Effect.flatMap((result) => {
          const markdown = normalizePlanMarkdown(result.output);
          return markdown
            ? Effect.succeed({
              markdown,
              runId: result.runId,
              asyncDir: result.asyncDir,
              sessionPath: result.sessionPath,
              transcriptPath: result.transcriptPath,
            })
            : Effect.fail(new PlannerFailed({ reason: "Planner returned no plan." }));
        }),
      );

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

    const oracle = (state: FeatureState): Effect.Effect<string, PlannerFailed> =>
      runCli(config.routes.oracle, oraclePrompt(state), featureDir(state.featureId), false).pipe(
        Effect.flatMap((result) =>
          result.code !== 0
            ? Effect.fail(new PlannerFailed({ reason: result.stderr.trim() || "Oracle review failed." }))
            : Effect.succeed(result.stdout.trim())
        ),
      );

    return { plan, publish, oracle };
  }),
  dependencies: [FeatureConfig.Default, SubagentGateway.Default],
}) {}
