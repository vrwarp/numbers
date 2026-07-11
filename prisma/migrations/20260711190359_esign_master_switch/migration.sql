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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_EsignRegistry" ("consentVersion", "createdAt", "id", "rootPublicKey", "rootUserId", "rosterLedgerId", "rosterLedgerKey") SELECT "consentVersion", "createdAt", "id", "rootPublicKey", "rootUserId", "rosterLedgerId", "rosterLedgerKey" FROM "EsignRegistry";
DROP TABLE "EsignRegistry";
ALTER TABLE "new_EsignRegistry" RENAME TO "EsignRegistry";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
