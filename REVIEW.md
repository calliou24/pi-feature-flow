# Review: the vibecoded feature-system (2026-07-16)

This document reviews the original implementation that lived in
`~/.pi/agent/extensions/feature-system/` (plus `~/.pi/agent/agents/feature-*.md`
and `~/.pi/agent/feature-system/config.json`), reconstructs the intent from the
day's Pi session transcripts, and explains what this repository changes.

## 1. Intent recovered from the session transcripts

The design emerged across several sessions on 2026-07-16 (notably
`14-44-15` / `19-15-21` for the workflow, `16-07-53` for UI/ask_user polish,
`21-55-39` for the `/feature` UX). The stable requirements the user converged on:

1. **Model economics drive the architecture.** "Terra does not write very good
   code… Sol overshoots… the only model that writes better code is Fable 5, but
   asking Fable to do a whole integration is shooting yourself in the feet on
   cost." → route *interactive planning* to Sol-high (grill-me style
   questioning), *plan writing* to Fable via the Claude CLI, *implementation
   and validation* to Terra-high, *cheap recon* to Terra-low.
2. **Staged subagents run programmatically per feature stage**, plus a
   **decision vault**: per-feature `assumptions.md`, `decisions.md`, `plan.md`,
   `thread-log.md`, identified by **Jira key → PR → feature name**.
3. **Naming traceability**: branches `<KEY>-kebab`, commits `<KEY> …`,
   PR titles `<KEY> …`, enforced at tool-call time.
4. **Exactly one human checkpoint**: plan approval. "I should only approve the
   plan step; the next review and validation/implementation should be done
   automatically. And the final accept does not make sense."
5. **Explicit trigger only**: "this is being triggered every time — I don't
   want that; I want a feature workflow only when I trigger it."
6. **`/feature` UX**: `new` takes no parameters (editor opens; the agent infers
   identity and a ≤96-char title — the earlier version leaked the whole prompt
   into the footer); bare `/feature` is a selector; *resume = fresh handoff
   session with composed context, never jumping back into an old thread*.
7. **ask_user quality**: one question per item, batch independent questions,
   always offer a Custom (free-text) answer like Claude Code.
8. **The plan must be published for review as an artifact URL.**

The rewrite keeps all eight. They are good requirements; most problems were in
the execution.

## 2. What was structurally wrong

### 2.1 A 772-line monolith

`index.ts` mixed the state machine, pi-subagents RPC plumbing, TUI widgets,
naming enforcement, session bookkeeping, artifact publishing, model switching,
slash-command parsing, and two tool definitions. Nothing was independently
testable except what had been manually extracted (`naming.ts`, `artifact.ts`).

### 2.2 Dead configuration (the worst bug)

`~/.pi/agent/feature-system/config.json` declared a complete `routes` block —
and **nothing ever read it**. `modelRoute()` in `index.ts` hardcoded
`openai-codex/gpt-5.6-*` strings, and `switchMainModel()` hardcoded the
provider. The config file was documentation cosplaying as configuration; the
two had already drifted (config said planner = interactive sol, code also
switched the *main session* model as a side effect). **Fixed:** `src/config.ts`
is a schema-validated `FeatureConfig` service with defaults; every model
reference resolves through it.

### 2.3 Three data planes in one Markdown file

`thread-log.md` served as (a) human narrative, (b) machine ledger — JSON blocks
appended via `appendLedger` — and (c) a per-turn snapshot dump. It grew without
bound and was fed back into prompts via `slice(-5000)`, which happily cuts a
JSON block in half. **Fixed:** machine events go to `ledger.jsonl`
(append-only JSONL); `thread-log.md` keeps only human-readable sections.

### 2.4 Revision meant nothing

`appendArtifact` bumped `state.revision` on *every* append — including the
automatic per-turn snapshot — so the revision could not be used as a
concurrency token. **Fixed:** only state mutations bump the revision; artifact
appends do not (covered by a test).

### 2.5 No project hygiene

No `package.json`, no lockfile, no VCS, tests were ad-hoc `.mjs` harnesses in a
hidden dotfile directory, and one of them (`plan-artifact.test.mjs`) shadowed a
directory listing bug. **Fixed:** proper pi package, `npm test` via `node --test`,
typecheck via `tsc --noEmit`, git repo.

## 3. Overshoots (things that did more than the intent required)

1. **`publish-artifact.mjs` tmux puppetry.** To satisfy "plan as a Claude
   Artifact URL", the extension spawns tmux, drives the *interactive* Claude
   CLI, scrapes pane text with regexes, auto-answers a skill-approval prompt
   (`send-keys "2" Enter`), and greps `~/.claude/projects/**` internals to
   verify the publication. Any Claude UI change breaks it silently at up to
   300 s per attempt × 2 attempts. **Kept but demoted:** it is now an isolated
   adapter behind `PlanPublisher`, selected by `planArtifact.publisher:
   "claude-artifact"`. The default is a `file` publisher (copy + `file://` URL)
   that can never flake. The approval gate accepts either URL form.
2. **`factualSnapshot` on every settled turn** appended user/assistant excerpts
   + git state to thread-log — directly contradicting the system's own rule
   ("Git history, the diff, and the PR are the evidence; do not create
   narrative files"). **Fixed:** `turnSnapshot: off | compact | full` in
   config, default `compact` (entry ids + changed files into the JSONL ledger
   only).
3. **Speculative naming enforcement for hypothetical tools.** The `tool_call`
   hook pattern-matched tool names like `/create[_-]?branch/` for tools that do
   not exist in this setup, while the *real* bash guard missed `git commit -am`
   and `-F <file>`. **Fixed:** dropped the speculative branch; hardened the
   bash guard (`-am`, `--message=`, `-F/--file`, `||` chains — all tested).
4. **Eight wrapper slash commands** (`/feature-plan`, `/feature-publish`, …)
   duplicating `/feature <sub>`, in a system whose stated philosophy is "one
   explicit trigger, then autonomous". **Fixed:** one `/feature` command with
   completions. `/feature list` now opens the selector instead of throwing
   "was replaced by…" at the user.
5. **`feature-context` agent + "context" model route** that no code path ever
   spawned. The agent file remains (it is useful standalone via pi-subagents),
   but the dead route is gone.
6. **Duplicated prompt litany.** The same constraints (no N+1, no scope
   expansion, guard clauses, test value…) were repeated in the agent `.md`
   files *and* `stagePrompt()` *and* the `before_agent_start` context *and*
   tool guidelines — token cost per turn and four places to drift. **Fixed:**
   personas own their constraints in `agents/*.md`; runtime prompts carry only
   facts (identity, memory root, revision, task) — see `src/prompts.ts`.
7. **Oracle/adversary asymmetry:** `oracle` ran the Claude CLI synchronously,
   `adversary` spawned an async subagent, with different return semantics from
   the same command. Kept (they are genuinely different tools) but both now
   route through config and are documented.

## 4. What was genuinely good (kept intact)

+ **The execution lease.** Reserve-before-spawn, release-on-definitive-failure,
  *hold-on-timeout* (an RPC timeout is an unknown outcome — the child may be
  alive), human `/feature unlock` with confirmation. The subtle comment about
  never evicting a live lock owner by age is correct and preserved.
+ **The plan gate.** `sha256(plan.md)` + frontmatter revision recorded at
  publication and re-verified at approval and again at implementation-lease
  time — the human provably approved the bytes that will be implemented.
+ **Jira → PR → feature identity resolution** and prefix enforcement.
+ **Fresh-context worker/validator with the `PASS`/`BLOCKED` first-token
  contract**, and auto-validation after implementation.
+ **Session pointer + handoff sessions** (fresh session seeded with composed
  continuation context instead of resuming stale threads) — exactly what the
  user asked for in the `21-55` session.
+ **The ask_user TUI** (tabs, review step, custom answers, numeric shortcuts).
  Extracted to its own extension so it can ship/enable independently.

## 5. Architecture of the rewrite

Effect-TS service graph (all in `src/`):

```text
PiApi (Context.Tag — the live ExtensionAPI)
 ├─ SubagentGateway   RPC spawn over pi-subagents events, typed outcomes
 ├─ Planner           external CLI plan/oracle (config routes)
 ├─ PlanPublisher     file | claude-artifact adapters
 └─ Workflow          lifecycle orchestration (no UI, no model switching)
FeatureConfig          schema-validated config with total defaults
FeatureStore           locked, atomic, schema-decoded persistence + ledger
```

+ Typed failures (`Data.TaggedError`) replace string-matched `Error`s:
  `SpawnFailed` carries `outcome: "definitive" | "unknown"` so the lease
  decision reads as policy, not comment archaeology.
+ `FeatureState` is decoded on every read (`Schema.parseJson`) — corrupt state
  fails loudly as `StateCorrupt` instead of propagating `undefined`.
+ The extension entry (`extensions/feature-flow.ts`) owns UI, handoff sessions,
  and lifecycle hooks. Model routes are confined to subagents and external CLI
  processes; the developer's main-session model remains untouched.
+ Pure logic (identity, naming guard, plan gate, verdict, continuation) is
  dependency-free and fully unit-tested (34 tests).

## 6. Known remaining risks

+ The pi-subagents RPC contract (`subagents:rpc:v1:*`) and async-complete event
  shape are private coupling; a pi-subagents major bump can break spawning.
+ The `PASS`/`BLOCKED` verdict is prompt-contractual; a model that prefixes
  pleasantries produces a false `BLOCKED` (fail-safe direction, at least).
+ The claude-artifact publisher remains inherently brittle — use it knowingly.
