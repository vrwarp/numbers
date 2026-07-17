-- CreateTable
CREATE TABLE "SearchHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SearchHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "firebaseUid" TEXT,
    "email" TEXT NOT NULL,
    "fullName" TEXT,
    "mailingAddress" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "esignAllowed" BOOLEAN NOT NULL DEFAULT false,
    "approvalsPaused" BOOLEAN NOT NULL DEFAULT false,
    "financePaused" BOOLEAN NOT NULL DEFAULT false,
    "adminPaused" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "printIncludeReceipts" BOOLEAN NOT NULL DEFAULT false,
    "printIncludeCertificate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("adminPaused", "approvalsPaused", "createdAt", "email", "esignAllowed", "financePaused", "firebaseUid", "fullName", "id", "locale", "mailingAddress", "role") SELECT "adminPaused", "approvalsPaused", "createdAt", "email", "esignAllowed", "financePaused", "firebaseUid", "fullName", "id", "locale", "mailingAddress", "role" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "SearchHistory_userId_updatedAt_idx" ON "SearchHistory"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SearchHistory_userId_query_key" ON "SearchHistory"("userId", "query");
