# AI summaries: plan

1. Wire (`floor-ui/wire.ts`): `GetSummaryMessage` (file path or
   belt pair target), `SummaryMessage` (target echo, text,
   generatedAt, cached).
2. Server (`server/summarize.ts`, new): pure context assembly
   (caps, neighbor formatting, prompts) + cache + runner over
   injectable spawn (`muse exec`, prompt-file, 120 s timeout) +
   ARTIFEX_SUMMARY_STUB modes. `server/index.ts`: build contexts
   from buildings/belts/file text, answer `get-summary`.
3. Client (`floor-ui/app.ts` + `index.html`): Summarize buttons
   (file head, edge jumps), summary sections with AI label +
   meta + Regenerate, loading/error/outdated states, reset on
   selection change.
4. Tests: `server/summarize.test.ts` (prompts, caps, cache,
   runner success/timeout/failure, stub), e2e file + belt +
   error via stub.
