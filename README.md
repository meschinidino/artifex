# Artifex

Factorio-inspired visual IDE for coding agents: agents are the workers,
the human manages the factory floor. Design (approved):
`docs/designs/artifex-ghost-factory.md`.

Status: pre-alpha. Done: T1 protocol spike (`spike/RESULTS.md`,
preliminary at n=1 per condition; builder gate inputs recorded there);
T2 shared events module (`events/`); T3a ground layer and T3b import
belts (issues #2/#3; `server/`, `watcher/`, `parser/`, `resolver/`,
`floor-ui/`); T4 floor store + 1,000-block escape (search/zoom-to-file,
durable event log); intent binding at ingest; the Nightshift design
system (`DESIGN.md`); connections on any repo + multi-repo federation;
and the ghost layer (live `muse` dispatch). Current counts and open
work: `specs/roadmap.md` and `TODOS.md`.

Scale ceiling: a floor boots at most 2,500 files in total (across
federated districts) — measured server RSS crosses the 150 MiB
budget at ~3,000 files. A larger repo is refused at boot with the
counts named, before any state is written.

Connections (any repo): the floor now understands TS/JS, Python,
Java, Kotlin, and Go repositories with no project-specific rules.
Import belts come from tree-sitter imports resolved per language
(tsconfig paths, Python packages, JVM fully-qualified names, Go
modules incl. nested `go.mod` directories). On top of that, a
literal-only connections pass (`connections/`) extracts what each
file connects to — HTTP endpoints it exposes (Spring mappings,
Express/Fastify, Nest, FastAPI/Flask-style decorators, Go mux/gin),
outbound calls (Feign, WebClient/RestTemplate, `fetch`/axios,
`requests`/`httpx`, `net/http`), database tables it reaches through
Controller→Service→Repository→Entity chains (JPA `@Table`, native
and JPQL `@Query`, Spring Data derived methods; read vs write where
the method name or SQL verb proves it), and Kafka topics it
produces/consumes. The inspector shows these per selected file and
per endpoint handler, in both directions (endpoint → tables,
endpoint ← callers). Every fact cites the line it was proven from;
anything dynamic (placeholders, templates, concatenated or
constant paths, dynamic bases, absolute external URLs) is shown as
unresolved, never guessed. Unsupported frameworks detected in-file
(JAX-RS `@Path`, Django URLconfs) also surface as unresolved notes.

Several repos can share one floor: pass `--repo` more than once
(the repos must share a parent directory; each becomes a district).
Cross-repo belts are drawn only from real contract links — an HTTP
call matched to an endpoint of the service the client actually
names (Feign `name=` vs the target repo's `spring.application.name`;
explicit Feign `url=` never joins locally), and Kafka topics with
a producer on one side and a consumer on the other. A targetless
relative call only ever matches its own repo, and an ambiguous
destination matches nothing. Headless ground-truth report:
`bun run scripts/connections-report.ts <repo> [<repo>...]`.

Known limits, deliberately visible rather than papered over:
method overloads resolve by name; mounted-router prefixes
(`app.use`, FastAPI `prefix=`, gin `Group`) are not joined, so
router-local paths report as written; Go `replace`/`go.work`
remapping and build tags are not read; a repo naming several
Spring applications claims no single service name, so named Feign
calls into it stay unmatched; duplicate JVM FQNs stay unresolved;
shared topic names are treated as the same topic (cluster identity
is not modeled).

## Ghost layer (agent dispatch)

The dispatch console at the bottom of the floor talks to a real
agent. Type a prompt, hit SEND, and the server spawns
`muse exec --json --yolo --workspace <repo>` with the spike's
standing elicitation instruction prepended ("Before writing any
file, first record a todo/plan listing the exact relative file
paths you will create or modify."). **Dispatch runs Muse with
`--yolo` in the selected workspace** — approvals bypassed, exactly
as the spike measured; it is an explicit action from the
token-authenticated local console, and SEND becomes Stop while a
run is active.

Paths extracted from the agent's todo snapshots become ghosts:
dashed amber outlines at the layout slot the eventual building
will occupy. A write landing on a ghost path while the run is
active solidifies it (an intended `file-written` event, admitted
only when the intent-binding gate binds it to a persisted plan);
the observed write is always recorded regardless. Paths still
unwritten when the run ends — or after 10 minutes with no session
activity — are abandoned: the outline stays, dashed and dimmed,
until the next dispatch. The worker chip in the top strip shows
the agent state and current plan step. Ghosts in a collapsed zone
are counted on its pad caption, never invisible. The Runs button
opens the session viewer: every dispatch this boot as a work
order — prompt, state (running/done/error/stopped), times,
result, and the agent's text answer when it spoke. The ledger
is per-boot; a restart forgets it.

Verified live 2026-10-18 on a scratch repo (not simulated):
dispatch → ghosts for both planned files ~12 s in, before either
file existed → each solidified as a bound intended write when the
agent wrote it → run done in ~34 s. Flags: `--agent none` runs a
watch-only floor (dispatch refuses out loud); `--agent-bin <path>`
(or `ARTIFEX_MUSE_BIN`) points at a different Muse binary. If
`muse` is not on PATH, dispatch says so instead of failing
silently. One muse session is kept per floor lifetime, so
follow-up prompts resume context.

Known ghost-layer limits: Muse only (Claude Code/Codex adapters
are future work — see the matrix below); single worker; writes
during a run are attributed to the worker (a human write
mid-run to a planned path would solidify it too — with no run
active, human writes resolve ghosts as superseded, never
agent-solid); ghosts are not clickable yet; after a restart,
modify-intent for existing files is not restored (create-intent
is, from the durable event log).

## Agent capability matrix

Measured live on 2026-10-13 — method and raw evidence in
`spike/RESULTS.md`. Ghosts only ever render from "emits intent" channels;
everything else lands observed-solid.

| Agent | Emits intent | Lead (median) | Receives prompts | Answers why |
|---|---|---|---|---|
| Muse | Yes — elicited todo only | 29 s (elicited); none natural | Yes (exec, MSP) | Post-hoc yes; MSP sideChat/recap schema-only |
| Claude Code | Yes — plan turn only | Approval latency; 52 ms natural | Yes (`-p`, stream-json in) | Post-hoc yes |
| Codex | Partial — NL plan steps (app-server) | 20 ms live (write-time) | Yes (exec, app-server, queue) | Post-hoc yes |
| OpenCode | Unverified (ACP shape fits) | — blocked: no credentials on spike machine | Yes (ACP `session/prompt`, handshake verified) | Unverified |

## Develop

```sh
bun run start                         # floor server on http://127.0.0.1:4517 (--repo <path>, --port <n>, --agent muse|none, --agent-bin <path>)
bun run server/index.ts --repo <a> --repo <b>   # federate sibling repos on one floor (shared parent dir)
bun run scripts/connections-report.ts <repo> [<repo>...] [--json <out>]   # headless connections ground truth
bun test                              # full test suite (events, layout, parser, watcher, server)
bun run typecheck                     # strict types across all modules
bun run spike/harness/run.ts muse    # rerun a spike measurement
```

## License

Functional Source License 1.1 with MIT as the future license
(`FSL-1.1-MIT`, see [LICENSE](LICENSE)): the source is open — anyone can
read, use, modify, and redistribute it for any purpose except offering a
competing commercial product or service. Each release converts to plain MIT
two years after publication.
