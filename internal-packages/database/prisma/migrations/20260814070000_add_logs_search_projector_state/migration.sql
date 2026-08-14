-- CreateTable
CREATE TABLE "public"."LogsSearchProjectorState" (
    "id" TEXT NOT NULL,
    "liveWatermark" TIMESTAMP(3) NOT NULL,
    "historicalWatermark" TIMESTAMP(3) NOT NULL,
    "backfillTarget" TIMESTAMP(3),
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogsSearchProjectorState_pkey" PRIMARY KEY ("id")
);
