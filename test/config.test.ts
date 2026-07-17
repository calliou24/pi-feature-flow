import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Effect } from "effect";

process.env.PI_FEATURE_FLOW_ROOT ??= mkdtempSync(join(tmpdir(), "pi-feature-flow-test-"));
const root = process.env.PI_FEATURE_FLOW_ROOT;

const { FeatureConfig, CONFIG_PATH } = await import("../src/config.ts");

const load = () => Effect.runPromise(Effect.map(FeatureConfig, (service) => service.config).pipe(Effect.provide(FeatureConfig.Default)));

describe("feature config", () => {
  it("provides complete defaults without a config file", async () => {
    const config = await load();
    assert.equal(config.planArtifact.publisher, "file");
    assert.equal(config.turnSnapshot, "compact");
    assert.equal(config.budgets.implementationMaxTurns, 18);
    assert.match(config.routes.worker.model, /\//);
    assert.equal(config.routes.planner.command, "claude");
  });

  it("overrides selectively from config.json", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({
      routes: { worker: { model: "anthropic/claude-fable-5", thinking: "high" } },
      planArtifact: { publisher: "claude-artifact" },
      turnSnapshot: "off",
    }));
    const config = await load();
    assert.equal(config.routes.worker.model, "anthropic/claude-fable-5");
    assert.equal(config.planArtifact.publisher, "claude-artifact");
    assert.equal(config.turnSnapshot, "off");
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
