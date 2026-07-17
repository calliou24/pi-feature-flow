import { Either } from "effect";
import { InvalidIdentity, MAX_TITLE_LENGTH, type FeatureState, type WorkItem } from "./domain.ts";

/** Normalize any user-supplied identifier to a safe directory-friendly id. */
export function normalizeFeatureId(value: string): Either.Either<string, InvalidIdentity> {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(normalized)) {
    return Either.left(new InvalidIdentity({ value, reason: "Feature id must contain letters or numbers and may use single hyphens." }));
  }
  return Either.right(normalized);
}

export function normalizeTitle(value: string, fallback: string): Either.Either<string, InvalidIdentity> {
  const normalized = value.replace(/\s+/g, " ").trim() || fallback;
  if (normalized.length > MAX_TITLE_LENGTH) {
    return Either.left(new InvalidIdentity({
      value,
      reason: `Feature title must be at most ${MAX_TITLE_LENGTH} characters; provide a concise descriptive title instead of the full request.`,
    }));
  }
  return Either.right(normalized);
}

/**
 * Resolve the canonical identity in Jira → PR → stable-feature-name order.
 * The identity key drives branch, commit, and PR naming.
 */
export function identifyWorkItem(value: string): Either.Either<{ featureId: string; identity: WorkItem }, InvalidIdentity> {
  const source = value.trim();
  const jira = source.match(/(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]+-\d+)(?:$|[^A-Za-z0-9])/i) ?? source.match(/^([A-Za-z][A-Za-z0-9]+-\d+)$/i);
  if (jira?.[1]) {
    const key = jira[1].toUpperCase();
    return Either.map(normalizeFeatureId(key), (featureId) => ({ featureId, identity: { kind: "jira" as const, key, source } }));
  }
  const urlPr = source.match(/\/pull\/(\d+)(?:\/|$)/i);
  const shortPr = source.match(/^(?:pr[-# ]?|#)(\d+)$/i);
  const prNumber = urlPr?.[1] ?? shortPr?.[1];
  if (prNumber) {
    const key = `PR-${prNumber}`;
    return Either.map(normalizeFeatureId(key), (featureId) => ({ featureId, identity: { kind: "pr" as const, key, source } }));
  }
  return Either.map(normalizeFeatureId(source), (featureId) => ({ featureId, identity: { kind: "feature" as const, key: featureId, source } }));
}

export function namingPrefix(state: Pick<FeatureState, "workItem" | "featureId">): string {
  return state.workItem?.key || state.featureId;
}

// ─── Bash naming guard ───────────────────────────────────────────────────────

export interface NamingViolation {
  kind: "branch" | "commit" | "pr-title";
  reason: string;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function flagValue(segment: string, flag: "message" | "title"): string | null {
  const pattern = flag === "message"
    ? /(?:-[a-zA-Z]*m\s+|--message(?:=|\s+))(?:("[^"]+")|('[^']+')|([^\s;&]+))/
    : /--title(?:=|\s+)(?:("[^"]+")|('[^']+')|([^\s;&]+))/i;
  const match = segment.match(pattern);
  return match ? unquote(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

/**
 * Validate a bash command against the active work-item prefix.
 * Covers branch creation/rename, commits (including `-am` and `--message=`),
 * message-from-file commits, and `gh pr create/edit` titles.
 */
export function validateNamingCommand(command: string, prefix: string): NamingViolation | null {
  const segments = command.split(/\n|&&|\|\||;/).map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    const branchMatch = segment.match(/\bgit\s+(?:checkout\s+-b|switch\s+-c|branch(?!\s+-))\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/i)
      ?? segment.match(/\bgit\s+worktree\s+add\b.*?(?:-b|-B)\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
    const renameMatch = segment.match(/\bgit\s+branch\s+(?:-m|-M)\s+(?:(?:"[^"]+"|'[^']+'|[^\s]+)\s+)?(?:"([^"]+)"|'([^']+)'|([^\s]+))\s*$/i);
    const branch = branchMatch ? (branchMatch[1] ?? branchMatch[2] ?? branchMatch[3]) : renameMatch ? (renameMatch[1] ?? renameMatch[2] ?? renameMatch[3]) : null;
    if (branch && !branch.startsWith(`${prefix}-`)) {
      return { kind: "branch", reason: `Active work item ${prefix}: new or renamed branches must start '${prefix}-'. Example: ${prefix}-short-kebab-description` };
    }

    if (/\bgit\s+commit\b/i.test(segment) && !isAmendNoEdit(segment)) {
      if (/\s(?:-F|--file)[=\s]/.test(segment)) {
        return { kind: "commit", reason: `Active work item ${prefix}: commit messages from files cannot be verified. Use -m "${prefix} Imperative summary" instead.` };
      }
      const message = flagValue(segment, "message");
      if (!message || !message.startsWith(`${prefix} `)) {
        return { kind: "commit", reason: `Active work item ${prefix}: commit messages must start '${prefix} '. Example: git commit -m "${prefix} Add focused behavior"` };
      }
    }

    if (/\bgh\s+pr\s+(?:create|edit)\b/i.test(segment)) {
      const title = flagValue(segment, "title");
      if (!title || !title.startsWith(`${prefix} `)) {
        return { kind: "pr-title", reason: `Active work item ${prefix}: PR titles must start '${prefix} '. Example: gh pr create --title "${prefix} Describe the change"` };
      }
    }
  }
  return null;
}

export function isAmendNoEdit(segment: string): boolean {
  return /--amend\b/.test(segment) && /--no-edit\b/.test(segment);
}
