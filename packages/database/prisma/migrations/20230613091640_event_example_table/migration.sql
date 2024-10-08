-- CreateTable
CREATE TABLE "EventExample" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "jobVersionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventExample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventExample_slug_jobVersionId_key" ON "EventExample"("slug", "jobVersionId");

-- AddForeignKey
ALTER TABLE "EventExample" ADD CONSTRAINT "EventExample_jobVersionId_fkey" FOREIGN KEY ("jobVersionId") REFERENCES "JobVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
