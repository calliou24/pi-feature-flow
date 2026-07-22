import { Data, Schema } from "effect";

// ─── Identity ────────────────────────────────────────────────────────────────

export const MAX_TITLE_LENGTH = 96;

export const WorkItemKind = Schema.Literal("jira", "pr", "feature");
export type WorkItemKind = typeof WorkItemKind.Type;

export const WorkItem = Schema.Struct({
  kind: WorkItemKind,
  key: Schema.String,
  source: Schema.String,
});
export type WorkItem = typeof WorkItem.Type;

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export const FeatureStage = Schema.Literal("planning", "implementation", "validation", "done");
export type FeatureStage = typeof FeatureStage.Type;

export const FeatureStatus = Schema.Literal(
  "planning",
  "awaiting-approval",
  "planned",
  "implementing",
  "validating",
  "blocked",
  "complete",
  "abandoned",
);
export type FeatureStatus = typeof FeatureStatus.Type;

/** Stages a subagent run can execute. `adversary` reviews without a lifecycle transition. */
export type RunStage = "implementation" | "validation" | "adversary";

// ─── Records ─────────────────────────────────────────────────────────────────

export const SessionRecord = Schema.Struct({
  kind: Schema.Literal("pi", "subagent", "planner"),
  sessionId: Schema.NullOr(Schema.String),
  sessionFile: Schema.NullOr(Schema.String),
  transcriptPath: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  cwd: Schema.String,
  stage: Schema.Union(FeatureStage, Schema.Literal("review", "direct")),
  role: Schema.String,
  runId: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  asyncDir: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  parentSessionId: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  startedAt: Schema.String,
  endedAt: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  endReason: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
});
export type SessionRecord = typeof SessionRecord.Type;

export const Checkpoint = Schema.Struct({
  kind: Schema.Literal("none", "plan"),
  status: Schema.Literal("none", "pending", "approved", "rejected"),
  note: Schema.optional(Schema.String),
  updatedAt: Schema.String,
});
export type Checkpoint = typeof Checkpoint.Type;

export const PlanArtifact = Schema.Struct({
  url: Schema.String,
  publishedAt: Schema.String,
  planRevision: Schema.Number,
  planHash: Schema.String,
});
export type PlanArtifact = typeof PlanArtifact.Type;

export const ExecutionLease = Schema.Struct({
  token: Schema.String,
  stage: Schema.Literal("implementation", "validation"),
  ownerSessionId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type ExecutionLease = typeof ExecutionLease.Type;

export const GitSnapshot = Schema.Struct({
  cwd: Schema.String,
  head: Schema.NullOr(Schema.String),
  dirty: Schema.Boolean,
  changedFiles: Schema.Array(Schema.String),
});
export type GitSnapshot = typeof GitSnapshot.Type;

// ─── Feature state ───────────────────────────────────────────────────────────

export const FeatureState = Schema.Struct({
  version: Schema.Literal(3),
  featureId: Schema.String,
  title: Schema.String,
  workItem: WorkItem,
  project: Schema.Struct({ cwd: Schema.String }),
  status: FeatureStatus,
  activeStage: FeatureStage,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  revision: Schema.Number,
  checkpoint: Checkpoint,
  planArtifact: Schema.NullOr(PlanArtifact),
  sessions: Schema.Array(SessionRecord),
  executionLease: Schema.optionalWith(Schema.NullOr(ExecutionLease), { default: () => null }),
  lastKnownGit: Schema.NullOr(GitSnapshot),
  lastError: Schema.NullOr(Schema.String),
});
export type FeatureState = typeof FeatureState.Type;
type DeepMutable<T> = T extends ReadonlyArray<infer E> ? DeepMutable<E>[]
  : T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
  : T;

/** Mutable draft used inside store transactions. */
export type FeatureDraft = DeepMutable<FeatureState>;

export const FeatureStateFromJson = Schema.parseJson(FeatureState);

export const ARTIFACT_NAMES = ["assumptions", "decisions", "plan", "threadLog"] as const;
export type ArtifactName = (typeof ARTIFACT_NAMES)[number];

export const ARTIFACT_FILES: Record<ArtifactName, string> = {
  assumptions: "assumptions.md",
  decisions: "decisions.md",
  plan: "plan.md",
  threadLog: "thread-log.md",
};

export const ARTIFACT_TITLES: Record<ArtifactName, string> = {
  assumptions: "Assumptions",
  decisions: "Feature Decisions",
  plan: "Implementation Plan",
  threadLog: "Thread Activity Log",
};

// ─── Errors ──────────────────────────────────────────────────────────────────

export class FeatureNotFound extends Data.TaggedError("FeatureNotFound")<{ featureId: string }> {
  override get message(): string {
    return `Feature '${this.featureId}' was not found.`;
  }
}

export class FeatureAlreadyExists extends Data.TaggedError("FeatureAlreadyExists")<{ featureId: string }> {
  override get message(): string {
    return `Feature '${this.featureId}' already exists.`;
  }
}

export class FeatureBusy extends Data.TaggedError("FeatureBusy")<{ featureId: string }> {
  override get message(): string {
    return `Feature '${this.featureId}' is busy; retry shortly.`;
  }
}

export class StateCorrupt extends Data.TaggedError("StateCorrupt")<{ featureId: string; reason: string }> {
  override get message(): string {
    return `Feature '${this.featureId}' state is unreadable: ${this.reason}`;
  }
}

export class InvalidIdentity extends Data.TaggedError("InvalidIdentity")<{ value: string; reason: string }> {
  override get message(): string {
    return this.reason;
  }
}

export class LeaseHeld extends Data.TaggedError("LeaseHeld")<{ featureId: string; stage: string; token: string }> {
  override get message(): string {
    return `Execution is already reserved by ${this.stage} (${this.token}). Verify subagent status, then /feature unlock if it is dead.`;
  }
}

export class StageNotReady extends Data.TaggedError("StageNotReady")<{ reason: string }> {
  override get message(): string {
    return this.reason;
  }
}

export class SpawnFailed extends Data.TaggedError("SpawnFailed")<{ reason: string; outcome: "definitive" | "unknown" }> {
  override get message(): string {
    return this.reason;
  }
}

export class PublishFailed extends Data.TaggedError("PublishFailed")<{ reason: string }> {
  override get message(): string {
    return `Plan saved locally but artifact publication failed: ${this.reason}`;
  }
}

export class IoFailure extends Data.TaggedError("IoFailure")<{ op: string; path: string; cause: unknown }> {
  override get message(): string {
    return `${this.op} failed for ${this.path}: ${String(this.cause)}`;
  }
}

export type StoreError = FeatureNotFound | FeatureAlreadyExists | FeatureBusy | StateCorrupt | InvalidIdentity | LeaseHeld | IoFailure;
