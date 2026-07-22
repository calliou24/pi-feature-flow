import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { markdownBody, renderPlanHtml } from "../src/markdown.ts";

const PLAN = `---
revision: 7
---

# Goal

Ship **safe HTML** with a [review link](https://example.com/plan).

## Work packages

- [x] Publish the plan
- Wait for approval

| Stage | Model |
| --- | --- |
| Plan | Fable 5 |

\`\`\`ts
const value = "<safe>";
\`\`\`
`;

describe("plan HTML rendering", () => {
	it("renders common plan Markdown without exposing frontmatter", () => {
		const body = markdownBody(PLAN);
		assert.match(body, /<h1>Goal<\/h1>/);
		assert.match(body, /<strong>safe HTML<\/strong>/);
		assert.match(body, /<table>/);
		assert.match(body, /<pre><code data-language="ts">/);
		assert.doesNotMatch(body, /revision: 7/);
	});

	it("builds a standalone responsive HTML document", () => {
		const html = renderPlanHtml(PLAN, "Review plan", "CRM-1234", 7);
		assert.match(html, /^<!doctype html>/);
		assert.match(html, /Content-Security-Policy/);
		assert.match(html, /CRM-1234 · revision 7/);
		assert.match(html, /<article>/);
	});

	it("escapes raw HTML and rejects unsafe Markdown links", () => {
		const body = markdownBody(
			"<script>alert(1)</script>\n\n[bad](javascript:alert(1))",
		);
		assert.doesNotMatch(body, /<script>/);
		assert.doesNotMatch(body, /href="javascript:/);
		assert.match(body, /&lt;script&gt;/);
	});
});
