-- CreateTable
CREATE TABLE "CurrentEnvironment" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurrentEnvironment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CurrentEnvironment_workflowId_userId_key" ON "CurrentEnvironment"("workflowId", "userId");

-- AddForeignKey
ALTER TABLE "CurrentEnvironment" ADD CONSTRAINT "CurrentEnvironment_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrentEnvironment" ADD CONSTRAINT "CurrentEnvironment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrentEnvironment" ADD CONSTRAINT "CurrentEnvironment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
