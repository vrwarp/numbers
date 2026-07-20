-- AlterTable
ALTER TABLE "ExtractionLog" ADD COLUMN "receiptId" TEXT;

-- CreateTable
CREATE TABLE "ExtractionJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiptId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" DATETIME,
    "lastError" TEXT NOT NULL DEFAULT '',
    "failedFileSha256" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Receipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "originalFilePath" TEXT,
    "mimeType" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unassigned',
    "note" TEXT NOT NULL DEFAULT '',
    "merchant" TEXT NOT NULL DEFAULT '',
    "purchaseDate" TEXT NOT NULL DEFAULT '',
    "extractedTotalCents" INTEGER,
    "extractedRefundCents" INTEGER,
    "extractedSummary" TEXT NOT NULL DEFAULT '',
    "annotatedAt" DATETIME,
    "annotationSource" TEXT NOT NULL DEFAULT '',
    "fileSha256" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Receipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Receipt" ("createdAt", "extractedRefundCents", "extractedTotalCents", "filePath", "fileSha256", "id", "merchant", "mimeType", "note", "originalFilePath", "originalName", "purchaseDate", "sizeBytes", "status", "userId") SELECT "createdAt", "extractedRefundCents", "extractedTotalCents", "filePath", "fileSha256", "id", "merchant", "mimeType", "note", "originalFilePath", "originalName", "purchaseDate", "sizeBytes", "status", "userId" FROM "Receipt";
DROP TABLE "Receipt";
ALTER TABLE "new_Receipt" RENAME TO "Receipt";
CREATE INDEX "Receipt_userId_status_idx" ON "Receipt"("userId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionJob_receiptId_key" ON "ExtractionJob"("receiptId");

-- CreateIndex
CREATE INDEX "ExtractionJob_status_priority_nextAttemptAt_idx" ON "ExtractionJob"("status", "priority", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ExtractionJob_userId_status_idx" ON "ExtractionJob"("userId", "status");

-- CreateIndex
CREATE INDEX "ExtractionLog_receiptId_idx" ON "ExtractionLog"("receiptId");
