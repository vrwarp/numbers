# E-signature & approval workflow — design

Status: **implemented** (mock-backend verified end-to-end; live-Firestore wiring is the
remaining phase-5 work). Decisions in §1 were ratified by the project owner
(2026-07-11); the post-implementation amendments below them are also owner-ratified.
v2 added the first hardening round; v3 incorporated two independent design reviews
(protocol soundness; implementation feasibility): the thread model for submissions, the
out-of-band root anchor, server-side signature-backed mirroring, the ledger-IO split,
and the corrected Firebase-auth and receipt-lifecycle assumptions. This document is the
implementation contract; §10 has graduated into `CLAUDE.md`.

The feature adds a cryptographically tamper-evident e-signature and approval process on
top of the existing claim flow, using [charproof](https://github.com/vrwarp/charproof)
(client-side zero-knowledge key management + append-only, ECDSA-signed event ledgers on
Cloud Firestore). The existing flow — Shoebox → extraction → human verification →
generated PDF — is untouched; signing begins where it currently ends.

## 1. Decisions log

| # | Question | Decision |
| :-- | :-- | :-- |
| 1 | Trust root | The project owner is the genesis trust root (`ESIGN_ROOT_EMAIL`) |
| 2 | Vouching | In person only. A signer is attested by **two vouches from distinct attested members, or one vouch from an approver-or-above**. Vouching attests identity only; roles are granted separately |
| 3 | Key burden | Full charproof accounts (AMK, device enrollment, phrase/PRF recovery) — but **only required for e-sign actions**. Building and generating a claim never requires enrollment |
| 4 | Who signs | Requestor signs at submission **and** approver signs the decision. The treasurer's mark-paid is also a signed event |
| 5 | Routing | The requestor picks one approver per claim. No amount thresholds |
| 6 | Self-dealing | Requestor ≠ approver, enforced. Any *other* approver may approve anyone's claim, including the treasurer's |
| 7 | Rejection | Claim stays `rejected` (frozen) with the approver's comment until the requestor acts. Strict hash binding: any regeneration voids all collected signatures |
| 8 | ZK purpose | Tamper-evidence and non-repudiation, **not** secrecy. Ledger keys may be relayed by the numbers server |
| 9 | Finance | The treasurer is a numbers user (in-app queue). No notification infrastructure |
| 10 | Artifact | Digital packet is primary; printouts are backup; wet signatures not required |
| 11 | Formality | UETA/ESIGN-style ceremony: consent disclosure, intent affirmation, typed name |
| 12 | Platform | Firestore becomes a hard runtime dependency for the e-sign feature |

### Post-implementation amendments (owner-ratified)

| # | Change |
| :-- | :-- |
| A1 | **Duplicate-receipt guard removed** — the §6.4 advisory overlap warnings were cut from the approver/finance views at the owner's direction; cross-claim receipt reuse stays a human-process matter |
| A2 | **Non-technical UX rule**: the target member can scan a QR code and nothing more. Fingerprints, hashes, chain pills, anomaly lists, verifier pointers — and the plain-language "Everything checks out — this is the genuine paperwork" reassurance itself — live behind collapsed "Audit details" disclosures on every screen. A clean chain says nothing on the main path (no in-your-face verifiability); the ONLY chain banner that ever interrupts the main path is the red "something doesn't check out" alert, and it shows only when a check fails. Ceremonies stay fail-closed regardless of what is displayed |
| A3 | **Hand-drawn signatures**: enrollment captures a literal signature (touch/mouse canvas → transparent PNG, stored on `SignerIdentity.signatureImage`, redrawable without touching attestation). Ceremony payloads carry `signatureImageSha256` so the artwork used is part of the signed record. The stamped delivery PDF is what existing paper processes file. (Superseded in placement by A4.) |
| A5 | **Admin master switch, OFF by default**: `EsignRegistry.enabled` (default `false`). Bootstrapping creates the registry switched off; only an admin can flip it (PATCH `/api/esign/registry`, audited as `esign-toggle`). While off, every ceremony/queue/enrollment route refuses (`requireEnabledRegistry`, 409 "Electronic signing is turned off"), key material is not relayed, badges vanish, and the UI shows nothing e-sign related to regular members — the admin sees only the switch. Verification surfaces (`/api/v/[token]/*`, packet, certificate) deliberately stay open: retention and auditability of already-signed records never turn off. |
| A4 | **Click-to-stamp** (DocuSign-style): signing a paper form means *seeing the document and placing your signature on it*. Generation now produces the UNSIGNED form (blank signature lines — the base for print-and-wet-sign and e-sign alike; the requestor auto-stamp at generation is removed). In the submit/approve ceremony the packet is rendered client-side with pdf.js (`DocumentSignField`) — the EXACT verified bytes, never a server raster, preserving the approver's "you see what you sign" guarantee — and a pulsing "Tap to sign" placeholder marks the signature line. Nothing is stamped until the signer TAPS it — the tap is a required affirmative act (stronger UETA intent evidence than auto-placement), after which the signature sits on the line, stays draggable, and can be removed back to the placeholder (disabling the sign button again). The chosen spot travels as a page-normalized `signaturePlacement` INSIDE the signed SUBMIT/APPROVE payload, so *where* each person signed is attested and the client refuses to sign a placement it didn't choose. The requestor's placement is baked into the frozen packet bytes at submit (`buildClaimPdfBytes` regenerates with the stamp, then hashes+archives); the approver's placement is stamped onto the certificate delivery copy at their coordinates. The pdf.js worker is served same-origin from `/api/esign/pdf-worker` (with a `getOrInsertComputed` polyfill for older engines). |
| A6 | **Multi-device implemented** (M1–M4 of `docs/MULTI_DEVICE_PLAN.md`; the full walkthrough passes on BOTH the mock and the REAL Firestore backend via the Firebase emulator suite with the production rules — see `docs/agent/TESTING.md`; M5 residue is a live-project smoke): custody always runs charproof's real device/keystore code — in `ESIGN_MOCK` its persistence providers are injected (`setDeviceServiceProviders`) with a SQLite-backed `AccountKeyStore` over `/api/esign-mock/device-sync/*` (CAS `version` column standing in for Firestore transactions) plus a per-browser-context mock passkey; `LocalKeyCustody` is deleted. New devices join via typed-6-digit-code approval (`expectedVerificationCode` ENFORCED — stricter than LetUsMeet's display-only comparison), silent passkey unlock, or 24-word phrase recovery (print-first: a client-built recovery-sheet PDF — the words never reach the keyless server); the same attested key signs from every authorized device — no re-vouching, zero roster/payload/verifier changes. `DeviceRequestsBanner` (app-wide) prompts existing devices; the profile card gains a devices panel (remove = `revokeDevice` AMK rotation) and a recovery nudge (sticky for the root); the Members page (`/members`, treasurer/admin-gated) carries the root-only `REVOKE_KEY` button for the compromised-device path (§4.5) alongside the role controls (both moved off the vouch screen, which is now the ceremony alone). Device-sync routes are deliberately NOT master-switch-gated (prod Firestore isn't either); everything user-visible still is. |
| A7 | **Key supersession — re-vouching is the recovery path** (owner-ratified: the lost-everything case should route through the same two-members-or-one-approver ceremony, not the admin): when a key crosses the attestation threshold, the reducer revokes the same uid's earlier keys at that instant. Rationale: the vouch quorum is already the identity authority — what granted the old key replaces it; recovery needs no admin and gains no new trust assumptions (colluding vouchers could already mint a parallel key; supersession is bounded by in-person accountability plus the root override). Forward-only: everything the old key signed stays valid via `stateAt`; deliberately re-vouching an old key restores it (the quorum always speaks last). The root uid is EXCLUDED — vouching a "new root key" is an anomaly; the anchor rotates only by re-genesis (§12). Root `REVOKE_KEY` remains for immediate retirement of a possibly-misused key. Enforced identically in `roster.ts` and `scripts/verify-bundle.mjs`, with supersede/restore/root-guard unit tests; the vouch screen shows a "this replaces their previous signing key" notice on re-key vouches. |
| A8 | **Rollout allowlist** (owner direction: enable e-sign per person, not for everyone at once): `EsignRegistry.scope` — `"allowlist"` (the default) or `"everyone"` — under the A5 master switch, plus `User.esignAllowed` managed by the admin from the Members page (`/members`) and the admin dashboard's Members tab (`PATCH /api/esign/allowlist`, audited as `esign-allowlist`; the profile card keeps the scope switch and points at the Members page; scope changes ride the `esign-toggle` audit). With scope allowlist, every ceremony/queue/enrollment route refuses non-allowed members (`requireEsignAccess`, 409 `esign.notAllowed`), key material is not relayed to them, badges vanish, and the UI shows them nothing — identical posture to the switch being off. Admins always pass (they operate the controls). Like A5 this gates the APP's surfaces only: roster validity is cryptographic and untouched — removing someone from the allowlist never revokes what they signed (that is REVOKE_KEY/supersession, §4.5), and verification surfaces never check it. |
| A9 | **Role-at-exercise for decisions** (closes the demoted-approver hole): an APPROVE binds only if the named approver still holds approver-or-above at the APPROVE's own `createdAt` — the same as-of-signing rule MARK_PAID always had; previously the role was checked only when the SUBMIT named them, so an approver revoked mid-flight could still push a claim through. §5.3.4 amended; enforced identically in `validity.ts` and `scripts/verify-bundle.mjs` (unit-tested: revoke→approve is a void anomaly; re-grant re-arms; pre-revocation approvals stand forever — forward-only, so paid claims stay verifiable). **REJECT is deliberately exempt**: it declines to sign rather than signing, so a demoted approver can still hand the claim back. The decision route mirrors the rule (409 `esign.approverRoleLost` at APPROVE preflight) and, at commit, re-evaluates the ledger and flips mirror status only if the reported event actually binds (409 `esign.decisionNotBinding` otherwise) — the preflight→append race can therefore never make the mirror disagree with the chain. The owner's panel shows an assigned-approver-`ineligible` notice pointing at the existing withdraw+reassign escape (§6.1's stalled-approver path); the inbox disables Approve (Reject stays) with a role-lost banner. |
| A10 | **Self-service duty pauses**: each role-holder can switch their own duties off on their profile (`User.approvalsPaused` / `financePaused` / `adminPaused`, PATCH `/api/profile`, audited as `update-availability` with field diffs). Same app-surface-only posture as A5/A8 — NEVER a role change, never a roster event, invisible to ledger validity. Approvals paused: hidden from the approver picker and refused by the submit preflight (409 `esign.approverUnavailable`), but claims ALREADY assigned stay decidable (the ledger would accept the signature regardless — app refusal would only manufacture mirror divergence) — the inbox says so, badges keep counting assigned work, and the owner's panel shows a `paused` notice with the reassign path. Finance paused: finance queue 404s, mark-paid refuses, nav tab vanishes (nothing to grandfather — payment was never claim-assigned). Admin paused: `isAppAdmin()` fails everywhere it gates (admin area, master switch, allowlist, role controls), whichever way adminship was granted (roster role or ADMIN_EMAILS); the profile toggle itself is never admin-gated, so the pause is always self-reversible. |

## 2. Trust model — what the cryptography buys

- **Non-repudiation**: signing keys are generated client-side and never leave the
  signer's devices (IndexedDB, synced between a user's own devices only via the
  AMK-encrypted keystore). A valid signature proves possession of a key that a chain of
  humans physically vouched for.
- **Tamper-evidence**: ledger events are append-only and immutable (Firestore rules).
  Signatures bind the exact packet bytes (SHA-256), the claim, the ledger, and their
  thread position via signer-committed references (§5.2) — edits, replays, reordering,
  and retroactive re-submission are detectable by anyone re-running verification, and
  **settled threads are immune to later events** (§5.3).
- **Server exclusion, stated precisely.** The numbers server holds no Firestore
  credentials at all (`firebase-admin` stays keyless, projectId-only, used solely for
  ID-token verification): it can neither write nor read ledgers. It relays ledger keys
  (decision 8) and mirrors events that clients report, verifying their signatures
  before believing them (§5.5). What a fully compromised server *can* do: serve
  malicious page code, lie by omission, or present a parallel fake universe to a
  visitor with no prior state. What it can never do: forge a signature chained to the
  real root, or alter/remove events in the real ledgers. The defenses against the
  fake-universe attack are the out-of-band root anchor (§4.6) and the offline verifier
  (§7.1); in-browser verification on a fresh device is honestly phishing-equivalent and
  documented as such.
- **Timestamp authority.** Event `createdAt` is Firestore `request.time`, pinned by the
  rules fork (§9.2) — Google is therefore a trusted *ordering* authority. Signer-
  committed references remove timestamps from claim-thread structure entirely; residual
  timestamp trust is confined to roster replay order and decision tie-breaks (§4.4,
  §5.3), and is accepted (Google already operates the auth system).
- **Fail-closed verification, scoped.** Ceremony dialogs (submit/approve/mark-paid),
  claim detail views for approver/treasurer, `/v`, the certificate bundle, and the
  offline verifier re-derive the full chain and refuse on any mismatch. **List views**
  (inbox, finance queue, claim cards) render mirror status explicitly labeled as
  unverified — full verification requires packet downloads (multi-MB each) and belongs
  on detail/ceremony views, not on every list render.
- **Not secrecy**: ledger payloads are encrypted client-side as a side effect of using
  charproof, but confidentiality is not a goal. Keys are relayed to participants by the
  server and embedded in capability links.

## 3. charproof: what we use, what we bypass

Verified against charproof `2a61af5`.

**Used as-is (key custody & identity)** — the genuinely hard parts: `getActiveAmk`
(account master key), device enrollment with the 6-digit out-of-band ceremony,
`revokeDevice` (AMK rotation; historical keyring preserved for remaining devices),
keystore sync (`saveToKeystore`/`loadFromKeystore` — AMK-encrypted, synced to all of a
user's devices), phrase recovery (`setupPhraseRecovery`), WebAuthn-PRF recovery
(`enablePrfRecovery`), and `getVerificationCodeForPublicKey`.

**Bypassed (ledger I/O)** — the `LedgerSession` API is unsuitable for verification and
ceremonies, for reasons confirmed in source:

- `subscribe`/`getGenesisEvent` return only `{action, signerPublicKey}` — the Firestore
  doc id and server `createdAt` are stripped, and invalid events are **silently
  dropped**, so replay order, `stateAt` timing, anomaly display, and doc↔event
  correlation are all impossible through it.
- `appendEvent` generates the event id internally and returns `void` — ceremonies could
  never report which doc they wrote.
- `createLedgerSession`/`getLedgerSession` mint a **fresh keypair** per ledger per
  participant (and even for read-only visitors), which would leave first submissions
  signed by an unattested key and litter the keystore.

Instead, a small module `src/lib/esign/ledger-io.ts` owns ledger reads/writes directly
against `polls/{ledgerId}/events/{eventId}`, using charproof's **exported crypto
primitives** (`signAction`, `verifySignature`, `encrypt`, `decrypt`,
`canonicalStringify`, `generateSymmetricKey`, key import/export) and the same envelope
(`{action, signature, publicKey}`, AES-GCM under the ledger key) and document shape
(`{eventId, createdAt: serverTimestamp(), encryptedData, iv}`) so everything stays
compatible with charproof's rules and storage layout. It writes client-chosen event
ids, reads raw docs with `createdAt` + id intact, and never drops an event silently —
invalid ones are *classified*, not hidden. `setAuthorizedSigners` is not relied on;
authorization is per-event `stateAt` logic in our reducer (§4.4). Chaff is disabled by
construction: `chaff_pool/current` is never created and our writer adds no decoys.

**Ledger creation** (replacing `createLedgerSession`): generate a symmetric key
client-side, write the `polls/{ledgerId}` pointer doc ourselves, and store credentials
in the keystore with the **member's roster identity as the signing keypair** (§4.1) —
so there is no window where an unattested fresh key exists for the ledger.

### Conventions used throughout

- **Action hash**: SHA-256 over `canonicalStringify(action)`, hex — the cross-reference
  primitive (`submitRef`, `approveRef`, `closesRef`) and the idempotency key.
- **Key fingerprint**: SHA-256 over the base64-decoded SPKI key. Display form = first
  8 bytes, hex, space-grouped. Where a fingerprint is an *input* (manual vouch
  fallback, offline-verifier root anchor), the first 16 bytes (32 hex chars) are
  required — 128 bits, second-preimage-resistant; the 8-byte display form is never
  accepted as input.
- **Money** is integer cents everywhere, including signed payloads (invariant 1);
  dollars appear only in rendered UI/PDF text.
- **Frozen statuses**: `{generated, submitted, rejected, approved, paid}` — referenced
  throughout as `FROZEN`.

## 4. Identity layer

### 4.1 One church identity key per member

A member's **church signing identity is their participant keypair on the roster
ledger**, generated when they join it at enrollment (via `ledger-io`, stored through
`saveToKeystore(rosterLedgerId, …)` so it syncs across their devices). Claim ledgers
never get their own identities: when a claim ledger is created or first opened by a
participant, its keystore entry is written with the claim's symmetric key **and the
roster identity's signing keypair** — unconditionally for the creator (there is no
`createLedgerSession` path minting a fresh key anymore, see §3), and before first use
for every other participant. Verification is therefore one-hop: every event on every
ledger must be signed by a key attested in the roster.

*Phase-1 spike*: confirm keystore round-tripping of an externally-supplied signing
keypair (the entry shape matches what `loadFromKeystore` returns; no charproof code
path rotates or overwrites claim-ledger entries behind our back — `revokeDevice`
re-wraps but does not alter entry contents). Fallback if brittle: per-ledger keys plus
root-chained `DELEGATE {claimLedgerId, claimPublicKey}` roster events — two-hop
verification, same event schema.

### 4.2 Enrollment ("Enable signing")

Lazy, self-service, and **never required for claim building** (decision 3). A wizard on
the profile page:

1. **ESIGN/UETA consent** — first-use consent to transact electronically (versioned
   text, §5.4); recorded as `AuditEvent(action:"esign-consent",
   detail:{consentVersion, consentSha256})`. Shown once, re-shown on version bumps.
   (The *legally load-bearing* consent evidence is the consent-text hash inside every
   signed payload — this record is the onboarding acknowledgment.)
2. **Firebase re-auth** — see §9.2: the app deliberately drops client-side Firebase
   auth after login, so the wizard (and every later ceremony session) starts with
   `ensureFirebaseAuth()`, a popup that must resolve to the same email as the numbers
   session (abort on mismatch).
3. **Charproof bootstrap** — `getActiveAmk()` genesis on the member's first device.
4. **Recovery ceremony** — 24-word phrase with confirm-by-re-entry; passkey recovery
   offered where WebAuthn PRF exists. **Mandatory before any role grant takes effect**
   (approver/treasurer/root); skippable-with-nag for plain members, whose worst case is
   re-vouching (§4.5).
5. **Join the roster** — generate the identity keypair, save to keystore (§4.1).
6. **Report** — POST the public key to the server (`SignerIdentity` mirror row,
   status `pending`), then show the vouching QR (§4.3).

The Submit/Approve/Mark-paid buttons prompt un-enrolled users into this wizard.

### 4.3 Vouching ceremony (in person)

- The candidate opens **My signing identity** → a QR encoding
  `{uid, email, name, publicKey}` plus the key fingerprint and a 6-digit code
  (`getVerificationCodeForPublicKey`).
- The voucher opens the nav's **Vouch** tab (shown to attested members; the
  page is `/vouch`) and **scans the QR from the candidate's
  screen — the scan is the binding channel.** Scanning runs in-page
  (`VouchQrScanner` → nimiq `qr-scanner`, loaded on demand; it uses the native
  `BarcodeDetector` where present and a bundled worker on iOS Safari, which has none).
  Doing it in-page — rather than relying on the candidate's link opening in the
  phone's *default* browser — keeps the ceremony inside the voucher's own browser,
  the one already holding their session cookie and signing key (a link opened in a
  different or in-app browser lands in a fresh, unauthenticated, un-enrolled context).
  The legacy path still works: a voucher whose camera app opened `/vouch?c=` lands here
  with the subject pre-filled. When the camera can't be used, the fallback is picking the
  candidate from the pending list and typing their **16-byte fingerprint** (§3
  conventions) — never the 6-digit code alone, which at 10⁶ keyspace is grindable and
  serves only as a spoken sanity check. The voucher confirms the person standing in
  front of them is who the screen claims, then their client appends:

```jsonc
{ "t": "ATTEST", "v": 1, "ledger": "<rosterLedgerId>", "ts": 1760000000000,
  "subject": { "uid": "…", "email": "…", "name": "Jane Doe", "publicKey": "<b64 SPKI>" } }
```

- Attestation threshold (decision 2): a key becomes **attested** once ATTEST events
  from **two distinct attested member identities (distinct `uid`s and distinct signer
  keys — dedupe is by voucher, never by event count)** exist, or **one** from a member
  holding the `approver`/`treasurer`/root role at that point in the log. Self-vouching
  (signer uid = subject uid) never counts. The root's own key is attested by the
  roster's genesis event.
- Vouching asserts identity only. Roles arrive as separate events, valid **only when
  signed by the root key** (v1; delegation to the treasurer is a later option):

```jsonc
{ "t": "GRANT_ROLE", "v": 1, "ledger": "…", "ts": …, "uid": "…", "role": "approver" }
{ "t": "REVOKE_ROLE", "v": 1, "ledger": "…", "ts": …, "uid": "…", "role": "approver" }
{ "t": "REVOKE_KEY",  "v": 1, "ledger": "…", "ts": …, "publicKey": "…" }
```

- If ATTEST events carry differing `subject.name` strings, the reducer keeps the name
  from the first counting ATTEST and the UI surfaces variants; the name is a label, the
  key is the identity.

### 4.4 Roster evaluation (deterministic, client-safe, isomorphic)

Verifiers replay **all** roster events — the roster is never paginated, sampled, or
capped; a truncated roster is an invalid roster (a dropped `REVOKE_KEY` or
`GRANT_ROLE` silently changes validity) — in `createdAt` order (server-assigned,
rules-pinned §9.2; ties broken by event doc id) with a pure reducer:

1. Genesis signer key must match the **root anchor** (§4.6) — else the roster is
   invalid, full stop.
2. Every event's `ledger` field must equal the roster ledger ID (kills cross-ledger
   replay); duplicate action hashes are processed once (kills same-ledger replay).
3. `ATTEST` counts only if its **signer** is attested (or root) at that point and the
   subject key isn't revoked; thresholds per §4.3. The subject uid must not be the
   root's (the anchor rotates by re-genesis, never by vouching — else voucher
   collusion could retire it). **Key supersession (A7):** the moment a key crosses
   the attestation threshold, the same uid's earlier keys are revoked at that
   instant — the quorum that grants identity is the quorum that replaces it.
4. `GRANT_ROLE`/`REVOKE_ROLE`/`REVOKE_KEY` count only from the root key.
5. Output is a timeline: `stateAt(t)` returns `publicKey → {uid, name, roles[]}` as of
   server time `t`. **Claim events are judged against `stateAt(event.createdAt)`** — a
   signer must be attested (with the required role) *when they signed*; later
   revocation never retroactively voids earlier signatures (forward-only, matching
   charproof's revocation semantics). Paid claims therefore stay verifiable forever.

The reducer and the claim-validity rules (§5.3) live in dependency-free **isomorphic**
modules (`src/lib/esign/roster.ts`, `src/lib/esign/validity.ts`) with the same
unit-test discipline as `money.ts` — the same code runs in the browser (verification),
in the server's mirror pipeline (§5.5), and in the offline verifier script (§7.1).

### 4.5 Multi-device and key loss

> Implemented (amendment A6) per `docs/MULTI_DEVICE_PLAN.md` — M1–M4 done and
> e2e-verified on both the mock AND the Firebase-emulator (real Firestore +
> production rules) backends; M5 residue is a live-project smoke.

- **Second device**: charproof's own flow — `requestDeviceAuthorization()` on the new
  device, 6-digit code compared between the member's own two devices,
  `approveDeviceAuthorization(d, {expectedVerificationCode})` on the old one. The AMK
  unlocks the keystore, which carries the roster identity → **no re-vouching**.
- **Lost device, recovery configured**: phrase or PRF recovery restores the AMK on a
  clean device; identity intact. `revokeDevice` rotates the AMK for remaining devices.
- **Lost device, no recovery** (plain members only, §4.2): enroll fresh (new identity
  key) and get re-vouched next Sunday — the re-vouch itself retires the old key by
  **supersession** (A7): when the new key crosses the vouch threshold, the uid's
  earlier keys are revoked at that instant, no admin involved. Root `REVOKE_KEY`
  remains the *immediate* retirement path (stolen key that might be misused before
  the re-vouch happens). History signed by the old key remains valid per §4.4's
  `stateAt` rule either way.

### 4.6 The root anchor (out-of-band, never server-relayed alone)

The server relays the registry (`rosterLedgerId`, key, root public key) for
convenience, but **no verifier treats the relayed root as the anchor**:

- **Participants (TOFU + ceremony pin)**: at enrollment the wizard displays the root
  fingerprint; the member is instructed to compare it against the church's published
  value (printed in the church records / read out by the root at the vouching moment).
  The client persists the pin (IndexedDB, beside the charproof keys) and every later
  verification compares against the *pinned* value — a server that swaps registries
  breaks loudly for every enrolled device.
- **Deployment pin**: optional `ESIGN_ROOT_FINGERPRINT` config (via `configValue()`);
  when set, clients and the server refuse any registry that doesn't match. Set it right
  after bootstrap — it turns "compromise the DB row" into "compromise the config file
  too".
- **Offline verifier**: `scripts/verify-bundle.mjs` **requires** the expected root
  fingerprint as an explicit argument; it never trusts the bundle's embedded pin.
- **Fresh browsers on `/v`**: have no prior state, and the page code itself is
  server-served — verification there is honest-server-dependent, said so on the page
  ("cryptographically verified against the church roster pinned by this deployment";
  auditors who need server-independence use the offline verifier). This is the precise
  boundary of the §2 server-exclusion claim.

## 5. Claim signature layer

### 5.1 Packet freezing and the per-hash archive

Today `POST …/pdf` regenerates the packet (with the current date, and pdf-lib stamps
fresh metadata, so bytes differ on every call) and overwrites
`generated/<userId>/<claimId>.pdf` — incompatible with hash binding. Changes:

- `GET /api/reimbursements/[id]/packet` serves the **currently stored** packet bytes to
  the owner while `generated` (and archived bytes once signed) — the client never
  hashes regenerated bytes, only stored ones. `?sha=<64 lowercase hex>` (validated
  `/^[0-9a-f]{64}$/` **before** any path construction — `readStoredFile`'s traversal
  guard alone would let a crafted value escape the claim's directory while staying
  inside `DATA_DIR`) selects an archived version.
- **At submission** the client fetches the stored packet, hashes it, and signs that
  hash. The submit route then reads the stored file **once into memory, hashes those
  bytes, compares against the client's claimed hash (409 on mismatch — e.g. a
  regeneration raced the ceremony; the UI restarts against the new bytes), and archives
  those same in-memory bytes** to `signed/<userId>/<claimId>/<sha256>.pdf` inside the
  same transaction that flips status — no read-check-copy window in which a concurrent
  `POST …/pdf` (still legal while `generated`) could swap the file between hashing and
  archiving.
- While `status ∈ FROZEN ∖ {generated}`, `POST …/pdf` returns **409** ("packet is
  frozen under signature"). Downloads go through `GET …/packet` or `/c/<token>` (which
  keeps serving the latest stored packet — unchanged while frozen).
- Archived signed packets are **never deleted**, even if the claim is later reverted,
  edited, regenerated, or deleted (UETA retention; mirrors the `ExtractionLog`
  outlives-the-claim pattern). Claim deletion must skip the `signed/` tree, and the
  ledger pointer/key survive in `EsignClaimArchive` (§9.1) so certificates and `/v`
  keep working for retained packets.

**The approved copy (three-tier packet model).** A claim's PDF exists in three
tiers: (1) the regenerable unsigned form while `draft`/`generated`; (2) the
hash-frozen packet archived at submit — the cryptographic original that every
ceremony hashes; (3) the **approved copy** — tier 2 with the approver's
ink/name/date stamped onto the "Approved by" block plus a printed pointer to
tier 2's SHA-256. Tier 3 is derived **server-side in the decision preflight**
from signed data only (the APPROVE payload's own `typedName`/`ts`/
`signaturePlacement`, and the ink PNG pinned by `signatureImageSha256`),
archived write-once into the same per-hash store, and its SHA-256 is embedded
in the payload as `approvedPacketSha256` **before the approver signs** — the
commit's canonical-equality check against the pinned payload guarantees the
signature covers it, and the client refuses to sign until it has re-hashed the
archived copy itself (`runDecisionCeremony`). MARK_PAID pins tier 3
transitively through `approveRef`. Tier 2 remains the verification target of
every chain check (decisions bind ITS hash); tier 3 is additive: the default
`GET …/packet` download once `approved`/`paid` (mirror column
`approvedPacketSha256`), the pages behind the certificate cover, and
independently checkable via `verify-bundle.mjs --approved-copy`. Pre-feature
approvals have no tier 3 — surfaces fall back to tier 2 and the certificate's
legacy restamp path.

### 5.2 Canonical signable payloads

The envelope signs only the action (§3), so every action carries its own binding:
`ledger` (the claim ledger ID), `claimId`, `packetSha256`, and **signer-committed
thread references** — ordering never depends on timestamps or the server. `ts` is a
display timestamp for the UETA record only, never an ordering or validity input: for
ceremony payloads it is stamped at preflight (server clock, §5.5 — which is what makes
retries byte-identical), for roster events it is the signer's clock. `rowsDigest` = SHA-256 over
`canonicalStringify` of active rows `[{description, amountCents, ministry, event}]` in
sortOrder — it lets the certificate and verification page prove *contents*, not just
bytes, and verifiers recompute `totalCents` as the sum of row `amountCents`.
`consentSha256` = SHA-256 of the exact consent text version the signer was shown —
signed, so "the text I saw was different" is cryptographically foreclosed.

```jsonc
// Requestor — opens thread `seq`. closesRef: null for seq 1; otherwise the action
// hash(es) of the terminal event(s) that closed thread seq−1 (§5.3).
{ "t": "SUBMIT", "v": 1, "ledger": "…", "ts": …, "seq": 2, "closesRef": ["…"],
  "claimId": "…", "packetSha256": "…", "rowsDigest": "…", "totalCents": 12345,
  "requestorUid": "…", "approverUid": "…",
  "typedName": "Jane Doe", "consentVersion": "ueta-v1", "consentSha256": "…" }

// Approver — decision, bound to one SUBMIT by its action hash. APPROVE is a UETA
// signature (typedName + consent); REJECT is an authenticated action (typedName
// optional, no consent block — it declines to sign rather than signing).
{ "t": "APPROVE", "v": 1, "ledger": "…", "ts": …, "claimId": "…",
  "packetSha256": "…", "submitRef": "…", "approverUid": "…",
  "typedName": "John Smith", "consentVersion": "ueta-v1", "consentSha256": "…",
  "comment": "" }
{ "t": "REJECT",  "v": 1, "ledger": "…", "ts": …, "claimId": "…",
  "packetSha256": "…", "submitRef": "…", "approverUid": "…",
  "comment": "Receipt 2 is for the wrong ministry" }

// Requestor — closes their own open thread (reassignment, or before revert).
{ "t": "WITHDRAW", "v": 1, "ledger": "…", "ts": …, "claimId": "…", "submitRef": "…" }

// Treasurer — UETA signature closing the loop; binds the exact APPROVE it pays.
{ "t": "MARK_PAID", "v": 1, "ledger": "…", "ts": …, "claimId": "…",
  "packetSha256": "…", "approveRef": "…", "treasurerUid": "…",
  "typedName": "…", "consentVersion": "ueta-v1", "consentSha256": "…",
  "checkNumber": "1042" }
```

### 5.3 Threads: lifecycle and validity rules

Submissions form **threads**: thread *n* is the valid SUBMIT with `seq` *n* plus the
events referencing it. The core monotonicity rule — **later events never invalidate
settled threads** — is what makes the record repudiation-proof: nothing the requestor,
approver, or anyone else appends afterward can un-approve or un-pay an already-settled
thread (a requestor who got paid cannot orphan the evidence by submitting again; an
approver cannot muddy a paid claim by appending a contrary decision later).

Event-level validity, evaluated by the shared `validity.ts` (client, server mirror,
offline verifier alike):

1. **Envelope**: signature valid; signer key attested at `createdAt`
   (`stateAt`, §4.4); `action.ledger` equals this ledger's ID; duplicate action hashes
   count once.
2. **SUBMIT (thread n)**: signer maps to `requestorUid` = the claim owner;
   `approverUid` holds the `approver` role and ≠ `requestorUid` (decision 6);
   and its `closesRef` correctly closes thread n−1:
   - `seq 1`: `closesRef` null.
   - After a REJECT or WITHDRAW of thread n−1: `closesRef` = that event's action hash
     (array form covers closing multiple contested SUBMITs, below).
   - After an APPROVE of thread n−1: allowed **only with a different `packetSha256`**
     (the revert-and-edit flow) and `closesRef` = the APPROVE's hash. Same-bytes
     resubmission over an approval is invalid — that shape is precisely the
     repudiation attack.
   - No valid closure exists (thread n−1 open, or approved and same bytes): invalid.
3. **Contested seq** (two valid-form SUBMITs, same seq, different content — requires
   the owner's own key, e.g. equivocation or an interleaved two-tab mishap that
   escaped dedupe): *that thread* is `disputed` — neither SUBMIT is decidable — and
   **settled earlier threads are unaffected**. Recovery: WITHDRAW every contested
   SUBMIT, open thread n+1 with `closesRef` = all of those WITHDRAW hashes.
4. **APPROVE/REJECT**: signer maps to the `approverUid` named by the SUBMIT that
   `submitRef` points at; that SUBMIT must be valid and undisputed; `packetSha256`
   must match it. **An APPROVE additionally requires the signer to hold
   approver-or-above at the APPROVE's own `createdAt`** (A9 — role checked when
   exercised, exactly like MARK_PAID; a REVOKE_ROLE between submit and decision
   voids the pending approval, while decisions made before the revocation stand
   forever). REJECT carries no role clause — a demoted approver may still decline.
   The **binding decision** for a thread is the first valid decision by
   `createdAt` (doc-id tie-break; the §2 timestamp-authority caveat applies);
   subsequent conflicting decisions are flagged anomalies that never alter the binding
   — so a post-payment contrary decision is visible but inert.
5. **WITHDRAW**: signed by the requestor; targets their own SUBMIT; invalid if that
   thread already has a binding APPROVE (approved threads close only via §5.3.2's
   new-bytes rule; nothing "un-approves").
6. **MARK_PAID**: signer holds `treasurer` role at `createdAt`; `approveRef` resolves
   to a binding APPROVE; `packetSha256` matches it. Once valid, the thread is
   terminally settled.

**Claim-level state** shown to humans: the *current* thread is the **highest-seq valid
thread** whose `packetSha256` matches the currently archived packet version — several
threads may share those bytes after withdraw-and-resubmit (the server points at
"current"; every per-thread fact above is provable without that pointer — the pointer
only scopes display). `approved`/`paid` render green only when the current thread's
chain verifies end-to-end.

**Fail-closed countersigning**: before offering Approve/Reject, the approver's client
(a) verifies the chain end-to-end, (b) fetches the archived bytes, hashes them, and
requires equality with the SUBMIT's `packetSha256` — and the PDF rendered in the
ceremony **is those exact verified bytes, rendered client-side** (pdf.js in the dialog;
the existing server-raster preview path is for Shoebox receipts, not ceremonies — a
server raster would reopen the packet-swap hole on mobile, where embedded-PDF viewing
doesn't work natively). Mark-paid applies the same discipline. A missing/invalid SUBMIT
(e.g. a client that reported `submitted` but never appended) blocks the ceremony and
shows the discrepancy.

### 5.4 UETA/ESIGN ceremony (decision 11)

- **First use** (once per person, re-shown on text changes): consent to conduct these
  transactions electronically, that the typed name + cryptographic signature constitute
  a legal signature, and notice of the right to a paper process — versioned text kept
  in-repo (`src/lib/esign/consent.ts`, starting at `ueta-v1`) and recorded per §4.2.
- **Every signing dialog** (submit / approve / mark-paid):
  1. Renders the exact verified packet bytes client-side (§5.3) and the claim summary
     recomputed from the `rowsDigest` inputs.
  2. Restates the one-line intent affirmation with a required checkbox
     ("I intend this to be my signature").
  3. Shows the signer's name **prefilled from their roster attestation**, editable —
     the typed string is recorded in the payload as `typedName`, not validated against
     the roster (UETA cares about intent; strict string matching only causes lockouts —
     the cryptographic identity does the proving).
  4. Signs `consentSha256` + content into the payload, appends, then reports (§5.5).

### 5.5 Ceremony write path and the signature-backed mirror

Ceremonies follow **preflight → append → report**, engineered so that crashes and
double-submission converge instead of contaminating the ledger:

1. **Preflight** (`?preflight=1` on the semantic routes) validates server-side (status,
   approver eligibility, hash match) and returns the **exact canonical payload** to
   sign — the server stamps `seq`, `closesRef`, `ts`, and pins the content as that
   signer's *pending action* on the claim (persisted; at most one per (claim, signer),
   so a requestor preparing a WITHDRAW never clobbers the approver's in-flight
   decision). Re-preflighting replaces one's own unconsumed pending action. Two tabs
   therefore sign byte-identical payloads, and **ceremony event ids are derived from
   the action hash**, so the duplicate append fails at the rules layer (create on an
   existing doc) — nothing to dedupe. `submitSeq` never resets (revert included) — seq
   is a lifetime counter per claim.
2. **Append** via `ledger-io` with a client-chosen event id.
3. **Report** `{eventId, createdAtMs, encryptedData, iv}` — the **full raw event doc**,
   not just the payload. The route is idempotent on action hash; re-reporting after a
   crash is a no-op; reporting consumes the pending action.

**The server verifies before it believes.** It holds every ledger key (it relayed
them), so on each report (and on reconciliation) it decrypts the envelope, checks the
ECDSA signature, and runs the same isomorphic reducer/validity modules (§4.4) over its
mirrored event set — **`SignerIdentity.status`, `User.role`, claim `status`, and every
`SignatureRecord` are written only from events that verify**. This closes the
self-asserted-role hole (a fake ATTEST/GRANT_ROLE report without root-chained
signatures simply doesn't verify) and means the cross-tenant grants of §6.3 rest on
cryptography, not client honesty. Raw docs land in `LedgerEventMirror` (§9.1) — the
material for certificates and offline bundles, which the server could otherwise never
assemble (it cannot read Firestore). Residual gap, stated: the server can be starved by
*omission* (nobody reports an event); any participant's verifying view reconciles by
re-reporting valid events the mirror lacks, and `/v`'s live mode compares mirror vs
Firestore and flags divergence. Reconciliation **routes no work by itself**: a
reconciled SUBMIT updates mirror facts, but inbox/queue placement additionally requires
the server-side eligibility checks — a self-appended SUBMIT naming a non-consenting
approver surfaces as a flagged discrepancy on the claim, not as an inbox entry.

## 6. Workflow

### 6.1 Status machine (extends `DATA_MODEL.md`)

```
draft ⇄ generated → submitted → approved → paid            (paid is terminal)
  ▲                    │  ▲         │
  │                    ▼  │(withdraw+resubmit: new approver, same bytes)
  └─────(revert)──── rejected
        (revert also from submitted / approved)
```

- `generated → submitted`: requestor's SUBMIT ceremony (archives the packet, records
  the chosen approver, `submitSeq`+1).
- `submitted → approved | rejected`: the assigned approver's decision. `rejected`
  stays frozen with the comment until the requestor acts (decision 7).
- **Stalled approver** (expected failure mode — there are no notifications): the
  requestor may WITHDRAW + resubmit from `submitted` at any time — same bytes, next
  seq, different approver; no revert or re-verification of rows needed. The submit
  route accepts `generated | submitted | rejected` accordingly. The owner's panel
  names who the claim is waiting on and flags an assigned approver who has since
  paused approvals (A10 — may still decide) or lost the role/key entirely (A9 —
  cannot approve anymore), pointing at this same withdraw+reassign escape.
- `approved → paid`: treasurer's MARK_PAID. No revert from `paid`.
- **Revert** extends to `{generated, submitted, rejected, approved} → draft`; the UI
  appends WITHDRAW first when a thread is open (best-effort honesty marker; §5.3's
  hash rules are the mechanism).
- **Receipt lifecycle changes with the machine** (amending invariant 6):
  `Receipt.status="processed"` is redefined as **"on ≥1 claim in a FROZEN status"**.
  The revert route's release query must check `reimbursement.status IN FROZEN` (today
  it checks `= "generated"` — left as-is, a sibling claim's revert would release a
  receipt still inside a *submitted/approved/paid* claim, re-enabling image edits on
  receipts whose bytes back live signatures). The receipt-edit route's `processed` 409
  then covers signed claims automatically.
- Freezing of line items/claim settings needs no new enforcement: every mutation route
  is already draft-only. The routes that special-case `generated` and must learn the
  new statuses: `…/pdf` POST (§5.1), `…/revert`, and the **UI touchpoints that assume
  the binary status set** — `ReviewClaim.tsx` (types `status: "draft" | "generated"`;
  shows Revert for every non-draft status, which must exclude `paid`; its "Download
  PDF again" button POSTs `…/pdf` and must switch to `GET …/packet` when frozen),
  `claims/page.tsx` and `ReceiptGrid.tsx` status chips.
- **No notifications (decision 9), so the UI must surface state**: NavBar badge counts
  for approvers (pending decisions) and the treasurer (approved awaiting payment);
  status chips on claim cards for requestors. The same badges endpoint tells the nav
  whether the member is attested, which gates its low-priority **Vouch** tab (§4.3).

### 6.2 New/changed API routes (all `handleApi` + `requireUserId` unless noted)

| Route | Methods | Behavior |
| :-- | :-- | :-- |
| `/api/esign/registry` | GET | roster `{ledgerId, key, rootPublicKey}` + my `SignerIdentity` status. **Key material only for enrolled users** (a `SignerIdentity` row exists); others get existence/status only. 404 until bootstrapped |
| | POST | one-time bootstrap by the root user (email = `ESIGN_ROOT_EMAIL`): requires the recovery ceremony completed, stores registry, grants `role=admin`. Refuses a second row |
| `/api/esign/identity` | POST | begin enrollment: create my `SignerIdentity(pending)` and return registry key material; re-POST records my roster public key once generated |
| `/api/esign/report` | POST | raw roster event docs (ATTEST/GRANT_ROLE/…): server decrypts, verifies, re-runs the reducer, updates `SignerIdentity`/`User.role` mirrors + `LedgerEventMirror`. Idempotent per event |
| `/api/esign/members` | GET | attested members (+roles) from the verified mirror — feeds the approver picker. **Enrolled users only** (the Members page's directory is the treasurer/admin-gated `GET /api/members`) |
| `/api/reimbursements/[id]/submit` | POST | `?preflight=1` → pending-action payload (§5.5). Full call: `{eventId, createdAtMs, encryptedData, iv}` (+ `{ledgerId, ledgerKey}` on first submission only — later submissions reuse the stored ledger) → verify + apply: archive bytes it hashed (§5.1), status=`submitted`, `approverUserId`, `SignatureRecord`, AuditEvent(`submit`). Guards status `generated∣submitted∣rejected` |
| `/api/reimbursements/[id]/decision` | POST | assigned approver only; preflight + raw-doc report as above → status `approved∣rejected`, `SignatureRecord`, AuditEvent |
| `/api/reimbursements/[id]/paid` | POST | treasurer role; preflight + raw-doc report → status `paid`, `checkNumber`, `SignatureRecord`, AuditEvent |
| `/api/reimbursements/[id]/reconcile` | POST | raw claim-ledger event docs from any participant's verifying view: verify + merge into mirror (`SignatureRecord`/`LedgerEventMirror`), surface discrepancies; **never routes work** (§5.5). Also how WITHDRAW reaches the mirror |
| `/api/reimbursements/[id]/packet` | GET | stored packet bytes while `generated`; archived bytes once signed (`?sha=`, format-validated, §5.1) — owner, assigned approver, or treasurer |
| `/api/reimbursements/[id]/certificate` | GET | approval-certificate PDF (§7.1) — same access as `packet` |
| `/api/approvals` | GET | approver inbox: claims where `approverUserId = me` and `status="submitted"` (+ decided history), mirror-labeled; detail view fetches ledger key + runs full verification |
| `/api/finance` | GET | treasurer queue: `status ∈ {approved, paid}`, mirror-labeled |
| `/api/v/[token]/summary` · `/registry` · `/events` · `/packet` | GET | **token-authorized, `/c`-style** (token = the existing `publicToken`; no other auth): claim summary + ledger key, registry (id/key/root pin), mirrored raw events, archived packet bytes — everything the `/v` page verifies against. Live Firestore cross-check additionally requires the visitor's own Firebase sign-in |
| `/v/[token]` | GET page | verification page (§7.2) |

Enrollment gating note: numbers upserts a `User` for *any* verified Google sign-in
(existing posture), so registry keys and the member directory are withheld from
accounts that never started enrollment. This is an abuse dampener, not a security
boundary — see §8 (flooding) for why the boundary doesn't exist at the Firestore layer
either, and why that's acceptable.

### 6.3 Cross-tenant access (amendment to hard invariant 2)

The approver inbox, finance queue, `packet`, `certificate`, `reconcile`, and
`/api/v/[token]/*` are the **only** places a claim is readable by a non-owner, each
gated by an explicit grant: being the claim's assigned approver (set only by a
signature-verified SUBMIT), holding the treasurer role (set only by a root-chained
GRANT_ROLE), or presenting the capability token. Everything else keeps owner-only 404
semantics. Approvers review the *packet* (form + receipt images are already inside
it) — individual receipt routes stay owner-only.


## 7. Finance delivery & artifacts

### 7.1 Approval certificate (digital-primary, print-friendly — decision 10)

The signed inner packet can never be restamped (hash binding), so approval evidence
lives in a **certificate cover** prepended to it on download: claim summary (requestor,
approver, treasurer, totals via `centsToDollarString`), one UETA signature block per
event (typed name, `ts`, key fingerprint, event id, consent version + hash),
`packetSha256` and `rowsDigest`, the root fingerprint (for comparison against the
church's published value, §4.6), a QR to `/v/<token>`, and the consent text in an
appendix. The template's `Approver Name`/`Approval Date` AcroForm fields on the inner
pages stay blank forever — the certificate replaces them.

The bundle is assembled server-side **from `LedgerEventMirror`** (raw ciphertext docs
reported by clients, §5.5 — the server has no Firestore read path of its own):

- A PDF attachment `verification-bundle.json`: registry pin, raw roster events, raw
  claim-ledger events (ciphertext + envelope fields + `createdAt` + ids), ledger keys,
  and the archived packet's SHA-256.
- `scripts/verify-bundle.mjs` (Node WebCrypto; no Firestore, no server; takes the
  expected **root fingerprint as a required argument**) re-runs the full §4.4/§5.3
  verification against the bundle plus the packet bytes extracted from the same PDF.
  Financial records stay verifiable for the retention window (7+ years) even if
  Firestore, Firebase, or the app are gone.
- Completeness caveat, stated: a malicious server can *omit* events from a bundle
  (it cannot forge them). While Firestore lives, `/v`'s live mode exposes omission;
  archivally, participants keep their own certificate copies (each ceremony offers the
  download), so an omitted-event bundle can be contradicted by any honest copy.

### 7.2 Verification page `/v/<token>`

Client-side, from scratch, on every load, fed by `/api/v/[token]/*`: replay roster
from the root anchor (§4.6 — pinned/TOFU where available; explicitly labeled
"deployment-pinned" for fresh visitors) → verify the claim ledger events → fetch
archived packet bytes, hash in-browser, match against the SUBMIT chain → render
per-thread, per-signature ✓/✗ with names, roles, vouch chains, signer `ts`, and server
`createdAt`. When the visitor also signs into Firebase, a **live mode** re-reads
`polls/{ledgerId}/events` directly and diffs against the server-supplied set —
divergence (omission, extra events) renders loudly. Red states (hash mismatch,
unattested signer, disputed thread, mirror divergence) are prominent. This page is the
audit tool; SQLite status never feeds it.

## 8. Attack scenarios & defenses

| Attack | Defense |
| :-- | :-- |
| Edit a claim after signatures (server, owner, or DB tamper) | Hash binding to archived bytes; regeneration blocked while signed; verification recomputes hashes from bytes (§5.1, §5.3) |
| Paid requestor appends a new SUBMIT to orphan the approval (repudiation) | Thread monotonicity: settled threads are immune; same-bytes SUBMIT over an APPROVE is invalid; new-bytes threads don't touch old ones (§5.3) |
| Approver appends a contrary decision after payment | Binding decision is first-by-`createdAt`; later conflicts are inert flagged anomalies (§5.3.4) |
| Approver demoted mid-flight still approves the claim named to them | Role-at-exercise (A9): APPROVE binds only while the signer holds approver-or-above at its `createdAt`; the decision route re-evaluates at commit so the mirror can't disagree. REJECT stays available to hand the claim back (§5.3.4) |
| Replay an old SUBMIT/decision (same or different ledger) | Action-embedded `ledger`/`claimId`; duplicate action hashes count once; `closesRef`/`submitRef`/`approveRef` pin thread structure (§5.2–5.3) |
| Backdate/forward-date events with a custom Firestore client | Rules fork pins `createdAt == request.time` and the exact document shape (§9.2) |
| Server swaps packet bytes shown to the approver | Fail-closed countersigning renders only bytes whose hash matches the verified SUBMIT, client-side even on mobile (§5.3) |
| Server lies in the mirror (`status`, roles, names) | Mirror rows are written only from signature-verified events (§5.5); ceremonies/detail views/`/v` re-verify client-side; reconciliation + live mode surface divergence |
| Server presents a fake parallel roster/claim universe | Root anchor: TOFU pins on enrolled devices, `ESIGN_ROOT_FINGERPRINT` deployment pin, printed fingerprint comparison, offline verifier with explicit anchor. Fresh-browser `/v` is honestly labeled server-dependent (§4.6) |
| Forge a signer (mint a keypair, hold the shared ledger key) | Per-event `stateAt` attestation chained to the root; roster requires in-person vouches (§4.3–4.4) |
| Fake ATTEST/GRANT_ROLE report to gain roles/inbox access | Server verifies root-chained signatures before mirror/role writes (§5.5); unverifiable reports change nothing |
| Grind a keypair matching a victim's 6-digit vouch code | QR scan or 16-byte fingerprint entry is the binding channel; the code is never sufficient (§4.3) |
| Voucher collusion (two members attest a fake person) | Accepted residual risk (decision 2); events are permanent, signed, and attributable — collusion leaves evidence |
| Stolen device / exfiltrated key | charproof `revokeDevice` (AMK rotation); the key itself retires via re-vouch supersession (A7) or, when speed matters, root `REVOKE_KEY`; forward-only, historical events stand (§4.4–4.5) |
| Ledger flooding / junk events (any Firebase-authed account can append — charproof's world-append design) | Invalid events are classified client-side; **the roster is always read in full** (§4.4) — flooding it degrades performance, never validity; claim ledgers are per-claim and bounded-interest; escalation path: rules fork restricting the roster ledger's writers at deploy time, or roster re-genesis (§12) |
| Requestor reports `submitted` without appending SUBMIT | Approver ceremony fails closed on missing/invalid SUBMIT — the lie only wedges the liar's claim (§5.3) |
| Self-appended SUBMIT naming a non-consenting approver | Reconciliation never routes work; inbox placement requires server-side eligibility checks (§5.5) |
| Google (timestamp/order authority) misbehaves | Signer-committed refs keep claim threads timestamp-free; residual roster-order + tie-break trust accepted and documented (§2) |
| Firestore/Google disappears years later | Certificate-embedded verification bundle + offline verifier with out-of-band anchor (§7.1) |

Out of scope, stated honestly: malware on a signer's device (can sign as them until
revoked — mitigated by revocation + audit trail, not prevented), collusion between
requestor and approver (a human-process problem; thresholds were declined, decision 5),
and Google-account takeover of a signer (Firestore auth gates *access*; signatures
still require the device-held key, so takeover alone cannot sign — it can only read
and flood).

## 9. Data model & platform integration

### 9.1 SQLite changes (mirror + workflow + retention)

New values `Reimbursement.status`: `submitted | rejected | approved | paid`. New
columns: `approverUserId?`, `signatureLedgerId?`, `signatureLedgerKey?`,
`packetSha256?`, `submitSeq Int @default(0)` (lifetime counter, never reset),
`pendingActionsJson?` (§5.5 preflight pins, keyed by signer), `submittedAt?`,
`decidedAt?`, `paidAt?`, `checkNumber?`.

```prisma
model EsignRegistry {   // single row (app-enforced), written once at bootstrap
  id String @id @default(cuid())
  rosterLedgerId String
  rosterLedgerKey String
  rootPublicKey  String
  rootUserId     String
  consentVersion String  @default("ueta-v1")
  createdAt      DateTime @default(now())
}

model SignerIdentity {  // verified mirror of roster state (written per §5.5 only)
  id        String @id @default(cuid())
  userId    String @unique
  publicKey String  @default("")        // filled once the roster keypair exists
  status    String @default("pending")  // pending | attested | revoked
  attestedAt DateTime?
  createdAt  DateTime @default(now())
}

model LedgerEventMirror { // raw event docs as reported — certificate/bundle material
  id            String @id @default(cuid())
  ledgerId      String
  eventId       String
  createdAtMs   BigInt        // Firestore createdAt as reported
  encryptedData String
  iv            String
  kind          String @default("") // decrypted t, once verified
  verifiedAt    DateTime?
  @@unique([ledgerId, eventId])
  @@index([ledgerId])
}

model SignatureRecord { // verified mirror of claim-ledger actions; outlives the claim
  id              String  @id @default(cuid())
  reimbursementId String?
  reimbursement   Reimbursement? @relation(fields: [reimbursementId], references: [id], onDelete: SetNull)
  kind            String  // submit | approve | reject | paid | withdraw
  signerUserId    String
  signerPublicKey String
  typedName       String  @default("")
  packetSha256    String
  payloadJson     String  // the exact signed action (seq/refs/consent inside)
  actionHash      String  @unique       // idempotency key (§5.5)
  ledgerEventId   String
  createdAt       DateTime @default(now())
}

model EsignClaimArchive { // retention pointer — survives claim deletion untouched
  claimId       String @id   // plain string on purpose (no FK)
  ledgerId      String
  ledgerKey     String
  publicToken   String
  createdAt     DateTime @default(now())
}
```

`User.role` becomes the verified role mirror: `member | approver | treasurer | admin`
(update the stale `schema.prisma` comment, which predates `approver`) — UI/queue authz
only; the roster is the signed truth and the mirror is written only from verified
events (§5.5). Every transition writes an AuditEvent (`submit`, `approve`, `reject`,
`mark-paid`, `esign-consent`, `esign-reconcile` join the action list) — invariant 7
extends to this trail. `ownershipToken` from ledger creation is discarded (the
keystore syncs the requestor's credentials; the server holds the shareable key;
`EsignClaimArchive` preserves it past claim deletion).

### 9.2 Firebase client, Firestore & rules (forked minimally)

- **Firebase client**: new `src/lib/firebase-client.ts`, lazily loaded **only by
  e-sign screens** (SignInCard set the precedent of importing Firebase only where
  used; the Firestore SDK is too heavy for every page). Important verified fact:
  `SignInCard` **deliberately signs out of Firebase** right after exchanging the
  session cookie, so no Firebase auth state persists between visits. Every e-sign
  session therefore begins with `ensureFirebaseAuth()`: a Google popup (through the
  existing `FIREBASE_AUTH_PROXY` machinery on iOS) whose resulting email **must equal
  the numbers session's email** (abort otherwise — a user signed into a different
  Google account must not write ledgers under a mismatched uid). This is one popup per
  e-sign session; the deliberate post-login sign-out is retained (changing the app's
  auth posture is out of scope).
- **AUTH_TEST_MODE** users have no Firebase identity → e-sign controls disabled unless
  emulator env is present.
- **Rules**: start from charproof's `firestore.rules` (collection name `polls` is
  hardcoded upstream) with one hardening fork on event creation, kept in-repo at
  `firestore.rules` with a comment block explaining the delta:

```
allow create: if isSignedIn()
  && request.resource.data.keys().hasOnly(['eventId','createdAt','encryptedData','iv'])
  && request.resource.data.createdAt == request.time;   // serverTimestamp() only
```

  This matches exactly what both charproof's store and our `ledger-io` write, while
  denying custom clients the ability to backdate events — which roster replay order
  and `stateAt` depend on. **Deployment is an explicit phase-1 step with an owner**
  (`firebase deploy --only firestore:rules`), documented in the README alongside a
  canary: `scripts/check-rules.mjs` attempts a backdated write to a scratch ledger and
  must be denied — run it after every rules deploy and in the e2e emulator suite, so
  silent drift (console edits, forgotten deploys) is caught rather than trusted.
  `chaff_pool/current` is never created; `ledger-io` writes no decoys.
- **Config**: `ESIGN_ROOT_EMAIL` (bootstrap gate) and optional
  `ESIGN_ROOT_FINGERPRINT` (§4.6), both via `configValue()`. The roster registry lives
  in SQLite, created by the bootstrap route (which requires the root's recovery
  ceremony first). The e-sign UI renders only when Firebase web config + a
  bootstrapped registry exist — deployments that never bootstrap keep today's flow
  untouched.
- **Testing**: unit tests hammer `roster.ts`/`validity.ts` (isomorphic, dependency-
  free) and the offline verifier against fixture bundles; `ledger-io` and ceremony
  flows run against injected fakes (charproof's `setSessionProviders`/`cryptoProvider`
  seams + a fake Firestore layer for our reader). Route-level tests for the new
  statuses/grants (mirror-only, no emulator) land **with** phases 3–4, and
  `tests/e2e/security.spec.ts`'s cross-tenant-404 sweep is updated for the deliberate
  §6.3 exceptions in the same PRs. The full Firebase-emulator e2e
  (enroll → vouch → submit → approve → pay → verify) is phase 5.

## 10. New invariants (graduate into CLAUDE.md as implemented)

1. **Signed packets are immutable**: once a claim leaves `generated`, its packet bytes
   are archived per-hash under `signed/…/<sha256>.pdf` and never regenerated,
   overwritten, or deleted (claim deletion included; `EsignClaimArchive` keeps the
   ledger pointer/key) — regeneration is only reachable through revert, which voids
   signatures by hash mismatch.
2. **Mirror rows are written only from signature-verified events** (§5.5); ceremonies,
   detail views, `/v`, certificates, and the offline verifier re-derive validity
   themselves and fail closed; list views may show mirror status only when labeled
   unverified. The server never claims cryptographic truth.
3. **The numbers server never holds Firestore credentials** — it can neither write nor
   read ledgers; everything it knows arrives as client-reported, signature-verified
   raw events.
4. **Signed actions are self-binding and threads are monotonic**: every payload carries
   `ledger`, `claimId`, `packetSha256`, and its `seq`/`closesRef`/`submitRef`/
   `approveRef` linkage; settled threads are never invalidated by later events;
   verifiers never resolve thread structure from timestamps or the server. Roster and
   validity rules are isomorphic, dependency-free, exhaustively unit-tested modules.
5. **`Receipt.status="processed"` means "on ≥1 claim in a FROZEN status"** — every
   query that releases or edit-gates receipts uses the full frozen set (amends
   invariant 6).
6. Signed payloads carry money as **integer cents** and bind `packetSha256` +
   `rowsDigest` + `consentSha256`; every workflow transition writes its AuditEvent +
   SignatureRecord, idempotent on action hash.

## 11. Implementation phases

1. **Platform** — lazy firebase-client + `ensureFirebaseAuth()`, Firestore enablement,
   forked rules deploy (documented owner + `check-rules.mjs` canary), charproof
   dependency, `ledger-io` module (append/read/verify round-trip vs the emulator),
   `ESIGN_ROOT_EMAIL`/`ESIGN_ROOT_FINGERPRINT`, feature gating. *Spike: keystore
   round-trip of an externally-supplied signing keypair (§4.1); fall back to delegation
   events if brittle.*
2. **Identity** — registry bootstrap (root recovery ceremony + fingerprint
   publication), enable-signing wizard (consent → AMK → recovery → roster join →
   report), vouching ceremony (QR scanner dependency + camera UX + fingerprint
   fallback), roster reducer + `stateAt`, server-side verified mirroring
   (`/api/esign/report`), members endpoint, registry gating, TOFU pinning.
3. **Submission & approval** — per-hash archive + packet GET (sha validation,
   atomic hash-archive-flip), freeze/revert/pdf-route changes + FROZEN receipt
   semantics, preflight/pending-action machinery, submit ceremony, approver inbox +
   fail-closed decision ceremony (client-side pdf.js render), withdraw/reassignment,
   **reconciliation endpoint** (crash repair ships with the ceremonies that need it),
   duplicate-receipt guard, status machine + audit trail, badges, and the §6.1 UI
   touchpoint fixes (`ReviewClaim` status union/revert/download, claims page,
   `ReceiptGrid` chips), route tests + security-sweep updates.
4. **Finance & verification** — treasurer queue, mark-paid ceremony, certificate PDF
   with embedded verification bundle, offline verifier script, `/api/v/[token]/*` +
   `/v/<token>` page with live mode, route tests.
5. **Hardening** — device management UI + PRF recovery (planned in detail:
   `docs/MULTI_DEVICE_PLAN.md`), full emulator e2e suite, UETA consent text review,
   root-rotation ceremony doc, docs (`ARCHITECTURE`/`DATA_MODEL`/`CLAUDE.md` updates).

## 12. Risks & open items

- **Keystore identity reuse** (§4.1) is the one unproven charproof interaction — hence
  the phase-1 spike with a committed fallback (delegation events).
- **Roster availability**: the registry row (ledger ID + key) lives in SQLite on the
  `/data` volume; losing it without a backup means participants with keystore copies
  still function but new enrollments break. Covered by existing volume-backup practice;
  the registry is also recoverable from any enrolled client.
- **Root succession/compromise**: rotation = new roster genesis cross-signed by the old
  root, republished fingerprint, TOFU re-pin prompt (documented ceremony, phase 5);
  until then the root key is the single point of trust — per decision 1, accepted,
  with mandatory phrase backup at bootstrap.
- **UETA consent text** (`ueta-v1`) should get a once-over from someone who reads
  legalese before the feature is used in anger; payloads/certificates capture the
  consent text hash, typed name, and intent affirmation.
- **Safari IndexedDB eviction** can wipe device keys *and TOFU pins*; the AMK keystore
  + phrase/PRF recovery covers keys, the deployment pin covers the anchor, and worst
  case for a plain member is a re-vouch.
- **Ledger bloat** from the world-append rules is accepted at church scale (§8), with
  the roster-writer rules fork and roster re-genesis as escalation paths.
- **Client bundle weight**: firebase + charproof + pdf.js + a QR decoder are all
  lazy-loaded on e-sign screens only; keep them out of the shared bundle (phase 1/3
  acceptance criterion).
- Firestore outages make e-sign actions unavailable (hard dependency accepted,
  decision 12); claim building/PDF generation continue to work without Firestore.
