-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EsignRegistry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rosterLedgerId" TEXT NOT NULL,
    "rosterLedgerKey" TEXT NOT NULL,
    "rootPublicKey" TEXT NOT NULL,
    "rootUserId" TEXT NOT NULL,
    "consentVersion" TEXT NOT NULL DEFAULT 'ueta-v1',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT NOT NULL DEFAULT 'allowlist',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_EsignRegistry" ("consentVersion", "createdAt", "enabled", "id", "rootPublicKey", "rootUserId", "rosterLedgerId", "rosterLedgerKey") SELECT "consentVersion", "createdAt", "enabled", "id", "rootPublicKey", "rootUserId", "rosterLedgerId", "rosterLedgerKey" FROM "EsignRegistry";
DROP TABLE "EsignRegistry";
ALTER TABLE "new_EsignRegistry" RENAME TO "EsignRegistry";
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "firebaseUid" TEXT,
    "email" TEXT NOT NULL,
    "fullName" TEXT,
    "mailingAddress" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "esignAllowed" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("createdAt", "email", "firebaseUid", "fullName", "id", "locale", "mailingAddress", "role") SELECT "createdAt", "email", "firebaseUid", "fullName", "id", "locale", "mailingAddress", "role" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
