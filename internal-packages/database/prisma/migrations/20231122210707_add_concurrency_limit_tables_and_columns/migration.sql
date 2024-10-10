-- AlterTable
ALTER TABLE "JobRun" ADD COLUMN     "concurrencyLimitGroupId" TEXT;

-- AlterTable
ALTER TABLE "JobVersion" ADD COLUMN     "concurrencyLimit" INTEGER,
ADD COLUMN     "concurrencyLimitGroupId" TEXT;

-- CreateTable
CREATE TABLE "ConcurrencyLimitGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "concurrencyLimit" INTEGER NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConcurrencyLimitGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConcurrencyLimitGroup_environmentId_name_key" ON "ConcurrencyLimitGroup"("environmentId", "name");

-- AddForeignKey
ALTER TABLE "JobVersion" ADD CONSTRAINT "JobVersion_concurrencyLimitGroupId_fkey" FOREIGN KEY ("concurrencyLimitGroupId") REFERENCES "ConcurrencyLimitGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConcurrencyLimitGroup" ADD CONSTRAINT "ConcurrencyLimitGroup_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_concurrencyLimitGroupId_fkey" FOREIGN KEY ("concurrencyLimitGroupId") REFERENCES "ConcurrencyLimitGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
