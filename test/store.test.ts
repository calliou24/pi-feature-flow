import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { Effect, Either } from "effect";

process.env.PI_FEATURE_FLOW_ROOT = mkdtempSync(join(tmpdir(), "pi-feature-flow-test-"));

const { FeatureStore, featureDir } = await import("../src/store.ts");

const run = <A, E>(effect: Effect.Effect<A, E, InstanceType<typeof FeatureStore>>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(FeatureStore.Default)) as Effect.Effect<A, E, never>).catch((error) => {
    throw error instanceof Error ? error : new Error(String(error));
  });

describe("feature store", () => {
  before(() => run(Effect.flatMap(FeatureStore, (store) => store.ensureRoots())));

  it("creates a feature with jira identity and seed artifacts", async () => {
    const state = await run(Effect.flatMap(FeatureStore, (store) => store.create("CRM-42", "Fix pagination", "/tmp/project")));
    assert.equal(state.featureId, "crm-42");
    assert.equal(state.workItem.kind, "jira");
    assert.equal(state.status, "planning");
    const assumptions = await readFile(join(featureDir("crm-42"), "assumptions.md"), "utf8");
    assert.match(assumptions, /# Assumptions/);
    const ledger = await readFile(join(featureDir("crm-42"), "ledger.jsonl"), "utf8");
    assert.match(ledger, /feature\.created/);
  });

  it("rejects duplicate creation", async () => {
    const result = await run(Effect.flatMap(FeatureStore, (store) => store.create("CRM-42", "Again", "/tmp")).pipe(Effect.either));
    assert.ok(Either.isLeft(result));
  });

  it("round-trips state through update with revision bump", async () => {
    const updated = await run(Effect.flatMap(FeatureStore, (store) =>
      store.update("crm-42", (draft) => { draft.status = "awaiting-approval"; })
    ));
    assert.equal(updated.status, "awaiting-approval");
    assert.equal(updated.revision, 2);
    const loaded = await run(Effect.flatMap(FeatureStore, (store) => store.load("crm-42")));
    assert.equal(loaded.status, "awaiting-approval");
  });

  it("aborts update when mutate throws, leaving state untouched", async () => {
    const result = await run(Effect.flatMap(FeatureStore, (store) =>
      store.update("crm-42", () => { throw new Error("nope"); })
    ).pipe(Effect.either));
    assert.ok(Either.isLeft(result));
    const loaded = await run(Effect.flatMap(FeatureStore, (store) => store.load("crm-42")));
    assert.equal(loaded.revision, 2);
  });

  it("artifact appends do not bump the state revision", async () => {
    await run(Effect.flatMap(FeatureStore, (store) => store.appendArtifact("crm-42", "decisions", "Choice", "Use X.", "test")));
    const loaded = await run(Effect.flatMap(FeatureStore, (store) => store.load("crm-42")));
    assert.equal(loaded.revision, 2);
    const decisions = await run(Effect.flatMap(FeatureStore, (store) => store.readArtifact("crm-42", "decisions")));
    assert.match(decisions, /## Choice/);
  });

  it("replaceArtifact stamps frontmatter with the next revision", async () => {
    const revision = await run(Effect.flatMap(FeatureStore, (store) => store.replaceArtifact("crm-42", "plan", "# The plan", "planner")));
    const plan = await run(Effect.flatMap(FeatureStore, (store) => store.readArtifact("crm-42", "plan")));
    assert.match(plan, new RegExp(`revision: ${revision}`));
  });

  it("enforces single execution lease", async () => {
    const lease = { token: "t1", stage: "implementation" as const, ownerSessionId: null, createdAt: new Date().toISOString() };
    await run(Effect.flatMap(FeatureStore, (store) => store.reserveExecution("crm-42", lease, () => Effect.void)));
    const second = await run(Effect.flatMap(FeatureStore, (store) =>
      store.reserveExecution("crm-42", { ...lease, token: "t2" }, () => Effect.void)
    ).pipe(Effect.either));
    assert.ok(Either.isLeft(second));

    const wrongToken = await run(Effect.flatMap(FeatureStore, (store) => store.releaseExecution("crm-42", "t2")).pipe(Effect.either));
    assert.ok(Either.isLeft(wrongToken));
    const released = await run(Effect.flatMap(FeatureStore, (store) => store.releaseExecution("crm-42", "t1")));
    assert.equal(released.executionLease, null);
    const forced = await run(Effect.flatMap(FeatureStore, (store) => store.releaseExecution("crm-42", "whatever", true)));
    assert.equal(forced.executionLease, null);
  });

  it("lease reservation runs the validation gate", async () => {
    const lease = { token: "t3", stage: "validation" as const, ownerSessionId: null, createdAt: new Date().toISOString() };
    const rejected = await run(Effect.flatMap(FeatureStore, (store) =>
      store.reserveExecution("crm-42", lease, () => Effect.fail(new Error("not ready")))
    ).pipe(Effect.either));
    assert.ok(Either.isLeft(rejected));
  });

  it("lists features sorted by recency and skips malformed ones", async () => {
    await run(Effect.flatMap(FeatureStore, (store) => store.create("other-feature", "Other", "/tmp")));
    const states = await run(Effect.flatMap(FeatureStore, (store) => store.list()));
    assert.deepEqual(states.map((state) => state.featureId), ["other-feature", "crm-42"]);
  });

  it("refuses ids that escape the root", async () => {
    await assert.rejects(run(Effect.flatMap(FeatureStore, (store) => store.load("../escape"))), /escapes feature-flow root/);
  });
});
