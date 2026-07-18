# Limited-height mobile UX — audit findings & plan

Status: proposed (UXR audit 2026-07-18; no code changes yet).

Scope: mobile viewports with **limited visible height** — the landscape phone
(tested at 844×390) and the portrait phone with the on-screen keyboard up
(tested at 390×460 of visible height). Captured from a production build
(`next build` + `next start`, `AI_MOCK=1`, seeded receipts + a draft claim),
Chromium with touch emulation. Each screen went through three
critique → ideation loops; this doc records what survived loop 3.

## Measured problem

Share of the first viewport that is *working content* (rest is sticky nav,
headers/banners, sticky action bars), measured from the captures:

| Screen                  | Viewport | Nav | Headers/banners | Content | Action bar | Content share |
| ----------------------- | -------- | --- | --------------- | ------- | ---------- | ------------- |
| Receipts, 3 selected    | 844×390  | 64  | 171             | 95      | 60         | **24%**       |
| Receipts, 3 selected    | 390×460  | 64  | 235             | 101     | 60         | **22%**       |
| Review claim, top       | 844×390  | 64  | 228             | 25      | 73         | **6%**        |
| Review claim, row       | 390×460  | 64  | 0               | 285     | 111        | 62%           |
| Profile, field focused  | 390×460  | 64  | 80              | 316     | 0          | 69%¹          |

¹ Save button below the fold — the visible form can't be completed.

Two outright interaction blockers were observed:

1. **Split editor opens underneath the sticky action bar** (claim review,
   390×460). The amount input, the stays/split-off summary, and Confirm all
   render behind the floating bar; the user sees the editor heading and then
   the Print button. Nothing indicates scrolling would reveal the input.
2. **"Describe this receipt" dialog hides its own subject** (390×460). The
   note field and Save are below the fold; the crop/rotate editor fills the
   viewport. Height is capped with `vh`, which ignores the iOS keyboard, and
   the viewport export doesn't set `interactive-widget`, so Android keyboards
   cover rather than resize the layout.

## Root causes (themes)

- **T1 — width-only responsiveness.** Every breakpoint is width-based; a
  844×390 landscape phone gets `sm:`+ desktop styling with 390px of height.
  There is no way to say "when the viewport is short."
- **T2 — chrome budget.** Sticky nav (64px) + multi-row sticky action bars +
  banner stacks leave ≤25% of short viewports for content; scrolling reclaims
  nothing because everything is sticky.
- **T3 — occlusion.** The claim action bar is `sticky bottom-4` and floats
  over in-flow content (tip banners, receipt headers, the split editor);
  no `scroll-padding-bottom` compensates.
- **T4 — dialogs cap height in `vh` and center vertically**; primary buttons
  land under the keyboard. The e-sign dialogs already use the better pattern
  (bottom sheet: `items-end` + `rounded-t-2xl`, e.g. `ConfirmDialog.tsx`).
- **T5 — unspent width.** The receipt|fields grid in claim review is gated at
  `lg:` (1024px); a landscape phone stacks a ~292px receipt photo above the
  fields. Image clamp uses `75vh`.
- **T6 — header weight.** `text-3xl` titles + intro sentences + verbose
  banners cost 80–235px before content on every screen.
- **T7 — safe areas.** The shoebox dock pads `env(safe-area-inset-bottom)`
  (good) but nothing pads the left/right insets that matter in landscape.
- **T8 — no guardrail.** No Playwright project runs at a short viewport, so
  none of the above can regress visibly.

## Plan

### P0 — interaction blockers

1. **Never occlude an active editor** (T3).
   - Suppress the action bar (CSS hide/translate, not unmount — testids
     survive) while `splitOpenId` is set in `ReviewClaim.tsx` (bar at ~:1210).
   - Global `scroll-padding-bottom` equal to the bar height; scroll the split
     editor into view (`block: 'center'`) when it opens.
   - Stack the stays/split-off summary boxes vertically below 400px width.
   - Escalate to a bottom-sheet split editor only if keyboard measurements
     still swallow Confirm after this.
2. **Dialog footers reachable with the keyboard up** (T4).
   - Upload-note dialog (`Shoebox.tsx` ~:670): note field directly under the
     title; photo collapses to a thumbnail behind "Edit photo" on short
     screens; Save/Cancel pinned footer (flex column, scrollable middle).
   - `vh → dvh` for every dialog height cap (`AddReceiptsDialog.tsx:186`,
     `ManualEntryDialog.tsx:87`, `Shoebox.tsx:674`, esign dialogs are already
     sheets but also use `92vh`).
   - Keep per-file save semantics (each Save uploads that file); a batch note
     step is explicitly out of scope — it changes the upload pipeline.
3. **`interactiveWidget: "resizes-content"`** in the `viewport` export
   (`src/app/layout.tsx:25`) so Android keyboards resize the layout.

### P1 — chrome budget & core screens

4. **`short` variant foundation** (T1): in `globals.css` (Tailwind v4)
   `@custom-variant short (@media (max-height: 500px));`
5. **Un-stick the nav on short viewports** (T2): `NavBar.tsx:97`
   `sticky → short:static`; scrolling reclaims 64px, no JS.
6. **Single-row action bar at `bottom-0`** on short screens (T2):
   progress becomes a thin line on the bar's top edge + compact "0/2"
   (keep the accessible "n / m verified" string for e2e/a11y); matching
   `padding-bottom` on the list; no `bottom-4` gap.
7. **Header & banner compression** (T6): titles `short:text-xl`, intros
   `short:hidden`; profile warning collapses to a one-line chip (≥44px
   target, keeps role); claim review's "Ministry & event" card becomes an
   inline segmented control in the header row; tip banner one dismissible
   line. All new strings via `messages/*.json` + translator context +
   `npm run translate` (invariant 10).
8. **Profile sticky save footer**: reuse the existing pattern
   (`BudgetCategories.tsx:175`, `admin/SettingsTab.tsx:147`); "Saved ✓"
   feedback moves into the footer; email demoted to caption text. Explicit
   save stays (feeds a signed legal document — no autosave).
9. **Verify button visible whenever its row is**: elevate the per-row
   Confirm beside the amount in `LineItemRow`; optional Event field behind
   "+ Add event" on short screens (trial behind the variant first).

### P2 — landscape layout

10. **Two-column claim review at `md:`** instead of `lg:`
    (`ReviewClaim.tsx:1097`); check the sticky fields column at 768–1023px.
11. **Receipt image clamp** `max-h-[75vh] → max-h-[min(60dvh,320px)]`
    (`ReviewClaim.tsx:1102`).
12. **Safe-area x-padding** on fixed bars/docks (`Shoebox.tsx:516`,
    claim action bar) for notched landscape (T7).

### P3 — polish & guardrail

13. Sign-in hero compression (once-per-device screen — CSS only);
    claims-list header/padding density. Claims-card enrichment (ministry,
    merchant summary) is a separate feature — needs list-endpoint fields.
14. **Short-viewport Playwright project** (844×390 or 390×460) asserting:
    primary action of each core screen inside the first viewport; split
    editor's `split-amount` visible after opening; no fixed element overlaps
    a focused input (T8).

## Ideas considered and rejected (loop-3 casualties)

- Two-column landscape sign-in — once-per-device screen, not worth a layout.
- Auto-hiding (translate-on-scroll) nav — motion + state complexity;
  `short:static` gets the same 64px for one class.
- Selected-receipt thumbnail tray in the shoebox dock — duplicates the grid
  once headers shrink; revisit only if misselection shows up in usage.
- Delete-behind-long-press on receipt cards — discoverability loss, changes a
  tested interaction that already has a confirm guard.
- Bottom-sheet split editor — duplicates editor markup/logic and test
  surface; only if the cheap fix (P0.1) measurably fails under keyboard.
- Batch upload-note step — changes upload pipeline semantics, not layout.
- Profile autosave on blur — breaks explicit-save contract for data printed
  onto a signed form, and the "Saved ✓" e2e assertion.

## Verification

`npm run build && npm test`, then e2e (chromium) including `mobile.spec.ts`
and `nav-adaptive.spec.ts`; after P1, add the P3 guardrail project and
re-capture the five measured screens — target ≥50% content share on the
Receipts and Review-claim first viewports, and both P0 blockers gone.
