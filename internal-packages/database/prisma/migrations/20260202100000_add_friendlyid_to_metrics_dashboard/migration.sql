-- AlterTable
ALTER TABLE "public"."MetricsDashboard" ADD COLUMN "friendlyId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "MetricsDashboard_friendlyId_key" ON "public"."MetricsDashboard"("friendlyId");
