# Push notifications (FCM) — design

Status: **draft under UXR critique** — this document is being refined through an
ideation → UXR-critique loop; see §14 for the revision log. Nothing here is
implemented yet.

The one-sentence pitch: today the only way anyone learns that work arrived —
a packet awaiting their signature, a claim approved, a new device asking for
approval — is to have the app open and glance at a polled badge
(`src/components/NavBar.tsx` refreshes `/api/esign/badges` every 90 s and its
own comment calls that badge "the ONLY way an approver parked on another page
learns that work arrived"). Push notifications close that gap for a volunteer
congregation that opens this app a few times a month.

## 1. Goal

- Tell the right person, on their own device, when something they are waiting
  for (or something waiting for them) happens — without them keeping a tab open.
- Respect the app's trust model: the numbers server stays unable to touch the
  e-sign Firestore ledger; push must not become a back door credential.
- Every notification is opt-in, per-category controllable, localized
  (en / zh-Hans / zh-Hant), and never load-bearing: a user with notifications
  off has exactly today's experience — badges, banners, and pages still work.
- Delivery machinery mirrors the embeddings subsystem's discipline
  (invariant 11): enqueues are fire-and-forget and can never gate or fail the
  mutation that triggered them.

## 2. Non-goals

- **No email/SMS channel.** Web push (FCM) only, this iteration. The design
  keeps a `channel` column so email could join later, but nothing is built.
- **No in-payload sensitive data.** Push payloads transit Google (and Apple's
  APNs on iOS). They carry titles, short labels and routes — never money
  amounts, receipt images, or signature material (§11).
- **No marketing/broadcast surface.** There is no "message all members"
  feature; every notification is born from a lifecycle event the recipient is
  a party to.
- **Notifications never carry authority.** Tapping one only navigates; every
  screen re-checks session + permissions as it does today. A forged or replayed
  push can annoy, not authorize.
- **No native apps.** The installed PWA is the mobile story (manifest already
  ships `display: standalone`).

## 3. Platform primer — what FCM web push actually is (research summary)

Verified against Firebase docs and current (2026) platform behavior:

- **Web push = service worker + push subscription.** The Firebase JS SDK
  (`firebase/messaging`) wraps the standard Push API. A service worker file
  (conventionally `public/firebase-messaging-sw.js`) receives background
  messages; `onMessage` handles foreground ones. Pages must be HTTPS.
- **VAPID key pair** (Firebase console → Cloud Messaging → Web Push
  certificates) identifies the sender to browser push services. The public key
  is client-safe config; there is no secret on the client.
- **Registration tokens are per browser-profile-per-device.** `getToken()`
  (with the VAPID key + our SW registration) yields a token after the user
  grants notification permission. Tokens are what the server sends to; they go
  stale (FCM garbage-collects after ~270 days of inactivity) so the server
  stores a `lastSeenAt` per token, refreshes it whenever the app loads, prunes
  on send errors (`messaging/registration-token-not-registered` ⇒ delete row),
  and skips tokens unseen for longer than a staleness window (60 days) —
  stale tokens silently crater delivery rates.
- **Sending is the FCM HTTP v1 API only** (the legacy server-key API shut down
  June 2024). The `firebase-admin` SDK's `messaging().send()` handles OAuth,
  batching, and typed errors. Authentication requires a **service account** —
  see §4 for why ours must be messaging-scoped only.
- **Message shape:** we always send full `notification` + `webpush` payloads
  (title/body composed **server-side, already localized** — §9), with
  `webpush.fcm_options.link` for the click-through route, a `collapse key`
  (`webpush.headers.Topic`) so repeated events replace rather than stack, and
  a TTL suited to the event (a device-approval request is worthless tomorrow;
  "your claim was paid" can wait a day). Data-only messages are avoided: on
  web they require the SW to fabricate the notification and browsers penalize
  silent pushes.
- **iOS reality (large share of a congregation):** the Push API exists only for
  **installed home-screen web apps** on iOS 16.4+. In-Safari-tab browsing has
  no push at all. Standard FCM JS works once installed (it rides APNs
  transparently). Permission prompts must be triggered by a user gesture.
  Consequence: the enable flow must teach iPhone users to "Add to Home Screen"
  first, and the UI must detect and explain this state rather than dead-ending
  (§8.4).
- **Permission UX ground rules** (web.dev guidance, and Chrome/Firefox now
  auto-suppress prompts from sites with poor grant rates): never ask on page
  load; ask from a **contextual soft-ask** (our own explainer UI) at a moment
  the benefit is obvious; the native prompt fires only after the user accepts
  the soft-ask. A declined native prompt on Chrome can permanently mute us, so
  the soft-ask is also protection.

## 4. The trust-model collision, resolved

Two standing decisions get explicitly superseded, not quietly eroded:

**Decision 9 ("No notification infrastructure", `docs/ESIGN_DESIGN.md` §1)**
was made when the workflow shipped; its own §6.1 names the stalled approver an
"expected failure mode — there are no notifications," and the NavBar comment
concedes the polled badge is the only discovery surface. This design amends
decision 9: notifications become an *optional acceleration layer* on top of
badges — the badge/inbox surfaces remain authoritative and fully sufficient
(§1), so decision 9's real point (the workflow must not depend on delivery)
survives.

**The keyless-server constraint** — ESIGN §2: *the numbers server holds no
Firestore credentials at all (`firebase-admin` stays keyless, projectId-only,
used solely for ID-token verification)*. FCM sending requires a Google service
account — the first server-held Firebase credential — so this needs an
explicit resolution:

- **A dedicated service account with a custom IAM role containing exactly one
  permission: `cloudmessaging.messages.create`.** No predefined "Firebase
  Admin" role, ever. This SA cannot read or write Firestore, so the e-sign
  property actually being protected — *the server can neither read nor forge
  ledger events* — survives intact. The ESIGN doc's wording is amended from
  "no Firebase credentials" to "no credentials that can touch the ledger;
  the push SA is messaging-only by IAM construction" when this ships.
- The SA JSON lives in runtime config only (`FCM_SERVICE_ACCOUNT_JSON` env var
  or `<DATA_DIR>/config.json` overlay), is never returned by any GET (the
  `EmbeddingSettings.apiKey` fingerprint-only pattern), and initializes a
  **second, named** firebase-admin app so the existing keyless default app —
  and every `verifyFirebaseIdToken()` call site — is untouched.
- **Considered alternative — standalone Web Push (`web-push` npm, self-minted
  VAPID keys, no Google credential at all).** It would keep the server 100%
  Google-credential-free and works on every browser FCM web push works on.
  We still choose FCM because the product asked for it, it unifies future
  native clients, and its send API + error taxonomy are better maintained —
  but the schema stores generic push tokens, so swapping transports later
  touches only the send adapter, not the data model.

## 5. Notification catalog — every event, its audience, and whether it earns a push

The e-sign workflow is **strictly serial** — SUBMIT (owner names exactly one
approver) → APPROVE/REJECT (that approver only) → MARK_PAID (any unpaused
treasurer) — so the audience of every notification is a small, determinate set:
the named approver, the owner, or the active treasurers. There is no "N of M
signers" fan-out problem. The full lifecycle audit (every transition, actor,
route, and how the affected user finds out today) traced these as the events
worth pushing:

### Ships in v1

| Kind | Trigger (route) | Recipients | Category | Content sketch | Tap opens | TTL / collapse |
| --- | --- | --- | --- | --- | --- | --- |
| `signing-request` | SUBMIT lands (`…/[id]/submit`, **and `…/reconcile`** — see §7.1) | The named approver | Signing | "Signature requested — {claim event label}" / "Submitted by {name}" | `/approvals` | 14 d · `signing-request:{claimId}` |
| `claim-approved` | APPROVE (`…/[id]/decision`, reconcile) | Claim owner | My claims | "Your claim was approved — {label}" | `/claims/{id}` | 7 d · `claim:{claimId}` |
| `claim-rejected` | REJECT (same routes) | Claim owner | My claims | "Your claim needs changes — {label}" / "The approver left a note" (note text itself never in the payload) | `/claims/{id}` | 14 d · `claim:{claimId}` |
| `finance-queue` | APPROVE (same routes) | All treasurers/admins with finance duty unpaused, minus the actor | Finance | "A claim is ready for payment — {label}" | `/finance` | 7 d · `finance:{claimId}` |
| `claim-paid` | MARK_PAID (`…/[id]/paid`, reconcile) | Claim owner | My claims | "Your reimbursement was paid — {label}" (no amount, no check number) | `/claims/{id}` | 3 d · `claim:{claimId}` |
| `device-request` | Client hint from the requesting device (§7.1b) | Same user's **other** devices | Security | "A new device asked to join your signing identity. If this wasn't you, review now." | `/` (the app-wide `DeviceRequestsBanner` takes over) | 30 min · `device:{userId}` |

Notes on the table:

- **Reassignment is free:** withdraw + resubmit to a new approver replays
  `signing-request` to the new person (a fresh `submitSeq` makes it a new
  dedupe key, §7.2). The *old* approver gets nothing — the item simply leaves
  their queue, which matches today's behavior and avoids a "you lost work"
  guilt notification.
- **`device-request` is mostly a security alert.** The multi-device plan
  assumes the member is holding both devices during approval, so the happy
  path rarely needs the push — its real value is the *"if this wasn't you"*
  case. Short TTL because a stale device prompt is pure noise.
- The rejected-claim note stays out of the payload (lock screens, transit) —
  the body invites the tap instead.

### Explicitly deferred (phase 2 candidates, in priority order)

1. `approver-unavailable` — your submitted claim's approver paused their
   duty (today surfaced only if the owner opens the claim panel).
2. `identity-attested` — "you can now sign and vouch" when the vouch
   threshold is crossed.
3. `vouch-needed` — a new member awaits vouches (eligible vouchers only;
   risk of noise, needs volume data first).
4. `claim-ready` — only if receipt extraction ever moves from the current
   foreground NDJSON stream to a background queue; today the user watches it
   live, so there is no event to push.
5. Weekly digest / stale-work reminders ("3 claims have waited > 7 days") —
   deliberate fatigue-management decision required first (§8).

### Considered and rejected

- Uploads, claim creation, PDF generation, reverts: self-actions in the
  foreground; pushing them to the actor is noise.
- `esignAllowed` toggles, role grants, duty pauses (as events to the person
  toggled): low value or admin-visible already; role grants land with a
  ceremony the grantee is usually present for (revisit with real usage).
- Mirror `reconcile` repairs as their own event: reconcile is crash-repair
  plumbing, but it **is** a trigger site for the real events above (§7.1).

## 6. Data model

Two new tables plus `User` columns, shaped like the repo's existing patterns
(`SearchHistory` for owner-scoped rows, `EmbeddingJob` for the durable queue):

```prisma
model PushToken {
  id           String   @id @default(cuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  token        String   @unique          // FCM registration token
  locale       String   @default("en")   // locale captured at (re)registration — per-device fidelity
  userAgent    String   @default("")     // trimmed label for "manage devices" UI, e.g. "Safari · iPhone"
  createdAt    DateTime @default(now())
  lastSeenAt   DateTime @default(now())  // refreshed on every app load; staleness window keys off this
  @@index([userId])
}

model NotificationJob {
  id            String    @id @default(cuid())
  userId        String                    // recipient (NOT the actor)
  kind          String                    // catalog key, e.g. "signing-request"
  category      String                    // preference bucket it obeys (§8.2)
  targetId      String    @default("")    // claimId / deviceRequestId — for collapse + deep link
  dedupeKey     String    @unique         // {kind}:{targetId}:{recipient}:{submitSeq} — replay-proof (§7.2)
  payloadJson   String                    // event params only; text is composed per-locale at send time
  status        String    @default("queued") // queued | sent | failed | skipped
  attempts      Int       @default(0)
  nextAttemptAt DateTime  @default(now())
  leaseExpiresAt DateTime?
  lastError     String    @default("")
  createdAt     DateTime  @default(now())
  @@index([status, nextAttemptAt])
  @@index([userId, createdAt])
}
```

`User` gains preference columns (§8.2) — repo convention is explicit columns on
`User` (like `printIncludeReceipts`), not a JSON blob, so the PATCH schema and
audit diffs stay typed.

Retention: `NotificationJob` rows are pruned after 90 days (the
`ExtractionLog` embedding-kind precedent) — they are the delivery log (§11).

## 7. Delivery pipeline

Mirrors the embeddings subsystem exactly, because its constraints are the same
(never block a mutation, survive restarts, single container).

### 7.1 Where events enter the queue — two sources

**(a) Server-observed transitions.** Enqueue helpers in
`src/lib/notifications/enqueue.ts` — one per catalog event, called
fire-and-forget (`.catch(log)`) from the mutating route *after* its
transaction commits. A failed enqueue can never fail the mutation
(invariant 11 discipline). Hook sites: `…/[id]/submit`, `…/[id]/decision`,
`…/[id]/paid`, **and `…/[id]/reconcile`** — a decision signed on another
device reaches this server's mirror through reconcile, not through the primary
ceremony route, so reconcile enqueues the same events (dedupe in §7.2 makes
the overlap harmless).

**(b) Client-hinted self-events.** The keyless server never sees charproof
device-approval requests (they live in Firestore, which the server cannot
read). So the *requesting device* — which is already authenticated as the same
user — POSTs a fire-and-forget hint (`/api/notifications/hint`,
`device-request` only) after filing its request. Hints are **strictly
self-scoped**: an authenticated user can only ever trigger a notification to
their *own* other devices, so the entire spoof surface is "spam yourself."
The hint carries the requesting device's own token so it can be excluded from
recipients.

### 7.2 Dedupe

`NotificationJob` carries a unique `dedupeKey` —
`{kind}:{targetId}:{recipientId}:{submitSeq}` for claim events — and enqueue
is create-if-absent (the `EmbeddingJob` upsert discipline). Reconcile replays
and route retries therefore no-op against an existing job regardless of its
status; a genuine re-submit after withdraw carries a new `submitSeq` and
notifies the (possibly new) approver exactly once.

### 7.3 Worker

`startNotificationWorker()` joins `startEmbeddingWorker()` in
`src/instrumentation.ts` (in-process singleton loop, lease-based claim,
generation-guarded finalize, `__notifyWake?.()` nudge from enqueue so delivery
is near-instant rather than next-poll). Per job: re-check the recipient's
master + category switches and role/pause state **at send time**, resolve
fresh tokens (`lastSeenAt` within 60 d), compose localized payloads per token
locale (§9), send via the messaging-only admin app. Per-token outcomes:
`registration-token-not-registered` / `invalid-argument` ⇒ delete that token
row; transient errors ⇒ retry with backoff up to N attempts then `failed`.
Job is `sent` if ≥ 1 token succeeded, `skipped` if preferences/tokens
evaporated between enqueue and send.

### 7.4 Collapse & TTL

The worker sets the web-push `Topic` header from the catalog's collapse key
(so rapid-fire events about one claim replace each other in the tray, not
stack) and the per-kind TTL from §5 (an expired urgency never fires after a
container outage).

### 7.5 Mock mode

`PUSH_MOCK=1` (the `AI_MOCK`/`ESIGN_MOCK` convention) makes the send adapter
record deliveries to a local sink instead of FCM so unit + e2e suites assert
on real queue/dedupe/preference behavior with zero network.

## 8. Enabling, disabling, and the permission dance

### 8.1 Principles

- Default is **off**. Nobody is subscribed until they act.
- Enabling is **per-device by nature** (a token is a device); the *preference*
  is per-account. The mental model shown to users: "Notifications: on for this
  account — receiving on 2 devices."
- Disabling must always work even when the browser permission is a lost cause
  (user blocked it at the browser level): the account-level switch stops
  sends server-side regardless of token state.

### 8.2 Preference model

`User` columns, all honored at enqueue time *and* re-checked at send time:

- `notifyEnabled` — master switch (default `false`).
- Per-category switches (default `true`, only consulted when master is on),
  matching the §5 catalog's category column: `notifySigning` (claims awaiting
  *your* signature as the named approver), `notifyClaimProgress` (your own
  claims: approved / needs changes / paid), `notifyFinance` (treasurer duty:
  approved claims awaiting payment — only shown to role-holders),
  `notifySecurity` (new-device requests — §8.5).
- PATCH via the existing `/api/profile` route + `ProfileForm` card, audited
  like every profile edit.

### 8.3 The enable flow (soft-ask first)

1. Entry points: the Profile → Notifications card (persistent, discoverable),
   plus **contextual nudges** at high-intent moments — e.g. right after a user
   generates their first packet ("Want to know when it's signed?") and right
   after a role-holder first opens `/approvals`. Nudges are dismissible and
   never repeat after dismissal.
2. Tapping enable shows our **soft-ask**: what you'll be told about (the four
   categories), on this device, revocable anytime. Confirm ⇒ native
   `Notification.requestPermission()` from that same gesture ⇒ on grant,
   register SW, `getToken()`, POST token. Decline of the soft-ask just closes
   it — the native prompt was never risked.
3. Permission already `denied` at the browser level ⇒ the card explains that
   the *browser* is blocking and shows per-browser unblock instructions
   instead of a dead toggle.

### 8.4 iOS path

If `!window.PushManager` and the UA is iOS Safari (not standalone), the card
becomes an installer: "Add this app to your Home Screen to receive
notifications" with the Share → Add to Home Screen steps illustrated; the
enable toggle appears once running standalone. (Manifest already ships
`display: standalone`, so this is education, not new plumbing.)

### 8.5 Security category nuance

In the happy multi-device flow the member holds both devices, so the
`device-request` push is usually redundant — its real value is the *"if this
wasn't you"* case, where a missed notification has a security cost. The
category keeps a switch (user agency wins), but it defaults on with the master
switch and turning it off shows a one-line "you won't be warned about new
devices" explainer.

## 9. Localization

- Push content is composed **server-side at send time** from
  `messages/<locale>.json` under a new `Notifications` namespace, using the
  token row's `locale` (per-device fidelity — a shared-language household's
  iPad and phone can differ), falling back to `User.locale`.
- Every new key gets a translator `context` note and `npm run translate` runs
  before commit (CLAUDE.md invariant 10); staleness is already a red test.
- The service worker never needs the catalogs — it only displays what the
  server composed. (This is why we send notification-messages, not
  data-messages, §3.)
- User data inside notification text (claim event names, merchant labels)
  stays verbatim, never machine-translated — same rule as the rest of the app.

## 10. Failure modes

| Failure | Behavior |
| --- | --- |
| FCM unreachable / SA misconfigured | Jobs retry with backoff, then `failed` with `lastError`; app fully functional; admin health surfaces the error (§12). Never blocks mutations. |
| Token stale/revoked | Deleted on first send error; device silently stops receiving; profile card shows per-device `lastSeenAt` so a user can see a dead device and re-enable. |
| User blocked permission at browser | Server keeps sending to a token that will never display? No: blocked permission invalidates the push subscription ⇒ send error ⇒ token pruned. Account switch remains the reliable off. |
| Duplicate events (route retried) | Collapse key makes duplicates replace, not stack; enqueue helpers are idempotent per (kind, targetId, recipient) within a short window. |
| Container down at event time | Jobs are durable rows; worker drains on restart. TTL keeps resurrected-but-expired urgency (device approvals) from firing stale. |
| User's role/pauses changed between enqueue and send | Send-time re-check of preferences + role/pause state; job becomes `skipped`. |

## 11. Telemetry & privacy (invariant 7 & the payload boundary)

- `NotificationJob` rows *are* the send log (status, attempts, lastError,
  timestamps) — pruned at 90 days. Preference changes flow through the
  existing profile PATCH audit. No new `ExtractionLog` kind: nothing here is
  an AI call.
- **Payload minimization:** titles/bodies name the claim's event label and the
  action ("Signature requested — Retreat 2026"), never amounts, never receipt
  content, never signer lists. The tap-through route is where details live,
  behind the session. Rationale: payloads transit Google/APNs and sit on lock
  screens.
- Tokens are opaque credentials-to-annoy: leak of a token lets someone spam
  that device via *our* SA only; still, tokens are never returned by any GET
  (the profile card gets device labels + timestamps, not tokens).

## 12. Admin surface

A small card on the existing admin settings tab: push health (last successful
send, queue depth, failed-job count), SA fingerprint (never the key), and a
"send myself a test notification" button. No admin access to anyone's
preferences or tokens.

## 13. Build order

1. Schema (PushToken, NotificationJob, User columns) + migration.
2. Send adapter (messaging-only admin app) + `PUSH_MOCK`.
3. Worker + enqueue helpers for the top-3 catalog events, unit-tested.
4. SW + client registration + Profile card + soft-ask (en first, then
   translate).
5. Contextual nudges, iOS installer education, admin health card.
6. Remaining catalog events + e2e (mock) coverage.

## 14. Revision log — ideation → UXR critique rounds

> To be filled: 5 rounds of UXR critique; each round records the critique's
> top findings and what changed in response.
