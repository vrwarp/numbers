/*
  Warnings:

  - You are about to drop the column `originalQuantity` on the `LineItem` table. All the data in the column will be lost.
  - You are about to drop the column `quantity` on the `LineItem` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LineItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reimbursementId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "ministry" TEXT NOT NULL DEFAULT '',
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isExcluded" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "originalDescription" TEXT,
    "originalAmountCents" INTEGER,
    CONSTRAINT "LineItem_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "Reimbursement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LineItem_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_LineItem" ("amountCents", "description", "id", "isExcluded", "isVerified", "ministry", "originalAmountCents", "originalDescription", "receiptId", "reimbursementId", "sortOrder") SELECT "amountCents", "description", "id", "isExcluded", "isVerified", "ministry", "originalAmountCents", "originalDescription", "receiptId", "reimbursementId", "sortOrder" FROM "LineItem";
DROP TABLE "LineItem";
ALTER TABLE "new_LineItem" RENAME TO "LineItem";
CREATE INDEX "LineItem_reimbursementId_idx" ON "LineItem"("reimbursementId");
CREATE TABLE "new_Receipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unassigned',
    "merchant" TEXT NOT NULL DEFAULT '',
    "purchaseDate" TEXT NOT NULL DEFAULT '',
    "extractedTotalCents" INTEGER,
    "extractedRefundCents" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Receipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Receipt" ("createdAt", "filePath", "id", "mimeType", "originalName", "sizeBytes", "status", "userId") SELECT "createdAt", "filePath", "id", "mimeType", "originalName", "sizeBytes", "status", "userId" FROM "Receipt";
DROP TABLE "Receipt";
ALTER TABLE "new_Receipt" RENAME TO "Receipt";
CREATE INDEX "Receipt_userId_status_idx" ON "Receipt"("userId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
