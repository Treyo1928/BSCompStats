-- A player's own saber colours and replays, set on their profile and used in every tournament that has none of its
-- own for them. Additive only: the app before this migration runs on the database after it.
ALTER TABLE "Player" ADD COLUMN "saberLeft" TEXT;
ALTER TABLE "Player" ADD COLUMN "saberRight" TEXT;
ALTER TABLE "Player" ADD COLUMN "replays" JSONB NOT NULL DEFAULT '[]';
