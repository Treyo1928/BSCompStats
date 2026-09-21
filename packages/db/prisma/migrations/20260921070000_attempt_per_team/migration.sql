-- A player may be rostered on both teams of a match (small scrims share
-- players). Their one run then counts for each side, so an attempt is unique
-- per team, not per match map.
DROP INDEX "MatchMapAttempt_matchMapId_playerId_attempt_key";

CREATE UNIQUE INDEX "MatchMapAttempt_matchMapId_teamId_playerId_attempt_key" ON "MatchMapAttempt"("matchMapId", "teamId", "playerId", "attempt");
