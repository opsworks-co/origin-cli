-- AlterTable
ALTER TABLE "Commit" ADD COLUMN "additions" INTEGER;
ALTER TABLE "Commit" ADD COLUMN "deletions" INTEGER;
ALTER TABLE "Commit" ADD COLUMN "fileCount" INTEGER;
