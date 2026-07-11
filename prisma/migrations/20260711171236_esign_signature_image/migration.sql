-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SignerIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL DEFAULT '',
    "signatureImage" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attestedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignerIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SignerIdentity" ("attestedAt", "createdAt", "id", "publicKey", "status", "userId") SELECT "attestedAt", "createdAt", "id", "publicKey", "status", "userId" FROM "SignerIdentity";
DROP TABLE "SignerIdentity";
ALTER TABLE "new_SignerIdentity" RENAME TO "SignerIdentity";
CREATE UNIQUE INDEX "SignerIdentity_userId_key" ON "SignerIdentity"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
