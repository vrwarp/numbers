# E-signature & approval workflow — design

Status: **approved proposal, not yet implemented.** Decisions below were ratified by the
project owner (2026-07-11). This document is the implementation contract; the "New
invariants" section graduates into `CLAUDE.md` as phases land.

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
- **Tamper-evidence**: ledger events are append-only and immutable (enforced by
  charproof's Firestore security rules). Signatures bind to the SHA-256 of the exact
  generated packet bytes, so any after-the-fact edit is detectable by anyone re-running
  verification.
- **Server exclusion**: the numbers server holds **no Firestore write credentials**
  (`firebase-admin` stays keyless, projectId-only, used solely for ID-token
  verification). The server can relay ledger *read* keys (decision 8) but cannot forge,
  modify, or delete events — tamper-evidence holds even against a compromised app server.
- **Not secrecy**: ledger payloads are encrypted client-side as a side effect of using
  charproof, but confidentiality is not a goal. Keys are relayed to participants by the
  server and embedded in capability links.
- Authorship is verified **only client-side** (Firestore cannot check signatures — see
  charproof `SECURITY.md`). Every screen that displays approval state re-derives it from
  the ledgers in the browser; the SQLite mirror (§9) is a convenience cache, never proof.

## 3. charproof facts that shaped this design

Verified against charproof `2a61af5`:

- Ledgers live at `polls/{ledgerId}/events/{eventId}` (collection name hardcoded in
  `FirestoreLedgerEventStore`); events are ordered by a server-written `createdAt` and
  are append-only/immutable under the bundled `firestore.rules`.
- The event envelope is `{action, signature, publicKey}` — AES-GCM-encrypted with the
  ledger's symmetric key, signed with ECDSA over the canonicalized action
  (`canonicalStringify`). There is **no trusted timestamp**; signed payloads must carry
  their own `ts` (display/UETA record) and verifiers must not depend on clock honesty.
- Signing identities are **per-ledger**: `getLedgerSession(id, {shareableKey})` generates
  a fresh keypair for a new participant and stores it in the user's AMK-encrypted cloud
  keystore (`saveToKeystore`), which syncs it to all of that user's enrolled devices.
- Multi-writer authenticity requires `session.setAuthorizedSigners(keys)` — the
  allowlist is the application's job. This design derives it from the roster ledger (§5).
- Chaff/decoy writes only occur when `chaff_pool/current` exists. **We never create it**
  (and pass `decoyCount: 0`), so no chaff machinery, scheduled job, or admin credentials
  are needed. Plausible deniability is not a goal here.
- `getActiveAmk`, device enrollment with 6-digit out-of-band verification
  (`getLocalVerificationCode` / `approveDeviceAuthorization(d, {expectedVerificationCode})`),
  24-word phrase recovery (`setupPhraseRecovery`) and WebAuthn-PRF recovery are all
  public API and used as-is for enrollment/recovery UX.

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

1. **Charproof bootstrap** — `getActiveAmk()` genesis on the member's first device.
2. **Recovery ceremony** — display + confirm the 24-word phrase (`setupPhraseRecovery`);
   offer passkey recovery (`enablePrfRecovery`) where WebAuthn PRF is available.
3. **Join the roster** — `getLedgerSession(rosterLedgerId, {shareableKey})` (registry
   relayed by the server, §7.2) generates the member's identity keypair.
4. **Report** — POST the public key to the server (`SignerIdentity` mirror row,
   status `pending`), and show the vouching QR (§4.3).

The Submit/Approve/Mark-paid buttons prompt un-enrolled users into this wizard.

### 4.3 Vouching ceremony (in person)

- The candidate opens **My signing identity** → a QR encoding
  `{uid, email, name, publicKey}` plus a 6-digit code derived from the public key
  (charproof's `getVerificationCodeForPublicKey`), also shown as text.
- The voucher opens **Vouch for a member**, scans the QR (or types the code), confirms
  the person standing in front of them is who the screen says, compares the 6-digit code
  read aloud, and confirms. Their client appends to the roster:

```jsonc
{ "t": "ATTEST", "v": 1, "ts": 1760000000000,
  "subject": { "uid": "…", "email": "…", "name": "Jane Doe", "publicKey": "<b64 SPKI>" } }
```

- Attestation threshold (decision 2): a key becomes **attested** once it has ATTEST
  events from **two distinct attested members**, or **one** from a member holding the
  `approver`/`treasurer`/root role at that point in the log. The root's own key is
  attested by the genesis event.
- Vouching asserts identity only. Roles arrive as separate events, valid **only when
  signed by the root key** (v1; delegation to the treasurer is a later option):

```jsonc
{ "t": "GRANT_ROLE", "v": 1, "ts": …, "uid": "…", "role": "approver" }   // or "treasurer"
{ "t": "REVOKE_ROLE", "v": 1, "ts": …, "uid": "…", "role": "approver" }
{ "t": "REVOKE_KEY",  "v": 1, "ts": …, "publicKey": "…" }                // lost/compromised
```

### 4.4 Roster evaluation (deterministic, client-side)

Verifiers replay roster events in `createdAt` order with a pure reducer:

1. Genesis signer key = pinned root public key (cross-checked against the server-relayed
   registry pin, §7.2) — else the roster is invalid, full stop.
2. `ATTEST` counts only if its **signer** is attested (or root) at that point and the
   subject key isn't revoked. Self-vouching never counts.
3. `GRANT_ROLE`/`REVOKE_ROLE`/`REVOKE_KEY` count only from the root key.
4. Output: `publicKey → {uid, name, attestedAt, roles[]}` — the allowlist source for
   `setAuthorizedSigners` on every ledger and for role checks per event type.

The reducer lives in a dependency-free client-safe module (`src/lib/esign/roster.ts`)
with the same unit-test discipline as `money.ts`.

### 4.5 Multi-device and key loss

- **Second device**: charproof's own flow — `requestDeviceAuthorization()` on the new
  device, 6-digit code compared in person/on a call, `approveDeviceAuthorization` on the
  old one. The AMK unlocks the keystore, which carries the roster identity → **no
  re-vouching**.
- **Lost device, recovery configured**: phrase or PRF recovery restores the AMK on a
  clean device; identity intact. `revokeDevice` rotates the AMK for the remaining devices.
- **Lost device, no recovery**: the member enrolls fresh (new identity key) and gets
  re-vouched next Sunday; root appends `REVOKE_KEY` for the old key. History signed by
  the old key remains valid — revocation is forward-only.

## 5. Claim signature layer

### 5.1 Packet freezing and the per-hash archive

Today `POST …/pdf` regenerates the packet (with the current date) and overwrites
`generated/<userId>/<claimId>.pdf` on every call — incompatible with hash binding. Changes:

- **At submission** the server reads the stored packet, computes its SHA-256, and copies
  it to an immutable archive: `signed/<userId>/<claimId>/<sha256>.pdf`. The client
  independently hashes the bytes it fetched and signs *its own* hash; the submit route
  rejects on mismatch (409) — neither side trusts the other's digest.
- While `status ∈ {submitted, rejected, approved, paid}`, `POST …/pdf` returns **409**
  ("packet is frozen under signature"). Downloads go through `GET …/packet` (archived
  bytes) or `/c/<token>` (which keeps serving the latest stored packet — unchanged while
  frozen).
- Archived signed packets are **never deleted**, even if the claim is later reverted,
  edited, regenerated, or deleted (UETA retention; mirrors the `ExtractionLog` outlives-
  the-claim pattern).

### 5.2 Canonical signable payloads

All actions carry `v` (schema version), `ts` (signer's clock, for the record — ordering
never depends on it), and bind to the packet hash. Money is **integer cents** end to end
(invariant 1). `rowsDigest` = SHA-256 over the canonical JSON of active rows
`[{description, amountCents, ministry, event}]` in sortOrder — it lets the certificate
and verification page prove *contents*, not just bytes.

```jsonc
// Requestor — the submission signature (UETA §5.4 fields included)
{ "t": "SUBMIT", "v": 1, "ts": …,
  "claimId": "…", "packetSha256": "…", "rowsDigest": "…", "totalCents": 12345,
  "requestorUid": "…", "approverUid": "…",
  "typedName": "Jane Doe", "consentVersion": "ueta-v1" }

// Approver — the decision signature
{ "t": "APPROVE", "v": 1, "ts": …, "claimId": "…", "packetSha256": "…",
  "approverUid": "…", "typedName": "John Smith", "consentVersion": "ueta-v1",
  "comment": "" }
{ "t": "REJECT",  "v": 1, "ts": …, "claimId": "…", "packetSha256": "…",
  "approverUid": "…", "comment": "Receipt 2 is for the wrong ministry" }

// Treasurer — closes the loop
{ "t": "MARK_PAID", "v": 1, "ts": …, "claimId": "…", "packetSha256": "…",
  "treasurerUid": "…", "typedName": "…", "checkNumber": "1042" }

// Requestor — optional honesty marker when reverting a submitted/rejected claim
{ "t": "WITHDRAW", "v": 1, "ts": …, "claimId": "…", "packetSha256": "…" }
```

### 5.3 Claim ledger lifecycle and validity rules

- On first submission the requestor's client runs `createLedgerSession()` → one ledger
  per claim, forever (resubmissions append to it). The client POSTs
  `{ledgerId, exportSessionKey()}` to the submit route; the server stores both on the
  claim and relays them to the assigned approver, the treasurer, and `/v/<token>`
  holders (decision 8).
- Every reader derives the allowlist from the roster (§4.4) and calls
  `setAuthorizedSigners`. Event-level validity, evaluated client-side:
  - `SUBMIT` — signer key maps to `requestorUid` = the claim owner; `approverUid` has
    the `approver` role and ≠ `requestorUid` (decision 6).
  - `APPROVE`/`REJECT` — signer maps to the `approverUid` named by the **latest valid
    SUBMIT for the same `packetSha256`**; signer uid ≠ requestor uid.
  - `MARK_PAID` — signer holds `treasurer` role; a valid APPROVE for the same hash exists.
- **Approval state is a pure function** of (archived packet hash, roster, claim ledger):
  a claim is *approved* iff valid SUBMIT ∧ APPROVE exist for the hash of the currently
  archived packet. Hash binding makes edits self-voiding: revert → edit → regenerate
  produces a new hash, and the old signatures simply stop matching (strict, per
  decision 7 — even a typo fix restarts the ceremony). `WITHDRAW` is best-effort record
  keeping, not the mechanism.
- Resubmission after rejection appends a fresh `SUBMIT` (same hash, possibly a different
  approver, re-signed). "Latest valid SUBMIT" designates the current approver.

### 5.4 UETA/ESIGN ceremony (decision 11)

Every signing dialog (submit / approve / mark-paid):

1. Shows the exact archived packet (inline PDF) and the claim summary derived from
   `rowsDigest` inputs.
2. Presents the consent disclosure (versioned text, `consentVersion` in the payload):
   agreement to transact electronically, that the typed name + cryptographic signature
   constitute a legal signature, and the right to request a paper process.
3. Requires the signer to **type their full name** (must match their roster-attested
   name, case-insensitively) and tick "I intend this to be my signature."
4. Signs and appends the event, then reports the mirror row (§9) — which also preserves
   the consent record server-side for the retention file.

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
  chosen approver).
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

### 6.2 New/changed API routes (all `handleApi` + `requireUserId` unless noted)

| Route | Methods | Behavior |
| :-- | :-- | :-- |
| `/api/esign/registry` | GET | roster `{ledgerId, key, rootPublicKey}` + my `SignerIdentity` status. 404 until bootstrapped |
| | POST | one-time bootstrap by the root user (email = `ESIGN_ROOT_EMAIL`): stores registry, grants `role=admin` |
| `/api/esign/identity` | POST | report my roster public key → `SignerIdentity(pending)` |
| `/api/esign/attest` | POST | voucher reports an appended ATTEST/role event `{subjectUserId, eventId}`; server re-tallies the mirror (client-verified truth stays in the roster) |
| `/api/esign/members` | GET | attested members (+roles) — feeds the vouch screen and approver picker |
| `/api/reimbursements/[id]/submit` | POST | `{approverUserId, ledgerId, ledgerKey, packetSha256, typedName, eventId}` → guards: status `generated∣rejected`, approver attested + role + ≠ self, server-computed hash == client hash → archive packet, status=`submitted`, `SignatureRecord`, AuditEvent(`submit`) |
| `/api/reimbursements/[id]/decision` | POST | assigned approver only: `{decision, comment?, typedName, eventId, packetSha256}` → status `approved∣rejected`, `SignatureRecord`, AuditEvent |
| `/api/reimbursements/[id]/paid` | POST | treasurer role: `{checkNumber?, typedName, eventId, packetSha256}` → status `paid`, `SignatureRecord`, AuditEvent |
| `/api/reimbursements/[id]/packet` | GET | archived signed bytes (`?sha=` optional, default current) — owner, assigned approver, or treasurer |
| `/api/reimbursements/[id]/certificate` | GET | approval-certificate PDF (§8.1) — same access as `packet` |
| `/api/approvals` | GET | approver inbox: claims where `approverUserId = me`, `status="submitted"` (+ decided history) |
| `/api/finance` | GET | treasurer queue: `status ∈ {approved, paid}` |
| `/v/[token]` | GET page | verification page (§8.2). Requires numbers sign-in (Firestore reads need Firebase auth anyway); the unguessable token authorizes access to this claim's packet + ledger key, `/c`-style |

### 6.3 Cross-tenant access (amendment to hard invariant 2)

The approver inbox, finance queue, `packet`, `certificate`, and `/v/<token>` are the
**only** places a claim is readable by a non-owner, each gated by an explicit grant:
being the claim's assigned approver, holding the treasurer role, or presenting the
capability token. Everything else keeps owner-only 404 semantics. Approvers review the
*packet* (form + receipt images are already inside it) — individual receipt routes stay
owner-only.

## 7. Finance delivery & artifacts

### 7.1 Approval certificate (digital-primary, print-friendly — decision 10)

The signed inner packet can never be restamped (hash binding), so approval evidence
lives in a **certificate cover** prepended to it on download: claim summary (requestor,
approver, treasurer, totals in `centsToDollarString` form), one UETA signature block per
event (typed name, `ts`, key fingerprint, event id, consent version), `packetSha256` and
`rowsDigest`, a QR to `/v/<token>`, and the full manifest JSON embedded as a PDF
attachment so the artifact is self-describing offline. The bundle is rebuilt on demand
from the mirror; the QR is the pointer back to cryptographic truth. The template's
`Approver Name`/`Approval Date` AcroForm fields on the inner pages stay blank forever —
the certificate replaces them.

### 7.2 Verification page `/v/<token>`

Client-side, from scratch, on every load: fetch registry → replay roster from the pinned
root (§4.4) → open the claim ledger read-only with the allowlist → fetch archived packet
bytes, hash in-browser, match against events → render per-signature ✓/✗ with names,
roles, vouch chains, and timestamps. A red state (hash mismatch, unattested signer,
broken chain) is loud. This page is the audit tool; SQLite status never feeds it.

## 8. Data model changes (SQLite mirror)

New values `Reimbursement.status`: `submitted | rejected | approved | paid`. New columns:
`approverUserId?`, `signatureLedgerId?`, `signatureLedgerKey?`, `packetSha256?`,
`submittedAt?`, `decidedAt?`, `paidAt?`, `checkNumber?`.

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
  publicKey String
  status    String @default("pending") // pending | attested | revoked
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
  payloadJson     String  // the exact signed action, for the retention file
  ledgerEventId   String?
  createdAt       DateTime @default(now())
}
```

`User.role` (currently unread) becomes the role mirror: `member | approver | treasurer |
admin` — UI/queue authz only; the roster is the signed truth. Every transition writes an
AuditEvent (`submit`, `approve`, `reject`, `mark-paid` join the existing action list) —
invariant 7 extends to this trail.

Honest framing: mirror writes trust the reporting participant's client. Cryptographic
verification happens in the browser at every approval/finance/verification render. If
server-side verification is ever wanted, a read-only admin-SDK verifier can be added
without changing this design — deliberately out of scope for v1.

## 9. Platform integration

- **Firebase client**: new `src/lib/firebase-client.ts` singleton initializing the app +
  Firestore on app pages from the same runtime-relayed config the sign-in page uses.
  Google sign-in already persists Firebase auth in IndexedDB; e-sign screens wait for
  `onAuthStateChanged` and, when the numbers cookie has outlived the Firebase session,
  prompt a silent re-auth popup before any ledger operation.
- **Rules**: deploy charproof's `firestore.rules` verbatim (collection name `polls` is
  hardcoded upstream; cosmetic, not worth forking). Enable Firestore in the existing
  Firebase project. Never create `chaff_pool/current`; construct the event store with
  `decoyCount: 0`.
- **Config**: one new setting, `ESIGN_ROOT_EMAIL` (via `configValue()`, so
  `config.json`-overridable). Roster registry lives in SQLite, created by the bootstrap
  route. The e-sign UI renders only when Firebase web config + a bootstrapped registry
  exist — deployments that never bootstrap keep today's flow untouched.
- **AUTH_TEST_MODE / tests**: test-login users have no Firebase identity → e-sign
  controls disabled unless emulator env is present. Unit tests inject fake stores via
  `setSessionProviders`/`initializeZK({cryptoProvider})` (charproof's own test seam) and
  hammer the roster reducer + payload validity rules. E2E adds a Firebase
  emulator-backed project (auth + Firestore) exercising enroll → vouch → submit →
  approve → pay → verify; budgeted as its own phase.

## 10. New invariants (graduate into CLAUDE.md as implemented)

1. **Signed packets are immutable**: once a claim leaves `generated`, its packet bytes
   are archived per-hash under `signed/…/<sha256>.pdf` and never regenerated,
   overwritten, or deleted — regeneration is only reachable through revert, which voids
   signatures by hash mismatch.
2. **Approval state is client-verified**: SQLite `status`/`SignatureRecord` are mirrors;
   any UI asserting a signature's validity must derive it from the roster + claim ledger
   in the browser. The server never claims cryptographic truth.
3. **The numbers server never holds Firestore write credentials.**
4. **Roster rules are code, not convention**: attestation (2 vouches or 1 approver+),
   root-only role grants, and per-event validity live in the shared client-safe module
   with exhaustive unit tests.
5. Signed payloads carry money as **integer cents** and bind `packetSha256` +
   `rowsDigest`; every workflow transition writes its AuditEvent + SignatureRecord.

## 11. Implementation phases

1. **Platform** — firebase-client bootstrap, Firestore enablement + rules deploy,
   charproof dependency, `ESIGN_ROOT_EMAIL`, feature gating. *Spike: keystore-seeded
   identity reuse across ledgers (§4.1); fall back to delegation events if brittle.*
2. **Identity** — registry bootstrap, enable-signing wizard (AMK + recovery + roster
   join), vouching ceremony + QR, roster reducer, mirrors, members endpoint.
3. **Submission & approval** — per-hash archive, freeze/revert/pdf-route changes, submit
   ceremony, approver inbox, decision ceremony, status machine + audit trail.
4. **Finance & verification** — treasurer queue, mark-paid ceremony, certificate PDF,
   `/v/<token>` page.
5. **Hardening** — device management UI, PRF recovery, emulator e2e suite, UETA consent
   text review, docs (`ARCHITECTURE`/`DATA_MODEL`/`CLAUDE.md` updates).

## 12. Risks & open items

- **Keystore identity reuse** (§4.1) is the one unproven charproof interaction — hence
  the phase-1 spike with a committed fallback.
- **Event ordering** trusts Firestore's `createdAt` for roster replay. Append-only rules
  prevent rewriting history, but a hostile Firestore could reorder inserts; acceptable
  at this trust level (Google is already the auth provider). Signed `ts` fields make
  gross reordering visible.
- **Safari IndexedDB eviction** can wipe device keys; the AMK keystore + phrase/PRF
  recovery is the mitigation, and worst case is a re-vouch (cheap at church scale).
- **Root succession/compromise**: the root's phrase backup is mandatory at bootstrap.
  Rotation = new roster genesis cross-signed by the old root (documented ceremony,
  phase 5 doc work); until then the root key is the single point of trust — per
  decision 1, accepted.
- **UETA consent text** should get a once-over from someone who reads legalese before
  the feature is used in anger; the payloads/certificate already capture consent
  version, typed name, and intent affirmation.
- Firestore outages make e-sign actions unavailable (hard dependency accepted,
  decision 12); claim building/PDF generation continue to work offline from Firestore.
