-- What someone who knows the player expects them to score on a map they have
-- not played. Overrides the model, which only knows what BeatLeader knows.
CREATE TABLE "PredictionEstimate" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "leaderboardId" TEXT NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "setById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PredictionEstimate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PredictionEstimate_tournamentId_playerId_leaderboardId_key" ON "PredictionEstimate"("tournamentId", "playerId", "leaderboardId");

ALTER TABLE "PredictionEstimate" ADD CONSTRAINT "PredictionEstimate_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PredictionEstimate" ADD CONSTRAINT "PredictionEstimate_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PredictionEstimate" ADD CONSTRAINT "PredictionEstimate_leaderboardId_fkey" FOREIGN KEY ("leaderboardId") REFERENCES "Leaderboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PredictionEstimate" ADD CONSTRAINT "PredictionEstimate_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
