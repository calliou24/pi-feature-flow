import { createHash, randomUUID } from "node:crypto";
import { access, chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import { FEATURES_ROOT, FEATURE_FLOW_ROOT, FeatureConfig } from "./config.ts";
import type { FeatureState } from "./domain.ts";
import { PiApi } from "./pi-api.ts";
import { withArchiveLock } from "./archive-lock.ts";
import { FeatureStore, featureDir } from "./store.ts";

const DOCUMENT_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".rst", ".adoc", ".pdf", ".html", ".htm", ".csv", ".tsv", ".log",
]);
const DATA_EXTENSIONS = new Set([".json", ".jsonl", ".yaml", ".yml", ".toml"]);
const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".fish", ".ps1", ".mjs", ".cjs", ".js", ".py", ".ts"]);
const CONTEXT_DIRECTORIES = new Set(["artifacts", "reports", "report", "handoff", "handoffs", ".agent-tmp"]);
const FORBIDDEN_CONTEXT_NAMES = /^(?:package(?:-lock)?\.json|tsconfig(?:\.[^.]+)?\.json|docker-compose(?:\.[^.]+)?\.ya?ml|compose(?:\.[^.]+)?\.ya?ml|\.env(?:\..+)?|.*\.lock)$/i;
const FORBIDDEN_CONTEXT_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3", ".dump", ".bak", ".sql", ".tar", ".gz", ".zip"]);
const WALK_SKIP = new Set([".git", ".cache", ".local", ".npm", ".pnpm-store", "node_modules", ".venv", "venv", "dist", "build"]);
const MAX_ARCHIVE_FILE_BYTES = 95 * 1024 * 1024;

export interface ArchiveWorktree {
  path: string;
  repositoryRoot: string;
  primary: boolean;
  branch: string | null;
  head: string;
  remoteRefs: string[];
  defaultBranch: string | null;
}

export interface ArchiveContainer {
  id: string;
  name: string;
  image: string;
  volumes: string[];
}

export interface ArchiveContextFile {
  originalPath: string;
  kind: "memory" | "session" | "transcript" | "run-artifact" | "support";
}

export interface ArchivePreview {
  featureId: string;
  worktrees: ArchiveWorktree[];
  containers: ArchiveContainer[];
  files: ArchiveContextFile[];
  branches: string[];
}

interface StoredFile extends ArchiveContextFile {
  archivePath: string;
  homeRelative: string | null;
  sha256: string;
  size: number;
  mode: number;
}

interface ArchiveManifest {
  version: 1;
  featureId: string;
  title: string;
  workItem: string;
  createdAt: string;
  sourceHome: string;
  sourceFeatureRoot: string;
  repository: string;
  files: StoredFile[];
  worktrees: Array<{ checkout: string; branch: string | null; head: string; remoteRefs: string[] }>;
  containers: Array<{ name: string; image: string }>;
  cleanup: {
    removesWorktrees: boolean;
    removesLocalBranches: boolean;
    removesContainers: boolean;
    restoresRuntimeState: false;
  };
}

export interface ArchiveResult {
  featureId: string;
  repository: string;
  url: string;
  archivePath: string;
  localFeatureRemoved: boolean;
  warnings: string[];
}

export interface ArchiveSummary {
  featureId: string;
  title: string;
  workItem: string;
  createdAt: string;
  repository: string;
  archivePath: string;
}

export interface RecoveryResult {
  featureId: string;
  restoredFiles: number;
  skippedFiles: number;
  source: ArchiveSummary;
}

interface WorktreeRecord {
  path: string;
  head: string;
  branch: string | null;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function featureTokens(state: Pick<FeatureState, "featureId" | "workItem">): string[] {
  return [...new Set([normalizeToken(state.featureId), normalizeToken(state.workItem.key)].filter((token) => token.length >= 3))];
}

export function isFeatureRelated(value: string, tokens: readonly string[]): boolean {
  const normalized = normalizeToken(value);
  return tokens.some((token) => normalized === token || normalized.startsWith(`${token}-`) || normalized.endsWith(`-${token}`) || normalized.includes(`-${token}-`));
}

function contextDirectory(path: string): boolean {
  return path.toLowerCase().split(/[\\/]+/).some((segment) => CONTEXT_DIRECTORIES.has(segment));
}

function forbiddenContextPath(path: string): boolean {
  return FORBIDDEN_CONTEXT_NAMES.test(basename(path)) || FORBIDDEN_CONTEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

/** Conservative inference for dirty worktree files. Explicit extraPaths use a separate, opt-in predicate. */
export function isContextOnlyFile(path: string, tokens: readonly string[] = []): boolean {
  if (forbiddenContextPath(path)) return false;
  const extension = extname(path).toLowerCase();
  const related = tokens.length > 0 && isFeatureRelated(path, tokens);
  const contextualDirectory = contextDirectory(path);
  if (DOCUMENT_EXTENSIONS.has(extension)) return related || contextualDirectory;
  if (DATA_EXTENSIONS.has(extension)) return contextualDirectory;
  if (SCRIPT_EXTENSIONS.has(extension)) return related && contextualDirectory;
  return false;
}

function isExplicitContextFile(path: string): boolean {
  if (forbiddenContextPath(path)) return false;
  const extension = extname(path).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(extension) || DATA_EXTENSIONS.has(extension) || SCRIPT_EXTENSIONS.has(extension);
}

function isRunArtifactFile(path: string): boolean {
  if (forbiddenContextPath(path)) return false;
  return [".json", ".jsonl", ".log", ".md", ".txt"].includes(extname(path).toLowerCase());
}

function parseWorktreeList(raw: string): WorktreeRecord[] {
  return raw.trim().split(/\n\n+/).filter(Boolean).flatMap((block) => {
    const fields = new Map(block.split("\n").map((line) => {
      const separator = line.indexOf(" ");
      return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    const path = fields.get("worktree");
    const head = fields.get("HEAD");
    if (!path || !head) return [];
    const ref = fields.get("branch");
    return [{ path, head, branch: ref?.replace(/^refs\/heads\//, "") ?? null }];
  });
}

export function parsePorcelainPaths(raw: string): Array<{ status: string; path: string }> {
  const records = raw.split("\0");
  const files: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    files.push({ status, path: record.slice(3) });
    if (/[RC]/.test(status)) {
      const destination = records[++index];
      if (destination) files.push({ status, path: destination });
    }
  }
  return files;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export function containedPath(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Archive path escapes its allowed root: ${candidate}`);
  }
  return resolvedCandidate;
}

export async function containedRealFile(root: string, candidate: string): Promise<string> {
  const lexicalPath = containedPath(root, candidate);
  const info = await lstat(lexicalPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Archive source is not a regular non-symlink file: ${candidate}`);
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(lexicalPath)]);
  return containedPath(realRoot, realFile);
}

export async function safeDestination(root: string, candidate: string): Promise<string> {
  const destination = containedPath(root, candidate);
  const rootReal = await realpath(root);
  let ancestor = destination;
  while (!await exists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`No existing ancestor for recovery destination: ${destination}`);
    ancestor = parent;
  }
  const ancestorInfo = await lstat(ancestor);
  if (ancestorInfo.isSymbolicLink()) throw new Error(`Recovery destination uses a symlink: ${ancestor}`);
  const ancestorReal = await realpath(ancestor);
  containedPath(rootReal, ancestorReal);
  const destinationInfo = await lstat(destination).catch(() => null);
  if (destinationInfo?.isSymbolicLink()) throw new Error(`Recovery destination is a symlink: ${destination}`);
  return destination;
}

async function removeEmptyTree(root: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let empty = true;
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!await removeEmptyTree(path)) empty = false;
    } else {
      empty = false;
    }
  }
  if (empty) await rmdir(root).catch(() => undefined);
  return empty;
}

async function walkFiles(root: string, options: { maxDepth?: number; filter?: (path: string) => boolean } = {}): Promise<string[]> {
  const output: string[] = [];
  const visit = async (path: string, depth: number): Promise<void> => {
    const info = await lstat(path).catch(() => null);
    if (!info || info.isSymbolicLink()) return;
    if (info.isFile()) {
      if (!options.filter || options.filter(path)) output.push(path);
      return;
    }
    if (!info.isDirectory() || depth > (options.maxDepth ?? Number.POSITIVE_INFINITY)) return;
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && WALK_SKIP.has(entry.name)) continue;
      await visit(join(path, entry.name), depth + 1);
    }
  };
  await visit(root, 0);
  return output;
}

async function assertContextTree(root: string, accepts: (path: string) => boolean): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing to delete a context directory containing a symlink: ${path}`);
    if (info.isFile()) {
      if (!accepts(path)) throw new Error(`Refusing to delete a context directory containing an unarchived file: ${path}`);
      return;
    }
    if (!info.isDirectory()) throw new Error(`Refusing to delete an unsupported filesystem entry: ${path}`);
    for (const entry of await readdir(path)) await visit(join(path, entry));
  };
  await visit(root);
}

async function discoverNamedGitCheckouts(root: string, tokens: readonly string[], maxDepth = 6): Promise<string[]> {
  const found: string[] = [];
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || WALK_SKIP.has(entry.name)) continue;
      const child = join(path, entry.name);
      if (isFeatureRelated(entry.name, tokens) && await exists(join(child, ".git"))) found.push(child);
      await visit(child, depth + 1);
    }
  };
  await visit(root, 0);
  return found;
}

async function assertNoSymlinkPath(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Refusing to archive a path containing a symlink: ${path}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function copyStoredFile(source: string, destinationRoot: string, archivePath: string, kind: ArchiveContextFile["kind"]): Promise<StoredFile> {
  await assertNoSymlinkPath(source);
  const info = await stat(source);
  if (!info.isFile()) throw new Error(`Archive input is not a regular file: ${source}`);
  if (info.size > MAX_ARCHIVE_FILE_BYTES) throw new Error(`Archive input exceeds GitHub's safe file limit (${MAX_ARCHIVE_FILE_BYTES} bytes): ${source}`);
  const content = await readFile(source);
  const destination = join(destinationRoot, archivePath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, content, { mode: info.mode & 0o777 });
  const relativeHome = relative(homedir(), source);
  return {
    originalPath: source,
    archivePath,
    homeRelative: relativeHome !== "" && !relativeHome.startsWith(`..${sep}`) && relativeHome !== ".." ? relativeHome : null,
    kind,
    sha256: sha256(content),
    size: info.size,
    mode: info.mode & 0o777,
  };
}

function archiveTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeRepositoryDirectory(repository: string): string {
  return repository.replace(/[^a-zA-Z0-9._-]+/g, "--");
}

export function githubRepositoryFromRemote(remote: string): string | null {
  const match = remote.trim().match(/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeArchiveManifest(value: unknown): ArchiveManifest | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.featureId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.featureId)) return null;
  if (typeof value.title !== "string" || typeof value.workItem !== "string" || typeof value.createdAt !== "string") return null;
  if (typeof value.sourceHome !== "string" || typeof value.sourceFeatureRoot !== "string" || typeof value.repository !== "string") return null;
  if (!Array.isArray(value.files) || !Array.isArray(value.worktrees) || !Array.isArray(value.containers) || !isRecord(value.cleanup)) return null;
  const kinds = new Set<ArchiveContextFile["kind"]>(["memory", "session", "transcript", "run-artifact", "support"]);
  const files: StoredFile[] = [];
  for (const candidate of value.files) {
    if (!isRecord(candidate) || typeof candidate.originalPath !== "string" || typeof candidate.archivePath !== "string") return null;
    if (typeof candidate.kind !== "string" || !kinds.has(candidate.kind as ArchiveContextFile["kind"])) return null;
    if (candidate.homeRelative !== null && typeof candidate.homeRelative !== "string") return null;
    if (typeof candidate.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(candidate.sha256)) return null;
    if (typeof candidate.size !== "number" || !Number.isSafeInteger(candidate.size) || candidate.size < 0) return null;
    if (typeof candidate.mode !== "number" || !Number.isInteger(candidate.mode) || candidate.mode < 0 || candidate.mode > 0o777) return null;
    files.push(candidate as unknown as StoredFile);
  }
  if (!files.some((file) => file.kind === "memory" && file.archivePath === join("feature-memory", "state.json"))) return null;
  return { ...value, files } as unknown as ArchiveManifest;
}

export class FeatureArchive extends Effect.Service<FeatureArchive>()("FeatureArchive", {
  effect: Effect.gen(function* () {
    const pi = yield* PiApi;
    const store = yield* FeatureStore;
    const { config } = yield* FeatureConfig;

    const exec = async (command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) => {
      const result = await pi.exec(command, args, { cwd: options.cwd, timeout: options.timeout ?? 30_000 });
      return { code: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    };

    const checkedOutput = async (command: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<string> => {
      const result = await exec(command, args, options);
      if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
      return result.stdout;
    };

    const checked = async (command: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<string> =>
      (await checkedOutput(command, args, options)).trim();

    const gitRoot = async (path: string): Promise<string | null> => {
      const result = await exec("git", ["-C", path, "rev-parse", "--show-toplevel"], { timeout: 5_000 });
      return result.code === 0 ? result.stdout.trim() : null;
    };

    const currentRemoteRefsContaining = async (checkout: string, head: string): Promise<string[]> => {
      const remotes = (await checked("git", ["-C", checkout, "remote"], { timeout: 5_000 })).split("\n").filter(Boolean);
      const containing: string[] = [];
      for (const remote of remotes) {
        await checked("git", ["-C", checkout, "fetch", "--prune", "--no-tags", remote, `+refs/heads/*:refs/remotes/${remote}/*`], { timeout: 120_000 });
        const heads = await checked("git", ["-C", checkout, "ls-remote", "--heads", remote], { timeout: 60_000 });
        for (const line of heads.split("\n")) {
          const match = line.match(/^([0-9a-f]{40,64})\s+refs\/heads\/(.+)$/);
          if (!match) continue;
          const [, oid, branch] = match;
          if (!oid || !branch) continue;
          const reachable = await exec("git", ["-C", checkout, "merge-base", "--is-ancestor", head, oid], { timeout: 10_000 });
          if (reachable.code === 0) containing.push(`${remote}/${branch}`);
        }
      }
      return containing;
    };

    const inspectWorktrees = async (state: FeatureState): Promise<ArchiveWorktree[]> => {
      const tokens = featureTokens(state);
      const candidateCheckouts = new Set<string>();
      for (const path of [state.project.cwd, state.lastKnownGit?.cwd, ...state.sessions.map((session) => session.cwd)]) {
        if (!path || !await exists(path)) continue;
        const root = await gitRoot(path);
        if (root) candidateCheckouts.add(root);
      }
      for (const searchRoot of config.archive.searchRoots) {
        const resolvedRoot = resolve(searchRoot.replace(/^~(?=$|\/)/, homedir()));
        if (!await exists(resolvedRoot)) continue;
        for (const checkout of await discoverNamedGitCheckouts(resolvedRoot, tokens)) candidateCheckouts.add(checkout);
      }

      const repositories = new Map<string, WorktreeRecord[]>();
      for (const checkout of candidateCheckouts) {
        const common = await exec("git", ["-C", checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5_000 });
        if (common.code !== 0 || repositories.has(common.stdout.trim())) continue;
        const listed = await checked("git", ["-C", checkout, "worktree", "list", "--porcelain"], { timeout: 10_000 });
        repositories.set(common.stdout.trim(), parseWorktreeList(listed));
      }

      const worktrees: ArchiveWorktree[] = [];
      for (const records of repositories.values()) {
        const primaryPath = records[0]?.path;
        for (const record of records) {
          if (!isFeatureRelated(record.path, tokens) && !isFeatureRelated(record.branch ?? "", tokens)) continue;
          if (record.path === primaryPath) {
            throw new Error(`Refusing to archive while ${record.branch ?? "the feature"} is checked out in the repository's primary worktree (${record.path}). Move the feature to a secondary worktree or switch the primary checkout to its default branch first.`);
          }
          const dirty = await checkedOutput("git", ["-C", record.path, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { timeout: 15_000 });
          const dirtyFiles = parsePorcelainPaths(dirty);
          if (dirtyFiles.length > 0) {
            throw new Error(`Refusing to archive ${record.path}: related worktrees must be completely clean before removal (${dirtyFiles.map((file) => file.path).join(", ")}). Commit/push code and move any context-only scripts or documents into feature memory or archive.extraPaths first.`);
          }
          const remoteRefs = await currentRemoteRefsContaining(record.path, record.head);
          if (remoteRefs.length === 0) throw new Error(`Refusing to remove ${record.path}: commit ${record.head} is not reachable from any branch currently advertised by its Git remotes.`);
          const defaultRef = await exec("git", ["-C", record.path, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { timeout: 5_000 });
          worktrees.push({
            path: record.path,
            repositoryRoot: primaryPath ?? record.path,
            primary: record.path === primaryPath,
            branch: record.branch,
            head: record.head,
            remoteRefs,
            defaultBranch: defaultRef.code === 0 ? defaultRef.stdout.trim().replace(/^origin\//, "") : null,
          });
        }
      }
      return worktrees;
    };

    const inspectContainers = async (state: FeatureState, worktrees: readonly ArchiveWorktree[]): Promise<ArchiveContainer[]> => {
      const listed = await exec("docker", ["ps", "-aq"], { timeout: 10_000 });
      if (listed.code !== 0 || !listed.stdout.trim()) return [];
      const tokens = featureTokens(state);
      const worktreePaths = worktrees.map((worktree) => resolve(worktree.path));
      const containers: ArchiveContainer[] = [];
      for (const id of listed.stdout.trim().split(/\s+/)) {
        const inspected = await exec("docker", ["inspect", id], { timeout: 10_000 });
        if (inspected.code !== 0) continue;
        let parsed: Array<{
          Name?: string;
          Config?: { Image?: string; Labels?: Record<string, string> };
          Mounts?: Array<{ Type?: string; Name?: string; Source?: string }>;
        }>;
        try {
          parsed = JSON.parse(inspected.stdout) as typeof parsed;
        } catch {
          continue;
        }
        const item = parsed[0];
        if (!item) continue;
        const name = (item.Name ?? "").replace(/^\//, "");
        const mounts = item.Mounts ?? [];
        const values = [name, ...Object.values(item.Config?.Labels ?? {}), ...mounts.map((mount) => mount.Source ?? "")];
        const pathMatch = mounts.some((mount) => {
          if (!mount.Source) return false;
          const source = resolve(mount.Source);
          return worktreePaths.some((path) => source === path || source.startsWith(`${path}${sep}`));
        });
        if (!pathMatch && !values.some((value) => isFeatureRelated(value, tokens))) continue;
        const volumes = mounts.flatMap((mount) =>
          mount.Type === "volume" && mount.Name && isFeatureRelated(mount.Name, tokens) ? [mount.Name] : []
        );
        containers.push({ id, name, image: item.Config?.Image ?? "unknown", volumes });
      }
      return containers;
    };

    const collectFiles = async (state: FeatureState, worktrees: readonly ArchiveWorktree[]): Promise<ArchiveContextFile[]> => {
      const tokens = featureTokens(state);
      const files = new Map<string, ArchiveContextFile["kind"]>();
      const add = async (path: string | null | undefined, kind: ArchiveContextFile["kind"]): Promise<void> => {
        if (!path) return;
        const absolute = resolve(path);
        const info = await lstat(absolute).catch(() => null);
        if (info?.isFile() && !info.isSymbolicLink()) files.set(absolute, kind);
      };

      for (const path of await walkFiles(featureDir(state.featureId))) await add(path, "memory");
      for (const session of state.sessions) {
        await add(session.sessionFile, "session");
        await add(session.transcriptPath, "transcript");
        if (session.asyncDir && await exists(session.asyncDir)) {
          await assertContextTree(session.asyncDir, isRunArtifactFile);
          for (const path of await walkFiles(session.asyncDir, { filter: isRunArtifactFile })) await add(path, "run-artifact");
        }
      }
      for (const worktree of worktrees) {
        const dirty = await checkedOutput("git", ["-C", worktree.path, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { timeout: 15_000 });
        for (const file of parsePorcelainPaths(dirty)) {
          const path = containedPath(worktree.path, file.path);
          if (isContextOnlyFile(file.path, tokens)) await add(path, "support");
        }
      }
      for (const configuredPath of config.archive.extraPaths) {
        const expanded = configuredPath
          .replaceAll("{featureId}", state.featureId)
          .replaceAll("{workItem}", state.workItem.key)
          .replace(/^~(?=$|\/)/, homedir());
        const path = isAbsolute(expanded) ? resolve(expanded) : resolve(state.project.cwd, expanded);
        const info = await lstat(path).catch(() => null);
        if (info?.isFile() && isExplicitContextFile(path)) await add(path, "support");
        if (info?.isDirectory()) {
          for (const child of await walkFiles(path, { filter: isExplicitContextFile })) await add(child, "support");
        }
      }
      return [...files].map(([originalPath, kind]) => ({ originalPath, kind }));
    };

    const inspectPreview = async (state: FeatureState): Promise<ArchivePreview> => {
      if (state.executionLease) throw new Error(`Cannot archive while ${state.executionLease.stage} owns the execution lease.`);
      const activeRun = state.sessions.find((session) => session.kind === "subagent" && !session.endedAt);
      if (activeRun) throw new Error(`Cannot archive while subagent ${activeRun.runId ?? "unknown"} is still active.`);
      const worktrees = await inspectWorktrees(state);
      const containers = await inspectContainers(state, worktrees);
      const files = await collectFiles(state, worktrees);
      return {
        featureId: state.featureId,
        worktrees,
        containers,
        files,
        branches: [...new Set(worktrees.flatMap((worktree) => worktree.branch ? [worktree.branch] : []))],
      };
    };

    const previewSignature = (value: ArchivePreview): string => JSON.stringify({
      featureId: value.featureId,
      worktrees: value.worktrees.map(({ path, branch, head }) => `${path}\0${branch ?? ""}\0${head}`).sort((a, b) => a.localeCompare(b)),
      containers: value.containers.map(({ id, name }) => `${id}\0${name}`).sort((a, b) => a.localeCompare(b)),
      files: value.files.map(({ originalPath, kind }) => `${kind}\0${originalPath}`).sort((a, b) => a.localeCompare(b)),
      branches: [...value.branches].sort((a, b) => a.localeCompare(b)),
    });

    const assertCurrentInventory = async (expectedState: FeatureState, expectedPreview: ArchivePreview): Promise<FeatureState> => {
      const currentState = await Effect.runPromise(store.load(expectedState.featureId));
      if (currentState.revision !== expectedState.revision) {
        throw new Error(`Feature state changed from revision ${expectedState.revision} to ${currentState.revision}; local cleanup was not started.`);
      }
      const currentPreview = await inspectPreview(currentState);
      if (previewSignature(currentPreview) !== previewSignature(expectedPreview)) {
        throw new Error("Feature resources changed after the archive preview; local cleanup was not started. Inspect the new files, runs, worktrees, or containers and retry.");
      }
      return currentState;
    };

    const assertFilesAndWorktreesCurrent = async (expectedState: FeatureState, expectedPreview: ArchivePreview, storedFiles: readonly StoredFile[]): Promise<void> => {
      const currentState = await Effect.runPromise(store.load(expectedState.featureId));
      if (currentState.revision !== expectedState.revision) throw new Error("Feature state changed during archive cleanup.");
      const worktrees = await inspectWorktrees(currentState);
      const files = await collectFiles(currentState, worktrees);
      const current = previewSignature({ ...expectedPreview, worktrees, files, containers: expectedPreview.containers });
      if (current !== previewSignature(expectedPreview)) throw new Error("Feature files or worktrees changed during archive cleanup; destructive cleanup stopped.");
      for (const file of storedFiles) {
        const content = await readFile(file.originalPath).catch(() => null);
        if (!content || sha256(content) !== file.sha256) throw new Error(`Context file changed during archive cleanup: ${file.originalPath}`);
      }
    };

    const assertMemorySnapshot = async (featureId: string, storedFiles: readonly StoredFile[]): Promise<void> => {
      const expected = storedFiles.filter((file) => file.kind === "memory").map((file) => file.originalPath).sort((a, b) => a.localeCompare(b));
      const current = (await walkFiles(featureDir(featureId))).sort((a, b) => a.localeCompare(b));
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("Feature memory changed during cleanup; local memory was retained.");
      for (const file of storedFiles.filter((candidate) => candidate.kind === "memory")) {
        const content = await readFile(file.originalPath);
        if (sha256(content) !== file.sha256) throw new Error(`Feature memory changed during cleanup: ${file.originalPath}`);
      }
    };

    const preview = (state: FeatureState): Effect.Effect<ArchivePreview, Error> => Effect.tryPromise({
      try: () => inspectPreview(state),
      catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
    });

    const resolveRepository = async (create: boolean): Promise<{ login: string; repository: string; checkout: string }> => {
      const login = await checked("gh", ["api", "user", "--jq", ".login"], { timeout: 15_000 });
      const repository = config.archive.repository.includes("/") ? config.archive.repository : `${login}/${config.archive.repository}`;
      const owner = repository.split("/")[0];
      if (owner !== login) throw new Error(`Archive repository ${repository} does not belong to the active GitHub account ${login}. Run 'gh auth switch --user ${owner}' or change archive.repository.`);
      const view = await exec("gh", ["repo", "view", repository, "--json", "visibility", "--jq", ".visibility"], { timeout: 15_000 });
      if (view.code !== 0) {
        if (!create) throw new Error(`Archive repository ${repository} does not exist for the active GitHub account.`);
        await checked("gh", ["repo", "create", repository, "--private", "--add-readme", "--description", "Private context archives created by pi-feature-flow"], { timeout: 60_000 });
      } else if (view.stdout.trim() !== "PRIVATE") {
        throw new Error(`Archive repository ${repository} is ${view.stdout.trim().toLowerCase()}, not private. Refusing to upload feature context.`);
      }
      const checkout = join(FEATURE_FLOW_ROOT, "archive-repositories", safeRepositoryDirectory(repository));
      return { login, repository, checkout: resolve(checkout) };
    };

    const syncRepository = async (create: boolean): Promise<{ login: string; repository: string; checkout: string }> => {
      const target = await resolveRepository(create);
      if (!await exists(join(target.checkout, ".git"))) {
        await rm(target.checkout, { recursive: true, force: true });
        await mkdir(dirname(target.checkout), { recursive: true, mode: 0o700 });
        await checked("gh", ["repo", "clone", target.repository, target.checkout], { timeout: 120_000 });
      }
      const fetchRemote = await checked("git", ["-C", target.checkout, "remote", "get-url", "origin"]);
      const pushRemote = await checked("git", ["-C", target.checkout, "remote", "get-url", "--push", "origin"]);
      const expectedRepository = target.repository.toLowerCase();
      if (githubRepositoryFromRemote(fetchRemote) !== expectedRepository || githubRepositoryFromRemote(pushRemote) !== expectedRepository) {
        throw new Error(`Managed archive checkout origin does not exactly match ${target.repository}; remove ${target.checkout} and retry.`);
      }
      await checked("git", ["-C", target.checkout, "fetch", "origin", config.archive.branch], { timeout: 120_000 });
      await checked("git", ["-C", target.checkout, "checkout", "-B", config.archive.branch, `origin/${config.archive.branch}`]);
      await checked("git", ["-C", target.checkout, "reset", "--hard", `origin/${config.archive.branch}`]);
      await checked("git", ["-C", target.checkout, "clean", "-ffd"]);
      await checked("git", ["-C", target.checkout, "config", "user.name", target.login]);
      await checked("git", ["-C", target.checkout, "config", "user.email", `${target.login}@users.noreply.github.com`]);
      return target;
    };

    const archive = (state: FeatureState, inventory: ArchivePreview): Effect.Effect<ArchiveResult, Error> => Effect.tryPromise({
      try: () => withArchiveLock(state.featureId, () =>
        Effect.runPromise(store.withArchiveExclusive(state.featureId, async () => {
        if (state.featureId !== inventory.featureId) throw new Error("Archive inventory does not match the feature state.");
        const currentState = await assertCurrentInventory(state, inventory);
        const target = await syncRepository(true);
        const archivePath = join("archives", state.featureId, archiveTimestamp());
        const destinationRoot = join(target.checkout, archivePath);
        await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
        const storedFiles: StoredFile[] = [];
        const usedNames = new Set<string>();
        for (const [index, file] of inventory.files.entries()) {
          const memoryRoot = featureDir(state.featureId);
          let relativePath: string;
          if (file.kind === "memory") {
            const child = relative(memoryRoot, file.originalPath);
            if (child.startsWith("..") || isAbsolute(child)) throw new Error(`Feature memory path escaped its root: ${file.originalPath}`);
            relativePath = join("feature-memory", child);
          } else {
            const base = basename(file.originalPath).replace(/[^a-zA-Z0-9._-]+/g, "-");
            relativePath = join("context", file.kind, `${String(index + 1).padStart(4, "0")}-${base}`);
          }
          if (usedNames.has(relativePath)) throw new Error(`Duplicate archive path: ${relativePath}`);
          usedNames.add(relativePath);
          storedFiles.push(await copyStoredFile(file.originalPath, destinationRoot, relativePath, file.kind));
        }
        const manifest: ArchiveManifest = {
          version: 1,
          featureId: state.featureId,
          title: state.title,
          workItem: state.workItem.key,
          createdAt: new Date().toISOString(),
          sourceHome: "~",
          sourceFeatureRoot: join("feature-flow", "features", state.featureId),
          repository: target.repository,
          files: storedFiles.map((file) => ({ ...file, originalPath: file.homeRelative ?? basename(file.originalPath) })),
          worktrees: inventory.worktrees.map(({ path, branch, head, remoteRefs }) => ({ checkout: basename(path), branch, head, remoteRefs })),
          containers: inventory.containers.map(({ name, image }) => ({ name, image })),
          cleanup: {
            removesWorktrees: true,
            removesLocalBranches: true,
            removesContainers: true,
            restoresRuntimeState: false,
          },
        };
        await writeFile(join(destinationRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
        await checked("git", ["-C", target.checkout, "add", "--", archivePath]);
        await checked("git", ["-C", target.checkout, "commit", "-m", `Archive ${state.workItem.key}: ${state.title}`]);
        await checked("git", ["-C", target.checkout, "push", "origin", config.archive.branch], { timeout: 120_000 });
        const commit = await checked("git", ["-C", target.checkout, "rev-parse", "HEAD"]);
        const remoteCommit = await checked("git", ["-C", target.checkout, "ls-remote", "origin", `refs/heads/${config.archive.branch}`], { timeout: 60_000 });
        if (!remoteCommit.startsWith(commit)) throw new Error("Archive push could not be verified on the remote; local cleanup was not started.");

        await assertCurrentInventory(currentState, inventory);
        for (const file of storedFiles) {
          const content = await readFile(file.originalPath).catch(() => null);
          if (!content || sha256(content) !== file.sha256) {
            throw new Error(`Context file changed while the archive was uploading: ${file.originalPath}. The remote archive is safe, but local cleanup was not started; retry to capture the latest bytes.`);
          }
        }

        const warnings: string[] = [];
        for (const container of inventory.containers) {
          const removed = await exec("docker", ["rm", "-f", "-v", container.id], { timeout: 30_000 });
          if (removed.code !== 0) warnings.push(`Container ${container.name}: ${(removed.stderr || removed.stdout).trim()}`);
        }
        for (const volume of [...new Set(inventory.containers.flatMap((container) => container.volumes))]) {
          const removed = await exec("docker", ["volume", "rm", volume], { timeout: 30_000 });
          if (removed.code !== 0) warnings.push(`Volume ${volume}: ${(removed.stderr || removed.stdout).trim()}`);
        }
        if (warnings.length > 0) {
          throw new Error(`Remote archive is verified, but container cleanup was incomplete; no context files, worktrees, or feature memory were removed. ${warnings.join(" ")}`);
        }

        await assertFilesAndWorktreesCurrent(currentState, inventory, storedFiles);
        const memoryRoot = resolve(featureDir(state.featureId));
        const removedRoots = inventory.worktrees.filter((worktree) => !worktree.primary).map((worktree) => resolve(worktree.path));
        for (const file of storedFiles) {
          const original = resolve(file.originalPath);
          if (original === memoryRoot || original.startsWith(`${memoryRoot}${sep}`)) continue;
          if (removedRoots.some((root) => original === root || original.startsWith(`${root}${sep}`))) continue;
          await rm(original, { force: true }).catch((error) => warnings.push(`File ${original}: ${String(error)}`));
        }
        for (const session of state.sessions) {
          if (!session.asyncDir || !await exists(session.asyncDir)) continue;
          const removed = await removeEmptyTree(session.asyncDir);
          if (!removed) warnings.push(`Run directory ${session.asyncDir} still contains unarchived files and was retained.`);
        }

        for (const worktree of inventory.worktrees.filter((candidate) => !candidate.primary)) {
          const head = await exec("git", ["-C", worktree.path, "rev-parse", "HEAD"], { timeout: 5_000 });
          const status = await exec("git", ["-C", worktree.path, "status", "--porcelain=v1", "--untracked-files=all"], { timeout: 15_000 });
          const remoteRefs = head.code === 0 ? await currentRemoteRefsContaining(worktree.path, head.stdout.trim()) : [];
          if (head.code !== 0 || head.stdout.trim() !== worktree.head || status.code !== 0 || status.stdout.trim() || remoteRefs.length === 0) {
            warnings.push(`Worktree ${worktree.path} changed or is not clean/recoverable; it was retained.`);
            continue;
          }
          const removed = await exec("git", ["-C", worktree.repositoryRoot, "worktree", "remove", worktree.path], { timeout: 60_000 });
          if (removed.code !== 0) warnings.push(`Worktree ${worktree.path}: ${(removed.stderr || removed.stdout).trim()}`);
        }
        for (const repositoryRoot of [...new Set(inventory.worktrees.map((worktree) => worktree.repositoryRoot))]) {
          await exec("git", ["-C", repositoryRoot, "worktree", "prune"], { timeout: 30_000 });
        }
        for (const worktree of inventory.worktrees) {
          if (!worktree.branch) continue;
          const branchRef = `refs/heads/${worktree.branch}`;
          const currentOid = await exec("git", ["-C", worktree.repositoryRoot, "rev-parse", "--verify", branchRef], { timeout: 5_000 });
          if (currentOid.code !== 0) continue;
          const verifiedOid = currentOid.stdout.trim();
          const remoteRefs = await currentRemoteRefsContaining(worktree.repositoryRoot, verifiedOid);
          if (remoteRefs.length === 0) {
            warnings.push(`Branch ${worktree.branch} is no longer recoverable from a live remote and was retained.`);
            continue;
          }
          const deleted = await exec("git", ["-C", worktree.repositoryRoot, "update-ref", "-d", branchRef, verifiedOid], { timeout: 30_000 });
          if (deleted.code !== 0) warnings.push(`Branch ${worktree.branch} changed during deletion and was retained: ${(deleted.stderr || deleted.stdout).trim()}`);
        }
        let localFeatureRemoved = false;
        if (warnings.length === 0) {
          await assertMemorySnapshot(state.featureId, storedFiles);
          await rm(featureDir(state.featureId), { recursive: true, force: true });
          localFeatureRemoved = true;
        } else {
          warnings.push("Local feature memory was retained so incomplete cleanup can be inspected and retried.");
        }

        return {
          featureId: state.featureId,
          repository: target.repository,
          url: `https://github.com/${target.repository}/tree/${encodeURIComponent(config.archive.branch)}/${archivePath.split(sep).map(encodeURIComponent).join("/")}`,
          archivePath,
          localFeatureRemoved,
          warnings,
        };
      }))),
      catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
    });

    const readArchives = async (): Promise<Array<{ summary: ArchiveSummary; manifest: ArchiveManifest; root: string }>> => {
      const target = await syncRepository(false);
      const archiveRoot = join(target.checkout, "archives");
      if (!await exists(archiveRoot)) return [];
      const manifests = await walkFiles(archiveRoot, { filter: (path) => basename(path) === "manifest.json" });
      const entries: Array<{ summary: ArchiveSummary; manifest: ArchiveManifest; root: string }> = [];
      for (const path of manifests) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(await readFile(path, "utf8"));
        } catch {
          continue;
        }
        const manifest = decodeArchiveManifest(decoded);
        if (!manifest) continue;
        const root = dirname(path);
        entries.push({
          manifest,
          root,
          summary: {
            featureId: manifest.featureId,
            title: manifest.title,
            workItem: manifest.workItem,
            createdAt: manifest.createdAt,
            repository: target.repository,
            archivePath: relative(target.checkout, root),
          },
        });
      }
      return entries.sort((a, b) => b.summary.createdAt.localeCompare(a.summary.createdAt));
    };

    const list = (): Effect.Effect<ArchiveSummary[], Error> => Effect.tryPromise({
      try: async () => (await readArchives()).map((entry) => entry.summary),
      catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
    });

    const recover = (featureId: string): Effect.Effect<RecoveryResult, Error> => Effect.tryPromise({
      try: async () => {
        const entry = (await readArchives()).find((candidate) => candidate.summary.featureId === featureId);
        if (!entry) throw new Error(`No remote archive found for ${featureId}.`);
        const finalFeatureRoot = featureDir(featureId);
        if (await exists(finalFeatureRoot)) throw new Error(`Feature ${featureId} already exists locally; refusing to overwrite it.`);
        if (entry.manifest.featureId !== featureId) throw new Error(`Archive manifest identity mismatch for ${featureId}.`);
        const stagingRoot = join(FEATURE_FLOW_ROOT, "recovery-staging", `${featureId}-${randomUUID()}`);
        await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
        const destinations = await Promise.all(entry.manifest.files.map(async (file, index) => {
          const source = await containedRealFile(entry.root, file.archivePath);
          let destination: string;
          let copyDestination: string;
          if (file.kind === "memory") {
            const memoryPath = relative("feature-memory", file.archivePath);
            destination = await safeDestination(FEATURES_ROOT, containedPath(finalFeatureRoot, memoryPath));
            copyDestination = await safeDestination(stagingRoot, containedPath(stagingRoot, memoryPath));
          } else if (file.homeRelative) {
            destination = await safeDestination(homedir(), containedPath(homedir(), file.homeRelative));
            copyDestination = destination;
          } else {
            const fallbackName = `${String(index + 1).padStart(4, "0")}-${basename(file.originalPath)}`;
            destination = await safeDestination(FEATURES_ROOT, containedPath(join(finalFeatureRoot, "recovered-context", file.kind), fallbackName));
            copyDestination = await safeDestination(stagingRoot, containedPath(join(stagingRoot, "recovered-context", file.kind), fallbackName));
          }
          const content = await readFile(source);
          if (sha256(content) !== file.sha256) throw new Error(`Archive checksum mismatch: ${file.archivePath}`);
          const existing = await readFile(destination).catch(() => null);
          if (existing && sha256(existing) !== file.sha256) throw new Error(`Recovery would overwrite a different local file: ${destination}`);
          return { file, source, destination, copyDestination, exists: existing !== null };
        }));
        const uniqueDestinations = new Set(destinations.map((item) => item.destination));
        if (uniqueDestinations.size !== destinations.length) throw new Error("Archive manifest maps multiple files to the same recovery path.");
        let restoredFiles = 0;
        let skippedFiles = 0;
        for (const item of destinations) {
          if (item.exists) { skippedFiles++; continue; }
          await mkdir(dirname(item.copyDestination), { recursive: true, mode: 0o700 });
          await copyFile(item.source, item.copyDestination);
          await chmod(item.copyDestination, item.file.mode).catch(() => undefined);
          restoredFiles++;
        }
        await rename(stagingRoot, finalFeatureRoot);
        return { featureId, restoredFiles, skippedFiles, source: entry.summary };
      },
      catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
    });

    return { preview, archive, list, recover };
  }),
  dependencies: [FeatureConfig.Default, FeatureStore.Default],
}) {}
