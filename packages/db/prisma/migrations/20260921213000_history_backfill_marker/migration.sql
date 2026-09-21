-- How far back a player's BeatLeader history is known to be complete. Null means
-- never walked to the end, so the next pass backfills rather than assuming.
ALTER TABLE "Player" ADD COLUMN "historyBackfilledTo" INTEGER;
