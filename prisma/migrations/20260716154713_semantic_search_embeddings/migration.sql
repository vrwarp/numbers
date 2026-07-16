-- CreateTable
CREATE TABLE "EmbeddingSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "endpoint" TEXT NOT NULL DEFAULT '',
    "apiKey" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "dim" INTEGER NOT NULL DEFAULT 0,
    "queryPrefix" TEXT NOT NULL DEFAULT '',
    "minScoreMilli" INTEGER NOT NULL DEFAULT 250,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Embedding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "vector" BLOB NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EmbeddingJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" DATETIME,
    "lastError" TEXT NOT NULL DEFAULT '',
    "failedSourceSha256" TEXT NOT NULL DEFAULT '',
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
    "fileSha256" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Receipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Receipt" ("createdAt", "extractedRefundCents", "extractedTotalCents", "filePath", "id", "merchant", "mimeType", "note", "originalFilePath", "originalName", "purchaseDate", "sizeBytes", "status", "userId") SELECT "createdAt", "extractedRefundCents", "extractedTotalCents", "filePath", "id", "merchant", "mimeType", "note", "originalFilePath", "originalName", "purchaseDate", "sizeBytes", "status", "userId" FROM "Receipt";
DROP TABLE "Receipt";
ALTER TABLE "new_Receipt" RENAME TO "Receipt";
CREATE INDEX "Receipt_userId_status_idx" ON "Receipt"("userId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Embedding_model_userId_idx" ON "Embedding"("model", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Embedding_kind_targetId_model_key" ON "Embedding"("kind", "targetId", "model");

-- CreateIndex
CREATE INDEX "EmbeddingJob_status_priority_nextAttemptAt_idx" ON "EmbeddingJob"("status", "priority", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmbeddingJob_userId_status_idx" ON "EmbeddingJob"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EmbeddingJob_kind_targetId_model_key" ON "EmbeddingJob"("kind", "targetId", "model");
