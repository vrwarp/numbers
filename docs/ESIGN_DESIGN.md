# E-signature & approval workflow — design

Status: **approved proposal, not yet implemented.** Decisions in §1 were ratified by the
project owner (2026-07-11); v2 adds the hardening round (replay binding, rules fork,
fail-closed verification, offline verification bundle, duplicate-receipt guard). This
document is the implementation contract; §10 graduates into `CLAUDE.md` as phases land.

The feature adds a cryptographically tamper-evident e-signature and approval process on
top of the existing claim flow, using [charproof](https://github.com/vrwarp/charproof)
(client-side zero-knowledge, append-only, ECDSA-signed event ledgers on Cloud Firestore).
The existing flow — Shoebox → extraction → human verification → generated PDF — is
untouched; signing begins where it currently ends.

## 1. Decisions log

| # | Question | Decision |
| :-- | :-- | :-- |
| 1 | Trust root | The project owner is the genesis trust root (`ESIGN_ROOT_EMAIL`) |
| 2 | Vouching | In person only. A signer is attested by **two vouches from any attested members, or one vouch from an approver-or-above**. Vouching attests identity only; roles are granted separately |
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

## 2. Trust model — what the cryptography buys

- **Non-repudiation**: signing keys are generated client-side and never leave the
  signer's devices (IndexedDB, synced between a user's own devices only via the
  AMK-encrypted keystore). A valid signature proves possession of a key that a chain of
  humans physically vouched for.
- **Tamper-evidence**: ledger events are append-only and immutable (Firestore rules).
  Signatures bind the exact packet bytes (SHA-256), the claim, the ledger, and their
  position in the submission sequence (§5.2), so edits, replays, and reordering are
  detectable by anyone re-running verification.
- **Server exclusion**: the numbers server holds **no Firestore write credentials**
  (`firebase-admin` stays keyless, projectId-only, used solely for ID-token
  verification). The server relays ledger *read* keys (decision 8) but cannot forge,
  modify, or delete events — tamper-evidence holds even against a compromised app server.
- **Fail-closed verification**: any UI about to countersign (approve, mark-paid) or to
  assert validity (`/v` page, finance queue) must first re-derive the full chain —
  roster from the pinned root, event signatures against the allowlist, packet bytes
  against the signed hash — in the browser, and refuse the ceremony on any mismatch.
  The SQLite mirror (§8) is a convenience cache, never proof.
- **Not secrecy**: ledger payloads are encrypted client-side as a side effect of using
  charproof, but confidentiality is not a goal. Keys are relayed to participants by the
  server and embedded in capability links.

## 3. charproof facts that shaped this design

Verified against charproof `2a61af5`:

- Ledgers live at `polls/{ledgerId}/events/{eventId}` (collection name hardcoded in
  `FirestoreLedgerEventStore`). The library writes `createdAt: serverTimestamp()` on
  every event and orders by it; event doc IDs are client-chosen UUIDs. **The bundled
  rules do not pin `createdAt`**, so a custom client bypassing the library could
  backdate events — we fork the rules minimally to close this (§9.2).
- The event envelope is `{action, signature, publicKey}` — AES-GCM-encrypted with the
  ledger's symmetric key, ECDSA-signed over the canonicalized action
  (`canonicalStringify`). The signature covers **only the action**: neither the ledger
  ID, the event ID, nor the timestamp. Anyone holding the ledger key can therefore
  re-append a copied envelope (same signature, new event ID) or append it to a
  different ledger. Our payload schema carries the binding the envelope lacks (§5.2).
- Events are immutable once written (`update, delete: if false`; re-`set` on an existing
  doc ID counts as an update and is denied).
- Signing identities are **per-ledger**: `getLedgerSession(id, {shareableKey})` generates
  a fresh keypair for a new participant and stores it in the user's AMK-encrypted cloud
  keystore (`saveToKeystore`), which syncs it to all of that user's enrolled devices.
- Multi-writer authenticity requires `session.setAuthorizedSigners(keys)` — the
  allowlist is the application's job. This design derives it from the roster ledger (§4).
- Chaff/decoy writes only occur when `chaff_pool/current` exists. **We never create it**
  (and pass `decoyCount: 0`), so no chaff machinery, scheduled job, or admin credentials
  are needed. Plausible deniability is not a goal here.
- `getActiveAmk`, device enrollment with 6-digit out-of-band verification, 24-word
  phrase recovery (`setupPhraseRecovery`), WebAuthn-PRF recovery (`enablePrfRecovery`),
  and `getVerificationCodeForPublicKey` are public API and used as-is.

### Conventions used throughout

- **Action hash**: SHA-256 over `canonicalStringify(action)`, hex — used for
  cross-references (`submitRef`, `approveRef`).
- **Key fingerprint** (display only): first 8 bytes of SHA-256 over the base64-decoded
  SPKI key, hex, space-grouped in pairs — shown on certificates, `/v`, and vouch screens.
- **Money** is integer cents everywhere, including signed payloads (invariant 1);
  dollars appear only in rendered UI/PDF text.

## 4. Identity layer

### 4.1 One church identity key per member

A member's **church signing identity is their participant keypair on the roster ledger**.
When claim ledgers are opened, the same identity is reused by pre-seeding the claim
ledger's credentials via the exported keystore API before the first
`getLedgerSession` call:

```ts
// openClaimLedger(claimLedgerId, claimLedgerKey) — always seed before opening
const roster = await loadFromKeystore(rosterLedgerId);      // my roster identity
const existing = await loadFromKeystore(claimLedgerId);
if (!existing) {
  await saveToKeystore(claimLedgerId, {
    symmetricKey: claimLedgerKey,
    signingPrivateKey: roster.signingPrivateKey,            // reuse attested identity
    signingPublicKey: roster.signingPublicKey,
  });
}
return getLedgerSession(claimLedgerId);                     // path 1: keystore creds
```

This keeps verification one-hop: *every* event on *any* claim ledger must be signed by a
key attested in the roster. **Implementation checkpoint (phase 1 spike)**: if keystore
seeding proves brittle against charproof internals, the fallback is per-ledger keys plus
signed `DELEGATE {claimLedgerId, claimPublicKey}` events appended to the roster by the
member's roster key — verification becomes two-hop but stays within the plain
`appendEvent` API. The event schema below is agnostic to which resolution is used.

### 4.2 Enrollment ("Enable signing")

Lazy, self-service, and **never required for claim building** (decision 3). A wizard on
the profile page:

1. **ESIGN/UETA consent** — first-use consent to transact electronically (versioned
   text, §5.4); recorded as `AuditEvent(action:"esign-consent",
   detail:{consentVersion})`. Shown once, re-shown on version bumps.
2. **Charproof bootstrap** — `getActiveAmk()` genesis on the member's first device.
3. **Recovery ceremony** — 24-word phrase (`setupPhraseRecovery`) with confirm-by-
   re-entry; passkey recovery (`enablePrfRecovery`) offered where WebAuthn PRF exists.
   **Mandatory before any role grant takes effect** (approver/treasurer/root);
   skippable-with-nag for plain members, whose worst case is re-vouching (§4.5).
4. **Join the roster** — `getLedgerSession(rosterLedgerId, {shareableKey})` (registry
   relayed by the server, §6.2) generates the member's identity keypair.
5. **Report** — POST the public key to the server (`SignerIdentity` mirror row,
   status `pending`), then show the vouching QR (§4.3).

The Submit/Approve/Mark-paid buttons prompt un-enrolled users into this wizard.

### 4.3 Vouching ceremony (in person)

- The candidate opens **My signing identity** → a QR encoding
  `{uid, email, name, publicKey}` plus a 6-digit code
  (`getVerificationCodeForPublicKey`) and the key fingerprint.
- The voucher opens **Vouch for a member** and **scans the QR from the candidate's
  screen — the scan is the binding channel.** The spoken 6-digit code is a human sanity
  check only: at 10⁶ keyspace an attacker can grind a keypair matching any code, so the
  code must never be accepted as the sole channel (manual entry falls back to typing
  the full fingerprint, not the code). The voucher confirms the person standing in
  front of them is who the screen claims, then their client appends:

```jsonc
{ "t": "ATTEST", "v": 1, "ledger": "<rosterLedgerId>", "ts": 1760000000000,
  "subject": { "uid": "…", "email": "…", "name": "Jane Doe", "publicKey": "<b64 SPKI>" } }
```

- Attestation threshold (decision 2): a key becomes **attested** once it has ATTEST
  events from **two distinct attested members**, or **one** from a member holding the
  `approver`/`treasurer`/root role at that point in the log. Self-vouching never counts.
  The root's own key is attested by the roster's genesis event.
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

### 4.4 Roster evaluation (deterministic, client-side)

Verifiers replay roster events in `createdAt` order (server-assigned; pinned by the
rules fork §9.2) with a pure reducer:

1. Genesis signer key = pinned root public key (cross-checked against the server-relayed
   registry pin, §6.2) — else the roster is invalid, full stop.
2. Every event's `ledger` field must equal the roster ledger ID (kills cross-ledger
   replay); duplicate action hashes are processed once (kills same-ledger replay).
3. `ATTEST` counts only if its **signer** is attested (or root) at that point and the
   subject key isn't revoked.
4. `GRANT_ROLE`/`REVOKE_ROLE`/`REVOKE_KEY` count only from the root key.
5. Output is a timeline, not just a final state: `stateAt(t)` returns
   `publicKey → {uid, name, roles[]}` as of server time `t`. **Claim events are judged
   against `stateAt(event.createdAt)`** — a signer must be attested (with the required
   role) *when they signed*; later revocation never retroactively voids earlier
   signatures (forward-only, matching charproof's revocation semantics). Paid claims
   therefore stay verifiable forever.

The reducer lives in a dependency-free client-safe module (`src/lib/esign/roster.ts`)
with the same unit-test discipline as `money.ts`.

### 4.5 Multi-device and key loss

- **Second device**: charproof's own flow — `requestDeviceAuthorization()` on the new
  device, 6-digit code compared between the member's own two devices,
  `approveDeviceAuthorization(d, {expectedVerificationCode})` on the old one. The AMK
  unlocks the keystore, which carries the roster identity → **no re-vouching**.
- **Lost device, recovery configured**: phrase or PRF recovery restores the AMK on a
  clean device; identity intact. `revokeDevice` rotates the AMK for remaining devices.
- **Lost device, no recovery** (plain members only, §4.2): enroll fresh (new identity
  key), get re-vouched next Sunday; root appends `REVOKE_KEY` for the old key. History
  signed by the old key remains valid per §4.4's `stateAt` rule.

## 5. Claim signature layer

### 5.1 Packet freezing and the per-hash archive

Today `POST …/pdf` regenerates the packet (with the current date, and pdf-lib stamps
fresh metadata, so bytes differ on every call) and overwrites
`generated/<userId>/<claimId>.pdf` — incompatible with hash binding. Changes:

- `GET /api/reimbursements/[id]/packet` serves the **currently stored** packet bytes to
  the owner while `generated` (and archived bytes once signed, §6.2) — the client never
  hashes regenerated bytes, only stored ones.
- **At submission** the client fetches the stored packet, hashes it, and signs that
  hash; the server independently hashes the same file and rejects on mismatch (409 —
  e.g. the user regenerated in another tab between fetch and submit; the UI retries the
  ceremony against the new bytes). On success the server copies the packet to an
  immutable archive: `signed/<userId>/<claimId>/<sha256>.pdf`.
- While `status ∈ {submitted, rejected, approved, paid}`, `POST …/pdf` returns **409**
  ("packet is frozen under signature"). Downloads go through `GET …/packet` or
  `/c/<token>` (which keeps serving the latest stored packet — unchanged while frozen).
- Archived signed packets are **never deleted**, even if the claim is later reverted,
  edited, regenerated, or deleted (UETA retention; mirrors the `ExtractionLog`
  outlives-the-claim pattern). Claim deletion must skip the `signed/` tree.

### 5.2 Canonical signable payloads

The envelope signs only the action (§3), so every action carries its own binding:
`ledger` (the claim ledger ID), `claimId`, `packetSha256`, a submission sequence `seq`,
and cross-references by action hash. `ts` is the signer's clock — kept for the UETA
record and display, never used for ordering or validity. `rowsDigest` = SHA-256 over
`canonicalStringify` of active rows `[{description, amountCents, ministry, event}]` in
sortOrder — it lets the certificate and verification page prove *contents*, not just
bytes, and verifiers recompute `totalCents` as the sum of row `amountCents`.

```jsonc
// Requestor — the submission signature (UETA §5.4 fields included).
// seq starts at 1 and increments on every SUBMIT for this claim (server-issued,
// embedded and signed here so verifiers don't consult the server).
{ "t": "SUBMIT", "v": 1, "ledger": "…", "ts": …, "seq": 1,
  "claimId": "…", "packetSha256": "…", "rowsDigest": "…", "totalCents": 12345,
  "requestorUid": "…", "approverUid": "…",
  "typedName": "Jane Doe", "consentVersion": "ueta-v1" }

// Approver — the decision signature. submitRef = action hash (§3) of the exact
// SUBMIT being answered; a decision never floats free of its submission.
{ "t": "APPROVE", "v": 1, "ledger": "…", "ts": …, "claimId": "…",
  "packetSha256": "…", "submitRef": "…", "approverUid": "…",
  "typedName": "John Smith", "consentVersion": "ueta-v1", "comment": "" }
{ "t": "REJECT",  "v": 1, "ledger": "…", "ts": …, "claimId": "…",
  "packetSha256": "…", "submitRef": "…", "approverUid": "…",
  "comment": "Receipt 2 is for the wrong ministry" }

// Treasurer — closes the loop; approveRef = action hash of the APPROVE it pays.
{ "t": "MARK_PAID", "v": 1, "ledger": "…", "ts": …, "claimId": "…",
  "packetSha256": "…", "approveRef": "…", "treasurerUid": "…",
  "typedName": "…", "checkNumber": "1042" }

// Requestor — optional honesty marker when reverting a submitted/rejected claim.
{ "t": "WITHDRAW", "v": 1, "ledger": "…", "ts": …, "claimId": "…",
  "packetSha256": "…", "seq": 1 }
```

### 5.3 Claim ledger lifecycle and validity rules

- On first submission the requestor's client runs `createLedgerSession()` → one ledger
  per claim, forever (resubmissions append to it). The client POSTs
  `{ledgerId, exportSessionKey()}` to the submit route; the server stores both on the
  claim and relays them to the assigned approver, the treasurer, and `/v/<token>`
  holders (decision 8). The server's claim→ledger mapping is the *pointer*; all
  validity below is judged inside the ledger itself.
- Every reader derives the allowlist from the roster (§4.4) and calls
  `setAuthorizedSigners`. Event-level validity, evaluated client-side:
  1. Envelope signature valid and signer key attested at `createdAt` (§4.4);
     `action.ledger` equals this ledger's ID; duplicate action hashes count once.
  2. `SUBMIT` — signer maps to `requestorUid` = the claim owner; `approverUid` holds
     the `approver` role and ≠ `requestorUid` (decision 6). The **authoritative SUBMIT**
     is the valid one with the highest `seq`; two distinct valid SUBMITs sharing a `seq`
     render the claim invalid (loud red — that only happens under key compromise).
  3. `APPROVE`/`REJECT` — signer maps to the `approverUid` named by the SUBMIT that
     `submitRef` points at, **and** that SUBMIT is the authoritative one; `packetSha256`
     must match it. A decision referencing a superseded SUBMIT is ignored — so a stale
     APPROVE can never be revived by resubmission, replay, or approver reassignment.
  4. `MARK_PAID` — signer holds `treasurer` role; `approveRef` resolves to a currently
     valid APPROVE.
- **Approval state is a pure function** of (archived packet hash, roster, claim ledger):
  a claim is *approved* iff the authoritative SUBMIT and a valid APPROVE exist for the
  hash of the currently archived packet. Hash binding makes edits self-voiding:
  revert → edit → regenerate produces a new hash and the old signatures simply stop
  matching (strict, per decision 7 — even a typo fix restarts the ceremony). `WITHDRAW`
  is best-effort record keeping, not the mechanism.
- Resubmission after rejection appends a fresh `SUBMIT` (same hash allowed, next `seq`,
  possibly a different approver, re-signed with a fresh ceremony).
- **Fail-closed countersigning**: before offering Approve/Reject, the approver's client
  must (a) verify the chain end-to-end, (b) fetch the archived bytes and check their
  hash equals the authoritative SUBMIT's `packetSha256` — the PDF rendered on screen is
  those exact verified bytes, so a server that swaps packets can't obtain a signature
  over its swap. Mark-paid applies the same discipline. A missing/invalid SUBMIT
  (e.g. a client that reported `submitted` to the server but never appended) blocks the
  ceremony and shows the discrepancy.

### 5.4 UETA/ESIGN ceremony (decision 11)

- **First use** (once per person, re-shown on text changes): consent to conduct these
  transactions electronically, that the typed name + cryptographic signature constitute
  a legal signature, and notice of the right to a paper process — versioned text kept
  in-repo (`src/lib/esign/consent.ts`, starting at `ueta-v1`) and recorded per §4.2.
- **Every signing dialog** (submit / approve / mark-paid):
  1. Shows the exact verified packet bytes inline and the claim summary recomputed from
     the `rowsDigest` inputs.
  2. Restates the one-line intent affirmation with a required checkbox
     ("I intend this to be my signature").
  3. Shows the signer's name **prefilled from their roster attestation**, editable —
     the typed string is recorded in the payload as `typedName`, not validated against
     the roster (UETA cares about intent; strict string matching only causes lockouts —
     the cryptographic identity does the proving).
  4. Signs, appends, then reports the mirror row (§5.5).

### 5.5 Ledger-first write order and mirror reconciliation

Ceremonies follow **preflight → append → report**:

1. `POST …/submit?preflight=1` (and equivalents) validates everything server-side
   (status, approver eligibility, hash match) *before* the client appends — so ledgers
   don't collect events for requests the server would refuse.
2. The client appends the ledger event.
3. The client reports `{eventId, action payload}`; the route is **idempotent on
   (claim, action hash)** — re-reporting after a crash is a no-op.

If the report is lost (step 3 crash), truth is ahead of the mirror. Every participant
view that verifies the ledger also **reconciles**: when it finds a valid event the
mirror lacks, it re-POSTs the report. The mirror can lag; it can never contradict a
verifying client silently — discrepancies render as warnings on `/v` and the queues.

## 6. Workflow

### 6.1 Status machine (extends `DATA_MODEL.md`)

```
draft ⇄ generated → submitted → approved → paid            (paid is terminal)
  ▲                    │  ▲         │
  │                    ▼  │(resubmit)
  └─────(revert)──── rejected
        (also from submitted / approved)
```

- `generated → submitted`: requestor's SUBMIT ceremony (archives the packet, records the
  chosen approver, increments `submitSeq`).
- `submitted → approved | rejected`: the assigned approver's decision. `rejected` stays
  frozen with the comment until the requestor resubmits or reverts (decision 7).
- `approved → paid`: treasurer's MARK_PAID. No revert from `paid`.
- **Revert** extends to `{generated, submitted, rejected, approved} → draft`; receipts
  release exactly as today. Signatures for the old hash void automatically (§5.3).
- Freezing needs no new enforcement: every line-item/claim mutation route is already
  draft-only, so the new statuses are frozen for free. The two routes that special-case
  `generated` change: `…/pdf` POST (409 while signed, §5.1) and `…/revert` (accepts the
  new statuses).
- Receipt statuses are untouched — `processed` still means "on ≥1 generated claim".
- **No notifications (decision 9), so the UI must surface state**: NavBar badge counts
  for approvers (pending decisions) and the treasurer (approved awaiting payment);
  status chips on claim cards for requestors.

### 6.2 New/changed API routes (all `handleApi` + `requireUserId` unless noted)

| Route | Methods | Behavior |
| :-- | :-- | :-- |
| `/api/esign/registry` | GET | roster `{ledgerId, key, rootPublicKey}` + my `SignerIdentity` status. **Key material only for enrolled users** (a `SignerIdentity` row exists); others get existence/status only. 404 until bootstrapped |
| | POST | one-time bootstrap by the root user (email = `ESIGN_ROOT_EMAIL`): stores registry, grants `role=admin`. Refuses a second row |
| `/api/esign/identity` | POST | begin enrollment: create my `SignerIdentity(pending)` and return the registry key material; later, PATCH-like re-POST records my roster public key once generated |
| `/api/esign/attest` | POST | voucher reports an appended ATTEST/role event `{subjectUserId, eventId}`; server re-tallies the mirror (client-verified truth stays in the roster) |
| `/api/esign/members` | GET | attested members (+roles) — feeds the vouch screen and approver picker. **Enrolled users only** (see registry gating) |
| `/api/reimbursements/[id]/submit` | POST | `?preflight=1` validates only. Full call: `{approverUserId, ledgerId, ledgerKey, packetSha256, typedName, eventId, payload}` → guards: status `generated∣rejected`, approver attested + role + ≠ self, server-recomputed hash == claimed hash → archive packet, `submitSeq`+1, status=`submitted`, `SignatureRecord`, AuditEvent(`submit`). Idempotent on action hash |
| `/api/reimbursements/[id]/decision` | POST | assigned approver only: `{decision, comment?, typedName, eventId, payload}` → status `approved∣rejected`, `SignatureRecord`, AuditEvent. Preflight + idempotency as above |
| `/api/reimbursements/[id]/paid` | POST | treasurer role: `{checkNumber?, typedName, eventId, payload}` → status `paid`, `SignatureRecord`, AuditEvent. Preflight + idempotency as above |
| `/api/reimbursements/[id]/packet` | GET | stored packet bytes while `generated`; archived bytes once signed (`?sha=` selects a version, default current) — owner, assigned approver, or treasurer |
| `/api/reimbursements/[id]/certificate` | GET | approval-certificate PDF (§7.1) — same access as `packet` |
| `/api/approvals` | GET | approver inbox: claims where `approverUserId = me`, `status="submitted"` (+ decided history). Detail view includes ledger key + receipt-overlap warnings (§6.4) |
| `/api/finance` | GET | treasurer queue: `status ∈ {approved, paid}`, with receipt-overlap warnings |
| `/v/[token]` | GET page | verification page (§7.2). Requires numbers sign-in (Firestore reads need Firebase auth anyway); the unguessable token authorizes access to this claim's packet, ledger key, and registry read, `/c`-style |

Enrollment gating note: numbers upserts a `User` for *any* verified Google sign-in
(existing posture), so registry keys and the member directory are withheld from
accounts that never started enrollment. This is an abuse dampener, not a security
boundary — see §8 (flooding) for why the boundary doesn't exist at the Firestore layer
either, and why that's acceptable.

### 6.3 Cross-tenant access (amendment to hard invariant 2)

The approver inbox, finance queue, `packet`, `certificate`, and `/v/<token>` are the
**only** places a claim is readable by a non-owner, each gated by an explicit grant:
being the claim's assigned approver, holding the treasurer role, or presenting the
capability token. Everything else keeps owner-only 404 semantics. Approvers review the
*packet* (form + receipt images are already inside it) — individual receipt routes stay
owner-only.

### 6.4 Duplicate-receipt guard

A receipt may legitimately join many claims (existing feature), which under paper
process is how double-reimbursement slips through. The approver detail and finance
queue therefore compute, per receipt on the claim: the sum of that receipt's line-item
`amountCents` across **all** claims in `{submitted, approved, paid}` vs the receipt's
`extractedTotalCents − extractedRefundCents`. Over-claiming or any overlap renders a
prominent warning with links (for the treasurer) to the overlapping claims. A warning,
not a block — legitimate cross-claim splits exist; the human judges (and their judgment
is what they sign).

## 7. Finance delivery & artifacts

### 7.1 Approval certificate (digital-primary, print-friendly — decision 10)

The signed inner packet can never be restamped (hash binding), so approval evidence
lives in a **certificate cover** prepended to it on download: claim summary (requestor,
approver, treasurer, totals via `centsToDollarString`), one UETA signature block per
event (typed name, `ts`, key fingerprint, event id, consent version), `packetSha256`
and `rowsDigest`, a QR to `/v/<token>`, and the consent text version in an appendix.
The template's `Approver Name`/`Approval Date` AcroForm fields on the inner pages stay
blank forever — the certificate replaces them.

The bundle is rebuilt on demand by the server **from the mirror**, so on its own it is
only as honest as the server; the QR is the pointer back to cryptographic truth, and
the embedded **verification bundle** makes it independently checkable:

- A PDF attachment `verification-bundle.json` embedding the raw roster events, the raw
  claim-ledger events (ciphertext + keys + envelope fields), the registry pin, and the
  archived packet's SHA-256.
- `scripts/verify-bundle.mjs` (Node WebCrypto, no Firestore, no server) re-runs the full
  §4.4/§5.3 verification against the bundle plus the packet bytes extracted from the
  same PDF. Financial records stay verifiable for the retention window (7+ years) even
  if Firestore, Firebase, or the app are gone.

### 7.2 Verification page `/v/<token>`

Client-side, from scratch, on every load: fetch registry → replay roster from the pinned
root (§4.4) → open the claim ledger read-only with the allowlist → fetch archived packet
bytes, hash in-browser, match against the authoritative SUBMIT → render per-signature
✓/✗ with names, roles, vouch chains, signer `ts`, and server `createdAt` (read directly
from the event docs alongside charproof's decryption). A red state (hash mismatch,
unattested signer, superseded submit, mirror disagreement) is loud. This page is the
audit tool; SQLite status never feeds it.

## 8. Attack scenarios & defenses

| Attack | Defense |
| :-- | :-- |
| Edit a claim after signatures (server, owner, or DB tamper) | Hash binding to archived bytes; regeneration blocked while signed; verification recomputes hashes from bytes (§5.1, §5.3) |
| Replay an old SUBMIT to re-route approval to a previously named approver | `seq` — authoritative SUBMIT is highest-seq valid; duplicates count once (§5.2) |
| Revive a stale APPROVE after revert/resubmit of identical bytes | `submitRef` pins a decision to one SUBMIT; superseded refs are ignored (§5.3) |
| Copy a signed envelope into another ledger (cross-claim/roster replay) | Every action embeds `ledger` + `claimId`; mismatches are invalid (§4.4, §5.3) |
| Backdate/forward-date events with a custom Firestore client | Rules fork pins `createdAt == request.time` and the exact document shape (§9.2) |
| Server swaps packet bytes shown to the approver | Fail-closed countersigning: the approve UI renders only bytes whose hash matches the verified SUBMIT (§5.3) |
| Server lies in the mirror (`status`, names) | Mirror is presentation-only; queues, `/v`, and certificates re-verify client-side; reconciliation surfaces divergence (§5.5, §7.2) |
| Forge a signer (mint a keypair, hold the shared ledger key) | `setAuthorizedSigners` from the roster; roster requires in-person vouches chained to the pinned root (§4.3–4.4) |
| Grind a keypair matching a victim's 6-digit vouch code | QR scan is the binding channel; the code is never sufficient (§4.3) |
| Voucher collusion (two members attest a fake person) | Accepted residual risk (decision 2); events are permanent, signed, and attributable — collusion leaves evidence |
| Stolen device / exfiltrated key | charproof `revokeDevice` (AMK rotation) + roster `REVOKE_KEY`; forward-only, historical events stand, `stateAt` keeps old signatures valid (§4.4–4.5) |
| Same receipt reimbursed twice across claims | Duplicate-receipt guard on approver/finance views (§6.4) |
| Ledger flooding / junk events (any Firebase-authed account can append — charproof's world-append design) | Invalid events are filtered client-side; reads are paginated/capped; registry gating dampens drive-by abuse; if it ever matters, a further rules fork can restrict event creation — accepted at church scale (§6.2, §9.2) |
| Requestor reports `submitted` without appending SUBMIT | Approver ceremony fails closed on missing/invalid SUBMIT — the lie only wedges the liar's claim (§5.3) |
| Firestore/Google disappears years later | Certificate-embedded verification bundle + offline verifier script (§7.1) |

Out of scope, stated honestly: malware on a signer's device (can sign as them until
revoked — mitigated by revocation + audit trail, not prevented), collusion between
requestor and approver (a human-process problem; thresholds were declined, decision 5),
and Google-account takeover of a signer (Firestore auth gates *access*; signatures
still require the device-held key, so takeover alone cannot sign — it can only read).

## 9. Data model & platform integration

### 9.1 SQLite changes (mirror + workflow)

New values `Reimbursement.status`: `submitted | rejected | approved | paid`. New columns:
`approverUserId?`, `signatureLedgerId?`, `signatureLedgerKey?`, `packetSha256?`,
`submitSeq Int @default(0)`, `submittedAt?`, `decidedAt?`, `paidAt?`, `checkNumber?`.

```prisma
model EsignRegistry {   // single row, written once at bootstrap
  id String @id @default(cuid())
  rosterLedgerId String
  rosterLedgerKey String
  rootPublicKey  String
  rootUserId     String
  consentVersion String  @default("ueta-v1")
  createdAt      DateTime @default(now())
}

model SignerIdentity {  // mirror of roster state, for pickers/badges only
  id        String @id @default(cuid())
  userId    String @unique
  publicKey String  @default("")        // filled once the roster keypair exists
  status    String @default("pending")  // pending | attested | revoked
  attestedAt DateTime?
  createdAt  DateTime @default(now())
}

model SignatureRecord { // mirror of claim-ledger events; outlives the claim
  id              String  @id @default(cuid())
  reimbursementId String? // SetNull on claim deletion (retention, like ExtractionLog)
  kind            String  // submit | approve | reject | paid | withdraw
  signerUserId    String
  signerPublicKey String
  typedName       String  @default("")
  packetSha256    String
  payloadJson     String  // the exact signed action (carries seq/refs/consent)
  actionHash      String  @unique       // idempotency key for reports (§5.5)
  ledgerEventId   String?
  createdAt       DateTime @default(now())
}
```

`User.role` (currently unread) becomes the role mirror: `member | approver | treasurer |
admin` — UI/queue authz only; the roster is the signed truth. Every transition writes an
AuditEvent (`submit`, `approve`, `reject`, `mark-paid`, `esign-consent` join the action
list) — invariant 7 extends to this trail. `ownershipToken` from `createLedgerSession`
is discarded: the keystore already syncs the requestor's credentials, and the server
holds the shareable key.

### 9.2 Firestore & rules (forked minimally)

- **Firebase client**: new `src/lib/firebase-client.ts` singleton initializing the app +
  Firestore on app pages from the same runtime-relayed config the sign-in page uses.
  Google sign-in already persists Firebase auth in IndexedDB; e-sign screens wait for
  `onAuthStateChanged` and, when the numbers cookie has outlived the Firebase session,
  prompt a re-auth popup before any ledger operation.
- **Rules**: start from charproof's `firestore.rules` (collection name `polls` is
  hardcoded upstream) with one hardening fork on event creation, kept in-repo at
  `firestore.rules` with a comment block explaining the delta:

```
allow create: if isSignedIn()
  && request.resource.data.keys().hasOnly(['eventId','createdAt','encryptedData','iv'])
  && request.resource.data.createdAt == request.time;   // serverTimestamp() only
```

  This preserves charproof compatibility (the library always writes
  `serverTimestamp()`) while denying custom clients the ability to backdate events —
  which the roster reducer's ordering and `stateAt` depend on. `chaff_pool/current` is
  never created; the event store is constructed with `decoyCount: 0`.
- **Config**: one new setting, `ESIGN_ROOT_EMAIL` (via `configValue()`, so
  `config.json`-overridable). The roster registry lives in SQLite, created by the
  bootstrap route (which **requires the root to complete the recovery-phrase ceremony
  before finishing** — the root key is the single point of trust, decision 1). The
  e-sign UI renders only when Firebase web config + a bootstrapped registry exist —
  deployments that never bootstrap keep today's flow untouched.
- **AUTH_TEST_MODE / tests**: test-login users have no Firebase identity → e-sign
  controls disabled unless emulator env is present. Unit tests inject fake stores via
  `setSessionProviders`/`initializeZK({cryptoProvider})` (charproof's own test seam) and
  hammer the roster reducer, payload validity rules, and the offline verifier. E2E adds
  a Firebase emulator-backed project (auth + Firestore) exercising enroll → vouch →
  submit → approve → pay → verify; budgeted as its own phase.

## 10. New invariants (graduate into CLAUDE.md as implemented)

1. **Signed packets are immutable**: once a claim leaves `generated`, its packet bytes
   are archived per-hash under `signed/…/<sha256>.pdf` and never regenerated,
   overwritten, or deleted (claim deletion included) — regeneration is only reachable
   through revert, which voids signatures by hash mismatch.
2. **Approval state is client-verified, fail-closed**: SQLite `status`/`SignatureRecord`
   are mirrors; any UI that countersigns or asserts validity must re-derive it from the
   roster + claim ledger in the browser and refuse on mismatch. The server never claims
   cryptographic truth.
3. **The numbers server never holds Firestore write credentials.**
4. **Signed actions are self-binding**: every payload carries `ledger`, `claimId`,
   `packetSha256`, and its `seq`/`submitRef`/`approveRef` linkage; verifiers never
   resolve authority from timestamps or the server. Roster rules (2 vouches or 1
   approver+, root-only role grants, `stateAt` role timing) are code in the shared
   client-safe module, exhaustively unit-tested.
5. Signed payloads carry money as **integer cents** and bind `packetSha256` +
   `rowsDigest`; every workflow transition writes its AuditEvent + SignatureRecord,
   idempotent on action hash.

## 11. Implementation phases

1. **Platform** — firebase-client bootstrap, Firestore enablement + forked rules
   deploy, charproof dependency, `ESIGN_ROOT_EMAIL`, feature gating. *Spike:
   keystore-seeded identity reuse across ledgers (§4.1); fall back to delegation events
   if brittle.*
2. **Identity** — registry bootstrap (root recovery ceremony), enable-signing wizard
   (consent → AMK → recovery → roster join), vouching ceremony + QR, roster reducer +
   `stateAt`, mirrors, members endpoint, registry gating.
3. **Submission & approval** — per-hash archive + packet GET, freeze/revert/pdf-route
   changes, submit ceremony (preflight/idempotent reports), approver inbox + fail-closed
   decision ceremony, duplicate-receipt guard, status machine + audit trail, badges.
4. **Finance & verification** — treasurer queue, mark-paid ceremony, certificate PDF
   with embedded verification bundle, offline verifier script, `/v/<token>` page,
   mirror reconciliation.
5. **Hardening** — device management UI, PRF recovery, emulator e2e suite, UETA consent
   text review, root-rotation ceremony doc, docs (`ARCHITECTURE`/`DATA_MODEL`/
   `CLAUDE.md` updates).

## 12. Risks & open items

- **Keystore identity reuse** (§4.1) is the one unproven charproof interaction — hence
  the phase-1 spike with a committed fallback (delegation events).
- **Roster availability**: the registry row (ledger ID + key) lives in SQLite on the
  `/data` volume; losing it without a backup means participants with keystore copies
  still function but new enrollments break. Covered by existing volume-backup practice;
  the registry is also recoverable from any enrolled client.
- **Root succession/compromise**: rotation = new roster genesis cross-signed by the old
  root (documented ceremony, phase 5); until then the root key is the single point of
  trust — per decision 1, accepted, with mandatory phrase backup at bootstrap.
- **UETA consent text** (`ueta-v1`) should get a once-over from someone who reads
  legalese before the feature is used in anger; payloads/certificates already capture
  consent version, typed name, and intent affirmation.
- **Safari IndexedDB eviction** can wipe device keys; the AMK keystore + phrase/PRF
  recovery is the mitigation, and worst case for a plain member is a re-vouch.
- **Ledger bloat** from the world-append rules is accepted at church scale (§8); revisit
  the rules if it ever matters.
- Firestore outages make e-sign actions unavailable (hard dependency accepted,
  decision 12); claim building/PDF generation continue to work without Firestore.
