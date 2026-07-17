import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Either } from "effect";
import { identifyWorkItem, normalizeFeatureId, normalizeTitle, validateNamingCommand } from "../src/identity.ts";

function unwrap<A>(either: Either.Either<A, { message: string }>): A {
  if (Either.isLeft(either)) throw new Error(either.left.message);
  return either.right;
}

describe("identity", () => {
  it("prefers jira keys", () => {
    const { featureId, identity } = unwrap(identifyWorkItem("Fix crm-9101 pagination"));
    assert.equal(identity.kind, "jira");
    assert.equal(identity.key, "CRM-9101");
    assert.equal(featureId, "crm-9101");
  });

  it("detects pr urls and short forms", () => {
    assert.equal(unwrap(identifyWorkItem("https://github.com/a/b/pull/512")).identity.key, "PR-512");
    assert.equal(unwrap(identifyWorkItem("#512")).identity.key, "PR-512");
    assert.equal(unwrap(identifyWorkItem("pr 512")).identity.key, "PR-512");
  });

  it("falls back to a stable feature name", () => {
    const { featureId, identity } = unwrap(identifyWorkItem("Dashboard Transcript Polish!"));
    assert.equal(identity.kind, "feature");
    assert.equal(featureId, "dashboard-transcript-polish");
  });

  it("rejects unusable ids", () => {
    assert.ok(Either.isLeft(normalizeFeatureId("???")));
  });

  it("rejects oversized titles", () => {
    assert.ok(Either.isLeft(normalizeTitle("x".repeat(200), "fallback")));
    assert.equal(unwrap(normalizeTitle("  spaced   title ", "f")), "spaced title");
  });
});

describe("naming guard", () => {
  const prefix = "CRM-9101";

  it("accepts compliant commands", () => {
    assert.equal(validateNamingCommand(`git checkout -b ${prefix}-fix-pagination`, prefix), null);
    assert.equal(validateNamingCommand(`git commit -m "${prefix} Fix pagination"`, prefix), null);
    assert.equal(validateNamingCommand(`gh pr create --title "${prefix} Fix pagination" --body x`, prefix), null);
    assert.equal(validateNamingCommand("git status", prefix), null);
  });

  it("blocks non-compliant branch creation, rename, and worktree", () => {
    assert.equal(validateNamingCommand("git checkout -b fix-pagination", prefix)?.kind, "branch");
    assert.equal(validateNamingCommand("git switch -c other-thing", prefix)?.kind, "branch");
    assert.equal(validateNamingCommand("git branch -m old new-name", prefix)?.kind, "branch");
    assert.equal(validateNamingCommand("git worktree add ../wt -b nope", prefix)?.kind, "branch");
  });

  it("blocks non-compliant commit messages including -am and --message=", () => {
    assert.equal(validateNamingCommand('git commit -m "Fix pagination"', prefix)?.kind, "commit");
    assert.equal(validateNamingCommand('git commit -am "Fix pagination"', prefix)?.kind, "commit");
    assert.equal(validateNamingCommand(`git commit -am "${prefix} Fix pagination"`, prefix), null);
    assert.equal(validateNamingCommand('git commit --message="Fix pagination"', prefix)?.kind, "commit");
  });

  it("blocks unverifiable message-from-file commits", () => {
    assert.equal(validateNamingCommand("git commit -F msg.txt", prefix)?.kind, "commit");
  });

  it("allows amend --no-edit", () => {
    assert.equal(validateNamingCommand("git commit --amend --no-edit", prefix), null);
  });

  it("checks each chained segment including || chains", () => {
    assert.equal(validateNamingCommand(`git add -A && git commit -m "bad"`, prefix)?.kind, "commit");
    assert.equal(validateNamingCommand(`true || git checkout -b bad-branch`, prefix)?.kind, "branch");
  });

  it("blocks pr edits without the prefix", () => {
    assert.equal(validateNamingCommand('gh pr edit 12 --title "Something"', prefix)?.kind, "pr-title");
  });
});
