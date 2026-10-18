# Artifex

Factorio-inspired visual IDE for coding agents: agents are the workers,
the human manages the factory floor. Design (approved):
`docs/designs/artifex-ghost-factory.md`.

Status: pre-alpha. T1 protocol spike is done (`spike/RESULTS.md`,
preliminary at n=1 per condition; builder gate inputs recorded there);
T2 shared events module is done (`events/`); T3a ground layer is built
(`server/`, `watcher/`, `parser/`, `floor-ui/` — live floor without belts;
acceptance measurements on issue #2); T3b import belts (issue #3)
is done and reviewed (`resolver/`, belt wiring, zoom-gated render);
T4 floor store + 1,000-block escape is done (search/zoom-to-file,
durable event log). Roadmap: `specs/roadmap.md`. Next: intent
binding at ingest.

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
bun run start                         # floor server on http://127.0.0.1:4517 (--repo <path>, --port <n>)
bun run server/index.ts --repo <a> --repo <b>   # federate sibling repos on one floor (shared parent dir)
bun run scripts/connections-report.ts <repo> [<repo>...] [--json <out>]   # headless connections ground truth
bun test                              # full test suite (events, layout, parser, watcher, server)
bun run typecheck                     # strict types across all modules
bun run spike/harness/run.ts muse    # rerun a spike measurement
```
