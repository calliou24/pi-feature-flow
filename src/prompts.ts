import type { FeatureState, RunStage } from "./domain.ts";
import { namingPrefix } from "./identity.ts";
import { featureDir } from "./store.ts";

/**
 * Prompt policy: persona constraints (scope discipline, code-quality rules,
 * PASS/BLOCKED contract, naming) live once in the agent definitions under
 * `agents/`. Stage prompts carry only the facts the persona cannot know:
 * identity, memory location, revision, and the concrete task.
 */

export function stageFacts(state: FeatureState, stage: string): string {
	return [
		`Work item: ${namingPrefix(state)} (${state.workItem.kind})`,
		`Feature: ${state.featureId} — ${state.title}`,
		`Feature memory: ${featureDir(state.featureId)}`,
		`State revision: ${state.revision}`,
		`Stage: ${stage}`,
	].join("\n");
}

export function stagePrompt(
	state: FeatureState,
	stage: RunStage,
	task: string,
): string {
	return `${stageFacts(state, stage)}\n\nTask: ${task}`;
}

export function stageRole(stage: RunStage): string {
	if (stage === "adversary") return "feature-adversary";
	if (stage === "implementation") return "feature-worker";
	return "feature-validator";
}

export function planningKickoff(state: FeatureState): string {
	return [
		`Continue planning ${namingPrefix(state)} — ${state.title} in the main agent.`,
		"Interview the developer only about meaningful unknowns that can change architecture or acceptance behavior; group independent questions into one ask_user_question call and do not re-ask known facts.",
		"Read assumptions.md, decisions.md, the conversation, relevant ADRs, and repository evidence yourself.",
		"Then author the COMPLETE plan Markdown with headings Goal, Accepted assumptions, Open questions, Non-goals, Architecture, Work packages, Validation, and Risks.",
		"Mark independent work packages that can run concurrently with [parallel-safe].",
		"Call feature_workflow action=plan as the final action of the turn and pass the complete Markdown in the plan parameter.",
		"The tool publishes a rendered HTML plan and ends the turn at the human checkpoint. Wait for the developer to review it; do not request approval in the same turn.",
		"Do not ask the developer to type slash commands.",
	].join(" ");
}

export function featureStartRequest(): string {
	return [
		"The developer explicitly invoked /feature new.",
		"Analyze the next user request, infer the canonical identity in Jira → PR → stable-feature order, and choose a concise descriptive display title of at most 96 characters.",
		"Do not copy the whole request into the title.",
		"Call feature_workflow with action=start, preserving the complete request as planning context.",
		"Ask one identity question only if no identity can be inferred.",
	].join(" ");
}

export function turnContext(state: FeatureState): string {
	const prefix = namingPrefix(state);
	return [
		`ACTIVE WORK ITEM: ${prefix} (${state.workItem.kind})`,
		`FEATURE: ${state.featureId} — ${state.title}`,
		`Stage: ${state.activeStage}; status: ${state.status}; checkpoint: ${state.checkpoint.kind}/${state.checkpoint.status}.`,
		`Naming is mandatory: branches start \`${prefix}-\`; commit messages and PR titles start \`${prefix} \`.`,
		`Memory root: ${featureDir(state.featureId)}`,
		"Read only assumptions.md, decisions.md, plan.md, and relevant thread-log.md excerpts. Git/diff/PR are implementation evidence.",
		"Do not silently change accepted decisions or broaden scope. Use ask_user_question for unresolved user decisions.",
		"Batch diagnostics once after edits; after validator BLOCKED, use its report for a FIX implementation run unless scope changed and requires replanning.",
		"Advance the lifecycle autonomously with feature_workflow; never ask the developer to orchestrate slash commands.",
	].join("\n");
}

export const WORKFLOW_GUIDELINES = [
	"Never call feature_workflow start unless the user explicitly asks to start/use the feature workflow or invokes /feature new. New sessions and ordinary requests stay direct.",
	"Do not infer workflow consent from a Jira key, PR, multiple files, complexity, or risk.",
	"After the explicit trigger, infer the Jira key, PR, or stable feature name and advance the workflow autonomously so the developer does not orchestrate a slash-command chain.",
	"Ask one focused ask_user_question identity question only when the user triggered the workflow but identity cannot be inferred.",
	"The main agent interviews the developer, reads repository evidence, authors the complete plan, and calls action=plan with that Markdown as the final action of the turn. The tool publishes a rendered HTML plan, displays its URL durably, starts a background adversarial review, and ends the turn at the human checkpoint. If the main planner is Fable 5, review automatically routes to Sol high for model diversity; otherwise it uses the configured adversary route. Wait for the developer to review the plan before calling action=request_approval.",
	"Natural-language plan approval still requires action=request_approval so the human sees the TUI confirmation. Never approve the plan yourself.",
	"After plan approval, implementation defaults to Sol low. When approved [parallel-safe] work packages can run concurrently, pass them via packages so one writer runs in each isolated Git worktree.",
	"Validation runs automatically once after implementation. If it returns BLOCKED, start a FIX implementation run from the validator report; replan only when scope actually changed.",
	"When a worker run ends failed or paused, diagnose and report the blocker to the developer instead of blindly respawning.",
	"Batch diagnostics: finish edits, then run one lens_diagnostics mode=all pass and fix all findings at once; never loop LSP checks after each edit.",
];

export const MEMORY_GUIDELINES = [
	"Use feature_memory only for durable assumptions, architectural decisions, plan context, or meaningful thread context. Do not duplicate Git history, diffs, validation output, or change logs.",
];
