import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { tailscaleDnsName } from "../src/planner.ts";

describe("Tailscale plan publication", () => {
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
