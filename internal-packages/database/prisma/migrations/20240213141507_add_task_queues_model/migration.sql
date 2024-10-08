-- CreateEnum
CREATE TYPE "TaskQueueType" AS ENUM ('VIRTUAL', 'NAMED');

-- CreateTable
CREATE TABLE "TaskQueue" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TaskQueueType" NOT NULL DEFAULT 'VIRTUAL',
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "concurrencyLimit" INTEGER,
    "rateLimit" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskQueue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskQueue_friendlyId_key" ON "TaskQueue"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskQueue_runtimeEnvironmentId_name_key" ON "TaskQueue"("runtimeEnvironmentId", "name");

-- AddForeignKey
ALTER TABLE "TaskQueue" ADD CONSTRAINT "TaskQueue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskQueue" ADD CONSTRAINT "TaskQueue_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
