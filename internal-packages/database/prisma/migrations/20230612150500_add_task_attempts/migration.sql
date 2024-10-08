-- CreateEnum
CREATE TYPE "TaskAttemptStatus" AS ENUM ('PENDING', 'STARTED', 'COMPLETED', 'ERRORED');

-- CreateTable
CREATE TABLE "TaskAttempt" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "taskId" TEXT NOT NULL,
    "status" "TaskAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "runAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskAttempt_taskId_number_key" ON "TaskAttempt"("taskId", "number");

-- AddForeignKey
ALTER TABLE "TaskAttempt" ADD CONSTRAINT "TaskAttempt_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
