-- Match manager: match points, scores pulled from BeatLeader, and who may do what.

ALTER TABLE "Tournament"
  ADD COLUMN "captainsPullScores" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "captainsCreateMatches" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "matchScoring" TEXT NOT NULL DEFAULT 'ACCURACY',
  ADD COLUMN "scoringLocked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pointsCurve" JSONB,
  ADD COLUMN "perfectFromBeatLeader" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "scorePull" JSONB;

ALTER TABLE "PoolMap" ADD COLUMN "perfectAcc" DOUBLE PRECISION;

ALTER TABLE "Match"
  ADD COLUMN "scoring" TEXT NOT NULL DEFAULT 'ACCURACY',
  ADD COLUMN "pointsCurve" JSONB;

ALTER TABLE "MatchMapAttempt"
  ADD COLUMN "beatLeaderAttemptId" INTEGER,
  ADD COLUMN "endType" TEXT,
  ADD COLUMN "timeset" INTEGER;
