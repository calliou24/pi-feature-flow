# pi-feature-flow

Explicit-trigger feature workflow for [pi](https://pi.dev): staged subagents,
durable per-feature memory, a single human plan checkpoint, and Jira/PR naming
enforcement. Core logic is built on [Effect](https://effect.website).

This is the productized rewrite of a one-day vibecoded prototype — see
[REVIEW.md](./REVIEW.md) for the full review of the original and the rationale
behind every change.

## The flow

```
/feature new  ──►  main-agent planning (interview + repository evidence)
                    │  feature_workflow plan(plan: complete Markdown)
                    ▼
              rendered HTML plan published through Tailscale Serve
                    ├──► background cross-model adversarial review
                    ▼
              HUMAN CHECKPOINT — approve the plan          ◄── the only gate
                    │  automatic
                    ▼
              Sol-low implementation (fresh context, execution lease)
                    │  [parallel-safe] packages fan out to isolated worktrees
                    ▼
              validator (fresh context) → PASS ⇒ complete / BLOCKED ⇒ FIX lane
```

- The workflow **never self-activates**. It starts only from `/feature new` or
  an explicit user request. Ordinary sessions stay direct.
- The active Pi session keeps the model and thinking level it started with.
  Feature-specific model routes apply only to isolated subagents; the workflow
  never calls Pi's main-session model controls. Every Fable subagent run still
  requires explicit one-run approval.
- Every feature is identified by **Jira key → PR → feature name**. While a
  feature is active, bash `git`/`gh` calls are checked: branches must start
  `<KEY>-`; commits and PR titles must start with `<KEY>` followed by a space.
- Starting a feature returns the planning kickoff directly to the active main
  agent; it never queues a synthetic follow-up user prompt. Plan publication is
  rejected after approval or while implementation/validation is active, so a
  delayed instruction cannot regress the lifecycle.
- The plan the human approves is hash-pinned: if `plan.md` changes after
  publication, approval and implementation refuse until it is republished.
- The main agent authors the plan. Adversarial review, implementation, and
  validation run as **pi-subagents**. Review defaults to Fable 5 high, but when
  Fable 5 authored the plan in the main session it automatically routes to Sol
  high instead, preserving an independent model perspective. The implementation
  default is Sol low; Fable low is available only when the user explicitly
  requests it. Approved
  `[parallel-safe]` packages can fan out to isolated Git worktrees with one
  writer per worktree and one workflow execution lease/run record. Workers and
  validators batch diagnostics once after edits/review rather than looping LSP
  checks after every edit.
- The exact approved Markdown is copied beneath
  `~/.pi/agent/feature-flow/published/` alongside a safe standalone HTML
  rendering. The durable review URL points to
  the HTML page and the plan tool ends the turn so the developer can inspect it
  before the approval checkpoint.
- Finished or abandoned features can be archived to a **private repository owned
  by the currently authenticated GitHub account**. Only context is retained:
  memory, plans, sessions/transcripts, scripts, documents, and run artifacts —
  never source code or database/container state.

## Install

Requires [pi-subagents](https://github.com/nicobailon/pi-subagents) for the
worker/validator/adversary stages,
[`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)
for structured planning questions, and an authenticated Tailscale node with
Tailscale Serve available for tailnet-only plan URLs.

```bash
pi install npm:@juicesharp/rpiv-ask-user-question
pi install git:github.com/calliou24/pi-feature-flow
# or from a local clone
pi install /path/to/pi-feature-flow
```

## Commands

| Command | Effect |
| --- | --- |
| `/feature` | Selector → fresh handoff session for a feature |
| `/feature new` | Editor opens; agent infers identity + title and starts main-agent planning |
| `/feature resume [id]` | Fresh handoff session with composed continuation context |
| `/feature status [id]` | Compact lifecycle, plan, and run status |
| `/feature unlock` | Clear a stuck execution lease after verifying no live worker |
| `/feature archive [id]` | Push context to the private archive repo, verify it, then clean local feature resources |
| `/feature recover [id]` | Restore the latest remote context archive; without an id, open the archive selector |

Tools exposed to the agent: `feature_workflow` (lifecycle), `feature_memory`
(read/append assumptions, decisions, thread log), and `ask_user_question`
(structured questions TUI, provided by `@juicesharp/rpiv-ask-user-question`).

## Memory layout

```
~/.pi/agent/feature-flow/
  config.json                    # optional, see below
  features/<id>/
    state.json                   # schema-validated lifecycle state
    assumptions.md  decisions.md # durable memory (agent + interview answers)
    plan.md                      # main-agent-authored, hash-pinned at approval
    thread-log.md                # human-readable narrative
    ledger.jsonl                 # machine events (runs, leases, checkpoints)
  published/<id>/               # exact plan copies exposed through Tailscale Serve
```

Git history, the diff, and the PR remain the implementation evidence; the
memory files deliberately do not duplicate them.

## Archive and recovery

`/feature archive [id]` performs a preview and asks for confirmation. It refuses
an archive while an execution lease/subagent is active, when a related checkout
is not completely clean, when its HEAD is unavailable on any live remote branch,
or when the feature itself is checked out in a repository's primary
worktree (switch that checkout first). It then:

1. discovers feature-named Git worktrees, containers, memory, recorded Pi and
   subagent sessions, transcripts, run artifacts, and context-only dirty files;
2. takes an archive lock, revalidates state/resources, and fetches plus queries
   the live project remotes to prove each checkout commit remains recoverable;
3. creates or reuses `<active-gh-user>/pi-feature-archives` as a **private** repo;
4. copies only plans, Markdown/data documents, explicitly related support
   scripts, transcripts, and artifacts, writes a checksum manifest, commits,
   pushes, verifies the remote branch, and revalidates local state/hashes;
5. only after verification, removes related containers/volumes, secondary
   worktrees and local feature branches, archived support/session files, async
   run directories, and the complete local feature-memory directory.

The removed memory directory makes the feature disappear from `/feature`.
Source code, project manifests/configuration, and database/container data are
intentionally excluded: code must already be pushed to its normal project
remote, and related worktrees must be clean. Use `archive.extraPaths` for a
support script or document outside feature memory that should be retained. The
private archive stores the context needed to understand what was done, how, and
why.

`/feature recover [id]` verifies checksums, restores context files and feature
memory without overwriting different local files, and makes the feature visible
again. Manifest fields and paths are validated; feature memory is assembled in
a staging directory and atomically installed only after all checks/copies pass.
It creates a fresh handoff session when the original project path still exists. It intentionally does **not** recreate containers, database data, source
checkouts, or local branches; inspect the project's normal remote history when
code context is needed.

The archive repository always follows the account reported by `gh api user`.
Switch accounts before archiving or recovering when necessary:

```bash
gh auth switch --user your-account
```

The extension refuses public archive repositories and refuses an explicit
`owner/name` that does not match the active GitHub account.

## Configuration (`~/.pi/agent/feature-flow/config.json`)

All keys optional; defaults shown:

```jsonc
{
  "version": 5,
  "routes": {
    "worker":       { "model": "openai-codex/gpt-5.6-sol",   "thinking": "low" },
    "fableWorker":  { "model": "anthropic/claude-fable-5",   "thinking": "low" },
    "validator":    { "model": "openai-codex/gpt-5.6-sol",   "thinking": "high" },
    "adversary":    { "model": "anthropic/claude-fable-5",   "thinking": "high" }
  },
  "planArtifact": { "servePath": "/feature-plans" },
  "turnSnapshot": "compact",                 // off | compact | full
  "archive": {
    "repository": "pi-feature-archives",      // name under active gh account, or matching owner/name
    "branch": "main",                        // custom branches must already exist
    "searchRoots": ["/home/you"],             // roots searched for feature-named worktrees
    "extraPaths": [                           // optional context-only files/directories
      "reports/{featureId}.md",
      "~/handoffs/{workItem}"
    ]
  },
  "budgets": {
    "implementationMaxTurns": 18,
    "validationMaxTurns": 10,
    "adversaryMaxTurns": 10,
    "spawnTimeoutMs": 900000,
    "rpcReplyTimeoutMs": 20000
  }
}
```

`routes` configures feature-flow's invoked roles. Interactive questioning,
repository inspection, and plan authoring stay on whatever model is already
selected in the main Pi session. `feature_workflow plan` preserves the exact
hash-pinned Markdown and publishes a standalone HTML rendering at
`https://<machine>.<tailnet>.ts.net/<servePath>/...`. The URL is displayed in a
durable plan card and the tool stops at the human checkpoint. The configured
adversary route runs in the background unless the active planner is Fable 5, in
which case review automatically uses `openai-codex/gpt-5.6-sol` at high
thinking. Existing Tailscale Serve handlers are preserved when this path is
added. Unrecognized legacy routing and publisher-selection keys are ignored.

## Development

```bash
npm install
npm run typecheck
npm test          # node --test suites for the core, store, gateway, and routing
```

Layout: `src/` Effect services and pure logic · `extensions/` pi entry points ·
`agents/` pi-subagents personas · `test/` node:test suites.
