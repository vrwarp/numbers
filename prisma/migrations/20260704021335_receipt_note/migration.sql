-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Receipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unassigned',
    "note" TEXT NOT NULL DEFAULT '',
    "merchant" TEXT NOT NULL DEFAULT '',
    "purchaseDate" TEXT NOT NULL DEFAULT '',
    "extractedTotalCents" INTEGER,
    "extractedRefundCents" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Receipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Receipt" ("createdAt", "extractedRefundCents", "extractedTotalCents", "filePath", "id", "merchant", "mimeType", "originalName", "purchaseDate", "sizeBytes", "status", "userId") SELECT "createdAt", "extractedRefundCents", "extractedTotalCents", "filePath", "id", "merchant", "mimeType", "originalName", "purchaseDate", "sizeBytes", "status", "userId" FROM "Receipt";
DROP TABLE "Receipt";
ALTER TABLE "new_Receipt" RENAME TO "Receipt";
CREATE INDEX "Receipt_userId_status_idx" ON "Receipt"("userId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
