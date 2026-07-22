const FRONTMATTER = /^---\s*\n[\s\S]*?\n---\s*/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const BLOCK_START = /^(?:#{1,6}\s+|```|~~~|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+)/;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

export function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) => HTML_ESCAPES[character] ?? character,
	);
}

function safeHref(value: string): string | null {
	const href = value.trim();
	return /^(?:https?:\/\/|mailto:|#)/i.test(href) ? escapeHtml(href) : null;
}

function inlineMarkdown(value: string): string {
	const code: string[] = [];
	let rendered = escapeHtml(value).replace(
		/`([^`\n]+)`/g,
		(_match, contents: string) => {
			const token = `\u0000CODE${code.length}\u0000`;
			code.push(`<code>${contents}</code>`);
			return token;
		},
	);
	rendered = rendered.replace(
		/\[([^\]\n]+)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
		(_match, label: string, href: string) => {
			const safe = safeHref(href);
			return safe ? `<a href="${safe}" rel="noreferrer">${label}</a>` : label;
		},
	);
	rendered = rendered
		.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
		.replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
		.replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
		.replace(/(^|[^\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
	return rendered.replace(
		/\u0000CODE(\d+)\u0000/g,
		(_match, index: string) => code[Number(index)] ?? "",
	);
}

function tableCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

function isTableHeader(lines: string[], index: number): boolean {
	return (
		lines[index]?.includes("|") === true &&
		TABLE_DIVIDER.test(lines[index + 1] ?? "")
	);
}

interface RenderedBlock {
	html: string;
	nextIndex: number;
}

function renderFence(
	lines: string[],
	index: number,
	match: RegExpMatchArray,
): RenderedBlock {
	const marker = match[1] ?? "```";
	const contents: string[] = [];
	let nextIndex = lines.length;
	for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
		const candidate = lines[cursor] ?? "";
		if (candidate.trimStart().startsWith(marker)) {
			nextIndex = cursor + 1;
			break;
		}
		contents.push(candidate);
	}
	const language = match[2] ? ` data-language="${escapeHtml(match[2])}"` : "";
	return {
		html: `<pre><code${language}>${escapeHtml(contents.join("\n"))}</code></pre>`,
		nextIndex,
	};
}

function renderTable(lines: string[], index: number): RenderedBlock {
	const headers = tableCells(lines[index] ?? "");
	const rows: string[][] = [];
	let nextIndex = lines.length;
	for (let cursor = index + 2; cursor < lines.length; cursor += 1) {
		const candidate = lines[cursor] ?? "";
		if (!candidate.includes("|") || !candidate.trim()) {
			nextIndex = cursor;
			break;
		}
		rows.push(tableCells(candidate));
	}
	const headerHtml = headers
		.map((cell) => `<th>${inlineMarkdown(cell)}</th>`)
		.join("");
	const rowHtml = rows
		.map(
			(row) =>
				`<tr>${headers.map((_header, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] ?? "")}</td>`).join("")}</tr>`,
		)
		.join("");
	return {
		html: `<div class="table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${rowHtml}</tbody></table></div>`,
		nextIndex,
	};
}

function renderQuote(lines: string[], index: number): RenderedBlock {
	const quote: string[] = [];
	let nextIndex = lines.length;
	for (let cursor = index; cursor < lines.length; cursor += 1) {
		const candidate = lines[cursor] ?? "";
		if (!/^>\s?/.test(candidate)) {
			nextIndex = cursor;
			break;
		}
		quote.push(candidate.replace(/^>\s?/, ""));
	}
	return {
		html: `<blockquote>${inlineMarkdown(quote.join(" "))}</blockquote>`,
		nextIndex,
	};
}

function renderParagraph(lines: string[], index: number): RenderedBlock {
	const paragraph = [(lines[index] ?? "").trim()];
	let nextIndex = lines.length;
	for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
		const candidate = lines[cursor] ?? "";
		if (
			!candidate.trim() ||
			BLOCK_START.test(candidate) ||
			isTableHeader(lines, cursor)
		) {
			nextIndex = cursor;
			break;
		}
		paragraph.push(candidate.trim());
	}
	return { html: `<p>${inlineMarkdown(paragraph.join(" "))}</p>`, nextIndex };
}

/** Render the plan subset of GitHub-flavored Markdown as safe, static HTML. */
export function markdownBody(markdown: string): string {
	const lines = markdown
		.replace(FRONTMATTER, "")
		.replace(/\r\n/g, "\n")
		.split("\n");
	const output: string[] = [];
	let list: "ul" | "ol" | null = null;

	const closeList = () => {
		if (list) output.push(`</${list}>`);
		list = null;
	};

	for (let index = 0; index < lines.length; ) {
		const line = lines[index] ?? "";
		if (!line.trim()) {
			closeList();
			index += 1;
			continue;
		}

		const fence = line.match(/^\s*(```|~~~)\s*([\w.+-]*)\s*$/);
		if (fence) {
			closeList();
			const rendered = renderFence(lines, index, fence);
			output.push(rendered.html);
			index = rendered.nextIndex;
			continue;
		}

		const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
		if (heading) {
			closeList();
			const level = heading[1]?.length ?? 1;
			output.push(`<h${level}>${inlineMarkdown(heading[2] ?? "")}</h${level}>`);
			index += 1;
			continue;
		}

		if (isTableHeader(lines, index)) {
			closeList();
			const rendered = renderTable(lines, index);
			output.push(rendered.html);
			index = rendered.nextIndex;
			continue;
		}

		const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
		const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
		if (unordered || ordered) {
			const nextList = unordered ? "ul" : "ol";
			if (list !== nextList) {
				closeList();
				list = nextList;
				output.push(`<${list}>`);
			}
			const rawItem = unordered?.[1] ?? ordered?.[1] ?? "";
			const item = rawItem.replace(
				/^\[([ xX])]\s+/,
				(_match, checked: string) =>
					checked.toLowerCase() === "x" ? "☑ " : "☐ ",
			);
			output.push(`<li>${inlineMarkdown(item)}</li>`);
			index += 1;
			continue;
		}

		if (/^>\s?/.test(line)) {
			closeList();
			const rendered = renderQuote(lines, index);
			output.push(rendered.html);
			index = rendered.nextIndex;
			continue;
		}

		closeList();
		const rendered = renderParagraph(lines, index);
		output.push(rendered.html);
		index = rendered.nextIndex;
	}

	closeList();
	return output.join("\n");
}

export function renderPlanHtml(
	markdown: string,
	title: string,
	workItem: string,
	revision: number,
): string {
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(title)} · Plan</title>
  <style>
    :root { color-scheme: light dark; --bg:#0b1020; --panel:#11182d; --text:#e8edf8; --muted:#9ba8c3; --accent:#8bb9ff; --border:#293656; --code:#080d1a; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:16px/1.65 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(920px,calc(100% - 32px)); margin:48px auto; padding:clamp(24px,5vw,56px); background:var(--panel); border:1px solid var(--border); border-radius:18px; box-shadow:0 24px 80px #0006; }
    header { padding-bottom:24px; margin-bottom:32px; border-bottom:1px solid var(--border); }
    .eyebrow { color:var(--accent); font-size:.78rem; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
    h1,h2,h3,h4 { line-height:1.25; margin:1.6em 0 .55em; }
    header h1 { margin:.35rem 0 .5rem; font-size:clamp(2rem,5vw,3.25rem); }
    .meta { color:var(--muted); }
    a { color:var(--accent); }
    code { padding:.15em .35em; background:var(--code); border:1px solid var(--border); border-radius:5px; font: .9em ui-monospace,SFMono-Regular,Consolas,monospace; }
    pre { overflow:auto; padding:18px; background:var(--code); border:1px solid var(--border); border-radius:10px; }
    pre code { padding:0; border:0; background:transparent; }
    blockquote { margin:1.5rem 0; padding:.5rem 1.2rem; color:var(--muted); border-left:4px solid var(--accent); }
    li { margin:.3rem 0; }
    .table-wrap { overflow-x:auto; }
    table { width:100%; border-collapse:collapse; margin:1.5rem 0; }
    th,td { padding:.65rem .8rem; text-align:left; vertical-align:top; border:1px solid var(--border); }
    th { background:var(--code); }
    @media (prefers-color-scheme: light) { :root { --bg:#edf2fb; --panel:#fff; --text:#172033; --muted:#5d6880; --accent:#1859b7; --border:#d8dfec; --code:#f4f6fa; } main { box-shadow:0 24px 80px #24405b1c; } }
    @media (max-width:600px) { main { width:100%; margin:0; min-height:100vh; border:0; border-radius:0; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">Implementation plan</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">${escapeHtml(workItem)} · revision ${revision}</div>
    </header>
    <article>${markdownBody(markdown)}</article>
  </main>
</body>
</html>\n`;
}
