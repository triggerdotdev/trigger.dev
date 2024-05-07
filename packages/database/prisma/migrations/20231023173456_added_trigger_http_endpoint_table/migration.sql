-- CreateTable
CREATE TABLE "TriggerHttpEndpoint" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "immediateResponseFilter" JSONB,
    "title" TEXT,
    "icon" TEXT,
    "properties" JSONB,
    "secretReferenceId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriggerHttpEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TriggerHttpEndpoint_key_environmentId_key" ON "TriggerHttpEndpoint"("key", "environmentId");

-- AddForeignKey
ALTER TABLE "TriggerHttpEndpoint" ADD CONSTRAINT "TriggerHttpEndpoint_secretReferenceId_fkey" FOREIGN KEY ("secretReferenceId") REFERENCES "SecretReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerHttpEndpoint" ADD CONSTRAINT "TriggerHttpEndpoint_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerHttpEndpoint" ADD CONSTRAINT "TriggerHttpEndpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
