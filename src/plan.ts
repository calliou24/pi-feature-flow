import { createHash } from "node:crypto";
import type { Checkpoint, FeatureState, PlanArtifact } from "./domain.ts";

export const ANY_ARTIFACT_URL = /(?:https:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net\/\S+|file:\/\/\S+)/;

export function extractArtifactUrl(value: string): string | null {
  return value.match(ANY_ARTIFACT_URL)?.[0] ?? null;
}

export function markdownRevision(value: string): number | null {
  const match = value.match(/^revision:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

export function planHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function planArtifactProblem(plan: string, artifact: PlanArtifact | null): string | null {
  const revision = markdownRevision(plan);
  if (!artifact || !ANY_ARTIFACT_URL.test(artifact.url)) return "The plan has no published review artifact URL.";
  if (revision === null || artifact.planRevision !== revision || artifact.planHash !== planHash(plan)) {
    return "The plan changed after publication. Republish it before approval.";
  }
  return null;
}

export function implementationProblem(checkpoint: Checkpoint, plan: string, artifact: PlanArtifact | null): string | null {
  if (checkpoint.status !== "approved" || checkpoint.kind !== "plan") return "Implementation requires the approved plan checkpoint.";
  return planArtifactProblem(plan, artifact);
}

// ─── Validation verdict ──────────────────────────────────────────────────────

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(part) && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function validationVerdictFromContents(contents: string[]): { passed: boolean; summary: string } {
  let lastAssistant = "";
  for (const raw of contents) {
    let foundJsonMessage = false;
    for (const line of raw.split("\n")) {
      try {
        const entry = JSON.parse(line) as { message?: { role?: string; content?: unknown } };
        if (entry.message?.role === "assistant") {
          foundJsonMessage = true;
          lastAssistant = textContent(entry.message.content) || lastAssistant;
        }
      } catch { /* non-JSON transcript */ }
    }
    if (!foundJsonMessage && raw.trim()) lastAssistant = raw.trim().slice(-10_000);
  }
  const summary = lastAssistant.trim();
  return { passed: /^PASS\b/i.test(summary), summary: summary.slice(0, 4000) };
}

// ─── Continuation handoff ────────────────────────────────────────────────────

export function composeContinuationContext(
  state: FeatureState,
  artifacts: Record<"assumptions" | "decisions" | "plan" | "threadLog", string>,
  git: { status: string; log: string },
): string {
  const sessions = state.sessions.slice(-8).map((session) =>
    `- ${session.kind}/${session.role} · ${session.stage} · session=${session.sessionId ?? "none"} · file=${session.sessionFile ?? "none"} · run=${session.runId ?? "none"} · ${session.endedAt ? `ended=${session.endedAt} (${session.endReason ?? "unknown"})` : "active"}`,
  ).join("\n");
  const excerpts = Object.entries(artifacts).map(([name, content]) => `## ${name}\n\n${content.slice(-5000)}`).join("\n\n");
  return `# Continue: ${state.title}\n\n- Work item: \`${state.workItem.key}\` (${state.workItem.kind})\n- Status: ${state.status}\n- Stage: ${state.activeStage}\n- Plan artifact: ${state.planArtifact?.url ?? "not published"}\n\n## Recoverable threads\n\n${sessions || "No recorded threads."}\n\n## Live Git\n\n\`\`\`text\n${git.status || "clean"}\n${git.log}\n\`\`\`\n\n${excerpts}\n`;
}
