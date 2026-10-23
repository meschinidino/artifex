import { describe, expect, test } from "bun:test";
import type { ToasterProof } from "../server/toaster-proof.ts";
import type { ZoneRect } from "./layout.ts";
import { gateAtPoint, packetPoint, packetRestX, stageAtPoint, storyLayout } from "./toaster-stage.ts";
import { buildToasterPanel } from "./toaster-view.ts";

const ZONES: ZoneRect[] = [
  { id: "src", name: "src", x: 100, y: 50, w: 400, h: 300, fileCount: 4 },
  { id: "lib", name: "lib", x: 548, y: 50, w: 300, h: 300, fileCount: 2 },
];
const SEED: ToasterProof = {
  schema: "toaster-gate-1",
  env: "homologacion",
  stub: false,
  ranAt: "2026-10-23T15:03:23.326Z",
  cuitMasked: "20•••••••9",
  voucher: { ptoVta: 1, cbteTipo: 11, cbteDesde: 2, cbteHasta: 2, impTotal: 1000, monId: "PES" },
  cae: "86431019567246",
  caeFchVto: "20261102",
  resultado: "A",
  reproceso: "N",
  obs: [],
  errors: [],
  latencyMs: { status: 247, voucher: 134 },
};
const NOW = Date.parse(SEED.ranAt) + 1000;

describe("toaster-stage geometry", () => {
  test("pad sits below the zones, left-aligned, machines in story order", () => {
    const layout = storyLayout(ZONES, buildToasterPanel([SEED], { recorded: true, now: NOW }));
    expect(layout.pad.x).toBe(100);
    expect(layout.pad.y).toBeGreaterThan(350);
    expect(layout.stages.map((s) => s.stage.id)).toEqual(["ask", "build", "file", "prove"]);
    expect(layout.stages[0]!.x).toBeLessThan(layout.stages[3]!.x);
    expect(layout.gate.x).toBeGreaterThan(layout.stages[3]!.x + layout.stages[3]!.w);
  });

  test("hit tests match the drawn rects: stages, gate, neither", () => {
    const layout = storyLayout(ZONES, buildToasterPanel([SEED], { recorded: true, now: NOW }));
    const ask = layout.stages[0]!;
    expect(stageAtPoint(layout, ask.x + 4, ask.y + 4)).toBe("ask");
    expect(gateAtPoint(layout, layout.gate.x + 4, layout.gate.y + 4)).toBe(true);
    expect(stageAtPoint(layout, layout.gate.x + 4, layout.gate.y + 4)).toBeUndefined();
    expect(stageAtPoint(layout, ask.x - 40, ask.y)).toBeUndefined();
  });

  test("packet rides ASK to gate monotonically and rests at the gate when proven", () => {
    const panel = buildToasterPanel([SEED], { recorded: true, now: NOW });
    const layout = storyLayout(ZONES, panel);
    const xs = [0, 0.25, 0.5, 0.75, 1].map((p) => packetPoint(layout, p).x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    expect(packetPoint(layout, 0).y).toBe(layout.beltY);
    expect(packetRestX(layout, panel)).toBe(layout.gate.x + layout.gate.w / 2);
    const empty = buildToasterPanel([], { recorded: false, now: NOW });
    expect(packetRestX(layout, empty)).toBe(layout.stages[0]!.x + layout.stages[0]!.w / 2);
  });

  test("zoneless floor still lays out at the origin", () => {
    const layout = storyLayout([], buildToasterPanel([], { recorded: false, now: NOW }));
    expect(layout.stages).toHaveLength(4);
    expect(layout.pad.w).toBeGreaterThan(layout.gate.x + layout.gate.w - layout.pad.x);
  });
});
