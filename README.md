# pi-feature-flow

Explicit-trigger feature workflow for [pi](https://pi.dev): staged subagents,
durable per-feature memory, a single human plan checkpoint, and Jira/PR naming
enforcement. Core logic is built on [Effect](https://effect.website).

This is the productized rewrite of a one-day vibecoded prototype — see
[REVIEW.md](./REVIEW.md) for the full review of the original and the rationale
behind every change.

## The flow

```
/feature new  ──►  interactive planning (grill-me questions, ask_user)
                    │  feature_workflow plan
                    ▼
              integrated planner (Claude CLI / best-writer model)
                    │  plan.md published as an artifact URL
                    ▼
              HUMAN CHECKPOINT — approve the plan          ◄── the only gate
                    │  automatic
                    ▼
              implementation worker (fresh context, execution lease)
                    │  automatic
                    ▼
              validator (fresh context) → PASS ⇒ complete / BLOCKED ⇒ surfaced
```

- The workflow **never self-activates**. It starts only from `/feature new` or
  an explicit user request. Ordinary sessions stay direct.
- Every feature is identified by **Jira key → PR → feature name**. While a
  feature is active, bash `git`/`gh` calls are checked: branches must start
  `<KEY>-`, commits and PR titles must start `<KEY> `.
- The plan the human approves is hash-pinned: if `plan.md` changes after
  publication, approval and implementation refuse until it is republished.
- Implementation/validation run as **pi-subagents** background runs guarded by
  an execution lease (no double-writers; unknown spawn outcomes keep the lease
  until `/feature unlock`).

## Install

Requires [pi-subagents](https://github.com/nicobailon/pi-subagents) for the
worker/validator/adversary stages.

```bash
pi install git:github.com/calliou24/pi-feature-flow
# or from a local clone
pi install /path/to/pi-feature-flow
```

## Commands

| Command | Effect |
| --- | --- |
| `/feature` or `/feature list` | Selector → fresh handoff session for a feature |
| `/feature new` | Editor opens; agent infers identity + title and starts planning |
| `/feature use\|resume <id>` | Fresh handoff session with composed continuation context |
| `/feature status` | State, checkpoint, lease, recent runs |
| `/feature plan` / `publish` | Run the integrated planner / republish plan.md |
| `/feature approve` / `reject [note]` | Decide the plan checkpoint (TUI confirm) |
| `/feature implement` / `validate` | Manual stage runs (recovery; normally automatic) |
| `/feature oracle` / `adversary` | Architecture review (CLI) / adversarial subagent review |
| `/feature unlock` | Clear a stuck execution lease after verifying no live worker |
| `/feature followup [task]` | Fresh handoff session with a custom task |

Tools exposed to the agent: `feature_workflow` (lifecycle), `feature_memory`
(read/append assumptions, decisions, thread log), `ask_user` (structured
questions TUI — ships as an independent extension).

## Memory layout

```
~/.pi/agent/feature-flow/
  config.json                    # optional, see below
  features/<id>/
    state.json                   # schema-validated lifecycle state
    assumptions.md  decisions.md # durable memory (agent + interview answers)
    plan.md                      # planner-owned, hash-pinned at approval
    thread-log.md                # human-readable narrative
    ledger.jsonl                 # machine events (runs, leases, checkpoints)
    published/                   # file-publisher plan copies
```

Git history, the diff, and the PR remain the implementation evidence; the
memory files deliberately do not duplicate them.

## Configuration (`~/.pi/agent/feature-flow/config.json`)

All keys optional; defaults shown:

```jsonc
{
  "routes": {
    "interactivePlanning": { "model": "openai-codex/gpt-5.6-sol",   "thinking": "high" },
    "execution":           { "model": "openai-codex/gpt-5.6-terra", "thinking": "high" },
    "worker":              { "model": "openai-codex/gpt-5.6-terra", "thinking": "high" },
    "validator":           { "model": "openai-codex/gpt-5.6-terra", "thinking": "high" },
    "adversary":           { "model": "openai-codex/gpt-5.6-sol",   "thinking": "high" },
    "planner": { "command": "claude", "model": "fable", "effort": "high" },
    "oracle":  { "command": "claude", "model": "fable", "effort": "high" }
  },
  "planArtifact": { "publisher": "file" },   // or "claude-artifact" (tmux driver, brittle)
  "turnSnapshot": "compact",                 // off | compact | full
  "budgets": {
    "implementationMaxTurns": 18,
    "validationMaxTurns": 10,
    "spawnTimeoutMs": 900000,
    "rpcReplyTimeoutMs": 20000
  }
}
```

## Development

```bash
npm install
npm run typecheck
npm test          # node --test, 34 unit tests over the pure core + store
```

Layout: `src/` Effect services and pure logic · `extensions/` pi entry points ·
`agents/` pi-subagents personas · `scripts/` the optional claude-artifact
publisher · `test/` node:test suites.
