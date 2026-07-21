import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { extractArtifactToolResults, planHash } from "../src/plan.ts";

const run = promisify(execFile);
const [filePath, title = "Fable implementation plan"] = process.argv.slice(2);
if (!filePath) throw new Error("Usage: publish-artifact.mjs <plan.md> [title]");
await access(filePath);
await run("tmux", ["-V"]);

const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const session = `pi-plan-artifact-${randomUUID().slice(0, 12)}`;
const claudeSessionId = randomUUID();
const cwd = dirname(filePath);

// Pre-stage an exact byte-for-byte copy of the plan inside the scratchpad Claude
// Code will use for this session id, so the publisher session only needs the
// already-allowed Artifact tool. Historically, asking Claude to copy the plan
// itself was the dominant failure mode: it either redesigned the content into
// HTML via the artifact-design skill (hash mismatch) or stalled on an
// unanswered Bash/Write permission prompt (timeout).
const projectSlug = cwd.replace(/[^A-Za-z0-9]/g, "-");
const scratchpadDir = join(tmpdir(), `claude-${process.getuid()}`, projectSlug, claudeSessionId, "scratchpad");
const stagedName = `${title.replace(/[\u0000-\u001f/\\]/g, "-").slice(0, 120).trim() || "plan"}.md`;
const stagedPath = join(scratchpadDir, stagedName);
await mkdir(scratchpadDir, { recursive: true });
await copyFile(filePath, stagedPath);

const command = [
  `cd -- ${quote(cwd)}`,
  `exec claude --session-id ${quote(claudeSessionId)} --model fable --effort low --permission-mode acceptEdits --allowedTools Read,Artifact`,
].join(" && ");
const prompt = [
  `An exact copy of ${filePath} is already staged at "${stagedPath}".`,
  `Publish that staged file with the Artifact tool now, passing its path unchanged, titled ${title}.`,
  `Publish it verbatim: do not rewrite, reformat, redesign, or convert it to HTML, do not invoke any skill, and do not create any other file — the published bytes must equal the staged file exactly.`,
  `If the staged file is missing, recreate it first with: cp ${quote(filePath)} ${quote(stagedPath)}`,
  `Reply with the artifact URL only after the Artifact tool succeeds.`,
].join(" ");
let approvedSkill = false;
let approvedCopy = false;

try {
  await run("tmux", ["new-session", "-d", "-s", session, "-x", "140", "-y", "44", command]);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await run("tmux", ["send-keys", "-t", session, "-l", prompt]);
  await run("tmux", ["send-keys", "-t", session, "Enter"]);

  const deadline = Date.now() + 300_000;
  let lastPane = "";
  let verified = false;
  let mismatchedUrl = null;
  const sourceHash = planHash(await readFile(filePath, "utf8"));
  while (Date.now() < deadline && !verified) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      ({ stdout: lastPane } = await run("tmux", ["capture-pane", "-p", "-t", session, "-S", "-500"]));
    } catch {
      throw new Error("Claude Artifact session exited before returning a URL.");
    }
    const projectEntries = await readdir(join(homedir(), ".claude", "projects"), { recursive: true }).catch(() => []);
    const relativeSessionPath = projectEntries.find((entry) => entry.endsWith(`${claudeSessionId}.jsonl`));
    if (relativeSessionPath) {
      const sessionLog = await readFile(join(homedir(), ".claude", "projects", relativeSessionPath), "utf8");
      for (const publication of extractArtifactToolResults(sessionLog, claudeSessionId)) {
        const publishedSource = await readFile(publication.path, "utf8").catch(() => null);
        if (publishedSource !== null && planHash(publishedSource) === sourceHash) {
          process.stdout.write(`${publication.url}\n`);
          verified = true;
          break;
        }
        mismatchedUrl = publication.url;
      }
    }
    if (verified) break;
    if (!approvedSkill && /Use skill "artifact-design"\?[\s\S]*Do you want to proceed\?/.test(lastPane)) {
      approvedSkill = true;
      await run("tmux", ["send-keys", "-t", session, "2", "Enter"]);
    }
    if (!approvedCopy && /Bash command[\s\S]*\bcp\b[\s\S]*Do you want to proceed\?/.test(lastPane)) {
      approvedCopy = true;
      await run("tmux", ["send-keys", "-t", session, "1", "Enter"]);
    }
    if (/Not logged in · Please run \/login/.test(lastPane)) throw new Error("Claude Artifact publishing is not logged in. Run claude, then /login.");
    if (/Artifact tool (?:isn't|is not) available/i.test(lastPane)) throw new Error("Claude Artifact tool is unavailable in the interactive Claude session.");
  }
  if (!verified && mismatchedUrl) {
    throw new Error(`Published artifact source does not exactly match the current plan.md (last publication: ${mismatchedUrl}).`);
  }
  if (!verified) throw new Error("Timed out waiting for a verified Claude Artifact tool result.");
} finally {
  await run("tmux", ["kill-session", "-t", session]).catch(() => undefined);
}
