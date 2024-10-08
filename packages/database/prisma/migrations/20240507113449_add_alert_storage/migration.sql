-- CreateTable
CREATE TABLE "ProjectAlertStorage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "alertChannelId" TEXT NOT NULL,
    "alertType" "ProjectAlertType" NOT NULL,
    "storageId" TEXT NOT NULL,
    "storageData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAlertStorage_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ProjectAlertStorage" ADD CONSTRAINT "ProjectAlertStorage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAlertStorage" ADD CONSTRAINT "ProjectAlertStorage_alertChannelId_fkey" FOREIGN KEY ("alertChannelId") REFERENCES "ProjectAlertChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
