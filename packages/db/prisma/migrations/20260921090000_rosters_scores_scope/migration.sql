-- Substitutes and absences: who is actually available to be fielded.
ALTER TABLE "TeamMember" ADD COLUMN "isSub" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "available" BOOLEAN NOT NULL DEFAULT true;

-- Lineups hidden from the other side until both teams have set every map.
ALTER TABLE "Match" ADD COLUMN "blindLineups" BOOLEAN NOT NULL DEFAULT false;

-- Whether captains may enter their own team's scores, and what the prediction
-- model learns from. The scope used to be tucked inside defaultFormat, where
-- saving one would have silently reset the match format.
ALTER TABLE "Tournament" ADD COLUMN "captainsEnterScores" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "statsScope" JSONB;

-- Teams that have spent a replay on this map.
ALTER TABLE "MatchMap" ADD COLUMN "replayCalledByTeamIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
