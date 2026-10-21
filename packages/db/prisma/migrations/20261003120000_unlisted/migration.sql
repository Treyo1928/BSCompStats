-- Tournaments and matches that open from a link but are not listed.
ALTER TABLE "Tournament" ADD COLUMN "unlisted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Match" ADD COLUMN "unlisted" BOOLEAN NOT NULL DEFAULT false;
