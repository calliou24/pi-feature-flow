import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
	type FeatureState,
	type RunStage,
	type SessionRecord,
	PublishFailed,
	type SpawnFailed,
	StageNotReady,
} from "./domain.ts";
import {
	implementationProblem,
	markdownRevision,
	planArtifactProblem,
	planPublicationProblem,
	planHash,
	validationVerdictFromContents,
} from "./plan.ts";
import {
	FeatureConfig,
	type ModelRoute,
	type WorkerKind,
	workerRoute,
} from "./config.ts";
import { FeatureStore } from "./store.ts";
import { SubagentGateway } from "./subagents.ts";
import { PlanPublisher } from "./planner.ts";
import { stagePrompt, stageRole } from "./prompts.ts";

export interface RunCompletion {
	featureId: string;
	stage: string;
	succeeded: boolean;
	validationPassed: boolean | null;
	autoValidate: boolean;
	summary: string | null;
	state: FeatureState;
}

interface SpawnStageOptions {
	cwd: string | null;
	parentSessionId: string | null;
	workerKind?: WorkerKind;
	packages?: readonly string[];
	adversaryRouteOverride?: ModelRoute;
}

/**
 * Feature lifecycle orchestrator. Pure workflow: no UI, no main-session model
 * switching — the extension entry owns those side effects.
 */
export class Workflow extends Effect.Service<Workflow>()("Workflow", {
	effect: Effect.gen(function* () {
		const store = yield* FeatureStore;
		const gateway = yield* SubagentGateway;
		const publisher = yield* PlanPublisher;
		const { config } = yield* FeatureConfig;

		const publishGeneratedPlan = (featureId: string) =>
			Effect.gen(function* () {
				const state = yield* store.load(featureId);
				const plan = yield* store.readArtifact(featureId, "plan");
				const planRevision = markdownRevision(plan);
				if (planRevision === null)
					return yield* Effect.fail(
						new PublishFailed({
							reason: "plan.md has no revision frontmatter.",
						}),
					);
				const planBody = plan
					.replace(/^---\s*[\s\S]*?\n---\s*/, "")
					.replace(/^# Implementation Plan\s*/i, "")
					.trim();
				if (!planBody)
					return yield* Effect.fail(
						new PublishFailed({ reason: "plan.md has no plan content." }),
					);
				const url = yield* publisher.publish(state, planRevision).pipe(
					Effect.tapError((error) =>
						store
							.update(featureId, (draft) => {
								draft.status = "planning";
								draft.checkpoint = {
									kind: "none",
									status: "none",
									updatedAt: new Date().toISOString(),
								};
								draft.lastError = error.message;
							})
							.pipe(Effect.ignore),
					),
				);
				yield* store.update(featureId, (draft) => {
					draft.planArtifact = {
						url,
						publishedAt: new Date().toISOString(),
						planRevision,
						planHash: planHash(plan),
					};
					draft.activeStage = "planning";
					draft.status = "awaiting-approval";
					draft.checkpoint = {
						kind: "plan",
						status: "pending",
						updatedAt: new Date().toISOString(),
						note: url,
					};
					draft.lastError = null;
				});
				yield* store.appendLedger(featureId, {
					type: "plan.published",
					url,
					planRevision,
				});
				return url;
			});

		const publishPlan = (featureId: string, planMarkdown: string | null) =>
			Effect.gen(function* () {
				const state = yield* store.load(featureId);
				const problem = planPublicationProblem(state);
				if (problem)
					return yield* Effect.fail(new StageNotReady({ reason: problem }));
				if (planMarkdown?.trim()) {
					yield* store.replaceArtifact(
						featureId,
						"plan",
						planMarkdown,
						"main-agent",
					);
					yield* store.update(featureId, (draft) => {
						draft.planArtifact = null;
						draft.status = "planning";
						draft.checkpoint = {
							kind: "none",
							status: "none",
							updatedAt: new Date().toISOString(),
						};
					});
				}
				return yield* publishGeneratedPlan(featureId);
			});

		const decideCheckpoint = (
			featureId: string,
			decision: "approve" | "reject",
			note: string,
			piSessionId: string | null,
		) =>
			Effect.gen(function* () {
				const state = yield* store.load(featureId);
				if (state.checkpoint.status !== "pending") {
					return yield* Effect.fail(
						new StageNotReady({
							reason: `No pending checkpoint to ${decision}.`,
						}),
					);
				}
				if (decision === "approve" && state.checkpoint.kind === "plan") {
					const plan = yield* store.readArtifact(featureId, "plan");
					const problem = planArtifactProblem(plan, state.planArtifact);
					if (problem)
						return yield* Effect.fail(new StageNotReady({ reason: problem }));
				}
				const updated = yield* store.update(featureId, (draft) => {
					draft.checkpoint = {
						...draft.checkpoint,
						status: decision === "approve" ? "approved" : "rejected",
						note: note || undefined,
						updatedAt: new Date().toISOString(),
					};
					if (decision === "approve" && draft.checkpoint.kind === "plan")
						draft.status = "planned";
					if (decision === "reject") draft.status = "blocked";
				});
				yield* store.appendLedger(featureId, {
					type: "checkpoint.decided",
					decision,
					note,
					piSessionId,
				});
				return updated;
			});

		const spawnStage = (
			featureId: string,
			stage: RunStage,
			task: string,
			options: SpawnStageOptions,
		) =>
			Effect.gen(function* () {
				const {
					cwd,
					parentSessionId,
					workerKind = "sol",
					packages,
					adversaryRouteOverride,
				} = options;
				const state = yield* store.load(featureId);
				const runCwd = cwd ?? state.project.cwd;
				const running = state.sessions.find(
					(session) =>
						session.kind === "subagent" &&
						!session.endedAt &&
						(session.stage === "implementation" ||
							session.stage === "validation"),
				);
				if (running)
					return yield* Effect.fail(
						new StageNotReady({
							reason: `Cannot start ${stage}; ${running.stage} run ${running.runId ?? "unknown"} is still active.`,
						}),
					);

				const requestId = `feature-${randomUUID()}`;
				const needsLease = stage === "implementation" || stage === "validation";
				if (needsLease) {
					yield* store.reserveExecution(
						featureId,
						{
							token: requestId,
							stage,
							ownerSessionId: parentSessionId,
							createdAt: new Date().toISOString(),
						},
						(current) =>
							Effect.gen(function* () {
								if (stage === "implementation") {
									const plan = yield* store
										.readArtifact(featureId, "plan")
										.pipe(Effect.orElseSucceed(() => ""));
									const problem = implementationProblem(
										current.checkpoint,
										plan,
										current.planArtifact,
									);
									if (problem) return yield* Effect.fail(new Error(problem));
								}
								if (stage === "validation") {
									const completed = current.sessions.some(
										(session) =>
											session.kind === "subagent" &&
											session.stage === "implementation" &&
											session.endedAt &&
											["complete", "completed"].includes(
												session.endReason ?? "",
											),
									);
									if (!completed)
										return yield* Effect.fail(
											new Error(
												"Validation requires a completed implementation run.",
											),
										);
								}
							}),
					);
					yield* store.appendLedger(featureId, {
						type: "execution.reserved",
						token: requestId,
						stage,
						piSessionId: parentSessionId,
					});
				}

				let route = adversaryRouteOverride ?? config.routes.adversary;
				if (stage === "implementation") route = workerRoute(config, workerKind);
				else if (stage === "validation") route = config.routes.validator;
				const maxTurns =
					stage === "implementation"
						? config.budgets.implementationMaxTurns
						: stage === "adversary"
							? config.budgets.adversaryMaxTurns
							: config.budgets.validationMaxTurns;
				const parallelPackages =
					stage === "implementation" && packages && packages.length >= 2
						? packages
						: null;
				const spawnEffect = parallelPackages
					? gateway.spawnParallel(
							parallelPackages.map((pkg) => ({
								agent: "feature-worker",
								task: stagePrompt(
									state,
									stage,
									`Implement ONLY this work package inside your assigned worktree:\n\n${pkg}`,
								),
							})),
							{
								model: route.model,
								thinking: route.thinking,
								cwd: runCwd,
								maxTurns,
							},
							true,
						)
					: gateway.spawn({
							agent: stageRole(stage),
							task: stagePrompt(state, stage, task),
							model: route.model,
							thinking: route.thinking,
							cwd: runCwd,
							maxTurns,
						});
				const spawnResult = yield* spawnEffect.pipe(
					Effect.tapError((error: SpawnFailed) =>
						// A timeout is an unknown outcome: the child may be alive with the
						// reply lost. Keep the lease until a human runs /feature unlock.
						// Only a definitive negative reply is safe to roll back.
						needsLease && error.outcome === "definitive"
							? store
									.releaseExecution(featureId, requestId, false)
									.pipe(Effect.ignore)
							: Effect.void,
					),
				);

				const record: SessionRecord = {
					kind: "subagent",
					sessionId: null,
					sessionFile: null,
					transcriptPath: null,
					cwd: runCwd,
					stage: stage === "adversary" ? "review" : stage,
					role: stageRole(stage),
					runId: spawnResult.runId,
					asyncDir: spawnResult.asyncDir,
					parentSessionId,
					startedAt: new Date().toISOString(),
					endedAt: null,
					endReason: null,
				};
				yield* store.update(featureId, (draft) => {
					if (needsLease && draft.executionLease?.token !== requestId) {
						throw new Error(
							"Execution reservation changed before spawn persistence.",
						);
					}
					if (needsLease) draft.executionLease = null;
					if (stage === "implementation" || stage === "validation") {
						draft.activeStage = stage;
						draft.status =
							stage === "implementation" ? "implementing" : "validating";
					}
					draft.sessions.push(record);
				});
				yield* store.appendLedger(featureId, {
					type: "subagent.started",
					stage,
					runId: spawnResult.runId,
					asyncDir: spawnResult.asyncDir,
					task,
					model: route.model,
					thinking: route.thinking,
					packageCount: parallelPackages?.length ?? 1,
					...(stage === "implementation" ? { workerKind } : {}),
				});
				return {
					runId: spawnResult.runId,
					state: yield* store.load(featureId),
				};
			});

		/** Reconcile an async completion event against all recorded runs. */
		const completeRun = (
			runId: string,
			result:
				| {
						sessionPath?: string;
						transcriptPath?: string;
						status?: string;
						agent?: string;
						summary?: string;
				  }
				| undefined,
			asyncDir: string | null,
		): Effect.Effect<RunCompletion | null, unknown> =>
			Effect.gen(function* () {
				const features = yield* store.list();
				const feature = features.find((candidate) =>
					candidate.sessions.some(
						(session) =>
							session.kind === "subagent" &&
							session.runId === runId &&
							!session.endedAt,
					),
				);
				if (!feature) return null;
				const index = feature.sessions.findIndex(
					(session) =>
						session.kind === "subagent" &&
						session.runId === runId &&
						!session.endedAt,
				);
				const completedStage = feature.sessions[index]!.stage;
				const succeeded = ["complete", "completed"].includes(
					result?.status ?? "",
				);
				const verdict =
					completedStage === "validation"
						? yield* Effect.promise(async () => {
								const { readFile } = await import("node:fs/promises");
								const contents: string[] = result?.summary
									? [result.summary]
									: [];
								for (const path of [
									result?.sessionPath,
									result?.transcriptPath,
								]) {
									if (!path) continue;
									try {
										contents.push(await readFile(path, "utf8"));
									} catch {
										/* try next */
									}
								}
								return validationVerdictFromContents(contents);
							})
						: null;

				const state = yield* store.update(feature.featureId, (draft) => {
					const session = draft.sessions[index]!;
					session.endedAt = new Date().toISOString();
					session.sessionFile = result?.sessionPath ?? session.sessionFile;
					session.transcriptPath =
						result?.transcriptPath ?? session.transcriptPath;
					session.endReason = result?.status ?? "complete";
					if (session.stage === "implementation") {
						draft.status = succeeded ? "planned" : "blocked";
						draft.lastError = succeeded
							? null
							: `Implementation run ${runId} ended without a confirmed successful status (${result?.status ?? "unknown"}).`;
					} else if (session.stage === "validation") {
						const passed = succeeded && verdict?.passed === true;
						draft.status = passed ? "complete" : "blocked";
						draft.activeStage = passed ? "done" : "validation";
						draft.lastError = passed
							? null
							: verdict?.summary ||
								`Validation run ${runId} did not report PASS.`;
					}
				});
				yield* store.appendLedger(feature.featureId, {
					type: "subagent.completed",
					runId,
					asyncDir,
					result: result
						? {
								status: result.status,
								agent: result.agent,
								sessionPath: result.sessionPath,
								transcriptPath: result.transcriptPath,
							}
						: null,
					validationPassed: verdict?.passed ?? null,
				});
				return {
					featureId: feature.featureId,
					stage: completedStage,
					succeeded,
					validationPassed: verdict?.passed ?? null,
					autoValidate: completedStage === "implementation" && succeeded,
					summary: result?.summary?.trim() || verdict?.summary || null,
					state,
				} satisfies RunCompletion;
			});

		return { publishPlan, decideCheckpoint, spawnStage, completeRun };
	}),
	dependencies: [
		FeatureStore.Default,
		SubagentGateway.Default,
		PlanPublisher.Default,
		FeatureConfig.Default,
	],
}) {}
