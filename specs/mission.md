# Mission: Artifex

Factorio-inspired visual IDE for coding agents: agents are the workers,
the human manages the factory floor.

## The product

A live map of a codebase, rendered as a factory floor — folders as zones,
files as machines, imports as conveyor belts — plus a ghost layer that
shows AI coding agents at work: what they just wrote (observed) and,
when elicited, what they plan to write next (intent).

Two halves, in order:

1. **The floor (what is).** A real-time, truthful rendering of one repo.
   Nothing is shown that cannot be proven from bytes on disk
   ("text is truth"): unparseable files get an error lamp, secrets get
   masked, missing data is shown as missing.
2. **The ghosts (what is happening).** Agent sessions surface as ghosts
   on the floor via a shared event log. Intent renders only from
   measured intent channels; everything else lands observed-solid.

## Non-goals for v1

- Multi-repo floors (deferred; gated on the single-repo validation gate).
- Session replay UI (deferred; needs a shipped ghost layer first).
- Guessing: no inferred edges, no unproven plans, no silent gaps.

## Source of truth

Approved design: `docs/designs/artifex-ghost-factory.md` (Approach B,
Ghost Factory, chosen; Approach C, Replay Theater, as a later layer).
This file summarizes; the design doc decides.
