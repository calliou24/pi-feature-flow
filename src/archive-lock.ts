import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { FEATURE_FLOW_ROOT } from "./config.ts";

const ARCHIVE_LOCKS_ROOT = join(FEATURE_FLOW_ROOT, "archive-locks");

interface ArchiveLockRecord {
  token: string;
  pid: number;
  createdAt: string;
}

export function archiveLockPath(featureId: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(featureId)) throw new Error(`Invalid feature id for archive lock: ${featureId}`);
  return join(ARCHIVE_LOCKS_ROOT, `${featureId}.lock`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function decodeLock(raw: string): ArchiveLockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<ArchiveLockRecord>;
    if (typeof value.token !== "string" || typeof value.pid !== "number" || !Number.isInteger(value.pid) || typeof value.createdAt !== "string") return null;
    return value as ArchiveLockRecord;
  } catch {
    return null;
  }
}

export async function archiveLocked(featureId: string): Promise<boolean> {
  const path = archiveLockPath(featureId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  const lock = decodeLock(raw);
  // A newly created file can be observed before its owner writes metadata.
  // Treat malformed/initializing locks as held; never delete another owner's lock.
  if (!lock) return true;
  if (processAlive(lock.pid)) return true;
  await rm(path, { force: true }).catch(() => undefined);
  return false;
}

export async function assertArchiveUnlocked(featureId: string): Promise<void> {
  if (await archiveLocked(featureId)) throw new Error(`Feature '${featureId}' is being archived; retry after archive cleanup finishes.`);
}

export async function withArchiveLock<A>(featureId: string, run: () => Promise<A>): Promise<A> {
  await mkdir(ARCHIVE_LOCKS_ROOT, { recursive: true, mode: 0o700 });
  if (await archiveLocked(featureId)) throw new Error(`Feature '${featureId}' already has an archive operation in progress.`);
  const path = archiveLockPath(featureId);
  const token = randomUUID();
  const handle = await open(path, "wx", 0o600).catch(() => {
    throw new Error(`Feature '${featureId}' already has an archive operation in progress.`);
  });
  try {
    await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    return await run();
  } finally {
    await handle.close().catch(() => undefined);
    const current = await readFile(path, "utf8").then(decodeLock, () => null);
    if (current?.token === token) await rm(path, { force: true }).catch(() => undefined);
  }
}
