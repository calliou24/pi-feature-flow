import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  composeContinuationContext,
  extractArtifactUrl,
  implementationProblem,
  markdownRevision,
  planArtifactProblem,
  planHash,
  validationVerdictFromContents,
} from "../src/plan.ts";
import type { FeatureState } from "../src/domain.ts";

const PLAN = "---\nfeature_id: f\nwork_item: F-1\nrevision: 4\nupdated_at: now\nauthor: planner\n---\n\n# Plan\n";

describe("plan artifact gate", () => {
  const artifact = { url: "https://ubuntu-desktop.example.ts.net/feature-plans/f/plan-rev4.md", publishedAt: "now", planRevision: 4, planHash: planHash(PLAN) };

  it("extracts revision from frontmatter", () => {
    assert.equal(markdownRevision(PLAN), 4);
    assert.equal(markdownRevision("# no frontmatter"), null);
  });

  it("accepts a matching published plan", () => {
    assert.equal(planArtifactProblem(PLAN, artifact), null);
  });

  it("rejects unpublished or stale plans", () => {
    assert.ok(planArtifactProblem(PLAN, null));
    assert.ok(planArtifactProblem(`${PLAN}\nchanged`, artifact));
    assert.ok(planArtifactProblem(PLAN, { ...artifact, planRevision: 3 }));
  });

  it("requires an approved checkpoint for implementation", () => {
    const now = new Date().toISOString();
    assert.ok(implementationProblem({ kind: "plan", status: "pending", updatedAt: now }, PLAN, artifact));
    assert.equal(implementationProblem({ kind: "plan", status: "approved", updatedAt: now }, PLAN, artifact), null);
  });

  it("accepts Tailscale HTTPS and local file URLs", () => {
    assert.equal(extractArtifactUrl("published file:///home/x/plan-rev4.md ok"), "file:///home/x/plan-rev4.md");
    assert.equal(
      extractArtifactUrl("see https://ubuntu-desktop.example.ts.net/feature-plans/f/plan-rev4.md"),
      "https://ubuntu-desktop.example.ts.net/feature-plans/f/plan-rev4.md",
    );
    assert.equal(extractArtifactUrl("see https://public.example.com/plan.md"), null);
    assert.equal(extractArtifactUrl("nothing here"), null);
  });
});

describe("validation verdict", () => {
  it("reads PASS from the last assistant message in a jsonl session", () => {
    const jsonl = [
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "working..." }] } }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "PASS — no blockers." }] } }),
    ].join("\n");
    const verdict = validationVerdictFromContents([jsonl]);
    assert.equal(verdict.passed, true);
  });

  it("treats anything else as blocked", () => {
    const verdict = validationVerdictFromContents(["BLOCKED: missing tests"]);
    assert.equal(verdict.passed, false);
    assert.match(verdict.summary, /BLOCKED/);
  });

  it("handles plain-text transcripts", () => {
    const verdict = validationVerdictFromContents(["PASS everything checks out"]);
    assert.equal(verdict.passed, true);
  });
});

describe("continuation context", () => {
  it("composes a bounded handoff", () => {
    const state = {
      version: 3, featureId: "f-1", title: "Test", workItem: { kind: "feature", key: "f-1", source: "f-1" },
      project: { cwd: "/tmp" }, status: "planning", activeStage: "planning",
      createdAt: "now", updatedAt: "now", revision: 1,
      checkpoint: { kind: "none", status: "none", updatedAt: "now" },
      planArtifact: null, sessions: [], executionLease: null, lastKnownGit: null, lastError: null,
    } as unknown as FeatureState;
    const text = composeContinuationContext(state, { assumptions: "a", decisions: "d", plan: "p", threadLog: "t" }, { status: "", log: "abc123 init" });
    assert.match(text, /# Continue: Test/);
    assert.match(text, /clean/);
    assert.match(text, /## plan/);
  });
});
