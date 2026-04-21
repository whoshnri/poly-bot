/*
  Warnings:

  - You are about to drop the column `taskAction` on the `SessionStage` table. All the data in the column will be lost.
  - Added the required column `sessionAction` to the `SessionStage` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "SessionAction" AS ENUM ('START_TRADE', 'END_TRADE', 'WAIT', 'SKIP');

-- AlterTable
ALTER TABLE "SessionStage" DROP COLUMN "taskAction",
ADD COLUMN     "sessionAction" "SessionAction" NOT NULL;

-- DropEnum
DROP TYPE "TaskAction";
