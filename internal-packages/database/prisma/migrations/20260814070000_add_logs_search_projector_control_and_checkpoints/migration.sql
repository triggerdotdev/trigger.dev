-- CreateTable
CREATE TABLE "public"."LogsSearchProjectorControl" (
    "id" TEXT NOT NULL,
    "initialWatermark" TIMESTAMP(3) NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogsSearchProjectorControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LogsSearchProjectorCheckpoint" (
    "id" BIGSERIAL NOT NULL,
    "projectorId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "queryId" TEXT,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogsSearchProjectorCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LogsSearchProjectorCheckpoint_projectorId_mode_windowStart_windowEnd_key"
ON "public"."LogsSearchProjectorCheckpoint"("projectorId", "mode", "windowStart", "windowEnd");

-- CreateIndex
CREATE INDEX "LogsSearchProjectorCheckpoint_projectorId_mode_windowEnd_idx"
ON "public"."LogsSearchProjectorCheckpoint"("projectorId", "mode", "windowEnd" DESC);
