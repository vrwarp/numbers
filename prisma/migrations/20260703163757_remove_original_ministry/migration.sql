/*
  Warnings:

  - You are about to drop the column `originalMinistry` on the `LineItem` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LineItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reimbursementId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" REAL NOT NULL DEFAULT 1,
    "amountCents" INTEGER NOT NULL,
    "ministry" TEXT NOT NULL DEFAULT '',
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isExcluded" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "originalDescription" TEXT,
    "originalQuantity" REAL,
    "originalAmountCents" INTEGER,
    CONSTRAINT "LineItem_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "Reimbursement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LineItem_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_LineItem" ("amountCents", "description", "id", "isExcluded", "isVerified", "ministry", "originalAmountCents", "originalDescription", "originalQuantity", "quantity", "receiptId", "reimbursementId", "sortOrder") SELECT "amountCents", "description", "id", "isExcluded", "isVerified", "ministry", "originalAmountCents", "originalDescription", "originalQuantity", "quantity", "receiptId", "reimbursementId", "sortOrder" FROM "LineItem";
DROP TABLE "LineItem";
ALTER TABLE "new_LineItem" RENAME TO "LineItem";
CREATE INDEX "LineItem_reimbursementId_idx" ON "LineItem"("reimbursementId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
