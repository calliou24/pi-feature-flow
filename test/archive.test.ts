import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { containedPath, containedRealFile, featureTokens, githubRepositoryFromRemote, isContextOnlyFile, isFeatureRelated, parsePorcelainPaths, safeDestination } from "../src/archive.ts";

describe("feature archive discovery", () => {
  const state = {
    featureId: "crm-9748",
    workItem: { kind: "jira" as const, key: "CRM-9748", source: "CRM-9748" },
  };
  const tokens = featureTokens(state);

  it("matches delimited feature worktrees and containers without loose substring matches", () => {
    assert.equal(isFeatureRelated("/worktrees/CRM-9748-stale-lease-reconciliation", tokens), true);
    assert.equal(isFeatureRelated("crm-db-wt-CRM-9748-stale-lease-reconciliation", tokens), true);
    assert.equal(isFeatureRelated("/worktrees/CRM-97480-unrelated", tokens), false);
    assert.equal(isFeatureRelated("crm-db-main", tokens), false);
  });

  it("accepts feature context while rejecting source, project config, and database artifacts", () => {
    assert.equal(isContextOnlyFile("notes/CRM-9748-handoff.md", tokens), true);
    assert.equal(isContextOnlyFile("reports/output.jsonl", tokens), true);
    assert.equal(isContextOnlyFile("artifacts/CRM-9748-recover.py", tokens), true);
    assert.equal(isContextOnlyFile("scripts/recover.py", tokens), false);
    assert.equal(isContextOnlyFile("backend/api/views.py", tokens), false);
    assert.equal(isContextOnlyFile("src/CRM-9748-model.ts", tokens), false);
    assert.equal(isContextOnlyFile("package.json", tokens), false);
    assert.equal(isContextOnlyFile("docker-compose.yml", tokens), false);
    assert.equal(isContextOnlyFile("config/production.yaml", tokens), false);
    assert.equal(isContextOnlyFile("db/CRM-9748.dump", tokens), false);
  });

  it("canonicalizes only exact GitHub SSH and HTTPS archive remotes", () => {
    assert.equal(githubRepositoryFromRemote("https://github.com/calliou24/pi-feature-archives.git"), "calliou24/pi-feature-archives");
    assert.equal(githubRepositoryFromRemote("git@github.com:calliou24/pi-feature-archives.git"), "calliou24/pi-feature-archives");
    assert.equal(githubRepositoryFromRemote("/tmp/calliou24/pi-feature-archives"), null);
    assert.equal(githubRepositoryFromRemote("https://example.com/calliou24/pi-feature-archives.git"), null);
  });

  it("rejects archive source and recovery destinations that escape their roots", () => {
    assert.equal(containedPath("/tmp/archive", "context/item.md"), "/tmp/archive/context/item.md");
    assert.throws(() => containedPath("/tmp/archive", "../../etc/passwd"), /escapes its allowed root/);
    assert.throws(() => containedPath("/home/user", "/tmp/pwn"), /escapes its allowed root/);
  });

  it("rejects archive and recovery paths whose existing ancestors escape through symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "feature-archive-root-"));
    const outside = await mkdtemp(join(tmpdir(), "feature-archive-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"));
    await assert.rejects(containedRealFile(root, "escape/secret.txt"), /escapes its allowed root/);
    await mkdir(join(root, "safe"));
    await assert.rejects(safeDestination(root, join(root, "escape", "new.txt")), /(uses a symlink|escapes its allowed root)/);
  });

  it("parses NUL-delimited porcelain output without trimming its leading status column", () => {
    assert.deepEqual(parsePorcelainPaths(" M docs/plan.md\0?? reports/result.json\0"), [
      { status: " M", path: "docs/plan.md" },
      { status: "??", path: "reports/result.json" },
    ]);
  });

  it("deduplicates equivalent feature identity tokens", () => {
    assert.deepEqual(tokens, ["crm-9748"]);
  });
});
