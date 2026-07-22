import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FeatureConfig } from "../src/config.ts";
import { PiApi } from "../src/pi-api.ts";
import { RPC_REPLY_PREFIX, RPC_REQUEST_EVENT, SubagentGateway } from "../src/subagents.ts";

interface RpcRequest {
  requestId: string;
  params: Record<string, unknown>;
}

class FakeEventBus {
  readonly handlers = new Map<string, Set<(value: unknown) => void>>();
  request: RpcRequest | null = null;
  replyCount = 0;

  on(event: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
    if (event !== RPC_REQUEST_EVENT) return;
    this.request = value as RpcRequest;
    queueMicrotask(() => {
      this.replyCount += 1;
      this.emit(`${RPC_REPLY_PREFIX}${this.request!.requestId}`, {
        success: true,
        data: { details: { runId: "parallel-run", asyncDir: "/tmp/parallel-run" } },
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
  it("spawns parallel tasks in one worktree RPC and handles one reply", async () => {
    const events = new FakeEventBus();
    const tasks = Array.from({ length: 5 }, (_, index) => ({ agent: "feature-worker", task: `Package ${index + 1}` }));
    const result = await Effect.runPromise(
      Effect.flatMap(SubagentGateway, (gateway) => gateway.spawnParallel(
        tasks,
        { model: "openai-codex/gpt-5.6-sol", thinking: "low", cwd: "/repo", maxTurns: 18 },
        true,
      )).pipe(Effect.provide(gatewayLayer(events))),
    );

    assert.deepEqual(result, { runId: "parallel-run", asyncDir: "/tmp/parallel-run" });
    assert.equal(events.replyCount, 1);
    assert.deepEqual(events.request?.params.tasks, tasks.map((task) => ({ ...task, model: "openai-codex/gpt-5.6-sol" })));
    assert.equal(events.request?.params.worktree, true);
    assert.equal(events.request?.params.concurrency, 4);
    assert.equal(events.request?.params.async, true);
  });
});
