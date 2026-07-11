-- CreateTable
CREATE TABLE "EsignAccountKeys" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "doc" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EsignPendingDevice" (
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("userId", "deviceId")
);

-- CreateTable
CREATE TABLE "EsignKeystoreEntry" (
    "userId" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "entry" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("userId", "docId")
);
