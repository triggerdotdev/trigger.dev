-- CreateTable
CREATE TABLE "TaskRunCounter" (
    "taskIdentifier" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TaskRunCounter_pkey" PRIMARY KEY ("taskIdentifier")
);
