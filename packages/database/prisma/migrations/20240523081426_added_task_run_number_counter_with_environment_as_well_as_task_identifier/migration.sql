-- CreateTable
CREATE TABLE "TaskRunNumberCounter" (
    "id" TEXT NOT NULL,
    "taskIdentifier" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TaskRunNumberCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunNumberCounter_taskIdentifier_environmentId_key" ON "TaskRunNumberCounter"("taskIdentifier", "environmentId");

-- AddForeignKey
ALTER TABLE "TaskRunNumberCounter" ADD CONSTRAINT "TaskRunNumberCounter_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
