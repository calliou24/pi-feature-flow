import { Effect } from "effect";
import { PlannerFailed, type FeatureState } from "./domain.ts";
import { FeatureConfig } from "./config.ts";
import { PiApi, piExec } from "./pi-api.ts";
import { featureDir } from "./store.ts";
import { oraclePrompt, plannerPrompt } from "./prompts.ts";

const PLANNER_TIMEOUT_MS = 600_000;

export interface PlanOutput {
  markdown: string;
  sessionId: string | null;
}

/**
 * External-CLI planner and oracle reviewer. Both routes come from config; the
 * default is the Claude CLI with the best-writer model, headless (`-p`) and
 * read-only (`Read,Grep,Glob`).
 */
export class Planner extends Effect.Service<Planner>()("Planner", {
  effect: Effect.gen(function* () {
    const { config } = yield* FeatureConfig;
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
      runCli(config.routes.planner, plannerPrompt(state, repositoryCwd), featureDir(state.featureId), true).pipe(
        Effect.flatMap((result) => {
          if (result.code !== 0) return Effect.fail(new PlannerFailed({ reason: result.stderr.trim() || "Planning CLI failed." }));
          let markdown = result.stdout.trim();
          let sessionId: string | null = null;
          try {
            const parsed = JSON.parse(result.stdout) as { result?: string; session_id?: string };
            markdown = parsed.result?.trim() || markdown;
            sessionId = parsed.session_id ?? null;
          } catch { /* plain-text fallback */ }
          if (!markdown) return Effect.fail(new PlannerFailed({ reason: "Planner returned no plan." }));
          return Effect.succeed({ markdown, sessionId });
        }),
      );

    const oracle = (state: FeatureState): Effect.Effect<string, PlannerFailed> =>
      runCli(config.routes.oracle, oraclePrompt(state), featureDir(state.featureId), false).pipe(
        Effect.flatMap((result) =>
          result.code !== 0
            ? Effect.fail(new PlannerFailed({ reason: result.stderr.trim() || "Oracle review failed." }))
            : Effect.succeed(result.stdout.trim())
        ),
      );

    return { plan, oracle };
  }),
  dependencies: [FeatureConfig.Default],
}) {}
