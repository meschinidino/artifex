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
bun test                              # full test suite (events, layout, parser, watcher, server)
bun run typecheck                     # strict types across all modules
bun run spike/harness/run.ts muse    # rerun a spike measurement
```
