-- CreateTable
CREATE TABLE
    "public"."MetricsDashboard" (
        "id" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "organizationId" TEXT NOT NULL,
        "projectId" TEXT,
        "ownerId" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        "layout" TEXT NOT NULL,
        CONSTRAINT "MetricsDashboard_pkey" PRIMARY KEY ("id")
    );

-- CreateIndex
CREATE INDEX "MetricsDashboard_projectId_createdAt_idx" ON "public"."MetricsDashboard" ("projectId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "public"."MetricsDashboard" ADD CONSTRAINT "MetricsDashboard_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MetricsDashboard" ADD CONSTRAINT "MetricsDashboard_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MetricsDashboard" ADD CONSTRAINT "MetricsDashboard_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;