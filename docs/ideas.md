# Ideas

Intake list, unprioritized. Each item needs a proper spec before it becomes
roadmap work. Collected 2026-10-18.

## Structural trace export

Status: shipped 2026-10-20 — spec in `specs/2026-10-19-trace-export.md`, landed on main.

One-click export of a file or symbol's neighborhood — imports, importers,
callers, callees, endpoint/table links — as compact markdown with `path:line`
anchors and no source code. The point is agent context: structure is the part
a model can't reconstruct cheaply, and source it can already read. Natural fit
for the inspector panel and the planned agent interface.

## Change-footprint overlays

Status: shipped 2026-10-20 — spec in `specs/2026-10-19-footprint-overlays.md`, landed on main.

Render the working tree's footprint directly on the floor: added, modified,
and removed nodes each get their own distinct treatment, so one change shows
its whole architectural blast radius at a glance. Same overlay machinery could
later show a single session's footprint (what this run touched) once replay
work starts.

## Instruction write-back

Status: shipped 2026-10-20 — spec in `specs/2026-10-19-writeback.md`, landed on main.

After a run ends, record concrete, reusable lessons back into the repo's agent
instruction file (`AGENTS.md` or equivalent): what wasted context, what to do
differently next time. The session viewer already keeps the raw material
(prompt, result, timing); this closes the loop so each run makes the next one
cheaper.

## Declarative contract handlers

Status: shipped 2026-10-20 — spec in `specs/2026-10-19-contracts.md` (SQL/table-reference v1), landed on main.

Extend the connections pass beyond code imports to declarative contracts:
SQL/table references, OpenAPI specs, Protobuf/GraphQL schemas, Terraform.
Same honesty rules as the existing pass — literal-only, every fact cites its
line, anything dynamic stays unresolved. Terraform is the interesting edge:
"what does this actually expose" asked of infrastructure.

## Zero-install preview

Status: shipped 2026-10-20 — spec in `specs/2026-10-19-preview.md` (single-file export), landed on main.

A way to see a floor without installing anything: a hosted demo over a sample
repo, a paste-URL map that builds in the browser, or a single-file floor
export. Nothing here changes the local-first product; it's purely an adoption
ramp so a curious viewer reaches the "oh, I get it" moment before any setup.

## Run cost readout

Status: shipped 2026-10-20 — spec in `specs/2026-10-19-run-cost.md`, landed on main.

Show what each dispatch cost in the session viewer: wall time, and token
usage where the agent reports it. Runs are already work orders with prompts
and outcomes; cost per order is the missing column, and the natural basis for
spotting expensive patterns across runs.
