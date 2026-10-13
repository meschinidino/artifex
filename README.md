# Artifex

Factorio-inspired visual IDE for coding agents: agents are the workers,
the human manages the factory floor. Design (approved):
`docs/designs/artifex-ghost-factory.md`.

Status: pre-alpha. T1 protocol spike is done (`spike/RESULTS.md`,
preliminary at n=1 per condition; builder gate inputs recorded there);
T2 shared events module is done (`events/`). Next: T3 ground layer.

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
bun test                              # events contract tests
bun run spike/harness/run.ts muse    # rerun a spike measurement
```
