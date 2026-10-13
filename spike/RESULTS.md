# T1 — Protocol Spike Results

Date: 2026-10-13. Design: `docs/designs/artifex-ghost-factory.md` (D6, D11, D12,
D14, D15). Harness: `spike/harness/run.ts` + `spike/harness/analyze.ts`.
Raw evidence: `spike/captures/*.json`, summaries `spike/captures/*.summary.json`.

> Honesty note, split by evidence kind. **Tested live** (retained under
> `spike/captures/`): every lead-time and match number, the why answers
> (`muse-why.jsonl`, `claude-why.json`, `codex-why.jsonl`), the Claude
> plan→resume execution (`claude-plan.json` + `claude-execute.jsonl`), the
> OpenCode ACP handshake (`opencode-acp-init.json`), and the RSS runs
> and direct five-process measurement in
> `spike/rss/baseline-2026-10-13.txt`. **Schema-only, never driven live:** Muse
> MSP `turn/steer`, `session/sideChat`, `recap/request`; Codex app-server
> `turn/plan/updated` and `turn/steer`; ACP beyond the handshake. Those
> rows say so wherever they appear. All live runs are on the dev machine
> (Apple M4 Pro, 24 GB, macOS 27.0.1), NOT the potato target. Sample
> size is n=1 per agent per condition on a 3–5 file toy task: treat the
> elicited-intent conclusion as preliminary until a larger-task trial
> (T4) measures plan compliance. Nothing is simulated.

## Method

Same neutral task for every agent, in a fresh git scratch repo under
`/tmp/artifex-spike/runs/`, no file paths named in the prompt:

> "Build a tiny TypeScript greeting library in this empty repo: a module that
> exports a greet(name: string): string function returning "Hello, <name>!",
> a public entry point that re-exports it, and a Bun test file with two tests
> for greet. Run the tests with bun test and fix any failures. Keep it
> minimal, no extra dependencies."

The harness records every stdout line with arrival time (ms since spawn) and
polls the scratch tree every 20 ms to timestamp each file's first appearance
on disk. Per written file: lead time = first path mention in the stream
before the write, classified from the parsed event structure as plan /
tool-call / text. Measurement limits: file timestamps are quantized to the
20 ms poll, so the natural-run leads (20 ms, 52 ms) carry roughly ±20 ms
error; they establish write-time class, not precise values. Elicited leads
are seconds-scale and unaffected.

Versions: Muse 1.4.7 (`muse exec --json`), Claude Code 2.1.293
(`-p --output-format stream-json`; real binary resolved from the newest
install under `~/.local/share/claude/versions/` — `Muse` on PATH is a
Muse shim on this machine), Codex `codex-cli 0.160.0`
(`codex exec --json`), OpenCode 1.18.15 (blocked, see below), Bun 1.3.14.
Reproducibility limit: agent runs inherit this machine's ambient agent
configuration, rules, subscriptions, and environment, so behavioral
details can differ on another install even at the same CLI versions.

## Headline result

**No agent, left to itself, announces file paths usefully before writing.**
Natural (unprompted) runs produced path-bearing events only at write time:

| Run | First path event | Median lead |
|---|---|---|
| Muse natural | none before write (`side_effect_intent` names `tool:write_file`, no path) | — |
| Claude Code natural | Write `tool_use` blocks | 52 ms |
| Codex natural | `file_change` `item.started` | 20 ms |

**Elicited intent works, on both gate agents:**

| Run | Intent channel | Median lead | Planned→written |
|---|---|---|---|
| Muse elicited (todo instruction) | `todo.snapshot.updated` (structured items) | 29,027 ms | 3/3, precision 3/3 |
| Claude Code plan mode | plan document (Write to plan file + result text) | writes blocked until approval (no single lead number) | 4/4, precision 4/4 (same-session resume under "build exactly as planned") |

Per D11, write-time-only paths are labeled observed *for ghost purposes*.
Per D12's wording, the both-fail branch triggers only if no agent emits
paths before writes *with usable lead time*. Two agents do — but only via an
adapter-driven elicitation step (instruct the plan/todo first, or run a plan
turn and hold execution for approval). Ghost UI is therefore **viable as an
elicited-intent feature, not as a passive observation feature**. The floor
must ask for the blueprint; it cannot just watch for one.

## Per-agent findings

### Muse (v1 primary, daily loop)

- **Surface used live:** `muse exec --json --yolo --workspace <dir>`.
  Stream is the internal event log (392 lines for this task):
  `task.lifecycle.proposed/accepted/scheduled/side_effect_intent/started/output`,
  `tool.result`, `run.output.delta`, `todo.snapshot.updated`.
- Natural run (100 s, 5 files): `side_effect_intent` for `tool:write_file`
  fires 18–219 ms before the first file lands but carries **no path**
  (verified in the raw payload — only operation + idempotency key). First
  literal path appears at 38,232 ms, *after* the writes at 37,723 ms.
- Elicited run (prompt adds "first record a todo/plan listing the exact
  relative file paths", 87 s, 3 files): `todo.snapshot.updated` at
  14,857 ms with items "Create src/greet.ts — …", "Create src/index.ts — …",
  "Create src/greet.test.ts — …". Leads: 19.9 s / 29.0 s / 45.1 s.
  Recall 3/3, precision 3/3. Todo text is free-form: the adapter extracts
  paths by pattern, it does not receive a typed path field.
- **Receives prompts:** yes — `muse exec` (one-shot) and MSP `turn/start`.
  Steering: MSP `turn/steer` exists (schema-verified in the exported
  `msp.schema.json`; not driven live in this spike).
- **Answers why:** post-hoc yes — re-running `muse exec` with the same
  `--session-id` answered accurately. Caveat observed: the why turn
  executed fresh tool calls (it re-verified the library). For a read-only
  why, prefer MSP `session/sideChat` or `recap/request` (both in the
  exported schema), or instruct the turn to be read-only.
- **Intent label:** emits-intent = **yes, elicited-via-todo** (natural: no).
  This resolves the D12 Muse-fail branch differently than expected:
  Muse does not need to be demoted to observed-only, provided Artifex's
  floor prompt carries the standing todo instruction. The risk moves from
  protocol (solved) to compliance (agent may skip or vague-up the todo on
  larger tasks — needs a bigger-task trial during T4).

### Claude Code 2.1.293

- **Surface used live:** `-p --output-format stream-json --verbose`.
- Natural run (11 s, 3 files): all paths inside one assistant message of
  parallel Write `tool_use` blocks at 7,431 ms; files on disk at 7,483 ms.
  `--include-partial-messages` would stream tool input earlier, but it
  stays write-time class. PreToolUse hooks also see the path pre-write —
  same timing class, guaranteed ordering.
- Plan mode run (`--permission-mode plan`, 17 s, no source writes): agent
  wrote a plan file listing exactly `src/greet.ts`, `src/index.ts`,
  `src/greet.test.ts`, `package.json`, and returned the plan as result
  text. Note: `ExitPlanMode` was unavailable in this headless session;
  approval = resume the session. Resume with "Approved. Build it exactly
  as planned" (`--permission-mode bypassPermissions`) wrote exactly the 4
  planned files and `bun test` passed: **recall 4/4, precision 4/4**
  (retained: `claude-plan.json` + `claude-execute.jsonl`; measured under
  the explicit "build exactly as planned" approval instruction, which is
  the intended floor workflow. The analyzer's regex planned-path list for
  the plan run also counts context mentions like `README.md`; the 4/4
  figure counts only create-intent paths from the plan's file list).
- **Receives prompts:** yes — `-p`, plus stream-json bidirectional input
  (`--input-format stream-json`, flags verified in `--help`).
- **Answers why:** post-hoc yes — `--resume` why question answered
  accurately from session context, no tool calls needed.
- **Intent label:** emits-intent = **yes, plan-turn gated** (natural: no).
  The plan→approve→resume loop *is* the ghost workflow for this agent.

### Codex 0.160.0

- **Surface used live:** `codex exec --json` (13 events). Prose intent at
  5,776 ms ("I'll add the greeting module…") with **no paths**; paths first
  appear in `file_change` `item.started` at 16,695 ms, on disk 20 ms later.
  This is the tool-call class, not plan text: `matchRatePlanText` is 0
  in the regenerated summary (the first analyzer version misclassified
  it; fixed in review, numbers otherwise unchanged).
- App-server (schema exported locally, not driven live):
  `turn/plan/updated` exists but `TurnPlanStep` is `{step: string, status}`
  — natural-language steps, no path field. `turn/steer`, `turn/interrupt`,
  `fs/changed`, approval requests for file changes also exist. Approval-gated
  file changes would give guaranteed path-before-write, at write-time class.
- **Receives prompts:** yes — `codex exec`, app-server `turn/start`,
  `codex queue --thread --message` for an existing session.
- **Answers why:** post-hoc yes — `codex exec resume <thread-id>` answered
  accurately.
- **Intent label:** emits-intent = **partial** — no path-bearing plan
  observed live; app-server plan steps are unstructured text. Treat as
  observed for ghosts in v1 until an elicited app-server trial proves lead
  time (candidate T4 follow-up, same todo-instruction trick may work).

### OpenCode 1.18.15 — BLOCKED live, do not guess

- `opencode run --format json --auto` produced **no output and hung**
  (killed at timeout; capture `opencode.json` is empty — it predates a
  harness timeout fix, so its `durationMs` is unreliable; the zero-line
  conclusion is unaffected). With an explicit
  model it emits a JSON error event (`UnknownError: Unexpected server
  error`). Root cause on this machine: `opencode providers list` shows
  **0 credentials**, and the local Ollama server is not responding.
- Protocol evidence obtained offline: `opencode acp` answers an ACP
  `initialize` handshake (protocolVersion 1, `loadSession: true`, MCP
  http/sse, session close/fork/list/resume; auth via `opencode auth
  login`). ACP `session/update` includes plan and `tool_call` updates with
  locations, so the *shape* could carry intent — **unverified live**.
- **Builder action to unblock:** `opencode providers login` (or start
  Ollama), then rerun `bun run spike/harness/run.ts opencode`.
- **Intent label:** unverified (treat as observed-only until rerun).

## Capability matrix (ships in README + agent picker, per design)

| Agent | Emits intent | Lead (median) | Receives prompts | Answers why |
|---|---|---|---|---|
| Muse | Yes — elicited todo only | 29 s (elicited); none natural | Yes (exec, MSP) | Post-hoc yes; MSP sideChat/recap schema-only |
| Claude Code | Yes — plan turn only | Approval latency; 52 ms natural | Yes (`-p`, stream-json in) | Post-hoc yes |
| Codex | Partial — NL plan steps (app-server) | 20 ms live (write-time) | Yes (exec, app-server, queue) | Post-hoc yes |
| OpenCode | Unverified (ACP shape fits) | — blocked: no credentials | Yes (ACP `session/prompt`, handshake verified) | Unverified |

Ghost scope decision: build ghosts for **elicited intent** (Muse todos,
Claude Code plan turns). All other cells render observed-solid, exactly as
the design's matrix prescribes. D12 both-fail branch does **not** trigger.

## Floor event contract (feeds T2)

Adapters normalize agent streams into the shared events module (`events/`,
D8). Required discriminant on every event: `provenance: "intended" |
"observed"`. Intended events only ever come from an intent channel measured
above (todo snapshot, plan document; the Codex app-server plan joins only
after an elicited trial measures it). Write-time tool events (≤ ~250 ms
lead) and filesystem watcher events are observed. The events validator
guarantees shape and provenance consistency, not origin: adapters assert
provenance, and the floor store MUST bind every intended event's
`planId` to a `planned` event actually seen on an intent channel before
solidifying a ghost (T4 requirement, from cross-review).

Events: `planned`, `started`, `file-written`, `test-result`,
`observed-change`, `abandoned-plan`, `prompt-sent`, `why-answered`,
`annotate`. Implemented and tested in `events/` (T2).

## D14 — RSS baselines (dev machine; retained runs in `spike/rss/baseline-2026-10-13.txt`)

All values below are MiB. Ranges use only the three retained parse runs
in the baseline file.

| Process | Self RSS | Peak (maxrss / footprint) |
|---|---|---|
| Bun empty | 22.5 | 23.1 maxrss; 7.7 footprint |
| Bun + web-tree-sitter init | 44.8–45.0 | — |
| + TS + Python grammars | 64.8–68.1 | — |
| + parse 1,010 files (800 TS, 210 Py) | 122.1–128.6 | 122.3–128.8 maxrss; 93.9–100.7 footprint |

Direct five-process measurement (`spike/rss/combined-five.ts`, four
empty Bun processes plus one parser process, summed from `ps` RSS;
orchestrator excluded; the parser holds after loading grammars until
the parent samples RSS, so idle is genuinely pre-parse):
**155.7–156.0 MiB at synchronized grammar-loaded idle** and
**211.7–216.7 MiB after a full parse**, over two runs.

Parse speed: 98–170 ms for 1,010 files in the retained runs. Versions
pinned for ABI compatibility: `web-tree-sitter@0.24.7` +
`tree-sitter-wasms@0.1.13` (the current web-tree-sitter rejects those
grammar WASMs).

**Consequence for D2 (fold required):** the five Artifex-owned units as
separate Bun processes (the sixth unit is the browser tab, excluded per
D3) cannot fit the 150 MB budget on the budget's own RSS accounting:
the directly measured synchronized idle total is already ~156 MiB
before any parsing.
macOS footprint is a different metric and reads lower; it is not the
RSS budget D14 defines, so no footprint-based pass is claimed. Process
RSS grows during parsing and does not return after `tree.delete()`;
the mechanism (WASM linear memory vs JS heap) was not isolated.

Recorded arrangement change (same features, fewer processes): **one Bun
process** hosting server + watcher + agent interface + DB introspector as
in-process modules, with the parser in-process or in a worker *thread*
(shared process RSS). Measured so far is the parser alone (grammar-loaded
≈ 66 MiB by `ps`, full-parse ≈ 122–127 MiB by `ps`); the
server/watcher/interface modules are unmeasured, so the single-process
steady state is a lower bound, not a promise. Corpus limit: the 1,010
files are near-identical ~600-byte modules, so these numbers show
file-*count* scaling; a real repo's peak also depends on its largest
files. T3 must re-measure on a real ~1,000-file repo. Mitigations if the
potato machine shows worse numbers: lazy per-language grammar load,
periodic parser-instance recycling.

## Builder gate inputs (recorded 2026-10-13)

1. **Weak machine**: this Mac — Apple M4 Pro, 24 GB RAM, macOS 27.0.1
   (arm64). It is both the dev machine and the named potato-gate target,
   so the RSS baselines above were already measured on it.
2. **Browser tab fail threshold** (D15): **500 MB**, measured separately
   from the 150 MB Artifex-process budget on this machine.
3. **Solo effort budget** (D21): **no fixed cap** (builder decision,
   2026-10-13; deviates from D21's numeric form). The gate therefore
   reviews remaining scope qualitatively instead of against a number.
4. **OpenCode** (still open, builder action): run
   `opencode providers login`, then rerun the harness to fill its
   matrix row.

## Reproduce

```sh
bun run spike/harness/run.ts muse        # or claude-code | codex | opencode
bun run spike/harness/analyze.ts spike/captures/muse.json
# elicited Muse run (todo instruction):
SPIKE_PROMPT='Before writing any file, first record a todo/plan listing the exact relative file paths you will create. Then build a tiny TypeScript greeting library in this empty repo: a module that exports a greet(name: string): string function returning "Hello, <name>!", a public entry point that re-exports it, and a Bun test file with two tests for greet. Run the tests with bun test and fix any failures. Keep it minimal, no extra dependencies.' bun run spike/harness/run.ts muse-elicited
# Claude Code plan turn, then approve in the same session:
bun run spike/harness/run.ts claude-plan
#   resume the session id from spike/captures/claude-plan.json in its scratch with
#   --permission-mode bypassPermissions "Approved. Build it exactly as planned and run the tests."
cd spike/rss && bun install && bun run gen-corpus.ts && /usr/bin/time -l bun run parse-all.ts
```
