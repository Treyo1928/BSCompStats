-- Every run BeatLeader recorded for a player on a map, not only their best clear.
CREATE TYPE "AttemptEnd" AS ENUM ('UNKNOWN', 'CLEAR', 'FAIL', 'RESTART', 'QUIT', 'PRACTICE');

ALTER TABLE "Player" ADD COLUMN "attemptsPublic" BOOLEAN;
ALTER TABLE "Player" ADD COLUMN "attemptsCheckedAt" TIMESTAMP(3);
ALTER TABLE "Player" ADD COLUMN "attemptsSyncedAt" TIMESTAMP(3);

CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "leaderboardId" TEXT NOT NULL,
    "beatLeaderAttemptId" INTEGER NOT NULL,
    "endType" "AttemptEnd" NOT NULL,
    "time" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "baseScore" INTEGER NOT NULL,
    "modifiers" TEXT NOT NULL DEFAULT '',
    "missedNotes" INTEGER NOT NULL DEFAULT 0,
    "badCuts" INTEGER NOT NULL DEFAULT 0,
    "replayUrl" TEXT,
    "timeset" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Attempt_beatLeaderAttemptId_key" ON "Attempt"("beatLeaderAttemptId");
CREATE INDEX "Attempt_playerId_leaderboardId_idx" ON "Attempt"("playerId", "leaderboardId");
CREATE INDEX "Attempt_leaderboardId_idx" ON "Attempt"("leaderboardId");

ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_leaderboardId_fkey" FOREIGN KEY ("leaderboardId") REFERENCES "Leaderboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
