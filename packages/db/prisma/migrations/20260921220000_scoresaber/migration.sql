-- ScoreSaber: profile figures on the player, and their scores in a table of their own.
ALTER TABLE "Player" ADD COLUMN "ssPp" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Player" ADD COLUMN "ssRank" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Player" ADD COLUMN "ssCountryRank" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Player" ADD COLUMN "ssRankedPlayCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Player" ADD COLUMN "ssAvgRankedAcc" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Player" ADD COLUMN "ssSyncedAt" TIMESTAMP(3);
ALTER TABLE "Player" ADD COLUMN "ssCheckedAt" TIMESTAMP(3);
ALTER TABLE "Player" ADD COLUMN "ssBackfilledAt" TIMESTAMP(3);
ALTER TABLE "Player" ADD COLUMN "ssOptOut" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ScoreSaberScore" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "ssLeaderboardId" INTEGER NOT NULL,
    "songHash" TEXT NOT NULL,
    "difficultyValue" INTEGER NOT NULL,
    "gameMode" TEXT NOT NULL,
    "songName" TEXT NOT NULL,
    "stars" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ranked" BOOLEAN NOT NULL DEFAULT false,
    "maxScore" INTEGER NOT NULL DEFAULT 0,
    "baseScore" INTEGER NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pp" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "modifiers" TEXT NOT NULL DEFAULT '',
    "fullCombo" BOOLEAN NOT NULL DEFAULT false,
    "missedNotes" INTEGER NOT NULL DEFAULT 0,
    "badCuts" INTEGER NOT NULL DEFAULT 0,
    "timeset" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreSaberScore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScoreSaberScore_playerId_ssLeaderboardId_key" ON "ScoreSaberScore"("playerId", "ssLeaderboardId");
CREATE INDEX "ScoreSaberScore_playerId_idx" ON "ScoreSaberScore"("playerId");
CREATE INDEX "ScoreSaberScore_songHash_difficultyValue_idx" ON "ScoreSaberScore"("songHash", "difficultyValue");

ALTER TABLE "ScoreSaberScore" ADD CONSTRAINT "ScoreSaberScore_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
