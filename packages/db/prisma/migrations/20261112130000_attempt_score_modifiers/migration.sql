-- The score a recorded clear became, and whether its modifiers have been read from that score (BeatLeader
-- leaves them off the run itself).
ALTER TABLE "Attempt" ADD COLUMN "beatLeaderScoreId" INTEGER;
ALTER TABLE "Attempt" ADD COLUMN "modifiersChecked" BOOLEAN NOT NULL DEFAULT false;

-- Have the worker read everyone's runs again on its next pass, which fills in the score ids on the runs already stored.
UPDATE "Player" SET "attemptsSyncedAt" = NULL WHERE "attemptsPublic" = true;
