/**
 * The canonical Firestore security rules, embedded as a string so the server
 * can diff the deployed rules against them and (with an ephemeral admin key)
 * redeploy them — without depending on `firestore.rules` being present on disk
 * at runtime (the `output: "standalone"` Docker image doesn't ship it).
 *
 * `firestore.rules` at the repo root stays the SOURCE OF TRUTH — it's what
 * `firebase deploy` and `scripts/check-rules.mjs` use. This constant is a build
 * artifact kept in lock-step by tests/unit/firestore-rules-source.test.ts,
 * which fails (showing both versions) if the file and this copy ever diverge.
 */

export const FIRESTORE_RULES_SOURCE = `rules_version = '2';

// Numbers e-sign Firestore rules — charproof's reference ruleset with ONE
// hardening fork (docs/ESIGN_DESIGN.md §9.2): event creates must carry the
// exact 4-field document shape with a server-assigned timestamp
// (\`createdAt == request.time\`, i.e. serverTimestamp()), denying custom
// clients the ability to backdate events. Roster replay order and stateAt
// role timing depend on this. Deploy with:
//
//   firebase deploy --only firestore:rules
//
// then run \`node scripts/check-rules.mjs\` (backdated-write canary) — a rules
// deploy is NOT done until the canary is denied. Never create
// \`chaff_pool/current\`: chaff stays disabled.

service cloud.firestore {
  match /databases/{database}/documents {

    function isSignedIn() {
      return request.auth != null;
    }

    // Per-user zero-knowledge key material (charproof keystore) — owner-only.
    match /users/{uid}/{document=**} {
      allow read, write: if isSignedIn() && request.auth.uid == uid;
    }

    // Chaff pool: read-only and intentionally never written (no chaff here).
    match /chaff_pool/{docId} {
      allow read: if isSignedIn();
      allow write: if false;
    }

    // Shared, link-accessible ledgers (ciphertext; keys travel out-of-band).
    match /polls/{ledgerId} {
      allow read: if isSignedIn();
      allow create: if isSignedIn();
      allow update, delete: if false;

      match /events/{eventId} {
        allow read: if isSignedIn();
        // FORK: exact shape + server-assigned createdAt only.
        allow create: if isSignedIn()
          && request.resource.data.keys().hasOnly(['eventId', 'createdAt', 'encryptedData', 'iv'])
          && request.resource.data.eventId == eventId
          && request.resource.data.createdAt == request.time;
        allow update, delete: if false;
      }
    }
  }
}
`;

/** Normalize for comparison: LF line endings, no trailing horizontal space,
 *  no leading/trailing blank lines. Comments are KEPT — a deployment that
 *  replaced the rules with a different (e.g. permissive) ruleset must read as
 *  drift, so we compare the real source, not a stripped skeleton. */
export function normalizeRules(source: string): string {
  return source.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Do two rule sources match once normalized? */
export function rulesMatch(a: string, b: string): boolean {
  return normalizeRules(a) === normalizeRules(b);
}
