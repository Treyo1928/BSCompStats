-- TournamentAssistant mode: organisers start each map in TA, a bridge reports back and enters the scores.
ALTER TABLE "Tournament" ADD COLUMN "taModeDefault" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Match" ADD COLUMN "taMode" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "MatchMap" ADD COLUMN "startRequestedAt" TIMESTAMP(3),
ADD COLUMN "startRequestedById" TEXT,
ADD COLUMN "taStatus" JSONB;

ALTER TABLE "MatchMapAttempt" ADD COLUMN "misses" INTEGER;

-- The id TA knows a player by, where it differs from their BeatLeader id (Quest players).
ALTER TABLE "Player" ADD COLUMN "taPlatformId" TEXT;

ALTER TABLE "MatchMap" ADD CONSTRAINT "MatchMap_startRequestedById_fkey" FOREIGN KEY ("startRequestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
