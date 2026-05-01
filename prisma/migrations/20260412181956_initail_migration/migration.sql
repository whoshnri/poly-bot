-- CreateEnum
CREATE TYPE "TaskAction" AS ENUM ('START_TRADE', 'END_TRADE', 'WAIT', 'SKIP');

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "pages" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionStage" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "todo" TEXT NOT NULL,
    "taskAction" "TaskAction" NOT NULL,
    "nextWake" TIMESTAMP(3) NOT NULL,
    "prevStageId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionStage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionStage_sessionId_createdAt_idx" ON "SessionStage"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "SessionStage_sessionId_nextWake_idx" ON "SessionStage"("sessionId", "nextWake");

-- CreateIndex
CREATE UNIQUE INDEX "SessionStage_sessionId_sequence_key" ON "SessionStage"("sessionId", "sequence");

-- AddForeignKey
ALTER TABLE "SessionStage" ADD CONSTRAINT "SessionStage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionStage" ADD CONSTRAINT "SessionStage_prevStageId_fkey" FOREIGN KEY ("prevStageId") REFERENCES "SessionStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
