-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ExtractionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "reimbursementId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'receipt',
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "receiptsJson" TEXT,
    "rawResponse" TEXT,
    "parsedJson" TEXT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExtractionLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExtractionLog_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "Reimbursement" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ExtractionLog" ("createdAt", "durationMs", "errorMessage", "id", "model", "parsedJson", "prompt", "rawResponse", "receiptsJson", "reimbursementId", "status", "userId") SELECT "createdAt", "durationMs", "errorMessage", "id", "model", "parsedJson", "prompt", "rawResponse", "receiptsJson", "reimbursementId", "status", "userId" FROM "ExtractionLog";
DROP TABLE "ExtractionLog";
ALTER TABLE "new_ExtractionLog" RENAME TO "ExtractionLog";
CREATE INDEX "ExtractionLog_userId_createdAt_idx" ON "ExtractionLog"("userId", "createdAt");
CREATE INDEX "ExtractionLog_reimbursementId_idx" ON "ExtractionLog"("reimbursementId");
CREATE TABLE "new_Reimbursement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "singleMinistry" BOOLEAN NOT NULL DEFAULT true,
    "claimMinistry" TEXT NOT NULL DEFAULT '',
    "claimEvent" TEXT NOT NULL DEFAULT '',
    "claimDescription" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Reimbursement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Reimbursement" ("createdAt", "id", "status", "totalCents", "updatedAt", "userId") SELECT "createdAt", "id", "status", "totalCents", "updatedAt", "userId" FROM "Reimbursement";
DROP TABLE "Reimbursement";
ALTER TABLE "new_Reimbursement" RENAME TO "Reimbursement";
CREATE INDEX "Reimbursement_userId_status_idx" ON "Reimbursement"("userId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Pre-existing claims keep their current per-row behavior: only claims created
-- after this migration default to single-ministry mode.
UPDATE "Reimbursement" SET "singleMinistry" = false;
