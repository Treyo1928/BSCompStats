-- A player's saber colours in one tournament, for replay viewers and the stream. Additive only: null is the
-- game's own colours, so the app before this migration runs on the database after it.
ALTER TABLE "TournamentPlayer" ADD COLUMN "saberLeft" TEXT;
ALTER TABLE "TournamentPlayer" ADD COLUMN "saberRight" TEXT;
