-- CreateTable
CREATE TABLE "EnvironmentVariable" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvironmentVariable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvironmentVariableValue" (
    "id" TEXT NOT NULL,
    "valueReferenceId" TEXT,
    "variableId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvironmentVariableValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentVariable_projectId_key_key" ON "EnvironmentVariable"("projectId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentVariableValue_variableId_environmentId_key" ON "EnvironmentVariableValue"("variableId", "environmentId");

-- AddForeignKey
ALTER TABLE "EnvironmentVariable" ADD CONSTRAINT "EnvironmentVariable_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvironmentVariableValue" ADD CONSTRAINT "EnvironmentVariableValue_valueReferenceId_fkey" FOREIGN KEY ("valueReferenceId") REFERENCES "SecretReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvironmentVariableValue" ADD CONSTRAINT "EnvironmentVariableValue_variableId_fkey" FOREIGN KEY ("variableId") REFERENCES "EnvironmentVariable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvironmentVariableValue" ADD CONSTRAINT "EnvironmentVariableValue_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
