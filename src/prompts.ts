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

export function stagePrompt(state: FeatureState, stage: RunStage, task: string): string {
  return `${stageFacts(state, stage)}\n\nTask: ${task}`;
}

export function stageRole(stage: RunStage): string {
  if (stage === "adversary") return "feature-adversary";
  if (stage === "implementation") return "feature-worker";
  return "feature-validator";
}

export function plannerPrompt(state: FeatureState, repositoryCwd: string): string {
  return [
    "You are the feature planner. Use the user conversation captured in assumptions.md, accepted decisions, repository evidence, and relevant ADRs.",
    "Resolve the integration into the smallest coherent architecture and independently verifiable work packages.",
    "Do not edit source files. Avoid speculative abstractions, I/O in loops, scope expansion, and redundant tests.",
    "",
    `Feature: ${state.title} (${namingPrefix(state)})`,
    `Feature memory: ${featureDir(state.featureId)}`,
    `Repository: ${repositoryCwd}`,
    "",
    "Return concise Markdown with headings: Goal, Accepted assumptions, Open questions, Non-goals, Architecture, Work packages, Validation, Risks.",
    "Cite repository paths. Open questions must contain only unresolved blockers; if meaningful unknowns remain, say so rather than inventing answers.",
  ].join("\n");
}

export function oraclePrompt(state: FeatureState): string {
  return `Review architecture consistency for ${state.title}. Read assumptions.md, decisions.md, plan.md, relevant ADRs and repository evidence in ${featureDir(state.featureId)}. Do not edit. Return only evidence-backed blockers and smallest corrections.`;
}

export function planningKickoff(state: FeatureState): string {
  return [
    `Continue the integrated planning workflow for ${namingPrefix(state)} — ${state.title}.`,
    "Read assumptions.md, decisions.md, the existing conversation, and relevant repository context.",
    "Ask only meaningful unknowns that can change the architecture or acceptance behavior. Group independent questions into one ask_user_question call and do not re-ask facts already available.",
    "When blockers are resolved, call feature_workflow with action=plan; the planner will create and publish the review artifact.",
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
    "Advance the lifecycle autonomously with feature_workflow; never ask the developer to orchestrate slash commands.",
  ].join("\n");
}

export const WORKFLOW_GUIDELINES = [
  "Never call feature_workflow start unless the user explicitly asks to start/use the feature workflow or invokes /feature new. New sessions and ordinary requests stay direct.",
  "Do not infer workflow consent from a Jira key, PR, multiple files, complexity, or risk.",
  "After the explicit trigger, infer the Jira key, PR, or stable feature name and advance the workflow autonomously so the developer does not orchestrate a slash-command chain.",
  "Ask one focused ask_user_question identity question only when the user triggered the workflow but identity cannot be inferred.",
  "During planning, ask only meaningful unknowns with ask_user_question. Group independent questions into one invocation. When resolved, call feature_workflow plan; always give the returned plan artifact URL to the user.",
  "Natural-language plan approval still requires action=request_approval so the human sees the TUI confirmation. Never approve the plan yourself.",
  "After plan approval, implementation defaults to the Sol-low worker and fresh validation runs automatically with no package-review or final-accept checkpoints. Select the Fable-low worker only when the user explicitly requests Fable for that run. Surface blockers, but do not ask for routine acceptance.",
];

export const MEMORY_GUIDELINES = [
  "Use feature_memory only for durable assumptions, architectural decisions, plan context, or meaningful thread context. Do not duplicate Git history, diffs, validation output, or change logs.",
];
