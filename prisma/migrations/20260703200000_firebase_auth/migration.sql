-- Firebase Auth migration: the identity column now stores the Firebase UID
-- instead of the Google OAuth subject. Rename in place to keep existing rows.
ALTER TABLE "User" RENAME COLUMN "googleId" TO "firebaseUid";
DROP INDEX "User_googleId_key";
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");
