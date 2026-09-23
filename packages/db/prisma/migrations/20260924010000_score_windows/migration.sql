-- When a match map's current run opened for play, and whether its scores are closed.
ALTER TABLE "MatchMap"
  ADD COLUMN "runOpenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "scoresClosedAt" TIMESTAMP(3);

-- Maps already played opened when they were picked.
UPDATE "MatchMap" SET "runOpenedAt" = "createdAt";
-- A finished match's maps are closed.
UPDATE "MatchMap" SET "scoresClosedAt" = m."completedAt"
  FROM "Match" m WHERE m."id" = "MatchMap"."matchId" AND m."state" = 'COMPLETE';
