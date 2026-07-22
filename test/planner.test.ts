import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { normalizedServePath, PlanPublisher, tailscaleDnsName } from "../src/planner.ts";

describe("PlanPublisher helpers", () => {
  it("exports the renamed publication service", () => {
    assert.equal(typeof PlanPublisher, "function");
  });

  it("normalizes and validates serve paths", () => {
    assert.equal(normalizedServePath("/team/feature-plans/"), "/team/feature-plans");
    assert.equal(normalizedServePath("bad path"), null);
  });

  it("normalizes the tailnet DNS name", () => {
    assert.equal(
      tailscaleDnsName(JSON.stringify({ Self: { DNSName: "ubuntu-desktop.example.ts.net." } })),
      "ubuntu-desktop.example.ts.net",
    );
  });

  it("rejects missing and malformed status payloads", () => {
    assert.equal(tailscaleDnsName("not-json"), null);
    assert.equal(tailscaleDnsName(JSON.stringify({ Self: {} })), null);
  });
});
