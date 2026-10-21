# Belt click inspector: requirements

Date: 2026-10-20. Builder testing: "loving the effect when I
hover a belt, but clicking it should show me WHAT the belt is."
Click a belt: pin the endpoint pair and show an edge card in the
inspector — endpoints, relationship kind, and server evidence.

## Requirements

- BCR1: At mid/near bands, a pointerup without drag that hits no
  building or removed marker but lands within 10 screen px of a
  drawn route selects the endpoint pair and shows the edge card:
  FROM path → TO path, one section per edge kind on the pair
  (IMPORT / HTTP CALL / KAFKA TOPIC), each listing its server
  `via` evidence lines, plus jump buttons to each endpoint file.
  The belt test runs before zone toggle in the hit chain, so
  clicking a belt no longer toggles its zone. Far band (rollup,
  no routes) or zero drawn routes: belt test skipped, behavior
  unchanged.
- BCR2: The selected pair redraws in ivory above the batch like
  hover (BHT1 style); hover wins while present. `__belts.selected`
  reads `[fromId, toId]` or null (diag + e2e seam).
- BCR3: Re-clicking the pair, empty-floor click, building select,
  and search jump all clear the edge. No prompt addressing and no
  preview/diff fetch for edges (nothing dispatchable).
- BCR5: A pair incident to the selected machine keeps it: the
  spotlight stays while its belts are inspected (card shows the
  edge, floor keeps the isolation, prompt keeps the machine
  address). A foreign pair switches to the edge alone. Escape is
  progressive: pair first (back to the machine card), then the
  machine.
- BCR6: Empty-floor click deselects first: with a machine or pair
  selected, clicking empty floor inside a zone clears the
  selection and leaves the zone untouched. Zone toggle on empty
  click happens only when nothing is selected.
- BCR4: `BeltEdge.via?: string[]` (additive wire field): server
  evidence, display-ready, one item per relationship —
  `line 12: <source text>` per import line (ascending),
  `GET /path — line 42: <text>` per HTTP call,
  `topic via handler — line 17: <text>` per produce. Source text
  is trimmed, secret-masked, capped at 120 chars (BCR4b: the card
  shows what the line says, not just its number); unreadable
  lines fall back to the bare citation. A `uses …` item names
  the symbols the source actually takes from the target, only
  when the cited line text does not already name them (BCR4c):
  Go `alias.Symbol` selector scans (blank → side-effect note,
  dot → unqualified note), TS multiline/namespace statement
  names, Python hidden from-names, JVM wildcard typeRefs met
  against declared types (re-anchored to the import statement in
  the display layer; the trace export stays line-less). Go edges
  attribute per file (BCR4d): only used symbols the target file
  declares are claimed (parsed top-level types/funcs/methods/
  vars/consts); unreadable targets fall back to the bare
  citation rather than borrowing package-wide uses. Incidental
  fan-out (BCR4e): a Go edge the source provably does not use
  (regular import, determined uses, readable target declaring
  none of them) is not drawn at all — every belt on the floor
  has demonstrable uses. Blank/dot/unreadable edges are always
  kept; resolution itself is unchanged (the trace export and
  agent model still record the package import).
  Multi-relationship pairs ship every item, never first-only. A
  pair with zero edges in the current snapshot shows its
  endpoints plus "belt no longer present", never stale evidence.

## Non-functional

- Hit-test reuses BHT1's `nearestRoute` threshold; render only on
  selection change. DESIGN.md: existing inspector classes only
  (label/mono/conn-section/btn), no new hues. Coverage ≥95/95:
  resolver + server via covered by unit tests, app glue pinned
  by e2e.
