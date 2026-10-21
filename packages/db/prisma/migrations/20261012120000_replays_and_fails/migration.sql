-- Which runs of a replayed map count: the team's best run together
-- (BEST_PAIR) or each player's own best (BEST_EACH).
ALTER TABLE "Tournament" ADD COLUMN "replayCounting" TEXT NOT NULL DEFAULT 'BEST_PAIR';
ALTER TABLE "Match" ADD COLUMN "replayCounting" TEXT NOT NULL DEFAULT 'BEST_PAIR';

-- Whether a failed run counts doubled back from No Fail's halving. Off:
-- a fail counts as scored. Existing matches take the new rule too.
ALTER TABLE "Tournament" ADD COLUMN "doubleFailedRuns" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Match" ADD COLUMN "doubleFailedRuns" BOOLEAN NOT NULL DEFAULT false;
