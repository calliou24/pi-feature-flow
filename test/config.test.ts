import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Effect } from "effect";

process.env.PI_FEATURE_FLOW_ROOT ??= mkdtempSync(join(tmpdir(), "pi-feature-flow-test-"));
const root = process.env.PI_FEATURE_FLOW_ROOT;

const { FeatureConfig, CONFIG_PATH } = await import("../src/config.ts");

const load = () => Effect.runPromise(Effect.map(FeatureConfig, (service) => service.config).pipe(Effect.provide(FeatureConfig.Default)));

describe("main session model ownership", () => {
  it("does not let feature flow change the active Pi model or thinking level", () => {
    const extension = readFileSync(new URL("../extensions/feature-flow.ts", import.meta.url), "utf8");
    assert.doesNotMatch(extension, /\bpi\.setModel\s*\(/);
    assert.doesNotMatch(extension, /\bpi\.setThinkingLevel\s*\(/);
  });
});

describe("feature config", () => {
  it("provides complete defaults without a config file", async () => {
    const config = await load();
    assert.equal(config.planArtifact.publisher, "file");
    assert.equal(config.turnSnapshot, "compact");
    assert.equal(config.budgets.implementationMaxTurns, 18);
    assert.match(config.routes.worker.model, /\//);
    assert.deepEqual(Object.keys(config.routes).sort((left, right) => left.localeCompare(right)), ["adversary", "oracle", "planner", "validator", "worker"]);
    assert.equal(config.routes.planner.command, "claude");
    assert.equal(config.archive.repository, "pi-feature-archives");
    assert.equal(config.archive.branch, "main");
    assert.ok(config.archive.searchRoots.length > 0);
  });

  it("overrides selectively from config.json", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({
      routes: {
        // Deprecated main-session routes are ignored so an old config cannot
        // reintroduce model switching or invalidate the remaining overrides.
        interactivePlanning: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
        execution: { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
        worker: { model: "anthropic/claude-fable-5", thinking: "high" },
      },
      planArtifact: { publisher: "claude-artifact" },
      turnSnapshot: "off",
      archive: { repository: "private-feature-context", extraPaths: ["reports/{featureId}.md"] },
    }));
    const config = await load();
    assert.equal(config.routes.worker.model, "anthropic/claude-fable-5");
    assert.equal("interactivePlanning" in config.routes, false);
    assert.equal("execution" in config.routes, false);
    assert.equal(config.planArtifact.publisher, "claude-artifact");
    assert.equal(config.turnSnapshot, "off");
    assert.equal(config.archive.repository, "private-feature-context");
    assert.deepEqual(config.archive.extraPaths, ["reports/{featureId}.md"]);
    // untouched defaults survive
    assert.equal(config.routes.adversary.model, "openai-codex/gpt-5.6-sol");
    assert.equal(config.budgets.rpcReplyTimeoutMs, 20_000);
  });

  it("falls back to defaults on malformed json", async () => {
    writeFileSync(CONFIG_PATH, "{not json");
    const config = await load();
    assert.equal(config.planArtifact.publisher, "file");
  });
});
