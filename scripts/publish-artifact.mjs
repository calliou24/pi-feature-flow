import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { assertPublishedSourceExact, extractArtifactToolResult } from "../src/plan.ts";

const run = promisify(execFile);
const [filePath, title = "Fable implementation plan"] = process.argv.slice(2);
if (!filePath) throw new Error("Usage: publish-artifact.mjs <plan.md> [title]");
await access(filePath);
await run("tmux", ["-V"]);

const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const session = `pi-plan-artifact-${randomUUID().slice(0, 12)}`;
const claudeSessionId = randomUUID();
const command = [
  `cd -- ${quote(dirname(filePath))}`,
  `exec claude --session-id ${quote(claudeSessionId)} --model fable --effort low --permission-mode acceptEdits --allowedTools Read,Artifact`,
].join(" && ");
const prompt = `Read ${filePath} and publish its exact contents with the Artifact tool, titled ${title}. Reply with the artifact URL only after the Artifact tool succeeds.`;
let approvedSkill = false;

try {
  await run("tmux", ["new-session", "-d", "-s", session, "-x", "140", "-y", "44", command]);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await run("tmux", ["send-keys", "-t", session, "-l", prompt]);
  await run("tmux", ["send-keys", "-t", session, "Enter"]);

  const deadline = Date.now() + 300_000;
  let lastPane = "";
  let verified = false;
  while (Date.now() < deadline) {
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
      const publication = extractArtifactToolResult(sessionLog, claudeSessionId);
      if (publication) {
        const [source, publishedSource] = await Promise.all([readFile(filePath, "utf8"), readFile(publication.path, "utf8")]);
        assertPublishedSourceExact(source, publishedSource);
        process.stdout.write(`${publication.url}\n`);
        verified = true;
        break;
      }
    }
    if (!approvedSkill && /Use skill "artifact-design"\?[\s\S]*Do you want to proceed\?/.test(lastPane)) {
      approvedSkill = true;
      await run("tmux", ["send-keys", "-t", session, "2", "Enter"]);
    }
    if (/Not logged in · Please run \/login/.test(lastPane)) throw new Error("Claude Artifact publishing is not logged in. Run claude, then /login.");
    if (/Artifact tool (?:isn't|is not) available/i.test(lastPane)) throw new Error("Claude Artifact tool is unavailable in the interactive Claude session.");
  }
  if (!verified) throw new Error("Timed out waiting for a verified Claude Artifact tool result.");
} finally {
  await run("tmux", ["kill-session", "-t", session]).catch(() => undefined);
}
