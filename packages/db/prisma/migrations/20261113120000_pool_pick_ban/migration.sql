-- A pool's own pick/ban order (a bigger finals pool has more bans). Additive only: null plays the tournament's
-- order, so the app before this migration runs on the database after it.
ALTER TABLE "MapPool" ADD COLUMN "pickBanSequence" JSONB;
