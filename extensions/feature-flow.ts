import { stat, writeFile } from "node:fs/promises";
import { Effect, Either, Layer, ManagedRuntime } from "effect";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	ARTIFACT_NAMES,
	type ArtifactName,
	type FeatureStage,
	type FeatureState,
	type RunStage,
} from "../src/domain.ts";
import {
	isAmendNoEdit,
	namingPrefix,
	normalizeFeatureId,
	validateNamingCommand,
} from "../src/identity.ts";
import { composeContinuationContext } from "../src/plan.ts";
import {
	FeatureConfig,
	adversaryRoute,
	isFableFiveModel,
	type WorkerKind,
	workerRoute,
} from "../src/config.ts";
import { FeatureStore, featureDir } from "../src/store.ts";
import { Workflow } from "../src/workflow.ts";
import { PlanPublisher } from "../src/planner.ts";
import { PiApi, piApiLayer } from "../src/pi-api.ts";
import { ASYNC_COMPLETE_EVENT } from "../src/subagents.ts";
import {
	FeatureArchive,
	type ArchivePreview,
	type ArchiveSummary,
} from "../src/archive.ts";
import {
	MEMORY_GUIDELINES,
	WORKFLOW_GUIDELINES,
	featureStartRequest,
	planningKickoff,
	turnContext,
} from "../src/prompts.ts";

const POINTER_TYPE = "feature-flow-pointer";
const PLAN_READY_TYPE = "feature-plan-ready";
const STATUS_KEY = "feature-flow";

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				Boolean(part) &&
				typeof part === "object" &&
				(part as { type?: string }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function splitArgs(raw: string): string[] {
	return (
		raw
			.trim()
			.match(/(?:[^\s"]+|"[^"]*")+/g)
			?.map((part) => part.replace(/^"|"$/g, "")) ?? []
	);
}

function compactText(value: string, maxLength: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLength) return oneLine;
	const prefix = oneLine.slice(0, Math.max(1, maxLength - 1));
	const wordBoundary = prefix.lastIndexOf(" ");
	const clipped =
		wordBoundary >= Math.floor(maxLength * 0.6)
			? prefix.slice(0, wordBoundary)
			: prefix;
	return `${clipped.trimEnd()}…`;
}

async function pathExists(path: string | null | undefined): Promise<boolean> {
	if (!path) return false;
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export default function featureFlow(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(PLAN_READY_TYPE, (entry, _options, theme) => {
		const data = entry.data as { title?: string; url?: string };
		return new Text(
			theme.fg(
				"accent",
				`Plan ready for review${data.title ? ` · ${data.title}` : ""}\n${data.url ?? "URL unavailable"}\nReview the HTML plan, then approve or reject it.`,
			),
			0,
			0,
		);
	});

	const appLayer = Layer.mergeAll(
		Workflow.Default,
		FeatureStore.Default,
		FeatureConfig.Default,
		PlanPublisher.Default,
		FeatureArchive.Default,
	).pipe(Layer.provide(piApiLayer(pi)));
	const runtime = ManagedRuntime.make(appLayer);
	const run = <A>(
		effect: Effect.Effect<
			A,
			unknown,
			| Workflow
			| FeatureStore
			| FeatureConfig
			| PlanPublisher
			| FeatureArchive
			| PiApi
		>,
	): Promise<A> =>
		runtime.runPromise(
			effect.pipe(
				Effect.provideService(PiApi, pi),
				Effect.mapError((error) =>
					error instanceof Error
						? error
						: new Error(
								typeof error === "object" &&
									error !== null &&
									"message" in error
									? String((error as { message: unknown }).message)
									: String(error),
							),
				),
			) as Effect.Effect<A, Error, never>,
		);

	let activeFeatureId: string | null = null;
	let currentContext: ExtensionContext | null = null;
	let pendingFeatureRequest: string | null = null;
	let progressTimer: ReturnType<typeof setInterval> | null = null;
	const processedRunIds = new Set<string>();

	const loadFeature = (featureId: string) =>
		run(Effect.flatMap(FeatureStore, (store) => store.load(featureId)));
	const listFeatures = () =>
		run(Effect.flatMap(FeatureStore, (store) => store.list()));
	const readArtifact = (featureId: string, artifact: ArtifactName) =>
		run(
			Effect.flatMap(FeatureStore, (store) =>
				store.readArtifact(featureId, artifact),
			),
		);
	const appendArtifact = (
		featureId: string,
		artifact: ArtifactName,
		heading: string,
		body: string,
		author: string,
	) =>
		run(
			Effect.flatMap(FeatureStore, (store) =>
				store.appendArtifact(featureId, artifact, heading, body, author),
			),
		);
	const appendLedger = (featureId: string, event: Record<string, unknown>) =>
		run(
			Effect.flatMap(FeatureStore, (store) =>
				store.appendLedger(featureId, event),
			),
		);
	const getConfig = () =>
		run(Effect.map(FeatureConfig, (service) => service.config));
	const previewArchive = (state: FeatureState) =>
		run(Effect.flatMap(FeatureArchive, (service) => service.preview(state)));
	const createArchive = (state: FeatureState, preview: ArchivePreview) =>
		run(
			Effect.flatMap(FeatureArchive, (service) =>
				service.archive(state, preview),
			),
		);
	const listArchives = () =>
		run(Effect.flatMap(FeatureArchive, (service) => service.list()));
	const recoverArchive = (featureId: string) =>
		run(
			Effect.flatMap(FeatureArchive, (service) => service.recover(featureId)),
		);

	function requireId(value: string): string {
		const normalized = normalizeFeatureId(value);
		if (Either.isLeft(normalized)) throw new Error(normalized.left.message);
		return normalized.right;
	}

	// ─── UI ────────────────────────────────────────────────────────────────────

	function activeRun(state: FeatureState) {
		return [...state.sessions]
			.reverse()
			.find(
				(session) => session.kind === "subagent" && session.endedAt === null,
			);
	}

	function updateUi(ctx: ExtensionContext, state?: FeatureState): void {
		if (!ctx.hasUI) return;
		if (!state) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(STATUS_KEY, undefined);
			return;
		}
		const gate =
			state.checkpoint.status === "pending"
				? ` · gate:${state.checkpoint.kind}`
				: "";
		const running = activeRun(state);
		const lines = [
			`${ctx.ui.theme.fg("accent", "Feature")} ${compactText(state.title, 96)}`,
			`${ctx.ui.theme.fg("muted", "Stage")} ${state.activeStage}  ${ctx.ui.theme.fg("muted", "Status")} ${state.status}  ${ctx.ui.theme.fg("muted", "Rev")} ${state.revision}`,
		];
		if (running) {
			const elapsed = Math.max(
				0,
				Math.floor((Date.now() - Date.parse(running.startedAt)) / 60_000),
			);
			lines.push(
				`⏳ ${running.stage} running · ${running.runId ?? "unknown"} · ${elapsed}m`,
			);
		}
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg(
				"accent",
				`◆ ${state.featureId}:${state.activeStage}${gate}`,
			),
		);
		ctx.ui.setWidget(STATUS_KEY, lines, { placement: "belowEditor" });
	}

	function clearProgressTicker(): void {
		if (progressTimer) clearInterval(progressTimer);
		progressTimer = null;
	}

	function startProgressTicker(
		ctx: ExtensionContext,
		state: FeatureState,
	): void {
		if (!ctx.hasUI || !activeRun(state)) {
			clearProgressTicker();
			return;
		}
		updateUi(ctx, state);
		if (progressTimer) return;
		progressTimer = setInterval(() => {
			void (async () => {
				if (!activeFeatureId || !currentContext?.hasUI) {
					clearProgressTicker();
					return;
				}
				const current = await loadFeature(activeFeatureId);
				if (!activeRun(current)) {
					clearProgressTicker();
					updateUi(currentContext, current);
					return;
				}
				updateUi(currentContext, current);
			})().catch(() => clearProgressTicker());
		}, 30_000);
		progressTimer.unref?.();
	}

	// ─── Session binding ───────────────────────────────────────────────────────

	function restorePointer(ctx: ExtensionContext): string | null {
		const entries = ctx.sessionManager.getBranch();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index] as {
				type?: string;
				customType?: string;
				data?: { featureId?: string };
			};
			if (
				entry.type === "custom" &&
				entry.customType === POINTER_TYPE &&
				entry.data?.featureId
			) {
				const normalized = normalizeFeatureId(entry.data.featureId);
				return Either.isRight(normalized) ? normalized.right : null;
			}
		}
		return null;
	}

	async function bindPiSession(
		featureId: string,
		stage: FeatureStage | "direct",
		ctx: ExtensionContext,
	): Promise<void> {
		const sessionId = ctx.sessionManager.getSessionId() ?? null;
		const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		const state = await loadFeature(featureId);
		const existing = state.sessions.some(
			(session) =>
				session.kind === "pi" &&
				session.sessionId === sessionId &&
				session.stage === stage &&
				!session.endedAt,
		);
		if (existing) return;
		const now = new Date().toISOString();
		await run(
			Effect.flatMap(FeatureStore, (store) =>
				store.update(featureId, (draft) => {
					for (const session of draft.sessions) {
						if (
							session.kind === "pi" &&
							session.sessionId === sessionId &&
							!session.endedAt
						) {
							session.endedAt = now;
							session.endReason = "stage-change";
						}
					}
					draft.sessions.push({
						kind: "pi",
						sessionId,
						sessionFile,
						transcriptPath: null,
						cwd: ctx.cwd,
						stage,
						role: "main",
						runId: null,
						asyncDir: null,
						startedAt: now,
						endedAt: null,
						endReason: null,
						parentSessionId:
							ctx.sessionManager.getHeader()?.parentSession ?? null,
					});
				}),
			),
		);
		await appendLedger(featureId, {
			type: "session.started",
			sessionId,
			sessionFile,
			stage,
			cwd: ctx.cwd,
		});
	}

	async function setActive(
		featureId: string,
		ctx: ExtensionContext,
	): Promise<FeatureState> {
		const state = await loadFeature(featureId);
		activeFeatureId = state.featureId;
		pi.appendEntry(POINTER_TYPE, {
			featureId: state.featureId,
			featureRoot: featureDir(state.featureId),
			revision: state.revision,
		});
		pi.setSessionName(`feature:${state.featureId}`);
		updateUi(ctx, state);
		await bindPiSession(state.featureId, state.activeStage, ctx);
		return state;
	}

	// ─── Turn snapshot (config-driven; compact by default) ─────────────────────

	async function turnSnapshot(
		featureId: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const config = await getConfig();
		if (config.turnSnapshot === "off") return;
		const branch = ctx.sessionManager.getBranch();
		const leafId = ctx.sessionManager.getLeafId();
		const status = await pi.exec("git", ["status", "--porcelain"], {
			timeout: 5000,
		});
		const head = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
		const changedFiles =
			status.code === 0
				? status.stdout
						.split("\n")
						.filter(Boolean)
						.map((line) => line.slice(3))
				: [];
		await run(
			Effect.flatMap(FeatureStore, (store) =>
				store.update(featureId, (draft) => {
					draft.lastKnownGit = {
						cwd: ctx.cwd,
						head: head.code === 0 ? head.stdout.trim() : null,
						dirty: changedFiles.length > 0,
						changedFiles,
					};
				}),
			),
		);
		const event: Record<string, unknown> = {
			type: "turn.settled",
			leafId: leafId ?? null,
			sessionId: ctx.sessionManager.getSessionId() ?? null,
			changedFiles,
		};
		if (config.turnSnapshot === "full") {
			const messages = branch.filter(
				(entry) => entry.type === "message" && "message" in entry,
			) as Array<{
				type: "message";
				message: { role: string; content: unknown };
			}>;
			const lastUser = [...messages]
				.reverse()
				.find((entry) => entry.message.role === "user");
			const lastAssistant = [...messages]
				.reverse()
				.find((entry) => entry.message.role === "assistant");
			event.userExcerpt = lastUser
				? textContent(lastUser.message.content).slice(0, 1500)
				: null;
			event.assistantExcerpt = lastAssistant
				? textContent(lastAssistant.message.content).slice(0, 2000)
				: null;
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
		const gitStatus = await pi.exec("git", ["status", "--short"], {
			timeout: 5000,
			cwd: state.project.cwd,
		});
		const gitLog = await pi.exec("git", ["log", "-5", "--oneline"], {
			timeout: 5000,
			cwd: state.project.cwd,
		});
		return `${composeContinuationContext(state, artifacts, { status: gitStatus.stdout.trim(), log: gitLog.stdout.trim() })}\n- Feature root: \`${featureDir(featureId)}\`\n`;
	}

	async function createHandoffSession(
		state: FeatureState,
		ctx: ExtensionCommandContext,
		task: string,
	): Promise<void> {
		const handoff = await buildContinuationContext(state.featureId);
		let rootSessionFile: string | null = null;
		for (const session of state.sessions) {
			if (
				session.kind === "pi" &&
				session.sessionFile &&
				(await pathExists(session.sessionFile))
			) {
				rootSessionFile = session.sessionFile;
				break;
			}
		}
		const parentSession =
			rootSessionFile ?? ctx.sessionManager.getSessionFile();
		const manager = SessionManager.create(state.project.cwd, undefined, {
			parentSession: parentSession ?? undefined,
		});
		manager.appendCustomEntry(POINTER_TYPE, {
			featureId: state.featureId,
			featureRoot: featureDir(state.featureId),
			revision: state.revision,
		});
		manager.appendCustomMessageEntry("feature-handoff", handoff, false, {
			featureId: state.featureId,
		});
		const handoffNumber =
			1 + state.sessions.filter((session) => session.kind === "pi").length;
		manager.appendSessionInfo(
			`feature:${state.featureId} · handoff ${handoffNumber}`,
		);
		const sessionFile = manager.getSessionFile();
		const header = manager.getHeader();
		if (!sessionFile || !header)
			throw new Error(
				`Could not create a fresh handoff session for ${state.featureId}.`,
			);
		await writeFile(
			sessionFile,
			[header, ...manager.getEntries()]
				.map((entry) => JSON.stringify(entry))
				.join("\n") + "\n",
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		);
		await ctx.switchSession(sessionFile, {
			withSession: async (replacement) => {
				replacement.ui.setEditorText(task);
				replacement.ui.notify(
					`Fresh handoff session ready for ${namingPrefix(state)}.`,
					"info",
				);
			},
		});
	}

	async function showFeatureSelector(
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const states = await listFeatures();
		if (states.length === 0) {
			ctx.ui.notify(
				"No features recorded. Run /feature new to create one.",
				"info",
			);
			return;
		}
		const choices = states.map(
			(state) =>
				`${namingPrefix(state)} · ${state.status}/${state.activeStage} · ${compactText(state.title, 64)} · ${state.project.cwd}`,
		);
		const selected = await ctx.ui.select(
			"Features — select one for a fresh handoff",
			choices,
		);
		if (!selected) return;
		const state = states[choices.indexOf(selected)];
		if (!state) return;
		await createHandoffSession(
			state,
			ctx,
			`Continue work on ${namingPrefix(state)}.\n\n`,
		);
	}

	async function selectLocalFeature(
		ctx: ExtensionCommandContext,
		title: string,
	): Promise<FeatureState | null> {
		const states = await listFeatures();
		if (states.length === 0) {
			ctx.ui.notify("No local features are available.", "info");
			return null;
		}
		const choices = states.map(
			(state) =>
				`${namingPrefix(state)} · ${state.status}/${state.activeStage} · ${compactText(state.title, 64)}`,
		);
		const selected = await ctx.ui.select(title, choices);
		return selected ? (states[choices.indexOf(selected)] ?? null) : null;
	}

	async function archiveFeature(
		state: FeatureState,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		ctx.ui.notify(
			`Inspecting local resources for ${namingPrefix(state)}…`,
			"info",
		);
		const preview = await previewArchive(state);
		const cleanup = [
			`${preview.worktrees.length} Git checkout(s) and ${preview.branches.length} local branch(es)`,
			`${preview.containers.length} related Docker container(s)`,
			`${preview.files.length} context file(s), including feature memory, plans, sessions, scripts, and artifacts`,
		].join("\n");
		const targets = [
			...preview.worktrees.map((worktree) => `worktree: ${worktree.path}`),
			...preview.containers.map((container) => `container: ${container.name}`),
			...preview.files
				.filter((file) => file.kind === "support")
				.map((file) => `support: ${file.originalPath}`),
		];
		const visibleTargets = targets.slice(0, 12);
		let targetSummary = "";
		if (visibleTargets.length > 0) {
			const overflow =
				targets.length > visibleTargets.length
					? `\n- …and ${targets.length - visibleTargets.length} more`
					: "";
			targetSummary = `\n\nCleanup targets:\n${visibleTargets.map((target) => `- ${target}`).join("\n")}${overflow}`;
		}
		const confirmed = await ctx.ui.confirm(
			`Archive ${namingPrefix(state)} to the private GitHub archive repository?`,
			`${cleanup}${targetSummary}\n\nCode and database/container state are not archived. Cleanup starts only after the remote push is verified.`,
		);
		if (!confirmed) return;
		const currentSessionFile = ctx.sessionManager.getSessionFile();
		const currentSessionWillBeRemoved = Boolean(
			currentSessionFile &&
				preview.files.some((file) => file.originalPath === currentSessionFile),
		);
		const result = await createArchive(state, preview);
		if (result.localFeatureRemoved && activeFeatureId === state.featureId) {
			activeFeatureId = null;
			updateUi(ctx);
		}
		const warningText =
			result.warnings.length > 0
				? `\nCleanup warnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}`
				: "";
		ctx.ui.notify(
			`Archived ${namingPrefix(state)}: ${result.url}${warningText}`,
			result.warnings.length > 0 ? "warning" : "info",
		);
		if (currentSessionWillBeRemoved) ctx.shutdown();
	}

	function archiveChoice(summary: ArchiveSummary): string {
		return `${summary.workItem} · ${summary.createdAt.slice(0, 10)} · ${compactText(summary.title, 72)}`;
	}

	async function recoverFeature(
		featureId: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const result = await recoverArchive(featureId);
		const state = await loadFeature(result.featureId);
		ctx.ui.notify(
			`Recovered ${namingPrefix(state)} (${result.restoredFiles} files restored, ${result.skippedFiles} already present). Runtime containers and code checkouts are intentionally not recreated.`,
			"info",
		);
		if (await pathExists(state.project.cwd)) {
			await createHandoffSession(
				state,
				ctx,
				`Continue work on recovered feature ${namingPrefix(state)}. Read the restored memory and artifacts, then inspect the remote implementation history if code context is needed.\n\n`,
			);
			return;
		}
		await setActive(state.featureId, ctx);
		ctx.ui.notify(
			`The original project path no longer exists: ${state.project.cwd}. The feature is restored and visible in /feature, but no handoff session was created.`,
			"warning",
		);
	}

	async function showArchiveSelector(
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const archives = await listArchives();
		if (archives.length === 0) {
			ctx.ui.notify(
				"No remote feature archives are available for the active GitHub account.",
				"info",
			);
			return;
		}
		const choices = archives.map(archiveChoice);
		const selected = await ctx.ui.select(
			"Private feature archives — select one to recover",
			choices,
		);
		if (!selected) return;
		const archive = archives[choices.indexOf(selected)];
		if (archive) await recoverFeature(archive.featureId, ctx);
	}

	// ─── Stage operations ──────────────────────────────────────────────────────

	async function beginIntegratedPlanning(
		featureId: string,
		ctx: ExtensionContext,
	): Promise<string> {
		const state = await loadFeature(featureId);
		await run(
			Effect.flatMap(FeatureStore, (store) =>
				store.update(featureId, (draft) => {
					draft.activeStage = "planning";
					draft.status = "planning";
					draft.checkpoint = {
						kind: "none",
						status: "none",
						updatedAt: new Date().toISOString(),
					};
				}),
			),
		);
		await bindPiSession(featureId, "planning", ctx);
		return planningKickoff(state);
	}

	async function confirmFableSubagent(
		ctx: ExtensionContext,
		purpose: string,
		model: string,
	): Promise<boolean> {
		if (!/fable/i.test(model)) return true;
		if (!ctx.hasUI)
			throw new Error(
				`The ${purpose} requires explicit Fable approval in an interactive Pi session.`,
			);
		return ctx.ui.confirm(
			"Run a Fable subagent?",
			`This run will use ${model} for ${purpose}. Approval applies only to this run.`,
		);
	}

	async function spawnStage(
		featureId: string,
		stage: RunStage,
		task: string,
		ctx: ExtensionContext | null,
		workerKind: WorkerKind = "sol",
		packages?: readonly string[],
		fableApproved = false,
	): Promise<void> {
		const config = await getConfig();
		let route = adversaryRoute(config, ctx?.model);
		if (stage === "implementation") route = workerRoute(config, workerKind);
		else if (stage === "validation") route = config.routes.validator;
		if (/fable/i.test(route.model) && !fableApproved) {
			if (!ctx)
				throw new Error(
					`A Fable ${stage} run requires explicit approval in an interactive Pi session.`,
				);
			if (!(await confirmFableSubagent(ctx, `feature ${stage}`, route.model))) {
				throw new Error(`Fable approval was not granted for feature ${stage}.`);
			}
		}
		const result = await run(
			Effect.flatMap(Workflow, (workflow) =>
				workflow.spawnStage(featureId, stage, task, {
					cwd: ctx?.cwd ?? null,
					parentSessionId: ctx?.sessionManager.getSessionId() ?? null,
					workerKind,
					packages,
					adversaryRouteOverride: stage === "adversary" ? route : undefined,
				}),
			),
		);
		if (ctx) {
			ctx.ui.notify(
				`Started ${stage}${result.runId ? ` (${result.runId})` : ""}`,
				"info",
			);
			startProgressTicker(ctx, result.state);
		}
	}

	async function startAdversary(
		featureId: string,
		ctx: ExtensionContext,
	): Promise<{ started: boolean; model: string; usedFallback: boolean }> {
		const config = await getConfig();
		const route = adversaryRoute(config, ctx.model);
		const usedFallback = isFableFiveModel(ctx.model);
		if (
			!(await confirmFableSubagent(ctx, "adversarial plan review", route.model))
		) {
			ctx.ui.notify(
				"Adversarial review skipped because Fable approval was declined.",
				"info",
			);
			return { started: false, model: route.model, usedFallback };
		}
		const state = await loadFeature(featureId);
		const revision = state.planArtifact?.planRevision;
		if (revision === undefined)
			throw new Error("Publish the plan before starting adversarial review.");
		await spawnStage(
			featureId,
			"adversary",
			`Adversarially review published plan revision ${revision} against the repository; return prioritized, evidence-backed findings.`,
			ctx,
			"sol",
			undefined,
			true,
		);
		return { started: true, model: route.model, usedFallback };
	}

	async function runPlanStage(
		featureId: string,
		planMarkdown: string | null,
		ctx: ExtensionContext,
	): Promise<{
		url: string;
		adversaryStarted: boolean;
		adversaryModel: string;
		usedAdversaryFallback: boolean;
		revision: number;
	}> {
		ctx.ui.notify("Publishing the main-agent plan to Tailscale…", "info");
		const url = await run(
			Effect.flatMap(Workflow, (workflow) =>
				workflow.publishPlan(featureId, planMarkdown),
			),
		);
		await appendArtifact(
			featureId,
			"threadLog",
			"Plan published",
			`- Artifact: ${url}`,
			"extension",
		);
		ctx.ui.notify(`Review the HTML plan: ${url}`, "info");
		const published = await loadFeature(featureId);
		pi.appendEntry(PLAN_READY_TYPE, {
			featureId,
			title: published.title,
			url,
			revision: published.planArtifact?.planRevision ?? 0,
		});
		updateUi(ctx, published);
		const adversary = await startAdversary(featureId, ctx);
		return {
			url,
			adversaryStarted: adversary.started,
			adversaryModel: adversary.model,
			usedAdversaryFallback: adversary.usedFallback,
			revision: published.planArtifact?.planRevision ?? 0,
		};
	}

	async function runReview(
		featureId: string,
		ctx: ExtensionContext,
	): Promise<string> {
		const review = await startAdversary(featureId, ctx);
		return review.started
			? `Adversarial review started with ${review.model}${review.usedFallback ? " (Sol-high fallback because Fable 5 authored the plan)" : ""}.`
			: "Adversarial review skipped.";
	}

	async function decideCheckpoint(
		featureId: string,
		decision: "approve" | "reject",
		note: string,
		ctx: ExtensionCommandContext | ExtensionContext,
		workerKind: WorkerKind = "sol",
		packages?: readonly string[],
	): Promise<void> {
		const state = await loadFeature(featureId);
		const confirmed = await ctx.ui.confirm(
			`${decision === "approve" ? "Approve" : "Reject"} ${state.checkpoint.kind} checkpoint?`,
			note || `${state.title} · ${state.activeStage}`,
		);
		if (!confirmed) return;
		const updated = await run(
			Effect.flatMap(Workflow, (workflow) =>
				workflow.decideCheckpoint(
					featureId,
					decision,
					note,
					ctx.sessionManager.getSessionId() ?? null,
				),
			),
		);
		if (decision === "approve" && updated.checkpoint.kind === "plan") {
			updateUi(ctx, updated);
			await spawnStage(
				featureId,
				"implementation",
				"Implement the complete approved plan; validation will start automatically afterward.",
				ctx,
				workerKind,
				packages,
			);
			return;
		}
		updateUi(ctx, await loadFeature(featureId));
	}

	function statusText(state: FeatureState): string {
		const subagents = state.sessions.filter(
			(session) => session.kind === "subagent",
		);
		const run =
			[...subagents].reverse().find((session) => !session.endedAt) ??
			subagents.at(-1);
		return [
			`${state.title} · ${namingPrefix(state)}`,
			`${state.status} · ${state.activeStage} · ${state.checkpoint.kind}/${state.checkpoint.status}`,
			`plan: ${state.planArtifact?.url ?? "not published"}`,
			run
				? `run: ${run.stage} · ${run.runId ?? "unknown"} · ${run.endedAt ? (run.endReason ?? "ended") : "running"}`
				: "run: none",
			...(state.lastError ? [`error: ${state.lastError}`] : []),
		].join("\n");
	}

	async function showStatus(
		featureId: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const state = await loadFeature(featureId);
		updateUi(ctx, state);
		ctx.ui.notify(statusText(state), "info");
	}

	// ─── /feature command ──────────────────────────────────────────────────────

	async function queueFeatureRequest(request: string): Promise<void> {
		pendingFeatureRequest = request;
		pi.sendMessage(
			{
				customType: "feature-start-request",
				content: featureStartRequest(),
				display: false,
			},
			{ deliverAs: "nextTurn" },
		);
		pi.sendUserMessage(request);
	}

	async function handleFeature(
		rawArgs: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const args = splitArgs(rawArgs);
		if (args.length === 0) return showFeatureSelector(ctx);
		const command = args.shift()!.toLowerCase();
		if (command === "new") {
			if (args.length > 0)
				throw new Error(
					"/feature new does not accept parameters. Run it by itself and enter the request in the editor.",
				);
			const request = await ctx.ui.editor("Describe the feature request", "");
			if (!request?.trim()) return;
			await queueFeatureRequest(request.trim());
			return;
		}
		if (command === "recover") {
			if (args.length === 0) return showArchiveSelector(ctx);
			if (args.length > 1) throw new Error("Usage: /feature recover [id]");
			return recoverFeature(requireId(args[0]!), ctx);
		}
		if (command === "archive") {
			if (args.length > 1) throw new Error("Usage: /feature archive [id]");
			const selected = args[0]
				? await loadFeature(requireId(args[0]))
				: activeFeatureId
					? await loadFeature(activeFeatureId)
					: await selectLocalFeature(
							ctx,
							"Features — select one to archive and clean up",
						);
			if (selected) await archiveFeature(selected, ctx);
			return;
		}
		if (command === "resume") {
			if (args.length > 1) throw new Error("Usage: /feature resume [id]");
			const requestedId = args[0] ?? activeFeatureId;
			if (!requestedId)
				throw new Error(
					"No active feature. Use /feature resume <id> or /feature new.",
				);
			const state = await loadFeature(requireId(requestedId));
			await createHandoffSession(
				state,
				ctx,
				`Continue work on ${namingPrefix(state)}.\n\n`,
			);
			return;
		}
		if (command === "status") {
			if (args.length > 1) throw new Error("Usage: /feature status [id]");
			const requestedId = args[0] ?? activeFeatureId;
			if (!requestedId)
				throw new Error(
					"No active feature. Use /feature status <id> or /feature new.",
				);
			return showStatus(requireId(requestedId), ctx);
		}
		if (command === "unlock") {
			if (args.length > 0) throw new Error("Usage: /feature unlock");
			if (!activeFeatureId) throw new Error("No active feature.");
			const current = await setActive(activeFeatureId, ctx);
			if (!current.executionLease)
				throw new Error("No execution reservation is present.");
			const confirmed = await ctx.ui.confirm(
				"Clear execution reservation?",
				`Only continue after checking that no worker is live. Reservation: ${current.executionLease.stage} ${current.executionLease.token}`,
			);
			if (!confirmed) return;
			await run(
				Effect.flatMap(FeatureStore, (store) =>
					store.releaseExecution(
						current.featureId,
						current.executionLease!.token,
						true,
					),
				),
			);
			await appendLedger(current.featureId, {
				type: "execution.unlocked",
				token: current.executionLease.token,
				stage: current.executionLease.stage,
			});
			updateUi(ctx, await loadFeature(current.featureId));
			return;
		}
		throw new Error(
			"Usage: /feature (selector) or /feature <new|resume|status|unlock|archive|recover>",
		);
	}

	pi.registerCommand("feature", {
		description:
			"Open the feature selector, create a feature request, or use recovery controls",
		getArgumentCompletions: (prefix) =>
			["new", "resume", "status", "unlock", "archive", "recover"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			try {
				await handleFeature(args, ctx);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});

	// ─── Tools ─────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "feature_workflow",
		label: "Feature Workflow",
		description:
			"Opt-in agent-facing controller for a feature workflow the user explicitly requested. After one explicit trigger, advance stages autonomously; slash commands are optional recovery controls.",
		promptSnippet:
			"Run the feature workflow only after the user explicitly triggers it; never activate it based on task size alone",
		promptGuidelines: WORKFLOW_GUIDELINES,
		parameters: Type.Object({
			action: StringEnum([
				"start",
				"plan",
				"request_approval",
				"reject",
				"implement",
				"validate",
				"review",
				"status",
			] as const),
			workItem: Type.Optional(Type.String()),
			title: Type.Optional(
				Type.String({
					description:
						"Concise descriptive display title, at most 96 characters; never copy the complete request",
				}),
			),
			package: Type.Optional(Type.String()),
			plan: Type.Optional(
				Type.String({
					description: "Complete plan Markdown authored by the main agent",
				}),
			),
			packages: Type.Optional(
				Type.Array(
					Type.String({
						description:
							"A [parallel-safe] work package to run in an isolated worktree",
					}),
				),
			),
			note: Type.Optional(Type.String()),
			worker: Type.Optional(
				StringEnum(["sol", "fable"] as const, {
					description:
						"Implementation worker. Defaults to sol; choose fable only when the user explicitly requests it.",
				}),
			),
		}),
		executionMode: "sequential",
		renderShell: "self",
		renderCall(args, _theme, options) {
			const feature = activeFeatureId ?? args.workItem ?? "active";
			const value = options.expanded
				? `feature_workflow ${args.action} · ${feature}\n${JSON.stringify(args, null, 2)}`
				: `feature_workflow ${args.action} · ${feature}`;
			return new Text(value, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial)
				return new Text(theme.fg("warning", "feature_workflow running…"), 0, 0);
			const full = textContent(result.content);
			const details = result.details as
				| { summary?: string; url?: string }
				| undefined;
			const collapsed = details?.url
				? `✓ HTML plan ready for review\n${details.url}\nReview it, then approve or reject.`
				: `✓ ${details?.summary ?? compactText(full, 120)}`;
			return new Text(expanded ? full : theme.fg("success", collapsed), 0, 0);
		},
		async execute(_id, params, _signal, _update, ctx) {
			if (params.action === "start") {
				if (!params.workItem)
					throw new Error(
						"workItem is required: Jira key, PR, or stable feature name.",
					);
				const state = await run(
					Effect.flatMap(FeatureStore, (store) =>
						store.create(
							params.workItem!,
							params.title || params.workItem!,
							ctx.cwd,
						),
					),
				);
				const initialRequest = pendingFeatureRequest;
				pendingFeatureRequest = null;
				await setActive(state.featureId, ctx);
				if (initialRequest)
					await appendArtifact(
						state.featureId,
						"assumptions",
						"Initial developer request",
						initialRequest,
						"user-via-feature-new",
					);
				await appendArtifact(
					state.featureId,
					"decisions",
					"Required Git and PR naming",
					`Canonical work item: \`${namingPrefix(state)}\`. Branches start \`${namingPrefix(state)}-\`; commits and PR titles start \`${namingPrefix(state)} \`.`,
					"extension",
				);
				const kickoff = await beginIntegratedPlanning(state.featureId, ctx);
				return {
					content: [
						{
							type: "text",
							text: `Started integrated planning for ${namingPrefix(state)}. Continue planning in this turn; no follow-up prompt was queued.\n\n${kickoff}`,
						},
					],
					details: { featureId: state.featureId },
				};
			}
			if (!activeFeatureId)
				throw new Error("No active feature. Start one with action=start.");
			const featureId = activeFeatureId;
			if (params.action === "plan") {
				const published = await runPlanStage(
					featureId,
					params.plan ?? null,
					ctx,
				);
				const reviewNote = published.adversaryStarted
					? `The adversarial review is running with ${published.adversaryModel}${published.usedAdversaryFallback ? " (Sol high selected automatically because Fable 5 authored the plan)" : ""}; surface its findings when they arrive.`
					: "The adversarial review was skipped because Fable approval was declined.";
				return {
					content: [
						{
							type: "text",
							text: `HTML plan published for human review: ${published.url}\n${reviewNote} Stop now and wait for the developer to review the plan. The plan checkpoint remains pending.`,
						},
					],
					details: {
						featureId,
						url: published.url,
						revision: published.revision,
						adversaryModel: published.adversaryModel,
						usedAdversaryFallback: published.usedAdversaryFallback,
						summary: `HTML plan published rev ${published.revision}`,
					},
					terminate: true,
				};
			}
			if (params.action === "request_approval" || params.action === "reject") {
				await decideCheckpoint(
					featureId,
					params.action === "reject" ? "reject" : "approve",
					params.note || "",
					ctx as ExtensionCommandContext,
					params.action === "request_approval"
						? (params.worker ?? "sol")
						: "sol",
					params.action === "request_approval" ? params.packages : undefined,
				);
				const state = await loadFeature(featureId);
				return {
					content: [
						{
							type: "text",
							text: `Human checkpoint result: ${state.checkpoint.kind}/${state.checkpoint.status}.`,
						},
					],
					details: { featureId, checkpoint: state.checkpoint },
				};
			}
			if (params.action === "implement") {
				const workerKind = params.worker ?? "sol";
				await spawnStage(
					featureId,
					"implementation",
					params.package || "Implement the complete approved plan.",
					ctx,
					workerKind,
					params.packages,
				);
				return {
					content: [
						{
							type: "text",
							text: `${workerKind === "fable" ? "Fable" : "Sol"} implementation worker started${params.packages && params.packages.length >= 2 ? ` across ${params.packages.length} isolated worktrees` : " for the complete approved plan"}; validation will follow automatically.`,
						},
					],
					details: { featureId, workerKind, summary: "implementation started" },
				};
			}
			if (params.action === "validate") {
				await spawnStage(
					featureId,
					"validation",
					params.note || "Validate the actual diff.",
					ctx,
				);
				return {
					content: [{ type: "text", text: "Fresh validation worker started." }],
					details: { featureId },
				};
			}
			if (params.action === "review") {
				const review = await runReview(featureId, ctx);
				return {
					content: [{ type: "text", text: review }],
					details: { featureId, summary: review },
				};
			}
			const state = await loadFeature(featureId);
			return {
				content: [{ type: "text", text: statusText(state) }],
				details: {
					featureId,
					revision: state.revision,
					summary: `${state.status}/${state.activeStage}`,
				},
			};
		},
	});

	pi.registerTool({
		name: "feature_memory",
		label: "Feature Memory",
		description:
			"Read or append the minimal durable feature memory: assumptions, architectural decisions, the plan, and thread activity. Git and the PR remain implementation evidence.",
		promptSnippet:
			"Read and append only important assumptions, decisions, plans, or thread context",
		promptGuidelines: MEMORY_GUIDELINES,
		parameters: Type.Object({
			action: StringEnum(["read", "append"] as const),
			featureId: Type.Optional(Type.String()),
			artifact: Type.Optional(
				StringEnum([...ARTIFACT_NAMES] as unknown as string[]),
			),
			heading: Type.Optional(Type.String()),
			content: Type.Optional(Type.String()),
		}),
		executionMode: "sequential",
		renderShell: "self",
		renderCall(args, _theme, options) {
			const feature = args.featureId ?? activeFeatureId ?? "active";
			const value = options.expanded
				? `feature_memory ${args.action} · ${feature}\n${JSON.stringify(args, null, 2)}`
				: `feature_memory ${args.action} · ${feature}`;
			return new Text(value, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial)
				return new Text(theme.fg("warning", "feature_memory running…"), 0, 0);
			const full = textContent(result.content);
			const details = result.details as { summary?: string } | undefined;
			return new Text(
				expanded
					? full
					: theme.fg(
							"success",
							`✓ ${details?.summary ?? compactText(full, 120)}`,
						),
				0,
				0,
			);
		},
		async execute(_id, params, _signal, _update, ctx) {
			const featureId = requireId(params.featureId || activeFeatureId || "");
			if (params.action === "read") {
				if (!params.artifact) throw new Error("artifact is required for read.");
				const content = await readArtifact(
					featureId,
					params.artifact as ArtifactName,
				);
				return {
					content: [{ type: "text", text: content.slice(0, 50_000) }],
					details: {
						featureId,
						artifact: params.artifact,
						summary: `${params.artifact} read`,
					},
				};
			}
			if (params.action === "append") {
				if (!params.artifact || !params.content)
					throw new Error("artifact and content are required for append.");
				if (params.artifact === "plan")
					throw new Error(
						"plan.md is main-agent-owned and cannot be appended. Call feature_workflow plan with the complete Markdown instead.",
					);
				await appendArtifact(
					featureId,
					params.artifact as ArtifactName,
					params.heading || "Update",
					params.content,
					"main-agent",
				);
				await appendLedger(featureId, {
					type: "artifact.appended",
					artifact: params.artifact,
					heading: params.heading || "Update",
					piSessionId: ctx.sessionManager.getSessionId() ?? null,
				});
				return {
					content: [
						{
							type: "text",
							text: `Appended ${params.artifact} for ${featureId}.`,
						},
					],
					details: {
						featureId,
						artifact: params.artifact,
						summary: `${params.artifact} appended`,
					},
				};
			}
			throw new Error(
				`Unsupported feature_memory action: ${String(params.action)}`,
			);
		},
	});

	// ─── Hooks ─────────────────────────────────────────────────────────────────

	pi.on("before_agent_start", async () => {
		if (!activeFeatureId) return;
		try {
			const state = await loadFeature(activeFeatureId);
			return {
				message: {
					customType: "feature-flow-context",
					content: turnContext(state),
					display: false,
				},
			};
		} catch {
			return;
		}
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
			const branchResult = await pi.exec("git", ["branch", "--show-current"], {
				timeout: 5000,
			});
			const currentBranch =
				branchResult.code === 0 ? branchResult.stdout.trim() : "";
			if (currentBranch && !currentBranch.startsWith(`${prefix}-`)) {
				return {
					block: true,
					reason: `Active work item ${prefix}: current branch '${currentBranch}' is not linked. Create or rename it to '${prefix}-short-kebab-description' before committing.`,
				};
			}
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (
			!activeFeatureId ||
			event.toolName !== "ask_user_question" ||
			event.isError
		)
			return;
		const details = event.details as
			| {
					cancelled?: boolean;
					answers?: Array<{
						question: string;
						kind: "option" | "custom" | "chat" | "multi";
						answer: string | null;
						selected?: string[];
						notes?: string;
					}>;
			  }
			| undefined;
		if (!details || details.cancelled || !details.answers?.length) return;
		const lines = details.answers
			.map((answer) => {
				const response =
					answer.kind === "multi" ? answer.selected?.join(", ") : answer.answer;
				const notes = answer.notes ? `\n  - Notes: ${answer.notes}` : "";
				return `- **${answer.question}**\n  - ${response || "No answer"}${notes}`;
			})
			.join("\n");
		await appendArtifact(
			activeFeatureId,
			"assumptions",
			"Raw interview answers",
			lines,
			"user-via-ask_user_question",
		);
		await appendLedger(activeFeatureId, {
			type: "questions.answered",
			toolCallId: event.toolCallId,
			piSessionId: ctx.sessionManager.getSessionId() ?? null,
		});
	});

	pi.events.on(ASYNC_COMPLETE_EVENT, (raw) => {
		void (async () => {
			const event = raw as {
				runId?: string;
				id?: string;
				asyncDir?: string;
				results?: Array<{
					sessionPath?: string;
					transcriptPath?: string;
					status?: string;
					agent?: string;
					summary?: string;
				}>;
			};
			const runId = event.runId || event.id;
			if (!runId || processedRunIds.has(runId)) return;
			processedRunIds.add(runId);
			const results = event.results ?? [];
			const result =
				results.length <= 1
					? results[0]
					: {
							...results[0],
							status: results.every((item) =>
								["complete", "completed"].includes(item.status ?? ""),
							)
								? "completed"
								: (results.find(
										(item) =>
											!["complete", "completed"].includes(item.status ?? ""),
									)?.status ?? "failed"),
							summary: results
								.map(
									(item, index) =>
										`Package ${index + 1}: ${item.summary?.trim() || item.status || "unknown"}`,
								)
								.join("\n\n"),
						};
			const completion = await run(
				Effect.flatMap(Workflow, (workflow) =>
					workflow.completeRun(runId, result, event.asyncDir ?? null),
				),
			);
			if (!completion) {
				processedRunIds.delete(runId);
				return;
			}
			if (completion.stage === "review" && completion.summary) {
				await appendArtifact(
					completion.featureId,
					"threadLog",
					"Adversary findings",
					completion.summary,
					"feature-adversary",
				);
				if (currentContext && activeFeatureId === completion.featureId) {
					currentContext.ui.notify(
						"Adversarial review finished — findings recorded.",
						"info",
					);
				}
			} else {
				await appendArtifact(
					completion.featureId,
					"threadLog",
					`${completion.stage} run ${runId}`,
					`- Status: ${completion.succeeded ? "succeeded" : "failed"}${completion.validationPassed !== null ? `\n- Validator verdict: ${completion.validationPassed ? "PASS" : "BLOCKED"}` : ""}${completion.validationPassed === false && completion.summary ? `\n\nValidator report:\n\n${completion.summary}` : ""}\n\nImplementation and validation evidence remains in the actual Git diff/history and child transcript (see ledger.jsonl for paths).`,
					"extension",
				);
			}
			const matchingContext =
				currentContext && activeFeatureId === completion.featureId
					? currentContext
					: null;
			if (completion.autoValidate) {
				// A BLOCKED validation is deliberately NOT auto-fixed here: the main agent
				// reads the recorded validator report and decides on a fix run, so the
				// workflow can never loop implement→validate unsupervised.
				await spawnStage(
					completion.featureId,
					"validation",
					"Automatically validate the complete implementation against the approved plan and actual Git diff.",
					matchingContext,
				);
			}
			if (currentContext && activeFeatureId === completion.featureId) {
				const updated = await loadFeature(completion.featureId);
				if (activeRun(updated)) startProgressTicker(currentContext, updated);
				else {
					clearProgressTicker();
					updateUi(currentContext, updated);
				}
				if (completion.stage !== "review") {
					currentContext.ui.notify(
						updated.status === "complete"
							? "Implementation and validation completed automatically."
							: updated.status === "blocked"
								? updated.lastError || "Workflow blocked."
								: "Automatic next stage started.",
						updated.status === "blocked" ? "warning" : "info",
					);
				}
			}
		})().catch((error) =>
			console.error("feature-flow async completion persistence failed", error),
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		await run(Effect.flatMap(FeatureStore, (store) => store.ensureRoots()));
		activeFeatureId = restorePointer(ctx);
		if (!activeFeatureId) {
			updateUi(ctx);
			return;
		}
		try {
			const state = await loadFeature(activeFeatureId);
			updateUi(ctx, state);
			startProgressTicker(ctx, state);
			await bindPiSession(activeFeatureId, state.activeStage, ctx);
		} catch (error) {
			activeFeatureId = null;
			ctx.ui.notify(
				`Feature pointer could not be restored: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!activeFeatureId) return;
		await turnSnapshot(activeFeatureId, ctx).catch((error) =>
			console.error("feature-flow snapshot failed", error),
		);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		clearProgressTicker();
		currentContext = null;
		pendingFeatureRequest = null;
		if (!activeFeatureId) return;
		const now = new Date().toISOString();
		const sessionId = ctx.sessionManager.getSessionId() ?? null;
		await run(
			Effect.flatMap(FeatureStore, (store) =>
				store.update(activeFeatureId!, (draft) => {
					for (const session of draft.sessions) {
						if (
							session.kind === "pi" &&
							session.sessionId === sessionId &&
							!session.endedAt
						) {
							session.endedAt = now;
							session.endReason = event.reason;
						}
					}
				}),
			),
		).catch(() => undefined);
		await appendLedger(activeFeatureId, {
			type: "session.ended",
			reason: event.reason,
			piSessionId: sessionId,
			targetSessionFile: event.targetSessionFile ?? null,
		}).catch(() => undefined);
	});
}
