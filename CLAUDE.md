# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

`dsh-superagent` is a research prototype: a proactive coding agent for **one** GitHub repository, packaged as a [DeepSeek Harness](https://www.deepseek.com/en/harness/) bundle. It polls GitHub (optionally Feishu), evaluates requests under a Policy, turns authorized ones into Tickets, and executes each in its own DSH Session and directory. A React panel shows what needs a person.

Two things follow from this:

- **`docs/` is the specification, and it is numbered and ordered.** Each document builds only on the earlier ones. Read `docs/000-philosophy.md` first; it states the project's judging criterion — every message, notification, setting and paragraph must cost less human attention than it returns. `docs/007-architecture.md` is the developer guide: it maps every concept to a file and test, and its module and test tables are machine-checked (see *Drift guards* below).
- **This is a bundle, not an app.** `src/index.ts` is a Cordis plugin; `src/sources/github.ts` and `src/sources/feishu.ts` are separate plugin entries. The host is DeepSeek Harness; `lib/` is build output (gitignored) and `cordis.patch.yml` is what inserts the plugins into a profile.

## Documentation

Read the numbered documents in order; each builds only on the ones before it:

- [000 Philosophy](docs/000-philosophy.md) — the judging criterion: every interaction must cost less human attention than it returns
- [001 Domain model](docs/001-domain.md) — Source, Trigger, Thread, Eval, Decision, Ticket, Assignment, Mandate, Input, Subscription, Report
- [002 Authorization](docs/002-authorization.md) — who may ask for work, the admission table, Mandate revalidation
- [003 Execution](docs/003-execution.md) — how Tickets run, stages, Inputs, Reports, outcomes
- [004 Prompts](docs/004-prompts.md) — prompt organization, versions, team-editable sections
- [005 Panel](docs/005-panel.md) — the React overview and settings UI
- [006 Deployment](docs/006-deployment.md) — manual setup, configuration, upgrades, troubleshooting
- [007 Architecture](docs/007-architecture.md) — developer guide: modules, tests, persistence, interfaces
- [008 Cookbook](docs/008-cookbook.md) — how to add a new Source
- [009 Model pool](docs/009-model-pool.md) — the machine's model gateway (magpie), routing groups, pools

## Commands

```sh
pnpm install                 # Node ^22.19 || >=24, pnpm@11.7.0
pnpm check                   # typecheck + tests + build — the gate before committing
pnpm typecheck               # tsc --noEmit
pnpm test                    # vitest run (all specs)
pnpm test tests/core-engine.spec.ts   # one spec file
pnpm vitest run tests/core-engine.spec.ts -t 'accept'   # one spec, one test name
pnpm build                   # tsdown → lib/ (ESM host entries + a CJS panel bundle)
```

The service script manages one local DSH profile (default `superagent`) in tmux without touching other sessions:

```sh
scripts/dsh-superagent status    # exit 0 healthy · 1 down/restartable · 2 a part errors · 3 waiting for setup
scripts/dsh-superagent start | stop | restart
scripts/dsh-superagent --profile superagent --respect-stop restart   # --respect-stop keeps an intentional stop
```

Startup logs land in `.artifacts/dsh-superagent-<profile>-<date>-<time>-<pid>.log` (20 kept); the newest is where "why did it not start" is answered.

The management API is local-only and answers `http://127.0.0.1:3082/orchestrator/api` with the header `x-orchestrator-request: 1` (no `Origin` from another site). `GET state` is the cheapest health read. API saves have the panel's permissions — they may change the execution environment and the account fields the setup checks, unlike saves made through a Session's tools.

## Architecture in one page

- **`Runtime` (`src/app/runtime.ts`) is the composition root.** It holds no domain rules. It locks the state directory, opens the `Store`, builds every part, registers the management routes, and owns startup/shutdown. The `Engine` and the `Assessor`/`Executor` call back into it, so it hands them getters instead of constructing a cycle.
- **`Engine` (`src/core/engine.ts`) is the only writer of Triggers, Threads, Decisions, Tickets and Assignments.** All its methods are synchronous; each command changes its aggregates in one transaction. It delegates to five parts — `Intake` (a Source's Trigger), `Evals` (assessing and deciding a Trigger), `Tickets` (the lifecycle), `Assignments` (what the Executor reports), `Replies` (channel writes) — each extending `EnginePart`. Callers receive only their role's `Pick`: `EngineForSources`, `EngineForMainSession`, `EngineForPeople`, `EngineForSettings`, `EngineForExecutor`.
- **`Effects` (`src/app/effects.ts`) is the durable side-effect queue.** A command calls `enqueue(kind, key, payload)` *inside* its transaction; the work runs only after commit. Kinds: `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply`. Each kind has a health entry that turns red after three failures in a row.
- **`Outbox` (`src/app/outbox.ts`) owns message receipts.** The Engine's messages and a Source's `notify` both go through `send`, which keeps the receipt and queues the `reply` effect in one transaction. A message waits while its Source is off and is dropped when the conversation is gone.
- **`Store` (`src/app/store.ts`) owns one SQLite file** (`<stateDir>/orchestrator.sqlite`, schema 11). Domain repositories, read-only queries (`store-read.ts`), settings, prompt versions, outbox receipts and typed `kv` records. `afterCommit` runs an action only when the transaction committed.
- **Sources** implement the `SourceKind` protocol (`src/sources/kind.ts`) and register with `SourceRegistry`, which implements the Engine's `SourceScope`. A plugin sees only `SourceHost`; its kind sees only its `SourceContext`. Adding a Source is a documented procedure: `docs/008-cookbook.md`.
- **`DshExecutor` (`src/executor/dsh.ts`)** gives each Ticket one Session and one directory, and reserves `WorkerSlots` before a launch.
- **`MasterAssessor` (`src/app/assessment.ts`)** lets the main Session judge proactive candidates; the prompt that tells it how is `prompts/admission.md`.
- **The panel** (`src/client/`) is React served by the host. It talks to the management API only, and never imports host code.

### Rules the code keeps

- **One writer per state.** Triggers/Threads/Decisions/Tickets/Assignments → the Engine. A Source's read positions and its `meta` on Threads → that Source. Settings → `Settings`. Prompt versions → `Prompts`. Effect rows → `Effects`. Outbox receipts → the Outbox. A health entry → the part that claimed it on the `HealthBoard`, which refuses a second claim.
- **`src/core` imports nothing outside itself apart from Node's hashing, and does no I/O.** `src/sources` imports nothing from `src/app`. The panel imports types and a few plain value modules from the host side (`src/admission.ts`, `src/limits.ts`, `src/setup.ts`, `src/navigation.ts`, `src/sources/host.ts`, `src/core/errors.ts`, `src/core/reasons.ts`, `src/app/api.ts`), never host code.
- **Naming carries meaning.** A request is an imperative verb plus its object (`stopTicket`, `bindThread`) and may be refused; a recorded fact is past tense (`assignmentStarted`, `deliveryFailed`). The query `candidate` is a noun.
- **A Source keeps nothing on a Ticket.** Which of a Source's Threads a Ticket follows is the Ticket's `follows`; what a Source knows about a Trigger or Thread is in their `meta`, which the core does not interpret.
- **Refusals are fixed.** A refusal a person or an agent can cause is a `UserError(code, values)` from `USER_ERRORS` in `src/core/errors.ts`; the API answers `missing` with 404 and the rest with 400, and the panel words each code in both languages.

### Domain vocabulary

Source, Trigger, Thread, Eval, Decision, Ticket, Assignment, Mandate, Input, Subscription, Report. `ticketStage` in `src/core/stage.ts` classifies a Ticket as `person` (with `delivery`, `answer`, `review`, `blocked` or `failed`), `working`, `idle` or `ended`; the table it follows is exercised row by row in `tests/stage.spec.ts`. `src/core/model.ts` holds the domain types; `src/core/reasons.ts` holds the codes that explain a Decision.

## Drift guards — tests that fail when the docs or the model surface go stale

These are the ones that surprise people:

- **`tests/docs.spec.ts`** asserts the module table and the test table in `docs/007-architecture.md` list every file under `src/` and `tests/`, and only files that exist. **Add or delete a module or a spec and you must update those two tables in the same commit.** It also checks that numbered documents link only to earlier ones and that every local link resolves.
- **`tests/class-docs.spec.ts`** requires a JSDoc block immediately before every `class` declaration in `src/`.
- **`tests/model-surface.spec.ts`** checks everything a model reads — tools, prompts, skills, inputs — against the tool schemas, the execution environment and the glossary, within a per-role character budget (`orchestrator` 59 000, `worker` 40 500). It also bans a list of retired terms (`member`, `topic`, `reopen`, `event/`, `task/`, `guide/`) and a list of banned phrases, and refuses several patterns of tool and prompt text. Growing `prompts/` or a tool description can break it; if you must raise the budget, do it on purpose and say why in the commit message.
- **`tests/cards.spec.ts`** checks the rules the built-in prompt text must state, file by file.
- **`tests/bundle-patch.spec.ts`** reads `cordis.patch.yml` the way the host reads it.
- **`tests/model-pool.spec.ts`** verifies `docs/009-model-pool.md`: the groups and models magpie knows, and their counts match reality.

## Prompts, skills and settings

- Most model instructions live in `prompts/*.md`, **one sentence per line**; `promptFile` joins the lines of a file into paragraphs. Team-editable sections are `prompts/team/*.md`. Source skills are `skills/dsh-superagent-*/SKILL.md`: GitHub at `dsh-superagent-github`, Feishu at `dsh-superagent-feishu` and `dsh-superagent-feishu-docs`. Assessment instructions live *only* in `prompts/admission.md` — not in code.
- Prompt configurations are stored as numbered `Versions`; an override of a built-in part keeps the built-in's `base` key so a later default change can be compared. `defaultChanged` reports what moved.
- Settings blocks are `policy`, `eval`, `executor` (plus `source:<kind>` instances and a separate `paused`). Every save declares its origin (`panel`, `tool`, `sync`); only `panel` may change the execution environment or the account fields in `SETUP_FIELDS`.
- A Policy-version change computes `policyEffects`, tells each affected Ticket how the change bears on it, and restarts the Evals running under the new version.

## Local deployment on this machine

The live instance differs from the repository template; keep the difference in mind before "fixing" the profile.

- Profile `superagent`, panel on `127.0.0.1:3082`, state directory `/root/.dsh/state/superagent` (`orchestrator.sqlite`, `worker-bin/`, `worker-gitconfig`, `work/`).
- The live profile patch `~/.dsh/profiles/superagent/cordis.patch.yml` carries **local-only** additions that are not in `examples/profile.cordis.patch.yml`: the `llm-pi-ai` provider override pointing at the magpie gateway (`api: openai-completions`, `baseURL: http://127.0.0.1:3425/v1`, `apiKeyEnv: MAGPIE_GATEWAY_KEY`, from `~/.dsh/.credentials.yaml`) and `agent-default-model` set to `group/dsh`. A second gateway (`qiniu`) has its own credential env var.
- **Models come from a local gateway, not from one pool.** `docs/009-model-pool.md` describes it: magpie on `127.0.0.1:3425` (systemd user unit `magpie.service`) fronts two pools, `aikey4k` and `minimax-cn`, and spreads work over them with routing groups. The Eval and Executor roles name `group/dsh`; Claude Code's tiers name `group/claude` and `group/cheap`. magpie rewrites both the profile patch and `~/.claude/settings.json` when its catalog changes — change them with `magpie group ...` / `magpie claude ...`, never by hand.
- **MiniMax's M3.1 Flash refuses thinking-off requests**, and the `aikey4k` gateway redacts the field names in that refusal, so magpie cannot recognise it and does not retry. Claude Code therefore needs `alwaysThinkingEnabled: true` in `~/.claude/settings.json` (it then sends `thinking: adaptive`, which both pools accept). `group/dsh` is built from MiniMax-M3, which accepts any request shape, so the DSH side needs no such setting. Dropping that flag turns every `group/claude` request into a 400.
- The plugin changes process-wide `PATH` and git configuration inside its own process, and it is meant to live in its own profile so a restart of the agent does not close the operator's Sessions.

## Working against real data

`docs/007-architecture.md` has a short recipe: point `DSH_HOME` at a temporary directory, create a new profile there, copy the database from a backup, disable every Source, pause processing, remove the main Session id, and give the GitHub and Feishu CLIs read-only stand-ins. The database refuses to open if it is newer than the code — `SCHEMA_VERSION` only increases, and `src/app/migration.ts` upgrades schema 10 once, in place, at startup.
