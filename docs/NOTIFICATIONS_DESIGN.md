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
- **No read-tracking — a non-goal, not a deferral.** Whether a notification
  reached, was seen, or was tapped is never recorded per-user or shown to
  anyone. Turning silence into legible refusal ("he was notified — why
  hasn't he signed?") is the exact social failure §5 guards against; if
  read-state is ever proposed, it needs its own consent design, not a schema
  migration.
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
  grants notification permission. Tokens are what the server sends to; they
  go stale (FCM garbage-collects after ~270 days of inactivity), so the
  server tracks per-token liveness and prunes on send errors
  (`messaging/registration-token-not-registered` ⇒ delete row). Liveness
  policy in §7.3 — crucially, a *successful send* counts as liveness, because
  this product's success mode is glance-at-the-lock-screen, which never opens
  the app.
- **Sending is the FCM HTTP v1 API only** (the legacy server-key API shut down
  June 2024). The `firebase-admin` SDK's `messaging().send()` handles OAuth,
  batching, and typed errors. Authentication requires a **service account** —
  see §4 for why ours must be messaging-scoped only.
- **Message shape:** we always send full `notification` + `webpush` payloads
  (title/body composed **server-side, already localized** — §9), with
  `webpush.fcm_options.link` for the click-through route, collapse semantics
  per §7.4 (a `Topic` header for undelivered-queue collapse *and* a
  notification `tag` for tray replacement — they are different mechanisms),
  and a TTL suited to the event (a device-approval request is worthless
  tomorrow; "your claim was paid" can wait a day). Data-only messages are
  avoided: on web they require the SW to fabricate the notification and
  browsers penalize silent pushes.
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
| `claim-rejected` | REJECT (same routes) | Claim owner | My claims | "Your claim needs changes — {label}" (the reviewer's note is mandatory in this app, so "there's a note" is filler — the body just invites the tap; note text never in the payload) | `/claims/{id}` | 14 d · `claim:{claimId}` |
| `finance-queue` | APPROVE (same routes) | All treasurers/admins with finance duty unpaused, minus the actor | Finance | Coalesced **per recipient**: "Ready for payment — {label}", updating to "{count} claims are ready for payment" | `/finance` | 7 d · tray tag `finance:{recipientId}` (dedupe stays per-claim) |
| `claim-paid` | MARK_PAID (`…/[id]/paid`, reconcile) | Claim owner | My claims | "Your reimbursement was paid — {label}" (no amount, no check number) | `/claims/{id}` | 3 d · `claim:{claimId}` |
| `device-request` | Client hint from the requesting device (§7.1b) | Same user's **other** devices | Security | "A new device asked to join your signing identity. If this wasn't you, review now." | `/` (the app-wide `DeviceRequestsBanner` takes over) | 30 min · `device:{userId}` |

Notes on the table:

- **Reassignment sends nothing new — but push already changed its social
  visibility, and the design must own that.** Withdraw + resubmit replays
  `signing-request` to the new approver (fresh `submitSeq` ⇒ new dedupe key,
  §7.2); the old approver gets no new message. Pre-push, a bypassed approver
  who never opened the app never knew the work existed; now his lock screen
  *retains the original request* as evidence he was passed over — nothing
  replaces it (the resubmit's tag targets the new person). So the
  `/approvals` empty state must be **cause-neutral and normalizing**:
  "Nothing is waiting for your signature. Owners can withdraw or reassign a
  request at any time — this is routine." (Never "already handled by someone
  else": SUBMIT names exactly one approver, so that euphemism decodes to
  "you were passed over." `/finance`, where any treasurer genuinely may have
  handled it, keeps the "already handled" wording.) The Signing-category
  soft-ask carries the same normalization line, so approvers learn *before*
  their first vanished request that reassignment is workflow, not censure.
  Translator `context` notes on these keys state why no cause may be
  implied.
- **`device-request` is mostly a security alert.** The multi-device plan
  assumes the member is holding both devices during approval, so the happy
  path rarely needs the push — its real value is the *"if this wasn't you"*
  case. Short TTL because a stale device prompt is pure noise.
- The rejected-claim note stays out of the payload (lock screens, transit) —
  the body invites the tap instead.
- **Web push cannot be retracted.** A withdrawn request or an item another
  treasurer already handled leaves a stale tray notification for up to its
  TTL; the tap lands on an empty queue. The landing pages own that moment
  with the split empty-state copy above — cause-neutral on `/approvals`,
  "may have been already handled" on `/finance` — so the stale tap reads as
  resolution, not data loss and not censure.
- **Interruption budget.** Expected volume drives the catalog: a member
  should see ≲ 2 pushes in a typical week (their own claims only); an
  approver a handful (only claims naming them); treasurers are the hot spot
  — every APPROVE fans out to all of them, so retreat season (~20 claims/
  month church-wide) is ~20 pushes each — hence the per-recipient
  coalescing above, and the quiet window in §7.3: submissions and foyer
  approvals cluster around Sunday service, and the approve→finance fan-out
  must not buzz every treasurer's phone mid-sermon. Any future catalog
  addition states its expected frequency against this budget.

### In-app parity — committed alongside v1, because push must not create castes

"Never load-bearing" (§1) is true per-user but can turn false *between* users:
once some approvers answer in minutes, owners learn who they are and route
around the rest — or a secretary starts nudging "why haven't you signed" at
people who were never told work arrived. The members least able to adopt push
(WeChat-only, iOS 15 hardware, abandoned onboarding) are exactly the ones the
stalled-approver problem already bites. Three backstops ship with v1, all
in-app, none requiring push:

- **Recent activity list.** `NotificationJob` rows are written for every
  recipient *regardless of push preferences* (§7.1) and double as an in-app
  reverse-chronological activity list ("Your claim was approved · Tuesday") —
  every member sees identical facts; push merely delivers them earlier. No
  read-tracking in v1; the list is informational, the badges remain the
  actionable surface.
- **Owner-facing stall state, de-personalized.** The claim detail (and claim
  card) shows "Waiting for signature for 9 days — you can withdraw and pick a
  different approver," turning "that elder is slow" into "you have an option,"
  with no push involved. This subsumes the old `approver-unavailable`
  phase-2 idea (the paused-approver notice already exists on the claim panel;
  this extends it to plain elapsed time). The copy **preserves charitable
  ambiguity** — "notifications are often missed; phones mute, batteries die"
  — which is simply true (§8.7, §10): delivery dies silently all the time,
  and the stall state must not teach owners to read silence as refusal.
- **Aggregate — never individual — visibility for leadership.** The §12 admin
  card gains one trend line: "claims waiting > 7 days" (count over time). It
  never breaks down by person or by who has push enabled; the design must not
  become a shaming instrument.

### Explicitly deferred (phase 2 candidates, in priority order)

1. `identity-attested` — "you can now sign and vouch" when the vouch
   threshold is crossed.
2. `vouch-needed` — a new member awaits vouches (eligible vouchers only;
   risk of noise, needs volume data first).
3. `claim-ready` — only if receipt extraction ever moves from the current
   foreground NDJSON stream to a background queue; today the user watches it
   live, so there is no event to push.
4. Weekly digest / stale-work push reminders — deliberate fatigue-management
   decision required first (§8); the in-app stall state above covers the need
   without delivery.

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
  locale       String                    // this device's resolved locale; re-captured on every app-load ping
                                         //   (never a bare "en" default — insert falls back to User.locale)
  userAgent    String   @default("")     // trimmed label for "manage devices" UI, e.g. "Safari · iPhone"
  createdAt    DateTime @default(now())
  lastSeenAt   DateTime @default(now())  // refreshed on app load + visibilitychange/focus ping
  lastSendOkAt DateTime?                 // a successful FCM send is liveness too (§7.3) —
                                         //   glance-only devices never ping but are healthy
  @@index([userId])
}

model NotificationJob {
  id            String    @id @default(cuid())
  userId        String                    // recipient (NOT the actor)
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)
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

### 7.0 Serving the service worker (this deployment has no build-time config)

The conventional static `public/firebase-messaging-sw.js` cannot work here:
Firebase config is **runtime** state (`FIREBASE_*` env or the hot-reloadable
`<DATA_DIR>/config.json`, relayed by `firebaseWebConfig()`), and the standalone
Docker image is church-agnostic — a static file could never carry a given
deployment's project config. Therefore:

- `/firebase-messaging-sw.js` is a **route handler** that renders the SW
  source with the current `configValue()` Firebase config injected, served
  `Cache-Control: no-cache` (the browser byte-compares on registration,
  navigation, push, and ~24 h — no-cache keeps that comparison honest).
- **Update contract:** this SW handles no fetches, so a new version calls
  `skipWaiting()` + `clients.claim()` unconditionally — an updated SW must
  not sit `waiting` for weeks behind a PWA parked in the iOS app switcher.
- **Changing the Firebase project in `config.json` invalidates every issued
  token.** The design accepts this (it's a church re-platforming, not a
  routine edit): sends start failing, tokens prune, and every user's §8.7
  reconnect surfaces re-enable on next visit. The admin health card states
  it plainly when it detects the mismatch.

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

Helpers resolve the audience (e.g. "treasurers with finance duty unpaused,
minus the actor") and insert one job per recipient **regardless of that
recipient's push preferences** — the job row is the event record feeding the
in-app activity list (§5), not just a send instruction. Whether and where it
is *delivered* is decided entirely at send time (§7.3): push off ⇒ the job
completes as `skipped` but still appears in the recipient's activity list.

**(b) Client-hinted self-events.** The keyless server never sees charproof
device-approval requests (they live in Firestore, which the server cannot
read). So the *requesting device* — which is already authenticated as the same
user — POSTs a fire-and-forget hint (`/api/notifications/hint`,
`device-request` only) after filing its request. Hints are **strictly
self-scoped**: an authenticated user can only ever trigger a notification to
their *own* other devices. "Spam yourself" still isn't free (FCM quota,
SQLite growth, admin health noise), and no client-supplied id may reach the
push path, so: the job's dedupe key is **server-derived** —
`device:{userId}:{15-minute bucket}` (matching the collapse key's per-user
granularity) — and the endpoint carries a small per-user hourly cap (429
beyond it). The hint includes the requesting device's own token only to
exclude it from recipients.

**Reconcile-sourced events are inherently late.** Reconcile runs when a
human opens a claim's verifying view — usually the owner — so a
reconcile-sourced `claim-approved` job would often be generated by the very
person it addresses, seconds after they read the outcome on screen. The
enqueue helper therefore suppresses a reconcile-sourced event whose sole
recipient is the reconciling user, and reconcile-sourced copy never uses
"just now" framing (§7.3 also age-gates it against the kind's TTL).

### 7.2 Dedupe

`NotificationJob` carries a unique `dedupeKey` —
`{kind}:{targetId}:{recipientId}:{submitSeq}` for claim events, the
server-derived bucket form of §7.1b for hints — and enqueue is
create-if-absent (the `EmbeddingJob` upsert discipline). Reconcile replays
and route retries therefore no-op against an existing job regardless of its
status; a genuine re-submit after withdraw carries a new `submitSeq` and
notifies the (possibly new) approver exactly once. Dedupe — not collapse
(§7.4) — is what actually guarantees "no double push" for retried routes.

### 7.3 Worker

`startNotificationWorker()` joins `startEmbeddingWorker()` in
`src/instrumentation.ts` (in-process singleton loop, lease-based claim,
generation-guarded finalize, `__notifyWake?.()` nudge from enqueue so delivery
is near-instant rather than next-poll). Per job:

- **Age gate first:** every job carries its *event-occurrence* timestamp in
  `payloadJson` (distinct from row `createdAt`). If the event is older than
  the kind's TTL, the job completes `skipped` — a container that was down for
  two hours must not resurrect a `device-request` and deliver it "fresh"
  (FCM's TTL bounds time in *FCM's* queue, not time in ours; it cannot do
  this for us).
- **Quiet window:** an admin-configured overnight/service-hours window (one
  congregation = one timezone) defers claim-lifecycle sends via
  `nextAttemptAt` — hold-then-send, not drop. `device-request` is exempt
  (genuine 30-minute urgency). No conflict with the age gate: claim-kind
  TTLs are days, holds are hours.
- Re-check the recipient's master + category switches and role/pause state
  **at send time**; resolve live tokens. **Liveness =
  `max(lastSeenAt, lastSendOkAt)` within 180 d** — a successful send marks
  `lastSendOkAt`, because glance-only devices (this product's success mode)
  never generate an app ping yet are demonstrably healthy; only send errors
  prune, and the window sits near FCM's own ~270 d GC horizon rather than
  starving the best-behaved phones.
- Compose localized payloads per token locale (§9); send via the
  messaging-only admin app. Per-token outcomes:
  `registration-token-not-registered` / `invalid-argument` ⇒ delete that
  token row; transient errors ⇒ retry with backoff up to N attempts then
  `failed`. Job is `sent` if ≥ 1 token succeeded, `skipped` if
  preferences/tokens evaporated between enqueue and send.

### 7.4 Collapse & TTL — two mechanisms, neither is magic

Getting this factually right matters because the naive version *rejects
sends*:

- **`Topic` header** (RFC 8030): collapses messages still *queued at the push
  service* for an offline device. Constraint: ≤ 32 characters from the
  base64url alphabet — `signing-request:{claimId}` is both too long and
  contains an illegal `:` (some push services 400 the entire send). The
  worker derives the Topic as a truncated base64url hash of the catalog
  collapse key.
- **`webpush.notification.tag`**: what actually replaces a notification
  *already displayed* in the tray. Set to the same collapse key (readable
  form is fine here). iOS tag-replacement is historically flaky — test,
  don't assume; a stacked pair on iOS is the acceptable degradation.
- **TTL** (`webpush.headers.TTL`) bounds FCM/APNs queue time for offline
  devices, per-kind from §5. Event *age* is our queue's job (§7.3), not
  TTL's.

### 7.5 Notification-click contract (unspecified = three platforms, three behaviors)

The FCM SDK's built-in `notificationclick` handler focuses an existing window
only on an **exact URL match** — a tab parked on `/` never matches
`/claims/{id}`, so every tap would open a new tab: on the shared office PC
(§8.6) that accumulates login-bearing windows; on desktop the app you already
have open is never the one that comes forward. So the SW registers its own
handler (ahead of the SDK's, keyed off the message's `FCM_MSG` payload):

- If an app window exists in scope: focus it and navigate via `postMessage` —
  **except** a client with an active claim-generation stream (the 15-minute
  NDJSON extraction) is never navigated; it shows the in-app toast (§8.9)
  instead. A tap must not destroy a multi-minute extraction someone is
  watching.
- Otherwise `clients.openWindow(route)`.
- **The route is allowlisted, not trusted:** the handler accepts only
  same-origin paths matching the catalog's route prefixes (`/approvals`,
  `/finance`, `/claims/`, `/`). A forged or tampered payload must not be able
  to deep-link a device anywhere else under the app's provenance (§11.1).
- iOS PWA is single-window with known foreground-without-navigate quirks —
  §13 carries an explicit acceptance test: *tap while the installed app is
  open on another page lands on the target page.*

### 7.6 Mock mode

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
- The feature must **report its own health to the user** (§8.7). Silently-dead
  delivery is worse than no delivery: it re-creates the stalled-approver
  failure this design exists to fix, now with false confidence — the badge
  habit atrophies once people trust push.

### 8.2 Preference model

`User` columns, all honored at enqueue time *and* re-checked at send time:

- `notifyEnabled` — master switch (default `false`).
- Per-category switches (default `true`, only consulted when master is on),
  matching the §5 catalog's category column: `notifySigning`,
  `notifyClaimProgress`, `notifyFinance`, `notifySecurity`.
- `notifyDiscreet` — **discreet previews** (default `false`): bodies become
  outcome- and name-neutral ("An update on one of your claims," "A signature
  request is waiting"), details only after tap. For lock screens that
  family members see (§11); offered in the soft-ask next to the
  shared-device lines.
- **A category is only rendered for users it can ever fire for** — the
  Finance rule generalized: members who can never be named approver don't see
  a "Signing" toggle they must decode. Every rendered toggle carries a
  one-line concrete example beneath its name ("e.g. 'Your claim was
  approved'") in all locales — the category noun alone ("Finance",
  "Security") is role jargon a monthly volunteer shouldn't have to parse.
- PATCH via the existing `/api/profile` route + `ProfileForm` card, audited
  like every profile edit.
- Nudge-dismissal state (§8.3) is stored **per account on the server**, not in
  browser storage — on a shared machine one person's "no thanks" must not hide
  the feature from the next person (§8.6).

### 8.3 The enable flow (soft-ask first)

0. **Capability pre-flight — never sell what this context can't deliver.**
   In-app browsers (WeChat, Line, Messenger… — reuse the `isEmbeddedBrowser()`
   detection that sign-in already ships in `SignInCard`) get "open this in
   Safari/Chrome first" with a copy-link affordance — never install steps,
   whose share-sheet controls don't exist there. iOS below 16.4 gets an honest
   "this iPhone can't receive web notifications." Only capable contexts ever
   see an enable toggle or installer.
1. Entry points: the Profile → Notifications card (persistent, discoverable),
   plus **contextual nudges** at high-intent moments — e.g. right after a user
   generates their first packet ("Want to know when it's signed?") and right
   after a role-holder first opens `/approvals`. Nudges are dismissible and
   never repeat after dismissal (per account, §8.2).
2. Tapping enable shows our **soft-ask**: what you'll be told about (the four
   categories), on this device, revocable anytime. Confirm ⇒ native
   `Notification.requestPermission()` from that same gesture ⇒ on grant,
   register SW, `getToken()`, POST token. Decline of the soft-ask just closes
   it — the native prompt was never risked.
   **Native-prompt hardening:** immediately before the native dialog, the
   soft-ask's confirm step shows what the system dialog will look like and
   which button to tap — because on iOS one mis-tap of "Don't Allow" is
   near-unrecoverable (§8.3 step 3), and older users mis-tap system dialogs
   constantly. Crucially, **the real dialog renders in the OS language, not
   the app locale** (a zh-Hant app on an English-configured iPhone shows
   "Allow / Don't Allow"). The preview is therefore keyed to *position and
   appearance*, and whenever `navigator.language` disagrees with the app
   locale it renders bilingually — "Allow / 允許 — the button on the right" —
   with a "your phone may show this in English" line. The same dual-language
   rule applies to every OS/browser menu path the copy quotes ("Add to Home
   Screen", "Site settings"); their translator `context` notes state that
   these strings quote OS chrome and must not be naturalized.
   **The soft-ask also says the quiet parts out loud** — the design's best
   trust properties are worthless unstated:
   - "Only you can see your notification settings. No one is told whether a
     notification reached you, or when." (Without this sentence, folk theory
     fills the gap: "he was notified in seconds — why hasn't he signed?"
     Enabling must not feel like joining an SLA.)
   - Role-holders additionally see: "This doesn't create a duty to respond
     faster — the badges remain the official queue."
   - "Is this a shared computer? A family iPad? Don't enable here — or turn
     on discreet previews" (§8.2, §8.6).
   **The soft-ask's final line teaches the one reliable undo** (delivery is
   the AND of five switches, but users get one sentence): "Turn everything
   off anytime: Profile → Notifications → Off — this works even if your
   phone's settings are wrong." The profile card opens with the same
   sentence.
3. Permission already `denied`:
   - Desktop/Android: the card explains the *browser* is blocking and shows
     per-browser unblock instructions (lock icon → Site settings → Notifications).
   - iOS installed app: there is no honest settings path — the app typically
     doesn't even appear under Settings → Notifications until permission was
     granted once. The card says the true recovery: remove the icon from the
     Home Screen and add it again (which re-runs the §8.4 flow including
     device re-approval). Documented plainly rather than pretending.

### 8.4 iOS onboarding — an install is a new *device*, not a shortcut

An installed home-screen web app on iOS has its **own storage container**: no
shared cookies, localStorage, or IndexedDB with the Safari tab (the repo
already navigates this split in `src/lib/pdf-delivery.ts`). So the freshly
installed app is **signed out** and, for e-sign users, **holds no charproof
signing key** — it is a brand-new e-sign device. Treating install as an
instruction card would strand exactly our least-technical persona in a
half-state (installed, signed out, keyless) she can't describe to a helper.
§8.4 is therefore a *sequenced onboarding flow*:

1. **Install** — Share → Add to Home Screen, illustrated, localized.
2. **Open + sign in** — inside standalone WebKit, Google sign-in popups are
   unreliable; the redirect fallback requires the first-party auth proxy.
   **Hard launch prerequisite: `FIREBASE_AUTH_PROXY` deployed** (§13).
3. **Device approval (e-sign users only)** — the installed app runs the
   standard typed-code new-device ceremony against the Safari-tab context,
   with copy written for the "both devices are this same phone" case (switch
   between them via the app switcher). Members who don't sign skip this step.
4. **Then** the permission soft-ask (§8.3), never before.

**Resume state and the helper story.** This flow spans two storage-isolated
contexts and four stages; assuming a solo, single-sitting completion would
recreate the half-state problem one step later. So:

- Onboarding progress persists **server-side per account** (the §8.2
  nudge-state precedent). Whichever context signs in next — Safari tab or
  installed app — renders a "Finish setting up notifications — step 3 of 4"
  resume card. Abandoning at any step is a pause, not a dead end.
- **Helper mode:** a dedicated step-by-step page designed to be read over the
  member's shoulder — side-by-side bilingual (member's app locale + English)
  so a zh-Hant grandmother and her English-reading grandson follow the same
  screen — reachable via a short URL/QR that the church tech deacon can print
  and reuse after service.
- The §12 admin card counts funnel drop-off in aggregate (installs started →
  sign-ins completed → permission granted) so leadership learns "8 of 10
  stall at sign-in" without any per-person visibility.

Acceptance criteria: *an approver who completed this flow can perform a full
signing ceremony inside the installed app without leaving it* — and *an
approver who abandons the flow at any step can resume it later from either
context without data loss.*

### 8.5 Security category honesty

In the happy multi-device flow the member holds both devices, so the
`device-request` push is usually redundant — the *"if this wasn't you"* case
is the real value. But that value only exists for people with **a second
push-enabled device**: on iOS the sole push-capable context is the installed
app, so for a single-device user (most of this congregation) the recipient
set of a `device-request` push is structurally empty — the requesting device
is excluded and nothing else is subscribed. The design states this honestly:

- The in-app `DeviceRequestsBanner` remains the security guarantee; push is
  best-effort acceleration. The profile card says "device alerts reach your
  *other* devices — they need a second device with notifications on."
- The worker skips (and records `skipped`) jobs whose recipient token set is
  empty rather than pretending coverage.
- This gap is the concrete motivation for the deferred email channel (§2
  keeps a `channel` column): security events are where email would land
  first, later.
- The category keeps a switch (user agency wins); it defaults on with the
  master switch, and turning it off shows a one-line "you won't be warned
  about new devices" explainer.

### 8.6 Shared and multi-account browsers (the church-office PC)

A push subscription belongs to the *browser profile*, but people share
machines. Tokens therefore follow the signed-in account, explicitly:

- **Sign-out deletes this installation's token** — server-side row delete plus
  client `deleteToken()` — so a treasurer's `finance-queue` pushes never pop
  on the office screen after she leaves, readable by whoever sits down next.
- **Sign-in re-association is defined, not accidental:** registering a token
  that exists under another user re-parents the row to the current user; the
  previous owner's device list drops it, and their zero-device banner (§8.7)
  catches the silent loss.
- `lastSeenAt` refreshes only while the token's current owner is the signed-in
  user — other people's visits must not make a dead device look alive.
- The soft-ask asks outright: "Is this a shared computer? Don't turn
  notifications on here." (Localized; this congregation has exactly such a
  machine.)

### 8.7 Staying connected — drift detection and self-test

Delivery dies silently: a phone migration/iCloud restore recreates the
home-screen *icon* but not the push subscription; iOS Settings can mute the
app with no server-visible error; browsers evict storage. Three feedback
loops keep "on" meaning on:

1. **Per-device reconnect chip:** on app load, if the account has
   `notifyEnabled` but *this installation* has no live token or
   `Notification.permission !== "granted"`, show a one-tap "reconnect
   notifications on this device." **Gated by the same §8.3 step-0 capability
   pre-flight** — an iOS Safari tab or WeChat view (push-incapable by
   construction, even while the same phone's installed PWA receives fine)
   must never nag "reconnect": in capable-but-uninstalled iOS Safari the
   correct surface is the §8.4 resume card; in incapable contexts, nothing.
2. **Account-level banner:** an enabled account with zero fresh tokens sees
   "Notifications are on, but no device is currently receiving them."
3. **Self-test for everyone:** "Send myself a test notification" lives on the
   user's own profile card — not admin-only — so "is this working?" has a
   30-second answer a volunteer can perform over the phone.

### 8.8 Taps must survive sign-in

Sessions are a fixed 30-day cookie with no sliding renewal, so a
few-times-a-month user is *routinely* signed out at the moment a push
arrives. A tap that ends on the home page after a Google sign-in — with no
trace of what was tapped — fails the core journey for the least-technical
persona. Requirements:

- The service-worker click handler opens the catalog route with the existing
  `?return=` pattern **extended to all auth redirects** (today only `/vouch`
  preserves it), so post-sign-in lands on `/approvals` or `/claims/{id}`,
  never bare `/`.
- Recommended alongside (separate decision, same milestone): sliding session
  renewal on active use, making the signed-out tap the exception rather than
  the monthly norm.
- e2e acceptance (§13): *tapping a notification while signed out lands on the
  target page after sign-in.*

### 8.9 Accessibility requirements (binding, not aspirational)

The new surfaces target the app's oldest users; they follow the codebase's
existing a11y idiom rather than inventing one:

- **Soft-ask modal:** the `ConfirmDialog` pattern — `aria-modal`, focus trap,
  focus returned to the invoking control on close.
- **Toggles:** the `DutyRow` labeled-state pattern — visible on/off text next
  to the control (color/position is never the only signal), touch targets
  ≥ 44 pt for tremor and presbyopia.
- **Reconnect state:** the transient chip is an *accelerator*, not the source
  of truth — the same state always exists as a persistent row in the Profile
  notifications card, and its appearance announces via `role="status"`. A
  VoiceOver user who never perceives a chip on load still finds the row.
- **Self-test confirms in-page**, independent of the notification arriving:
  "Sent at 3:42 — did your phone show it?" (a muted phone, DND, or in-page
  screen-reader focus otherwise makes success indistinguishable from
  failure).
- **Foreground pushes have a defined in-app surface.** When the page is
  focused, several platforms show no system banner at all; `onMessage` events
  render as an in-app toast (`aria-live="polite"`) using the same composed
  text, so foreground events don't silently vanish — for anyone.
- **Deep-link landings move focus,** extending the existing `?open=` contract
  beyond its visual pulse: the target row receives focus so screen-reader and
  keyboard users arrive *at* the thing the notification named.

## 9. Localization

- Push content is composed **server-side at send time** from
  `messages/<locale>.json` under a new `Notifications` namespace. Locale
  resolution order: **this device's current resolved locale → `User.locale`**
  — and the token row's locale is *live*, not a registration snapshot: the
  same app-load/visibility ping that refreshes `lastSeenAt` re-captures the
  request's resolved locale (the server already resolves cookie →
  Accept-Language on every request). A user whose grandson set the phone up in English and who
  later switches the app to 中文 must not keep receiving English pushes for a
  year — least of all the `device-request` security alert, where an
  unreadable warning is a dismissed warning.
- Every new key gets a translator `context` note and `npm run translate` runs
  before commit (CLAUDE.md invariant 10); staleness is already a red test.
- The service worker never needs the catalogs — it only displays what the
  server composed. (This is why we send notification-messages, not
  data-messages, §3.)
- User data inside notification text (claim event names, merchant labels)
  stays verbatim, never machine-translated — same rule as the rest of the app.

### 9.1 Composition rules (the lock screen is a hostile layout)

- **The variable is optional.** Every §5 sketch leans on the claim's event
  label, but `claimEvent` defaults to empty and is never required — the
  *common* case must not render "Signature requested — " with a dangling
  separator as someone's first-ever push. Fallback chain:
  `claimEvent` → localized generic ("a claim"), composed so the empty case
  reads as a complete sentence. **Never `claimDescription`**: in a church
  that free-text field names people and pastoral situations ("Funeral
  flowers — Wang family", benevolence purchases) — the most sensitive text
  in the system does not belong on a lock screen as a *fallback*.
- **Action first, label last.** iOS shows roughly one title line
  (~15–18 CJK glyphs); truncation must eat the free-text label, never the
  verb. The fixed part of a title budgets ≤ ~12 CJK glyphs. Every
  `Notifications.*` key's `context` note states this ordering so a translator
  doesn't naturally invert it.
- **House ICU discipline:** named arguments, ICU plurals ("receiving on
  {count} devices"), whole sentences per key.
- **Register rule:** notification and consent text consistently uses 您
  (formal register) in both Chinese catalogs — added to `messages/GLOSSARY.md`
  (today's catalogs mix 你/您; lock-screen text addressed to elders
  shouldn't).
- **Gate:** a unit test composes every catalog event × 3 locales × empty
  label and asserts no dangling separators, no missing-arg ICU errors.

## 10. Failure modes

| Failure | Behavior |
| --- | --- |
| FCM unreachable / SA misconfigured | Jobs retry with backoff, then `failed` with `lastError`; app fully functional; admin health surfaces the error (§12). Never blocks mutations. |
| Token stale/revoked | Deleted on first send error; the §8.7 reconnect chip (per device) and zero-device banner (per account) surface the loss instead of relying on the user to study `lastSeenAt`. |
| Phone migration / iOS mute — delivery dies with NO send error | Undetectable server-side; caught client-side by the §8.7 reconnect chip on next app open, plus the user-facing self-test button. |
| User blocked permission at browser | Blocked permission invalidates the push subscription ⇒ send error ⇒ token pruned. Account switch remains the reliable off. |
| Tap on a stale tray notification (work withdrawn / handled by someone else) | Landing pages own it: designed empty states on `/approvals` and `/finance` explain withdrawal/already-handled (§5). |
| Tap while signed out | `?return=` deep-link survival through sign-in (§8.8); never strands the user on `/`. |
| Duplicate events (route retried, reconcile replay) | The `dedupeKey` unique constraint no-ops the second enqueue (§7.2) — this, not collapse, is the duplicate guarantee; `tag` replacement is best-effort tray hygiene. |
| Container down at event time | Jobs are durable rows; worker drains on restart — but the §7.3 age gate skips any job whose *event* is older than its kind's TTL, so a resurrected `device-request` never fires "fresh" about a ceremony that ended hours ago. |
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
- **Push copy asserts mirror state — a hint, never a fact.** The verified
  truth lives in the client-checked ledger, and notification text never uses
  "verified"/"confirmed" language; a push says the mirror *reports* approval,
  the claim page and `/v` remain where verification happens. This keeps the
  app's "verify, don't trust the server" posture culturally intact even
  though the highest-frequency status surface is now server-composed.
- **`payloadJson` carries personal free text** (actor names, event labels)
  frozen at enqueue: owner-only read scope (the recipient's own activity
  list), same 90-day pruning. `NotificationJob` cascades with its user (§6);
  when a *claim* is deleted, its jobs degrade — the activity list renders a
  localized "a deleted claim" label and no dead deep-link (the designed
  dead-target state), because these rows are residue, not chain-of-custody
  (the e-sign archive invariant is untouched).

### 11.1 Attack scenarios & defenses (ESIGN §8's discipline, applied here)

| Attack | Defense / honest residual |
| --- | --- |
| **Messaging SA key exfiltrated** — attacker gains church-branded push infrastructure to every enrolled device | The SA can *only* send FCM messages (custom role, §4) — no ledger, no data reads. But off-server sends are **invisible to §12's health card**; the doc says so plainly. Defenses: the SA JSON lives in `config.json` on the NAS (§13), rotation guidance in the deploy docs, and §12's scope self-check catches over-granting. Residual: a stolen key means plausible pushes until rotated — mitigated by the next row. |
| **Forged-outcome push** ("Your claim was approved" when it wasn't) | Notifications carry zero authority; every tap lands behind the session on pages that re-check the mirror, and ceremony UIs re-verify the ledger client-side. Copy discipline above (no "verified" language) keeps users' trust anchored to the verifying surfaces. |
| **Push-timed ceremony pressure** — attacker files a device-approval request, then uses pushes to rush/normalize the typed-code approval (approval-fatigue) | The `device-request` push says "if this wasn't you, review" and never carries the code or an approve affordance; approval still requires the deliberate typed-code ceremony in-app on the old device. Quiet-window exemption is acceptable because the push adds scrutiny, not authority. |
| **Tampered/forged payload deep-links a device** under the app's provenance | §7.5's click handler allowlists same-origin catalog route prefixes only. |
| **Spam-yourself via the hint endpoint** | Server-derived dedupe bucket + hourly cap (§7.1b). |

## 12. Admin surface

A small card on the existing admin settings tab: push health (last successful
send, queue depth, failed-job count), SA fingerprint (never the key), the
onboarding funnel in aggregate (installs started → sign-ins → permissions
granted, §8.4), and the "claims waiting > 7 days" trend line (§5). Strictly
aggregate: no per-person adoption status, no access to anyone's preferences
or tokens — leadership gets "where do people stall," never "who to blame."
(The self-test button lives on every user's own profile, §8.7.)

At this congregation's scale, "aggregate" deanonymizes: "claims waiting > 7
days: 2" with three approvers is a named person in every reader's head, and
the deacon knows exactly who the ten onboarding installs were. Small counts
render floored ("fewer than 5"), and both metrics are framed as process
questions ("where does onboarding stall") — the card must never render in a
way that invites per-person resolution at a council meeting.

The card also **verifies the service account is messaging-only** (self-check
via `testIamPermissions`-style probe) and shows a plain-language warning when
it holds more than `cloudmessaging.messages.create` — because the predictable
failure mode of a hard console step is a frustrated volunteer granting
"Firebase Admin," which would silently void the §4 keyless-ledger property.

## 13. Build order

Launch prerequisites (hard dependencies surfaced by the journey work):

- `FIREBASE_AUTH_PROXY` deployed so sign-in works inside the installed iOS
  app (§8.4).
- `?return=` deep-link survival on all auth redirects (§8.8) — ships before
  or with the first notification, not after.

Deployment surface (the volunteer tech deacon must be able to complete
this):

- New config: `FIREBASE_VAPID_PUBLIC_KEY` (client-safe, relayed like the
  rest of `firebaseWebConfig()`) and the SA credential — **recommended home
  is the `<DATA_DIR>/config.json` overlay**, not compose-env quoting of a
  multi-line JSON blob. `.env.example`, `docker-compose.yml`, and the admin
  config schema all gain the entries.
- A step-by-step Firebase/GCP console walkthrough ships as part of this
  feature's docs: generate Web Push certificates; create the **custom IAM
  role first** (exactly `cloudmessaging.messages.create`), then the service
  account, then the key — written for someone who has never opened the GCP
  IAM screen, because the undocumented version of this step ends in
  "Firebase Admin out of frustration" (§12 warns if that happens).

Phases:

1. Schema (PushToken, NotificationJob, User columns) + migration.
2. Send adapter (messaging-only admin app) + `PUSH_MOCK`.
3. Worker + enqueue helpers for the top-3 catalog events, unit-tested
   (dedupe, send-time preference re-check, empty-recipient skip).
4. SW + client registration (incl. sign-out token deletion §8.6) + Profile
   card + soft-ask with capability pre-flight (en first, then translate).
5. iOS sequenced onboarding (§8.4), §8.7 feedback loops + self-test,
   contextual nudges, admin health card.
6. Remaining catalog events + e2e (mock) coverage.

Acceptance tests that gate launch (from the journey walkthroughs):

- An approver who completes §8.4 performs a full signing ceremony inside the
  installed app without leaving it.
- An approver who abandons §8.4 at any step resumes it later, from either
  context, without data loss.
- Tapping a notification while signed out lands on the target page after
  sign-in.
- Tapping while the installed iOS app is already open on another page lands
  on the target page (§7.5); a client mid claim-generation is never
  navigated away.
- Sign-out on a shared browser stops that machine's delivery immediately.
- Switch language in the app, then receive: the push arrives in the new
  language (unit: locale re-capture; §9).
- Composition test: every catalog event × 3 locales × empty label renders a
  complete sentence (§9.1).
- Comprehension check (moderated, small-n): a participant who enabled push
  can, unprompted, say what kinds of messages they'll get and turn them all
  off within 60 seconds.

## 14. Revision log — ideation → UXR critique rounds

### Round 1 — lens: end-to-end journey walkthroughs (persona-based)

Top findings and responses:

1. **[BLOCKER] iOS install creates a cold, signed-out, keyless second app** —
   the installed PWA has its own storage container, so "Add to Home Screen"
   lands the least-technical persona in a signed-out context with no e-sign
   device key. → §8.4 rewritten from "education card" to a sequenced
   onboarding flow (install → sign in → device-approval ceremony → permission
   ask), with `FIREBASE_AUTH_PROXY` promoted to a hard launch prerequisite
   and a signing-ceremony-inside-the-PWA acceptance test (§13).
2. **[MAJOR] Delivery dies silently** (phone migration recreates the icon but
   not the subscription; iOS mute is invisible server-side) → new §8.7: per-
   device reconnect chip, account-level zero-device banner, and the self-test
   button moved from admin-only to every profile.
3. **[MAJOR] Deep links died at the sign-in redirect** (fixed 30-day session
   ⇒ signed-out taps are routine) → new §8.8: `?return=` survival on all auth
   redirects + recommended sliding sessions; e2e acceptance test added.
4. **[MAJOR] Shared church-office PC unspecified** → new §8.6: sign-out
   deletes the token, sign-in re-association defined, per-account nudge
   dismissal, "shared computer?" line in the soft-ask.
5. **[MAJOR] One mis-tap of "Don't Allow" on iOS is near-unrecoverable** →
   §8.3: native-prompt hardening (localized preview of the system dialog) and
   an honest iOS-denied recovery path (remove + re-add the icon).
6. **[MAJOR] Dead-end contexts** (WeChat/Line in-app browsers, iOS < 16.4) →
   §8.3 step 0 capability pre-flight; the installer never renders where the
   payoff is impossible.
7. **[MINOR] Stale tray taps** (withdrawn/handled work; push can't be
   retracted) → §5/§10: `/approvals` & `/finance` empty states designed for
   the stale-tap moment.
8. **[MINOR] `device-request` push has zero recipients for single-device
   users** → §8.5 rewritten to state the limit honestly; empty-recipient jobs
   skip; gap explicitly motivates the future email channel.

### Round 2 — lens: inclusivity, language, accessibility

Top findings and responses:

1. **[BLOCKER] §8.4 onboarding assumed a solo, single-sitting completion** —
   no resume state, no helper story, no drop-off visibility. → §8.4 gains
   server-side per-account progress + a resume card in both contexts, a
   bilingual side-by-side helper mode (printable QR for the tech deacon), an
   aggregate funnel counter in §12, and an abandon-and-resume acceptance test.
2. **[MAJOR] The document had zero accessibility requirements** for surfaces
   aimed at the app's oldest users. → New §8.9 (binding): existing
   aria-modal/focus idioms, ≥ 44 pt labeled toggles, chip-as-accelerator with
   a persistent card row as source of truth, in-page self-test confirmation,
   a defined foreground surface (in-app toast, `aria-live`), and deep-links
   that move focus, not just pulse.
3. **[MAJOR] Per-device locale was a registration-time snapshot** that would
   shadow a later language switch indefinitely — worst for the security
   alert. → §6/§9: locale re-captured on every app-load ping; resolution
   "device's current resolved locale → `User.locale`"; never a bare `"en"`
   default; switch-then-receive test gate.
4. **[MAJOR] The mis-tap hardening previewed the dialog in the app's locale,
   but the real dialog renders in the OS language.** → §8.3: previews keyed
   to position/appearance, bilingual when `navigator.language` differs, dual-
   language rule for all quoted OS menu paths, translator context notes
   forbidding naturalization of OS chrome.
5. **[MAJOR] Two-tier adoption creates social gradients** (owners route
   around non-push approvers; the stalled-approver problem persists for
   exactly the least-adoptable members). → §5 "In-app parity" committed for
   v1: activity list fed by preference-independent job rows, de-personalized
   owner-facing stall state ("waiting 9 days — you can reassign"), and an
   aggregate-only staleness trend for leadership. §7.1 reworked so jobs are
   event records first, send instructions second.
6. **[MAJOR] All content sketches hung on `claimEvent`, an optional field
   empty by default** — dangling-separator pushes in three languages. → New
   §9.1 composition rules: fallback chain, action-verb-first ordering with a
   CJK title budget, ICU discipline, and an events × locales × empty-label
   test gate.
7. **[MINOR] Category names were role jargon rendered to the wrong people.**
   → §8.2: categories render only where they can ever fire; every toggle
   carries a concrete example line; 您-register rule added for notification
   and consent text in both Chinese catalogs (§9.1).
8. **[MINOR] Five ANDed switches, no taught undo.** → §8.3: soft-ask and
   profile card both teach the single reliable off-switch sentence; §13 adds
   a moderated comprehension check (name what you enabled; turn it off in
   60 s).

### Round 3 — lens: platform & technical reality

Top findings and responses:

1. **[BLOCKER] The service worker had no way to get Firebase config** — this
   deployment's config is runtime state (env/`config.json`), not build-time
   `NEXT_PUBLIC_*`, so a static `public/firebase-messaging-sw.js` can't
   exist. → New §7.0: the SW is a route handler with injected
   `configValue()` config, `no-cache`, an explicit
   `skipWaiting`/`clients.claim` update contract, and a stated consequence
   for project-config changes (all tokens invalidate; §8.7 surfaces
   re-enable).
2. **[MAJOR] Collapse as specced was doubly wrong**: `Topic` must be ≤ 32
   base64url chars (`signing-request:{claimId}` is illegal and can 400 the
   send), and Topic never replaces *displayed* notifications. → §7.4
   rewritten: hashed Topic for queue collapse + `webpush.notification.tag`
   for tray replacement (iOS flakiness acknowledged); §10 now credits
   `dedupeKey`, not collapse, for duplicate suppression.
3. **[MAJOR] TTL conflated with event age** — a resurrected job after a
   container outage would fire "fresh" about a dead ceremony; reconcile-
   sourced events are generated by the recipient's own page visit. → §7.3
   age-gates jobs on an event-occurrence timestamp; §7.1 suppresses
   reconcile events whose sole recipient is the reconciler and bans "just
   now" framing.
4. **[MAJOR] The 60-day staleness window starved glance-only devices** —
   the product's success mode (read the lock screen, don't open the app)
   generated no liveness signal. → `lastSendOkAt` added: successful sends
   count as liveness, window widened to 180 d, ping extended to
   `visibilitychange`/`focus`; only send errors prune.
5. **[MAJOR] The reconnect chip false-fired in every push-incapable
   context** (Safari tab / WeChat on a phone whose PWA receives fine). →
   §8.7 chip gated by the §8.3 step-0 pre-flight; capable-but-uninstalled
   contexts get the §8.4 resume card; the account banner stays the
   cross-context truth.
6. **[MAJOR] Notification-click behavior was unspecified** and the FCM
   default (exact-URL focus match) opens a new tab per tap — worst on the
   shared PC; naive navigation would kill a live 15-minute extraction
   stream. → New §7.5 click contract: custom handler, focus + `postMessage`
   navigation, never navigate a streaming client, `openWindow` fallback,
   iOS acceptance test.
7. **[MAJOR] The self-hosting setup was incomplete and its hardest step
   undocumented** — inviting a frustrated "Firebase Admin" grant that voids
   §4's security property. → §13 deployment surface (VAPID var, config.json
   as the SA home, console walkthrough written custom-role-first); §12
   verifies the SA is messaging-only and warns when broader.
8. **[MINOR] `/api/notifications/hint` had no dedupe/rate-limit** and its
   `targetId` was client-supplied. → §7.1b: server-derived bucket dedupe
   key, per-user hourly cap, no client ids in the push path.

### Round 4 — lens: trust, privacy, consent, fatigue, social dynamics

Top findings and responses:

1. **[BLOCKER] Push made withdraw-and-reassign visible to the bypassed
   elder** — his lock screen retains the original "Signature requested" as
   evidence, and the draft's "matches today's behavior" claim was false; the
   `/approvals` empty state's "already handled by someone else" decodes to
   "you were passed over" (SUBMIT names exactly one approver). → §5: the
   social shift is owned in text; empty-state copy split (cause-neutral,
   normalizing on `/approvals`; "already handled" only on `/finance`);
   reassignment-is-routine line added to the Signing soft-ask.
2. **[MAJOR] No interruption budget** — finance-queue was a per-claim pager
   for every treasurer (~20 pushes each in retreat season) peaking during
   Sunday service. → §5: per-recipient coalescing with count-updating body;
   stated per-persona weekly budget; §7.3: admin-configured quiet window
   (hold-then-send, `device-request` exempt).
3. **[MAJOR] Lock screens leaked pastoral content into households** — the
   §9.1 fallback promoted `claimDescription` (names, benevolence, funerals);
   "Submitted by {name}" tells a household who claims money; "left a note"
   was filler. → §9.1: fallback is event-label → generic, never description;
   §8.2: `notifyDiscreet` outcome/name-neutral previews; soft-ask gains a
   family-shared-device line; the note line dropped.
4. **[MAJOR] No attack/defense treatment for the push layer**, whose glance-
   don't-open success mode culturally inverts "verify, don't trust the
   server." → New §11.1 attack table (SA exfiltration with honest
   off-server-sends-are-invisible residual; forged-outcome pushes;
   push-timed ceremony pressure; deep-link forgery); §7.5 route allowlist;
   §11 copy discipline: push is a hint, never says "verified."
5. **[MAJOR] The design's privacy properties were never stated to users** —
   silence was becoming legible refusal, and "no read-tracking in v1" left
   the door ajar. → §8.3 soft-ask says the quiet parts ("no one is told
   whether a notification reached you"; role-holders: "no duty to respond
   faster"); §5 stall copy preserves charitable ambiguity; read-tracking
   reclassified as a §2 non-goal requiring its own consent design.
6. **[MINOR] `NotificationJob` rows outlived their subjects** — no user
   cascade, no claim-deletion semantics, personal free text frozen 90 days.
   → §6 cascade added; §11: deleted claims degrade to "a deleted claim" with
   a designed dead-target state; payloadJson scoped owner-only.
7. **[MINOR] "Aggregate" metrics deanonymize at N=3.** → §12: floored small
   counts, process-question framing, explicit no-per-person-resolution rule.
