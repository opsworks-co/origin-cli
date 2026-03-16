-- Add structured scoring fields to SessionReview
ALTER TABLE "SessionReview" ADD COLUMN "score" INTEGER;
ALTER TABLE "SessionReview" ADD COLUMN "riskLevel" TEXT;
ALTER TABLE "SessionReview" ADD COLUMN "concerns" TEXT;
ALTER TABLE "SessionReview" ADD COLUMN "suggestions" TEXT;
ALTER TABLE "SessionReview" ADD COLUMN "categories" TEXT;
ALTER TABLE "SessionReview" ADD COLUMN "isAutoReview" BOOLEAN NOT NULL DEFAULT false;
