-- CreateTable
CREATE TABLE "TicketCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unused',
    "usedAt" DATETIME,
    "usedOrderId" TEXT,
    "reservedPrizeId" TEXT,
    "reservationExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Prize" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "reservedByCode" TEXT,
    "reservedUntil" DATETIME,
    "claimedByCode" TEXT,
    "claimedOrderId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "TicketCode_code_key" ON "TicketCode"("code");
