# Multi-device plan — e-sign identity across a member's devices

Status: **plan, not yet implemented.** Companion to `docs/ESIGN_DESIGN.md` §4.5 (the
ratified behavior) and §11 phase 5 (where this work sits). Reference implementation
of the UX: [LetUsMeet](https://github.com/vrwarp/LetUsMeet) (`frontend/src/hooks/useAuth.ts`,
`components/Layout.tsx`), which ships this exact charproof ceremony in production.

## 1. Goal and non-goals

**Goal.** A member's attested signing identity follows them onto a second device (and
survives a lost one) without re-vouching, using charproof's AMK/keystore machinery:
enroll phone → approve from laptop with a typed 6-digit code → phone signs immediately,
still attested, because the vouched *key* (not the device) is the identity.

**Non-goals.**
- No change to roster rules, thread validity, signed payload shapes, or
  `scripts/verify-bundle.mjs`. Devices are transport; the protocol never sees them.
  (Guardrail G1 below.)
- No sharing an identity between *people* — that's vouching, not device sync.
- No server-side key custody. The numbers server stays keyless (design §2).
- Camera QR scanning stays a separate deferred item; device pairing uses the typed
  code, which two devices in the same hands make trivially easy.

## 2. What we already have

| Piece | State |
|---|---|
| `KeyCustody` interface (`src/lib/esign/custody.ts`) | Done — `ensureIdentity`/`getLedgerKey`/`saveLedgerKey`/root-pin |
| `CharproofKeyCustody` | Implemented, type-checked, **never exercised** (needs Firebase) |
| Roster-identity-in-keystore seeding (design §4.1) | Implemented in `CharproofKeyCustody.saveLedgerKey` |
| charproof primitives | All shipped in v1.0.8: AMK keyring, blinded keystore, pending-device docs, 6-digit codes with `expectedVerificationCode` enforcement, phrase + WebAuthn-PRF recovery, `revokeDevice` (AMK rotation), **`setDeviceServiceProviders()` injection** |
| Drawn signature (ink) | Server-side (`SignerIdentity.signatureImage`), hash-bound in payloads — syncs for free, nothing to do |
| TOFU root pin | Per-device by design (§4.6) — must NOT sync; each device re-verifies the anchor |
| Mock mode | `LocalKeyCustody` = this-browser IndexedDB only; no device story at all |

## 3. Architecture decisions

- **D1 — one custody code path; mock only at the store boundary.**
  charproof's `setDeviceServiceProviders({accountKeyStore, localDeviceStore, authProvider})`
  lets us run its *real* device/keystore logic against injected persistence. We
  implement `SqliteAccountKeyStore` (a client-side adapter calling new mock-only
  numbers API routes) + `NumbersAuthProvider` (session user, no Firebase), keep the
  default IndexedDB `LocalDeviceStore`, and use `CharproofKeyCustody` in **both**
  modes. `LocalKeyCustody` is deleted once parity is proven (M1 exit). This mirrors
  the mock ledger store philosophy: identical protocol code, swapped persistence —
  the ceremony we e2e-test in the sandbox is the ceremony production runs.
- **D2 — identity semantics unchanged (guardrail G1).** The vouches attest one ECDSA
  key; every device signs with that same key via keystore sync. Zero diffs allowed in
  `roster.ts`, `validity.ts`, payload shapes, or the offline verifier. Any PR touching
  those under this plan is wrong by definition.
- **D3 — typed code, not eyeballed.** The approving device requires the user to *type*
  the 6 digits shown on the new device; we always pass `expectedVerificationCode` so
  approval hard-fails on mismatch (§4.5). LetUsMeet displays both codes for visual
  comparison only — we deliberately go stricter, since approving wraps the AMK (and
  with it the signing key) to the pending public key.
- **D4 — mock store semantics match Firestore's.** Per-user isolation via
  `requireUserId()`; 404 unless `ESIGN_MOCK=1`; atomic create-if-absent for genesis
  (unique-constraint insert), Prisma interactive transactions for
  `transactAccountKeys`/`transactApproveDevice`; subscriptions become short-interval
  polling in the adapter (dev-only, fine). Keystore doc IDs arrive already blinded —
  the server stores opaque strings either way.
- **D5 — master switch applies (amendment A5).** Device routes take
  `requireEnabledRegistry()`; device UI renders only when `env.enabled`. Verification
  surfaces remain open as always.
- **D6 — two-severity revocation.** "Remove this device" (retired/wiped) =
  `revokeDevice` alone: AMK rotates, remaining devices re-wrapped, historical AMKs
  keep old keystore entries readable. "Someone else may have it" (stolen, possibly
  unlocked) = `revokeDevice` **plus** the §4.5 lost-key path: report to the root in
  person, root signs `REVOKE_KEY` (root-only in the v1 roster rules — keep it that
  way), member re-enrolls a fresh key and gets re-vouched. History signed by the old
  key stays valid per `stateAt` (§4.4). The UI must make the second option scary and
  the first one boring.
- **D7 — root redundancy is not optional-feeling.** Root key loss without recovery =
  new registry (documented catastrophe, design §12). Bootstrap and the root's device
  page nudge hard: add a second device AND phrase/passkey recovery immediately;
  offer a printable recovery sheet.
- **D8 — Firebase auth dependency is prod-only.** charproof's Firestore store needs a
  live `request.auth.uid`, but numbers signs out of Firebase after login. The
  existing phase-1 platform item `ensureFirebaseAuth()` (design §9.2) is a hard
  prerequisite for M5 only; M1–M4 run entirely on the mock store with the numbers
  session as the auth provider.

## 4. Phases

### M1 — providers & plumbing (foundation)

- `NumbersAuthProvider` (wraps the loaded `EsignEnv` user; `isAnonymous: false`).
- `SqliteAccountKeyStore` client adapter + mock routes under
  `/api/esign/device-sync/*` (see §5): account-keys doc, pending devices, keystore
  entries, all `ESIGN_MOCK`-gated + `requireEnabledRegistry`.
- `custody.ts`: mock mode wires `setDeviceServiceProviders(...)` instead of
  `initializeZK(...)`; `getCustody()` returns `CharproofKeyCustody` for both backends;
  delete `LocalKeyCustody` (mock DBs are throwaway — no migration, document the reset).
- **Exit criteria:** full existing walkthrough (`data/walkthrough.mjs`) passes
  unchanged on charproof custody in mock mode; unit tests for the adapter's atomic
  create + transaction semantics (model on charproof's own
  `core/__tests__/deviceService.integration.test.ts`).

### M2 — "new device" enrollment UX

State detection: server says this member is attested (`env.me.identityStatus`) but
custody has no identity for the roster → the profile card (and any ceremony dialog)
shows **"This looks like a new device"** instead of the enroll wizard, with paths in
priority order:

1. **Silent recovery** — `verifyAmk()` first; a synced passkey (PRF) may unlock with
   one biometric prompt and zero friction.
2. **Approve from your other device** — `requestDeviceAuthorization()`, show the
   6-digit code + "waiting…" (subscribe to own pending doc; auto-continue on
   approval, LetUsMeet's `subscribeCurrentDeviceStatus` pattern).
3. **Recovery phrase** — 24 words → `recoverAmkWithPhrase` + `registerCurrentDevice`.
4. **Start over** (last resort, collapsed): warns plainly that it mints a new key,
   requires re-vouching, and that they should tell the admin so the old key gets
   revoked (D6).

- **Exit criteria:** Playwright two-context test — enroll+vouch Alice on context A,
  open context B, run path 2 end-to-end (typed code on A), then B completes a real
  submit ceremony with the *same* fingerprint A had. Assert no new roster events.

### M3 — approval surface & device management

- **Pending-device banner** on authenticated pages (LetUsMeet `Layout.tsx` pattern):
  "«Chrome on a Mac» wants to sign as you" + code input + Approve/Reject.
  Approve calls `approveDeviceAuthorization(req, {expectedVerificationCode: typed})`.
  Test ids: `device-request-banner`, `device-code-input`, `approve-device`,
  `reject-device`.
- **"Your devices" panel** in the profile card (visible when enabled + enrolled):
  decrypted device names (small local helper around the account-keys doc +
  `getAmkById` — consider upstreaming to charproof later), this-device marker,
  added dates, and the two D6 actions.
- Root's member list (vouch screen) gains a root-only `REVOKE_KEY` button per member
  key for the compromised-device report (currently revocation exists only as a roster
  rule with no UI).
- **Exit criteria:** e2e — revoke context B from A: B's next ceremony fails closed
  with a clear "this device was signed out of signing" state; A still signs; the
  claim thread verifies throughout. Compromised path: root revokes the key, B's
  re-enroll produces a pending identity again, old claim signatures still VERIFIED
  by the offline verifier.

### M4 — recovery setup

- Post-enrollment nudge card: set up the phrase (show 24 words, confirm 3 random
  words back) and/or a passkey (`enablePrfRecovery`, behind feature detection).
  Dismissible for members; sticky until done for the root (D7), plus a printable
  recovery sheet from the bootstrap flow.
- PRF in CI: use a Playwright virtual authenticator where supported, else skip —
  phrase recovery is the deterministic, headless-testable path (LetUsMeet keeps a
  `mockPrfProvider` for exactly this; charproof accepts an injected `PrfProvider`).
- **Exit criteria:** e2e — fresh context C recovers Alice's identity with the phrase
  alone (no device B online), signs successfully; walkthrough gains shots of the
  new-device screen, banner + code entry, and devices panel; artifact updated.

### M5 — live Firestore validation (with the existing phase-5 platform work)

- `ensureFirebaseAuth()` (D8), merge charproof's `firestore.rules` paths for
  `accountKeys`/`pendingDevices`/keystore into our forked rules + extend
  `scripts/check-rules.mjs` canary.
- Manual two-device smoke on a real Firebase project (phone + laptop), then the
  emulator e2e suite from design §11.5.
- Runbook page in `docs/agent/PLAYBOOKS.md`: enroll/approve/revoke/recover, root
  recovery drill.

## 5. Mock device-sync store (M1 detail)

Prisma additions (mock-only tables, but migrations ship like any other):

```
EsignAccountKeys   userId (pk) · doc Json · updatedAt
EsignPendingDevice userId · deviceId (pk composite) · data Json · status · updatedAt
EsignKeystoreEntry userId · docId (pk composite) · entry Json · updatedAt
```

Routes (all `handleApi` + `requireUserId` + `requireEnabledRegistry`, 404 unless
`ESIGN_MOCK=1`; bodies are opaque JSON — keystore doc IDs and payloads arrive
pre-blinded/pre-encrypted from the client exactly as they would hit Firestore):

```
GET/PUT           /api/esign/device-sync/account-keys      (?create=1 → atomic create-if-absent)
POST              /api/esign/device-sync/account-keys/txn  (compare-and-swap by updatedAt for transactAccountKeys)
GET/PUT/DELETE    /api/esign/device-sync/pending/[deviceId]
GET               /api/esign/device-sync/pending           (list; adapter polls ~1.5s for "subscriptions")
GET/PUT           /api/esign/device-sync/keystore/[docId]
```

The adapter implements charproof's `AccountKeyStore` interface 1:1; optimistic
concurrency (CAS on `updatedAt`) stands in for Firestore transactions — retry loop in
the adapter, same observable semantics for the genesis race and concurrent approvals.
Trust note: the mock store trusts the numbers server by construction; that's fine —
it exists to exercise client logic, and production custody rides Firestore under
charproof's own rules.

## 6. Test plan

- **Unit:** store adapter (atomic create, CAS retry, per-user isolation); code
  mismatch → `VERIFICATION_CODE_MISMATCH` surfaces as a friendly error; keystore
  reads through historical AMKs after a rotation.
- **E2E (Playwright, multi-context):** M2/M3/M4 exit-criteria scenarios above, plus:
  device UI absent while the master switch is off; pending request rejected → new
  device shows the denied state and can retry.
- **Walkthrough & artifact:** 3 new screens (new-device, banner + typed code,
  devices panel); keep the offline-verifier segment — it must stay green across
  enroll-second-device and revoke flows since the protocol is untouched (G1).

## 7. Risks

| Risk | Mitigation |
|---|---|
| charproof API drift under us | Pin the version (already exact in package.json); the injected interfaces (`AccountKeyStore`, `AuthProvider`, `PrfProvider`) are the contract — adapter unit tests fail loudly on change |
| WebAuthn/PRF flaky in headless CI | Phrase recovery is the tested path; PRF behind feature detect + virtual authenticator/skip (M4) |
| Safari IndexedDB eviction wipes device keys | Already a design §12 item — AMK keystore + recovery covers keys; worst case for a plain member is re-vouch |
| Genesis race, two tabs | charproof handles it; the mock store must implement `createAccountKeys` atomically (unique insert) — covered by M1 unit tests |
| Approver taps Approve without comparing | D3 makes the typed code mandatory — there is no approve-without-code path |
| Root loses their only device mid-rollout | D7 sticky nudge + recovery sheet; runbook drill in M5 |
| Stolen unlocked device holds extractable identity key | D6 compromised path (AMK rotation + root `REVOKE_KEY` + re-vouch); forward-only by design |

## 8. Open questions (defaults chosen, revisit if wrong)

1. **Self-service `REVOKE_KEY`?** Default: stay root-only (v1 rule). An in-person
   report to the root fits the trust model and keeps the roster reducer untouched.
2. **Banner scope**: app-wide on authenticated pages (default, matches LetUsMeet) vs
   profile-only. App-wide wins because approval is time-sensitive — the member is
   standing there holding both devices.
3. **Device nicknames**: default to charproof's UA-derived name; rename-in-place can
   come later (pure UI, name is AMK-encrypted anyway).
4. **Upstream a `getAuthorizedDevices()` helper to charproof** vs decrypt locally.
   Default: local helper first, upstream once stable.

## 9. Sequencing & size

M1 → M2 → M3 → M4 are each independently shippable behind `ESIGN_MOCK` (rough sizes:
M1 ≈ adapter + routes + parity run; M2/M3 ≈ the bulk of the UI; M4 small). M5 rides
the existing phase-5 Firebase work and is the only phase needing credentials. Nothing
in M1–M4 blocks other e-sign work; G1 keeps the verifier and protocol frozen
throughout.
