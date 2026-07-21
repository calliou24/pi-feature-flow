import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FeatureConfig } from "../src/config.ts";
import { PiApi } from "../src/pi-api.ts";
import {
  ASYNC_COMPLETE_EVENT,
  RPC_REPLY_PREFIX,
  RPC_REQUEST_EVENT,
  SubagentGateway,
} from "../src/subagents.ts";

interface RpcRequest {
  requestId: string;
}

class FakeEventBus {
  readonly handlers = new Map<string, Set<(value: unknown) => void>>();

  on(event: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
    if (event !== RPC_REQUEST_EVENT) return;
    const request = value as RpcRequest;
    queueMicrotask(() => {
      this.emit(`${RPC_REPLY_PREFIX}${request.requestId}`, {
        success: true,
        data: { details: { runId: "planner-run", asyncDir: "/tmp/planner-run" } },
      });
      this.emit(ASYNC_COMPLETE_EVENT, {
        runId: "planner-run",
        asyncDir: "/tmp/planner-run",
        results: [{ status: "completed", summary: "# Goal\n\nPlan", sessionPath: "/tmp/session.jsonl" }],
      });
    });
  }
}

function gatewayLayer(events: FakeEventBus) {
  const pi = { events } as unknown as ExtensionAPI;
  return SubagentGateway.Default.pipe(
    Layer.provide(FeatureConfig.Default),
    Layer.provide(Layer.succeed(PiApi, pi)),
  );
}

describe("subagent gateway", () => {
  it("waits for a detached planner run and returns its final output", async () => {
    const events = new FakeEventBus();
    const result = await Effect.runPromise(
      Effect.flatMap(SubagentGateway, (gateway) => gateway.run({
        agent: "feature-planner",
        task: "Plan the feature",
        model: "anthropic/claude-fable-5",
        thinking: "high",
        cwd: "/tmp",
        maxTurns: 12,
      })).pipe(Effect.provide(gatewayLayer(events))),
    );

    assert.equal(result.runId, "planner-run");
    assert.equal(result.output, "# Goal\n\nPlan");
    assert.equal(result.sessionPath, "/tmp/session.jsonl");
  });
});
