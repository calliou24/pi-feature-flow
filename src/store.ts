import { appendFile, chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Effect, Either, Schema } from "effect";
import {
  ARTIFACT_FILES,
  ARTIFACT_TITLES,
  type ArtifactName,
  type ExecutionLease,
  FeatureAlreadyExists,
  FeatureBusy,
  FeatureNotFound,
  type FeatureDraft,
  type FeatureState,
  FeatureStateFromJson,
  IoFailure,
  LeaseHeld,
  StateCorrupt,
} from "./domain.ts";
import { identifyWorkItem, normalizeTitle } from "./identity.ts";
import { FEATURES_ROOT, FEATURE_FLOW_ROOT } from "./config.ts";

const LOCK_ATTEMPTS = 80;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 5 * 60_000;

// ─── Path safety ─────────────────────────────────────────────────────────────

function assertContained(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (absoluteCandidate !== absoluteRoot && !absoluteCandidate.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Path escapes feature-flow root: ${candidate}`);
  }
  return absoluteCandidate;
}

export function featureDir(featureId: string): string {
  return assertContained(FEATURES_ROOT, join(FEATURES_ROOT, featureId));
}

export function statePath(featureId: string): string {
  return join(featureDir(featureId), "state.json");
}

export function ledgerPath(featureId: string): string {
  return join(featureDir(featureId), "ledger.jsonl");
}

export function artifactPath(featureId: string, artifact: ArtifactName): string {
  return assertContained(featureDir(featureId), join(featureDir(featureId), ARTIFACT_FILES[artifact]));
}

// ─── IO helpers ──────────────────────────────────────────────────────────────

function io<A>(op: string, path: string, run: () => Promise<A>): Effect.Effect<A, IoFailure> {
  return Effect.tryPromise({ try: run, catch: (cause) => new IoFailure({ op, path, cause }) });
}

async function assertSafeManagedPath(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const resolvedParent = await realpath(parent);
  assertContained(FEATURE_FLOW_ROOT, resolvedParent);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing to follow managed symlink: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await assertSafeManagedPath(path);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

// ─── Advisory lock ───────────────────────────────────────────────────────────

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function recoverStaleLock(lockPath: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number; createdAt?: number };
    // Never evict a live owner based on age: a paused Pi process still owns its
    // critical section. Age applies only when owner metadata is absent.
    if (typeof raw.pid === "number") {
      if (processAlive(raw.pid)) return false;
      await rm(lockPath, { force: true });
      return true;
    }
    if (typeof raw.createdAt !== "number" || Date.now() - raw.createdAt > STALE_LOCK_MS) {
      await rm(lockPath, { force: true });
      return true;
    }
  } catch {
    const info = await stat(lockPath).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
      await rm(lockPath, { force: true });
      return true;
    }
  }
  return false;
}

interface LockHandle {
  lockPath: string;
  token: string;
  handle: Awaited<ReturnType<typeof open>>;
}

function acquireLock(featureId: string): Effect.Effect<LockHandle, FeatureBusy | IoFailure> {
  const dir = featureDir(featureId);
  const lockPath = join(dir, ".lock");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return io("acquire-lock", lockPath, async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }));
        return { lockPath, token, handle } satisfies LockHandle;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await recoverStaleLock(lockPath)) continue;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
      }
    }
    return null;
  }).pipe(
    Effect.flatMap((handle) => handle === null ? Effect.fail(new FeatureBusy({ featureId })) : Effect.succeed(handle)),
  );
}

function releaseLock(lock: LockHandle): Effect.Effect<void> {
  return Effect.promise(async () => {
    await lock.handle.close().catch(() => undefined);
    try {
      const current = JSON.parse(await readFile(lock.lockPath, "utf8")) as { token?: string };
      if (current.token === lock.token) await rm(lock.lockPath, { force: true });
    } catch {
      // A recovery action may already have replaced the lock; never delete an
      // unknown successor from this owner's release path.
    }
  });
}

function withLock<A, E>(featureId: string, operation: Effect.Effect<A, E>): Effect.Effect<A, E | FeatureBusy | IoFailure> {
  return Effect.acquireUseRelease(acquireLock(featureId), () => operation, releaseLock);
}

// ─── State codec ─────────────────────────────────────────────────────────────

const decodeState = Schema.decodeUnknown(FeatureStateFromJson);
const encodeState = Schema.encode(FeatureStateFromJson);

function loadUnlocked(featureId: string): Effect.Effect<FeatureState, FeatureNotFound | StateCorrupt | IoFailure> {
  const path = statePath(featureId);
  return io("read-state", path, async () => {
    await assertSafeManagedPath(path);
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }).pipe(
    Effect.flatMap((raw) => raw === null ? Effect.fail(new FeatureNotFound({ featureId })) : Effect.succeed(raw)),
    Effect.flatMap((raw) =>
      decodeState(raw).pipe(
        Effect.mapError((error) => new StateCorrupt({ featureId, reason: String(error) })),
      ),
    ),
    Effect.filterOrFail(
      (state) => state.featureId === featureId,
      () => new StateCorrupt({ featureId, reason: "state identity mismatch" }),
    ),
  );
}

function persist(featureId: string, draft: FeatureDraft): Effect.Effect<FeatureState, StateCorrupt | IoFailure> {
  draft.revision += 1;
  draft.updatedAt = new Date().toISOString();
  return encodeState(draft).pipe(
    Effect.mapError((error) => new StateCorrupt({ featureId, reason: `encode: ${String(error)}` })),
    Effect.flatMap((raw) => io("write-state", statePath(featureId), () => atomicWrite(statePath(featureId), `${raw}\n`))),
    Effect.as(draft as FeatureState),
  );
}

function asDraft(state: FeatureState): FeatureDraft {
  return structuredClone(state) as unknown as FeatureDraft;
}

function frontmatter(featureId: string, workItemKey: string, author: string): string {
  return `---\nfeature_id: ${featureId}\nwork_item: ${workItemKey}\nrevision: 1\nupdated_at: ${new Date().toISOString()}\nauthor: ${author}\n---\n`;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class FeatureStore extends Effect.Service<FeatureStore>()("FeatureStore", {
  effect: Effect.sync(() => {
    // Reads do not need the advisory lock: state writes are atomic renames.
    const load = (featureId: string) => loadUnlocked(featureId);

    /** Read-modify-write under the feature lock. `mutate` may throw to abort. */
    const update = (featureId: string, mutate: (draft: FeatureDraft) => void) =>
      withLock(featureId, Effect.gen(function* () {
        const draft = asDraft(yield* loadUnlocked(featureId));
        yield* Effect.try({ try: () => mutate(draft), catch: (cause) => new StateCorrupt({ featureId, reason: cause instanceof Error ? cause.message : String(cause) }) });
        return yield* persist(featureId, draft);
      }));

    const appendLedger = (featureId: string, event: Record<string, unknown>) =>
      io("append-ledger", ledgerPath(featureId), async () => {
        const path = ledgerPath(featureId);
        await assertSafeManagedPath(path);
        await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { encoding: "utf8", mode: 0o600 });
      });

    const readArtifact = (featureId: string, artifact: ArtifactName) =>
      io("read-artifact", artifactPath(featureId, artifact), async () => {
        const path = artifactPath(featureId, artifact);
        await assertSafeManagedPath(path);
        return readFile(path, "utf8");
      });

    /** Appends a human-readable section. Does not touch state.json: artifact appends are not state transitions. */
    const appendArtifact = (featureId: string, artifact: ArtifactName, heading: string, body: string, author: string) =>
      io("append-artifact", artifactPath(featureId, artifact), async () => {
        const path = artifactPath(featureId, artifact);
        await assertSafeManagedPath(path);
        const section = `\n## ${heading}\n\n_Recorded ${new Date().toISOString()} by ${author}._\n\n${body.trim()}\n`;
        await appendFile(path, section, { encoding: "utf8", mode: 0o600 });
        await chmod(path, 0o600).catch(() => undefined);
      });

    const replaceArtifact = (featureId: string, artifact: ArtifactName, body: string, author: string) =>
      withLock(featureId, Effect.gen(function* () {
        const state = yield* loadUnlocked(featureId);
        const nextRevision = state.revision + 1;
        const content = `---\nfeature_id: ${state.featureId}\nwork_item: ${state.workItem.key}\nrevision: ${nextRevision}\nupdated_at: ${new Date().toISOString()}\nauthor: ${author}\n---\n\n${body.trim()}\n`;
        yield* io("replace-artifact", artifactPath(featureId, artifact), () => atomicWrite(artifactPath(featureId, artifact), content));
        yield* persist(featureId, asDraft(state));
        return nextRevision;
      }));

    const create = (workItemInput: string, titleInput: string, cwd: string) =>
      Effect.gen(function* () {
        const direct = yield* identifyWorkItem(workItemInput);
        const combined = yield* identifyWorkItem(`${workItemInput} ${titleInput}`).pipe(Effect.orElseSucceed(() => direct));
        const { featureId, identity } = combined.identity.kind === "jira" || combined.identity.kind === "pr" ? combined : direct;
        const title = yield* normalizeTitle(titleInput, identity.key);
        return yield* withLock(featureId, Effect.gen(function* () {
          const existing = yield* io("stat-state", statePath(featureId), () => stat(statePath(featureId)).then(() => true, () => false));
          if (existing) return yield* Effect.fail(new FeatureAlreadyExists({ featureId }));
          const now = new Date().toISOString();
          const state: FeatureState = {
            version: 3,
            featureId,
            title,
            workItem: identity,
            project: { cwd },
            status: "planning",
            activeStage: "planning",
            createdAt: now,
            updatedAt: now,
            revision: 1,
            checkpoint: { kind: "none", status: "none", updatedAt: now },
            planArtifact: null,
            sessions: [],
            executionLease: null,
            lastKnownGit: { cwd, head: null, dirty: false, changedFiles: [] },
            lastError: null,
          };
          const raw = yield* encodeState(state).pipe(Effect.mapError((error) => new StateCorrupt({ featureId, reason: `encode: ${String(error)}` })));
          yield* io("write-state", statePath(featureId), () => atomicWrite(statePath(featureId), `${raw}\n`));
          for (const artifact of Object.keys(ARTIFACT_FILES) as ArtifactName[]) {
            const body = `${frontmatter(featureId, identity.key, "extension")}\n# ${ARTIFACT_TITLES[artifact]}\n\n`;
            yield* io("write-artifact", artifactPath(featureId, artifact), () => atomicWrite(artifactPath(featureId, artifact), body));
          }
          yield* appendLedger(featureId, { type: "feature.created", cwd, title, workItem: identity });
          return state;
        }));
      });

    const list = () =>
      Effect.gen(function* () {
        yield* io("mkdir", FEATURES_ROOT, () => mkdir(FEATURES_ROOT, { recursive: true, mode: 0o700 }));
        const entries = yield* io("readdir", FEATURES_ROOT, () => readdir(FEATURES_ROOT, { withFileTypes: true }));
        const states: FeatureState[] = [];
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const loaded = yield* Effect.either(loadUnlocked(entry.name));
          // A malformed feature stays recoverable by direct file inspection.
          if (Either.isRight(loaded)) states.push(loaded.right);
        }
        return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });

    const reserveExecution = (
      featureId: string,
      lease: ExecutionLease,
      validate: (state: FeatureState) => Effect.Effect<void, Error>,
    ) =>
      withLock(featureId, Effect.gen(function* () {
        const state = yield* loadUnlocked(featureId);
        yield* validate(state).pipe(Effect.mapError((error) => new StateCorrupt({ featureId, reason: error.message })));
        const active = state.sessions.find((session) => session.kind === "subagent" && !session.endedAt && (session.stage === "implementation" || session.stage === "validation"));
        if (state.executionLease) return yield* Effect.fail(new LeaseHeld({ featureId, stage: state.executionLease.stage, token: state.executionLease.token }));
        if (active) return yield* Effect.fail(new LeaseHeld({ featureId, stage: active.stage, token: active.runId ?? "unknown" }));
        const draft = asDraft(state);
        draft.executionLease = lease;
        return yield* persist(featureId, draft);
      }));

    const releaseExecution = (featureId: string, token: string, force = false) =>
      withLock(featureId, Effect.gen(function* () {
        const state = yield* loadUnlocked(featureId);
        if (!state.executionLease) return state;
        if (!force && state.executionLease.token !== token) {
          return yield* Effect.fail(new StateCorrupt({ featureId, reason: "Execution lease token mismatch." }));
        }
        const draft = asDraft(state);
        draft.executionLease = null;
        return yield* persist(featureId, draft);
      }));

    const ensureRoots = () =>
      io("mkdir-roots", FEATURE_FLOW_ROOT, async () => {
        await mkdir(FEATURE_FLOW_ROOT, { recursive: true, mode: 0o700 });
        await mkdir(FEATURES_ROOT, { recursive: true, mode: 0o700 });
        await Promise.all([FEATURE_FLOW_ROOT, FEATURES_ROOT].map((path) => chmod(path, 0o700).catch(() => undefined)));
      });

    return { load, update, create, list, appendLedger, readArtifact, appendArtifact, replaceArtifact, reserveExecution, releaseExecution, ensureRoots };
  }),
}) {}
