-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PositionHolder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "positionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "PositionHolder_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PositionHolder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Ministry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "defaultPositionId" TEXT,
    CONSTRAINT "Ministry_defaultPositionId_fkey" FOREIGN KEY ("defaultPositionId") REFERENCES "Position" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Ministry" ("active", "code", "createdAt", "description", "group", "id", "name", "sortOrder", "updatedAt") SELECT "active", "code", "createdAt", "description", "group", "id", "name", "sortOrder", "updatedAt" FROM "Ministry";
DROP TABLE "Ministry";
ALTER TABLE "new_Ministry" RENAME TO "Ministry";
CREATE INDEX "Ministry_active_sortOrder_idx" ON "Ministry"("active", "sortOrder");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Position_active_sortOrder_idx" ON "Position"("active", "sortOrder");

-- CreateIndex
CREATE INDEX "PositionHolder_userId_idx" ON "PositionHolder"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PositionHolder_positionId_userId_key" ON "PositionHolder"("positionId", "userId");
