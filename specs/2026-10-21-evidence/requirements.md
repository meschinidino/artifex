# Clickable evidence: requirements

Date: 2026-10-21. Builder decision (option A): via rows citing a
source line expand the code inline under the edge sections —
staying on the belt card (visual repo navigation).

## Requirements

- ECL1: Via rows matching `line N:` render as buttons (text-like,
  underline on hover, focus ring); uncited rows stay plain text.
  Click → `get-lines` (from-side path, center N, radius 10) →
  expansion block: title `lines a–b of <path>`, mono snippet with
  the cited line marked `>>`. Re-click collapses. One expansion
  per card.
- ECL2: Server guards mirror open-file (env/alias/excluded/
  building/binary); file problems report `lines-failed` (inline),
  malformed requests stay `bad-message`. Radius capped 25;
  centers clamp. Masking preserves line numbering.
- ECL3: A patch touching the shown file collapses the expansion
  (never stale code); BCR4 refreshes keep it; selection changes
  clear it. Preview/down reports inline, never blank.
