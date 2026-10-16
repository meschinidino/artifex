---
# gstack: design-md-format=spec
name: Artifex
description: Nightshift Assembler — a warm factory floor on night shift; matte industrial material on canvas, cool dark instrument chrome.
colors:
  primary: "#46C07A"
  on-primary: "#10241A"
  floor: "#20241D"
  surface: "#2C3128"
  surface-2: "#333931"
  surface-3: "#3E453B"
  line: "#4A5245"
  well: "#1A1E19"
  text: "#EDE8D8"
  text-muted: "#A8B09C"
  success: "#46C07A"
  warning: "#E0A437"
  error: "#E5484D"
typography:
  display:
    fontFamily: Anton
    fontWeight: 400
    fontSize: clamp(2rem, 5vw, 3.5rem)
    letterSpacing: 0.02em
  body:
    fontFamily: Instrument Sans
    fontSize: 1rem
    lineHeight: 1.55
  label:
    fontFamily: Saira Semi Condensed
    fontSize: 0.8125rem
    letterSpacing: 0.14em
  mono:
    fontFamily: JetBrains Mono
    fontFeature: tnum
rounded:
  sm: 2px
  md: 3px
  circle: 50%
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  button:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
  input:
    backgroundColor: "{colors.well}"
    borderColor: "{colors.line}"
    rounded: "{rounded.sm}"
  plate:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
  nav-link:
    textColor: "{colors.text-muted}"
---

# Artifex

## Overview

**Creative North Star:** A night-shift factory the user owns: the Canvas floor reads as a working Factorio yard (bay signage, machines, moving belts) while the surrounding chrome stays a quiet dark instrument, because the product must feel like a game and work like a pro tool for hours at a time.
**Product context:** Artifex is a local-first dev tool: a live map of one codebase as a factory floor (folders as zones, files as machines, imports as belts) plus a ghost layer showing AI coding agents at work. Solo developers supervising agents. Operate-mode tool with an Experience core.
**Mode per surface:** Floor canvas: Experience (the showpiece). Inspector/dispatch/top strip: Operate. Ghost why-notes and logs: Read. No Persuade surfaces in v1.
**Reference sites:** https://gource.io/, https://codecharta.com, https://codescene.com, https://factorio.com/ (visited read-only; screenshots under ~/.gstack/projects/meschinidino-artifex/designs/design-research-20261016/).
**Key characteristics:** Warm graphite ground with painted bay signage. Machines with roofs, lamps, and glyphs, not flat boxes. One green that always means live production. Square screwed-down hardware, zero glow. Full-bleed floor with chrome that gets out of the way.

## Colors

**Strategy:** Committed — one green owns live production, warm graphite neutrals derive from its complement, amber and red are fenced to single meanings.
**Light or dark:** Dark is normative: the use scene is hours of supervision in a dark tool stack. A Dayshift light direction (sage concrete #C9CFC0, bleached steel #EDEFE3, ink #1F261C, belt green #0B7A3E) was previewed and is recorded as experimental, not normative.
Green signals the live worker and primary action only. Amber signals abandoned or inferred only. Red signals errors only, and only on lamps, badges, and large text: measured 3.03:1 on surface-2, so red never carries body copy. Neutrals are green-tinted graphite; text is warm ivory tinted from the surface hue, never pure gray. States are never color-only: lamp plus shape plus label (D4).

## Typography

Faces come from two worlds: factory signage (Anton bay paint, Saira nameplate stencil) and the terminal readout (JetBrains Mono paths and counts), with Instrument Sans as the quiet UI voice. Operate register throughout. Display is Anton 400 uppercase, zones and hero only, never body or UI. Labels are Saira Semi Condensed 600 uppercase with wide tracking, nameplates and readouts only, never sentences. Mono carries paths, code, counts, and inputs with tabular numerals always on. Loading: one Google Fonts CSS link (Anton, Instrument Sans 400-700, Saira Semi Condensed 500-700, JetBrains Mono 400-600, display=swap); Canvas floor render waits on document fonts. No overused-list exceptions: all four faces are clear, and Clash Display was proposed and rejected as banned.

## Layout

Chrome is a grid-disciplined instrument frame: 56px top block-shelf strip (worker state, N of M, last-change readout, follow toggle), right inspector as a retracting full-height workbench drawer with a square graphite handle rail (ivory grip chevron), 72px bottom dispatch console (prompt input plus square SEND), thin status curb, minimap as a framed site-plan plate inset in the floor corner. The floor owns 100 percent of pixels at rest; the drawer covers it only on demand. Density is compact-operate. Spacing rhythm follows the 4px scale; canvas building pitch stays 96 with stepped size bands. Narrow windows collapse the inspector to a toggleable overlay; semantic zoom keeps three bands with large and recently changed buildings labeled first.

## Elevation & Depth

Depth is hard offset shadow only (4px, zero blur), plus plate borders and bevel pairs (light top edge, dark bottom edge on roofs). No glow, no gradients, no glass, no translucency. Plates stack like steel in sun; the ghost layer is a dashed amber outline, flat by rule.

## Shapes

Radius hierarchy: 2px for inputs, tags, and badges; 3px for plates, zones, and floor mockup buildings; 50 percent for status lamps only. No pill radius exists anywhere: SEND keys, toggles, and handles are square. Hazard striping appears only at zone borders.

## Components

Buttons press physically (translate 2px, shadow shrinks); no hover background change. Primary is live green with dark ink; default is roof-surface with ivory text; ghost is transparent with a plate border. Focus-visible rings use live green at 2px on every interactive element. Inputs are dark wells in mono. Plates (zones, inspector, minimap) never nest inside plates. The legend renders on first run and stays one click away. Disabled states drop to muted text on surface with no shadow shift.

## Do's and Don'ts

- Do: reserve green for the live worker and primary action, amber for abandoned/inferred, red for errors; pair every status color with shape plus label.
- Do: paint zone names large in Anton; navigate by bay signs, not tooltips.
- Do: keep idle at zero animation; collapse all motion under prefers-reduced-motion.
- Do: theme selection, focus rings, caret, and scrollbars from these tokens.
- Do: show missing data as missing (empty plates, N of M counts); mask secrets always.
- Don't: float rounded cards, pills, glass panels, or glowing edges anywhere.
- Don't: use red or amber for decoration, links, or emphasis.
- Don't: set body, UI sentences, or code in Anton or Saira.
- Don't: nest plates inside plates or border-left-stripe a rounded card.
- Don't: invent a new hue for a new state; extend shape, label, or position instead.

## Motion

- **Approach:** minimal-functional (locked D10).
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out).
- **Duration:** drawer slide 150ms; belt dash flow 1.2s loop; change pulses under 1.5s capped at 20 recent; ghost-to-solid is the one authored moment.
- **The one authored moment:** a dashed amber ghost solidifying into a lit machine when the agent's write lands.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-16 | Initial design system created | Created by /gstack-design-consultation: Q2-approved Nightshift Assembler from research (4 sites) plus 2 in-host voices (Signal Box, Dayshift Yard); tokens from approved HTML preview CSS; all faces verified on Google Fonts; red fenced to large text by measured 3.03:1 |
| 2026-10-16 | Drawer handle built as graphite rail, not brass | No brass token exists and D4 forbids new hues: surface-3 rail with ivory grip chevron from existing tokens; approved through the 16-round outside review |
