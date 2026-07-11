/**
 * UETA/ESIGN consent text (docs/ESIGN_DESIGN.md §5.4). The exact text is a
 * signed input: its SHA-256 travels inside every UETA payload as
 * `consentSha256`, so what the signer was shown is cryptographically part of
 * the record. Changing one character REQUIRES bumping the version.
 * Client-safe, dependency-free (hashing lives in canonical.ts).
 */

export const CONSENT_VERSION = "ueta-v1";

export const CONSENT_TEXT = `Electronic Records and Signatures Consent (${CONSENT_VERSION})

By continuing you agree that:
1. You consent to conduct reimbursement submissions, approvals, and payment
   records for this church electronically, under the Uniform Electronic
   Transactions Act (UETA) and the federal ESIGN Act.
2. The name you type, together with the cryptographic signature created by
   your enrolled device, constitutes your legal signature, made with intent
   to sign the specific reimbursement packet shown to you.
3. Signed records are retained electronically and remain verifiable; you may
   request a copy of any packet you signed.
4. You may withdraw this consent for future transactions at any time by
   using the paper reimbursement process instead — the church treasurer
   accepts printed forms; withdrawal does not affect records already signed.
5. To sign electronically you need a device with a modern browser; if you
   lose access to your enrolled device, you may re-enroll and be re-vouched.

I intend the signature created in this ceremony to be my signature.`;

export const INTENT_AFFIRMATION = "I intend this to be my signature.";
