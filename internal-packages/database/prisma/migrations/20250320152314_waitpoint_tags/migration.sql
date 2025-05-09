-- AlterTable
ALTER TABLE "Waitpoint" ADD COLUMN     "waitpointTags" TEXT[];

-- CreateTable
CREATE TABLE "WaitpointTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitpointTag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaitpointTag_environmentId_name_key" ON "WaitpointTag"("environmentId", "name");

-- AddForeignKey
ALTER TABLE "WaitpointTag" ADD CONSTRAINT "WaitpointTag_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitpointTag" ADD CONSTRAINT "WaitpointTag_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
