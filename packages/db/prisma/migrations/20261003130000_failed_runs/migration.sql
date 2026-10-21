-- A failed run's score, doubled back from No Fail's halving.
ALTER TABLE "MatchMapAttempt" ADD COLUMN "failed" BOOLEAN NOT NULL DEFAULT false;
