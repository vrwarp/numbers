# E-sign setup discoverability — entry points (design report)

Status: **proposal** (researched against the codebase; refined through a 5-round UXR
critique-ideation loop; not yet implemented). Companion to `docs/ESIGN_DESIGN.md` —
nothing here changes the e-sign protocol; this is purely about how users *find out* that
e-signing exists and needs a one-time setup.

## 1. The problem

A user is **eligible** for e-sign when the registry is bootstrapped, the master switch is
on (A5), and they clear the rollout scope (A8: `scope="everyone"`, or `User.esignAllowed`,
or admin). **Set up** means: profile-page wizard (consent → Google re-auth → key + drawn
signature → `SignerIdentity` `pending`) and then the **in-person vouching ceremony** (two
attested members or one approver-plus scan their QR) → `attested`. Only attested users can
run ceremonies.

Today the *only* proactive setup surface is the profile card (`SigningIdentityCard`),
reachable solely by navigating to `/profile`. Everything else is reactive and late:

- `Esign.notAttested` appears **inside the submit dialog** — after the tap already froze a
  draft (`ReviewClaim.tsx` `openSubmitForApproval` calls `freezePacketForSignature()`
  before the dialog can reveal the wall). A state mutation on a dead-end path.
- The "E-sign" primary button renders for every eligible user regardless of setup
  (`esignActions` never consults `identityStatus`), and the desktop gutter hint
  (`esignFinishHint`) tells un-set-up users "Finish this claim — print, or e-sign."
- `Claims.subtitle` unconditionally promises claims "can be printed or sent for approval"
  — including to users outside the allowlist, for whom the promise is false.
- The Shoebox first-run guide (step1–4) teaches **only the paper path**.
- A member granted a Position (or told "you're an approver now" at a board meeting) gets
  no signal at all: `User.role` is mirrored only for enrolled identities
  (`syncRosterMirrors` iterates `SignerIdentity` rows), routing skips non-attested holders
  silently (`pickSuggestedApprover`), `/api/esign/members` lists attested only, and the
  Approvals tab never appears for `role="member"`. Nobody tells *them*; claimants
  eventually hit `Esign.noEligibleApprovers`.

Why lateness is expensive **here**: attestation is in-person, so discovery at submit time
costs the claimant until the next gathering (~a week). There are deliberately **no
notifications** (decision 9) — in-app UI is the only channel. And
submitted/approved/paid exist *only* as e-sign ceremonies, so an un-set-up user's claim
dead-ends at `generated`.

Two further facts shaped everything below:

- **Approver enablement is a three-step chain**: enroll (self-service, minutes) → attested
  (in-person) → an officer grants the role (possible only for attested members; effective
  only after the recovery step). Copy that says "set up and you're done" is false for this
  cohort.
- **Setup's first tap on production is a Google popup** (`SigningConnectCard`), and a
  second device hits the device-approval wall. Copy that promises "two minutes" without
  mentioning this recreates the dead-end it's fixing.

## 2. Design principles (distilled from the critique loop)

**Layer model.** Surfaces divide into three layers with different rules:

- **Honesty layer** — repairs lies the UI tells today (entry points 1–4, string repairs).
  Not dismissible, no persistence, no persuasion tone; never gated by the nudge
  kill-switch (switching it off must not reintroduce the lies).
- **Persuasion layer** — invites (entry point 5). Dismissible, decaying, and gated by an
  admin **kill-switch** (`ADMIN_CONFIG_FIELDS` boolean `esignNudges`, default on, audited,
  hot-reloaded, no migration; its effective value rides the enabled branch of
  `/api/esign/badges` so live cards clear within one 90-second poll).
- **Ops layer** — gives the humans who run the rollout visibility and a script (entry
  point 6). In a congregation the human channel out-performs every pixel.

**Consent is durable.** The member decline ("I'll stick with paper") is **terminal** for
ambient persuasion — only a real state change (they enrolled anyway; they gained a duty)
overrides it. Never re-ask decliners; the one bounded re-ask (paper-repeat) applies only
to accounts with *no* dismissal record. Decline/dismiss marks must survive multi-tab
races: the nudge-state PATCH is a **server-side per-key merge** (client sends deltas;
unknown keys preserved; decline keys monotonic; size-capped; `prefersPaper` excluded).

**Decay everywhere.** Nothing nags forever: member card auto-collapses to a one-line chip
after 21 days un-actioned (`firstSeenAt` mark) or 14 days stuck in pending; duty card
snoozes weekly, caps at 4, then collapses — escalation moves to the ops layer (a
conversation, not a card). Terminal silencers: attested, position removed, `prefersPaper`.

**State-branched copy.** Every surface branches on `identityStatus`:
`null` → "set up" family (mentions the Google sign-in and the in-person split — the
now-vs-next-service distinction is *the* expectation to set); `pending` → "show your QR
code" action family (deep-links to the QR; softened with "you may be asked to sign in
with Google first"); `attested` → surfaces vanish (one closure card); `revoked` → neutral,
profile-owned copy only, no cheer. Names of possible vouchers appear only at the QR
destination (`VoucherDirectory`), never on cards.

**Tone and language.** Member persuasion is indigo (coaching — nothing is wrong); duty
surfaces amber with **capability-forward** wording on shared screens (face-safe for
officers; any deficit sentence lives only on duty-only screens). Members' copy says "sign
and submit"; only duty variants say "approve". Paper is legitimized in the same breath
(labeled decline, never a bare ✕). No "Sunday" hardcoding ("usually at the next service";
"Remind me next week"). zh catalogs split the lexicon: candidate-facing surfaces say
当面确认/當面確認 ("confirm in person"); 担保/擔保 (guarantor register) stays only on
voucher-facing ceremony surfaces. 您 register for all new surfaces. Shared wording is
declared in `SAME_VALUE_GROUPS`/`QUOTED_IN` (`translation-state.ts`) so the unification is
test-enforced across locales; GLOSSARY.md gains the split.

**Gating and privacy.** Every surface evaluates the same predicate the badges endpoint
uses (`getRegistry()` + `esignAccessAllowed`); outside eligibility *nothing* renders, and
the new badges fields (`identityStatus`, duty flag, nudge-switch state) ride **only** the
enabled branch. Dismissal state is never surfaced to admins; "prefers paper" is a
treasurer-*entered* audited column (action + targetUserId), never inferred from telemetry;
the vouch-capacity count stays server-side (never returned to clients); the
skipped-approver line speaks at position granularity only.

## 3. The entry points

Ordered by ship wave. Former draft IDs kept in parentheses for traceability to the loop
appendix.

### 3.1 Claim review: honest finish buttons + no-mutation callout (EP4; wave 1, size M)

**Moment.** The single highest-intent moment in the product: an eligible, un-attested
owner on `/claims/[id]` with a finished draft or generated claim — today they see a
primary "E-sign" button that cannot succeed for them, and tapping it freezes their draft
before telling them so.

**Treatment.**
1. While `identityStatus !== "attested"`: **Print stays primary**; the e-sign slot demotes
   to a secondary button relabeled by state — `null`: "Set up e-signing"; `pending`:
   "Waiting for confirmation". The pending control is a real, enabled button (never
   `aria-disabled`) with `aria-expanded` and an accessible name that includes the action
   ("E-signing: waiting for in-person confirmation — details").
2. The demoted button opens a small **callout, not the ceremony modal** — and performs
   **no state mutation** (the draft freeze is gated on attested). The callout carries: the
   state-branched explanation with the latency line ("confirmation happens in person —
   usually at the next service"), the CTA (→ profile landing, or the QR for pending), and
   outcome-worded paper reassurance ("You can still hand this claim in on paper — download
   the PDF now and print it at church or wherever's easy"). Accessibility contract:
   `role="region"`, programmatic focus on open, Esc + explicit close both return focus to
   the trigger; no focus trap.
3. The desktop gutter hint *replaces* `esignFinishHint` when un-attested (today that hint
   offers e-sign to people who can't); mobile placement is an inline callout above the
   action bar.
4. In-dialog repairs ride along: `Esign.notAttested` becomes state-branched and plain
   (never tells a pending user to enroll again; no "vouched" jargon);
   `Esign.noEligibleApprovers` drops "unenrolled" and names the recovery (paper now;
   withdraw stays possible). The dialog's own not-attested branch stays as a server-truth
   backstop, documented as intentionally unreachable from the gated owner path.

**Details that matter.** New `data-testid` for the demoted button — `submit-for-approval`
keeps meaning the real ceremony button (both emulator e2e suites click it); the env is
fetched once on mount today, so re-run `loadEnv` on tab focus (a user vouched mid-session
must not keep a stale demoted bar); testid registry in CONVENTIONS extended.

**Why first.** It fires at the moment of intent, replaces a misleading affordance rather
than adding a surface, cannot habituate, and removes a real bug (mutation on a dead-end
path). Highest conversion per unit of annoyance in the whole set.

### 3.2 Claims list: status-aware subtitle (EP3; wave 1, size S)

**Moment.** `/claims` — where "Ready to submit" status chips face users who can't
actually submit.

**Treatment.** Branch `Claims.subtitle` (a wayfinding line, not a banner — no accent
color, not dismissible): ineligible → print-only wording (fixes today's unconditional
"or sent for approval" over-promise, which currently leaks the feature's existence to
non-allowlisted users); eligible+`null` → "…printed — or e-signed once you set up
signing" (plain link to the profile landing); eligible+`pending` → "…show your QR code at
church and e-sign from then on" (link lands on the QR); `revoked` → print-only wording;
attested → today's copy.

### 3.3 Account menu: persistent row (EP7; wave 1, size S)

**Moment.** Any page, menu open — the always-available, zero-pressure door.

**Treatment.** A row after the reduced-tabs block and divider, above Profile:
`null` → "✍️ Set up signing" + "Not set up" chip (declared in `SAME_VALUE_GROUPS` with
`Identity.chipNone`); `pending` → "✍️ Show your QR code" + "Waiting for confirmation"
chip; `revoked` → row stays, no chip; after a decline or `prefersPaper` → row stays, chip
dropped (the chip's to-do valence is what would contradict an accepted decline — the row
is a door, not a task). The row never feeds the avatar work-dot (that dot means "pending
work"). Data is free: the badges route already selects `signerIdentity.status`; expose
`identityStatus` on the enabled branch.

### 3.4 Profile landing: deep link, connect-gate framing, return leg (PRE-B + EP11;
wave 1 core, wave 3 full; size S + M)

Every CTA above lands on `/profile?open=esign` — which requires wiring `/profile` into the
existing `?open=` contract (`use-open-param` + `data-open-id="esign"` +
`highlight-pulse`, reduced-motion-gated). Without this, every CTA in this document is a
broken link; it ships in wave 1.

The full landing spec (wave 3, with a degraded wave-1/2 mode of plain `?open=` links):

- **Nudge-originated visits land on the card's `enrollIntro` state** — one more explicit
  tap opens the wizard. The existing `justConnected` auto-open (Google popup → straight
  into the consent modal) is suppressed for this entry path: teleporting from an indigo
  card into legal text ("the binding text is the English version…") is how a wary elder
  concludes the feature is dangerous. The landing repeats the nudge's vocabulary (zh
  reuses `enrollIntro` phrasing).
- **Connect-gate framing ships in wave 2** (promoted after the red-team round): on
  production the first tap yields a Google popup, for `pending` users too — one plain
  line above the connect card ("First, sign in with the same Google account you use for
  this app") on *both* the null and pending paths, and pending-card copy softened with
  "you may be asked to sign in with Google first." Without this, wave 2 ships a politer
  version of today's dead-end — at church, on the one day latency matters.
- **Return leg is wizard-owned, never automatic.** When `open=esign` is present the
  identity card owns `?return=` and ProfileForm's save-push is suppressed (today it would
  yank a user who fixes their name mid-enrollment back to the claim). The pending/QR
  completion state renders "Back to your claim" + "You can still hand it in on paper
  today — e-sign once you're confirmed."

### 3.5 Home card system: member invite · duty · closure (EP1 + EP6-duty + EP12;
wave 2, size M + S island)

One home-slot machinery (server-rendered + a ~20-line client island that fetches
`/api/esign/badges` on the standard 90-second `useAutoRefresh` cadence — live
appear/disappear, including kill-switch-off within one poll).

**Member invite** (indigo; audience: eligible, `identityStatus null|pending`, not in the
duty cohort):
- `null`: "Skip the printer — sign and submit claims from your phone. You'll sign in with
  Google again, set up in about two minutes, and then two members (or one approver)
  confirm it's really you in person — usually at the next service."
  Buttons: [Set up signing] and a **labeled decline** [I'll stick with paper] — same
  `btn-secondary` geometry as the CTA, never a bare ✕ or text link.
- `pending`: "Almost there — show your QR code to any two members (or one approver) at
  church. (You may be asked to sign in with Google first.)" [Show your QR code].
- Lifecycle: decline is terminal (see §2); un-actioned card collapses to the one-line
  chip after 21 days; pending stalls collapse after 14 days (escalation is the ops layer,
  not louder cheer). Suppressed while the Shoebox first-run guide renders (the
  predicate-branched step-4 line carries the message alone until the first receipt);
  suppressed when the church lacks vouch capacity (server-side count: ≥1 attested
  approver-plus or ≥2 attested members besides the viewer — never returned to the
  client); yields to the profile-incomplete nudge (P1) and pauses politely for the
  device-request banner (accepted co-presence exception).
- One bounded re-ask for silent ignorers only (no dismissal record of any kind): when a
  prior claim sat `generated && submitSeq=0` for >14 days and a new one appears —
  "Finishing on paper? The next one can be signed from your phone." Once per account,
  ever. **Blocked on `Reimbursement.generatedAt`** (see §5 — the audit event the draft
  assumed does not exist).
- First-run step 4 (`Shoebox.step4`): predicate-branched via a page-computed prop
  (`searchEnabled` pattern); eligible variant is outcome-neutral ("…print and sign, or
  e-sign — you'll be offered both"); ineligible keeps today's copy exactly.

**Duty variant** (amber, capability-forward; audience: **active Position holders with
`identityStatus null|pending`** — precisely, *not* `eligibility === "cannotApprove"`,
which would also catch attested holders still awaiting their role grant):
- `null`: "Set up signing so members can send you claims to approve. Setup is
  self-service; confirmation happens in person; then an officer switches on your approver
  duty. Don't skip the recovery step — your duty can't be switched on without it."
- `pending`: "One scan and you're confirmed — any officer can do it."
- Lifecycle: [Remind me next week] snooze (no dismiss), cap 4, then permanent one-line
  chip — escalation transfers to the Members-page tally. Terminal silencers: attested,
  position removed, `prefersPaper`. Outranks the profile-incomplete nudge (replaces it;
  short viewports show the duty chip only) — the highest-stakes signal must not hide
  behind a mailing-address nag. **Hard-paired with 3.6(c)**: never ship the promise
  ("an officer switches on your duty") without the officer-side control that fulfills it.

**Closure card** (one-shot; attested + owns a `generated` claim at render):
"You're set up — '[claim]' can now be e-signed. You can now also confirm others at church
— that's your Vouch tab." Buttons: [Open the claim] and [Got it] — **both** mark
`closureShown` (explicit client action only; render-marking would be consumed by
`router.refresh()`/locale switches). The claim reference is recomputed per render;
if none exists, degrade to "your next claim can be e-signed"; the CTA routes via the
claims list `?open=<id>` so a deleted claim degrades to the existing gone-toast. The Vouch
line is the vouch-capacity flywheel — every conversion recruits a future voucher — and is
`QUOTED_IN`-declared against `NavBar.vouch`.

Accessibility: the island's slot carries an sr-only `aria-live="polite"` status line
("Signing setup suggestion added/resolved") — never the whole card; no announcement on
initial render; card removal is deferred while focus is inside it. The island renders
only on home — never on ceremony surfaces.

### 3.6 Members page: rollout operations (EP9; wave 2, size M; queue view phase-2 L)

**Moment.** The treasurer/officers (`/members` viewers include chairman/secretary) —
the people who granted eligibility (A8) and can actually finish other people's setup.

**Treatment.**
- (a) Neutral tally — "7 set up · 5 not yet · 2 prefer paper" — plus a small
  church-health readout (attested count, pending >14 days, paper-share, duty gaps).
  Aggregates only; never a leaderboard; "not yet" is not a deficiency. Pending-age needs
  `identityCreatedAt` added to the members payload (one line, same gated select).
- (b) Pending members elevated as actionable — "You can confirm these members yourself —
  one scan," with the Vouch link inline — **gated on the viewer's own attested status**
  (an un-attested treasurer gets "set up signing to confirm members yourself" instead;
  role alone cannot vouch).
- (c) **"Confirmed, awaiting duty"** row-state: attested + holds a Position + role still
  `member`, with the grant control adjacent (RoleControls already lives on this page).
  This closes the worst silent failure in the current system: the diligent approver-elect
  who did everything asked and is still invisible to routing, while everyone concludes
  the system is broken.
- (d) The in-person script, *leading with the privacy loop-closer*: "Some members may
  have chosen paper in the app — they won't have told you. Ask: 'Want help setting up, or
  are you set with paper?' and record prefers-paper accordingly." Then: setup lives on
  each member's Profile; confirmation is in-person; seniors may need help through the
  Google sign-in popup; paper is fine; early in rollout every ceremony funnels through
  the few attested vouchers — plan the after-service table.
- (e) Phase-2: a "setup Sunday" view — pending members as a scan queue + a two-line
  assisted-setup checklist for null members (bring your phone; know your Google
  password).

`prefersPaper` is a real column, treasurer-written, **audited** (action + targetUserId,
allowlist-route precedent), and doubles as the per-person OFF ramp for the whole nudge
layer. It is never inferred from in-app behavior, and members' dismissal state is never
shown here.

### 3.7 Skipped-approver disclosure (EP13; wave 3, size M)

**Moment.** The submit ceremony, when the claimant's budget-category default Position
holder was silently skipped by routing (not attested / no role / paused / vacant) and a
fallback or nobody was prefilled.

**Treatment.** A quiet line: "Your usual approver for [category] isn't taking e-sign
approvals right now — your treasurer can help." Wording is deliberately neutral across
all three skip causes (a paused approver chose that state — A10; an attested-awaiting-role
elder must not be called "not set up"; a vacant position has nobody to describe). The
hierarchy-safe route ("your treasurer") converts the disclosure into a deliverable
message aimed at the office, not a cross-hierarchy nudge from a junior member to an
elder. Position granularity only; predicate computed server-side at render (a stale line
disparages a nameable person). Needs `pickSuggestedApprover` to expose a skip reason
(today it silently falls through); an eligibility-enum split (`notAttested` vs
`roleMissing`) is an optional later refinement.

### 3.8 Approvals inbox: backstop branches (EP6 residue; wave 3, size S)

The inbox's empty state branches by the viewer's identity status — but this is a
**backstop, not a reach surface**: the Approvals tab never renders for `role="member"`
Position holders, so only transitional states land here (re-enrollment in progress:
role kept + `pending`; revocation: role kept + `revoked`).
- `null`: "Claims can't be sent to you yet — set up signing so members can pick you as
  their approver."
- `pending`: "Setup done — one in-person confirmation left. Any officer can scan your QR;
  then members can start sending you claims."
- `revoked` (ships in wave 1 alongside 3.1 if trivial): "Your signing identity was turned
  off. See your profile for details." — neutral, no cheer.
- attested: today's 🕊️ "Nothing waiting on you."

## 4. Ship plan

- **Wave 1 — stop lying, open the door** (no schema, no persuasion, nothing dismissible):
  3.1 claim-review honesty · 3.2 subtitle · 3.3 menu row · 3.4 deep-link core ·
  P5 string repairs (`notAttested`, `noEligibleApprovers`, chip unification, zh lexicon
  split, GLOSSARY). This wave repairs *current active harms* and is not optional under
  any budget.
- **Wave 2 — invite, with ops ready**: nudge-state infrastructure (JSON merge column +
  PATCH; `prefersPaper`; `Reimbursement.generatedAt`) · **3.6 Members ops BEFORE 3.5**
  (the human channel must exist before the machine channel generates questions) · 3.5
  home card system (with decline-terminal, decay, snooze cap, capacity gate, connect-gate
  copy leg) hard-paired with 3.6(c) · persuasion kill-switch.
- **Wave 3 — polish**: 3.4 full landing/return · 3.7 skipped-approver line · 3.8 inbox
  backstops · 3.6(e) queue view · per-locale chip-length checks.
- **At 60% funding, cut in order**: 3.7 → 3.4-full (keep plain `?open=` links + the
  connect-gate line, which ships in wave 2 regardless) → 3.6(e) → 3.8 → closure card.
  Never cut wave 1, 3.6(a–d), or the kill-switch.

## 5. Measurement (existing-data-only, small-congregation rules)

Success is judged on individual humans, not rates (N is tens):

1. **Coverage**: every active claimant (≥1 generated claim in 90 days) among eligible
   users is attested or `prefersPaper`; **zero duty gaps** (same for active Position
   holders). The Members tally *is* the dashboard.
2. **Discovery timing**: for each new `SignerIdentity`, `createdAt` vs the owner's first
   claim-generation. Enrollment before first generation = discovered early; within ~48h
   after = hit the wall. Success = wall-pattern enrollments stop.
3. **Paper-exit trend**: eligible users' claims stuck `generated && submitSeq=0` >14 days
   trend down; median `attestedAt − createdAt` ≤ ~8 days (one gathering); generate→submit
   latency shrinks.

**Blocking fact found in round 5**: the claim-generation timestamp these metrics (and the
paper-repeat re-ask) assume does **not exist** — the pdf route writes no AuditEvent and no
`generatedAt`. Add `Reimbursement.generatedAt` in the wave-2 migration and key everything
on it. Do *not* substitute a nudge AuditEvent.

**Permanent bans**: no nudge view/click instrumentation anywhere; AuditEvent (evidentiary
trail) and ExtractionLog (AI telemetry with retention semantics) are off-limits for nudge
events; no per-entry-point attribution (the card-vs-QR `?open=` target split is all the
channel signal worth having); no dismissal/decline-rate metrics (a decline is a legitimate
outcome; measuring it manufactures win-back pressure); no A/B at congregation scale (two
members comparing phones at church is a trust incident). The better instrument: 3.6(d)
gains "ask new sign-ups how they found it."

## 6. Ideas considered and rejected

- **Email/push notification** — decision 9 rules out notification infra; the nav is the
  channel.
- **Post-print "next time, skip the printer" toast** — the assumed anchor (`pdfReady`) is
  an iOS-fallback card, not a success toast; on most platforms the moment doesn't visibly
  exist; the claims-list subtitle catches the same cohort at the next decision point.
- **Grant-moment "New!" card** — the home card's first appearance *is* the grant moment;
  "New:" plumbing buys nothing.
- **Forking the first-run guide into a second pitch** — one pitch per screen; step 4 gets
  a predicate-branched neutral wording only.
- **Voucher names on nudge cards** — the names endpoint is enrolled-only, server cards
  would duplicate logic, and locale-aware list joins are a hazard; names live at the QR
  destination, which already renders them.
- **"First claim ready" re-arm** — the claim-review callout owns that moment with better
  proximity.
- **Sign-in page mention** — pre-auth, eligibility is unknowable (A8 would leak scope).
- **Modifying the official CFCC PDF** (footer promo) — the form is a fixed contract.
- **Modal takeover / forced tour** — violates A2's calm-UI rule; enrollment is optional.
- **Badging Receipts/Claims tabs for setup** — tab badges mean actionable work, not
  promos; same reason the account-menu row never feeds the avatar dot.
- **Nudge view/click analytics** — see §5 bans.

## 7. Appendix: the critique-ideation loop

Method: an initial draft was produced from a code-level journey audit, then refined
through five adversarial UXR rounds, each a different lens, each ending in an ideate/
revise pass. Every load-bearing claim was verified against the repo during the rounds.

- **R1 — Heuristic evaluation + cognitive walkthroughs** (claimant, new approver, pending
  member): produced the no-mutation rule and button demotion (3.1), the
  one-ambient-nudge budget, account-level dismissal, pending-as-action ("show your QR
  code"), subtitle-instead-of-banner (3.2), the closure moment, and the skipped-approver
  disclosure; killed the post-print toast; merged three overlapping surfaces.
- **R2 — Persona walkthroughs** (elderly zh-Hant deaconess; monthly-check approver;
  mobile-only claimant; chairman with face concerns; the treasurer running the rollout):
  discovered the duty cohort as originally defined was **empty** (roles mirror only after
  enrollment — verified in `syncRosterMirrors`), re-keying it to Position holders and
  adding the officer-side "awaiting duty" control; added the three-step honesty rule, the
  Google-popup expectation, the labeled paper decline, capability-forward duty wording,
  the zh 担保→当面确认 candidate/voucher lexicon split, 您 register, the prefers-paper
  marker, and the assisted-setup script.
- **R3 — Feasibility & consistency**: found every CTA targeted a deep link that doesn't
  exist yet (PRE-B born); consolidated persistence into one merge-safe JSON column +
  audited `prefersPaper`; fixed the closure one-shot to client-marked (render-marking
  would be eaten by locale switches); moved names off cards; established testid and
  `SAME_VALUE_GROUPS`/`QUOTED_IN` discipline; sized every entry point.
- **R4 — Attention economics & measurement**: made the decline terminal (label and
  retention must match), capped and terminated the duty snooze, added ignore-decay and
  pending-staleness collapse, the vouch-capacity gate, the persuasion kill-switch, the
  honesty/persuasion/ops layer model, the ship waves, and the existing-data-only
  measurement plan with its instrumentation bans.
- **R5 — Red team, accessibility, coherence**: caught the phantom `generate-pdf` audit
  event (→ `Reimbursement.generatedAt`), the false "lands on QR" promise on production
  (→ connect-gate copy promoted to wave 2), the duty-trigger misfire on
  attested-awaiting-role members, kill-switch storage/propagation, multi-tab
  last-write-wins vs the terminal decline (→ per-key monotonic merge), the a11y contracts
  (status-phrase-as-button, live-region and focus rules), the un-attested-treasurer
  dead-end in the ops copy, revoked-state branches, and the closure card's stale-claim
  degradation.

Per-surface verdicts after round 5: everything ships with the listed fixes; the three
"needs-rework" items (generatedAt, kill-switch storage, merge semantics) are resolved in
the text above.
