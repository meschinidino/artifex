# Belt click inspector: plan

1. Wire (`floor-ui/wire.ts`): add `via?: string[]` to `BeltEdge`;
   add pure `resolveEdgePair(belts, buildings, fromId, toId)` →
   card model `{ fromPath, toPath, edges, gone }` or undefined
   when either endpoint id is unresolvable.
2. Server (`server/index.ts` `currentBelts`): accumulate `via`
   per dedup key — import lines from `importLinesByPath`,
   `METHOD path — line N` per matched call, `topic via handler
   — line N` per produce. Import lines ascending; http/topic in
   conn order.
3. Client (`floor-ui/app.ts`): `selectedPair` state +
   `selectEdge` (exclusive with `selectBuilding`); pointerup
   branch between removed-marker and zone tests with the BHT1
   guard; `showEdgeInspector` mirroring `showRemovedInspector`;
   highlight fallback `hoverRoute ?? selectedPair`; Escape
   clears; `__belts.selected` probe; snapshot/patch refresh the
   card (flips to gone, never stale).
4. Markup (`floor-ui/index.html`): `#insp-edge` block — From/To
   rows, `#insp-edge-sections`, gone line, jump buttons.
5. Tests: `wire.test.ts` (pair/gone/multi-kind/unknown-id),
   `server/belts.test.ts` (import + http + topic via), e2e
   (click belt → card → jump → re-click → Esc clears).
