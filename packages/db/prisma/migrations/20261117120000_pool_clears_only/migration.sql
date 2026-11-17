-- A pool whose board counts finished runs only. Additive only.
ALTER TABLE "MapPool" ADD COLUMN "clearsOnly" BOOLEAN NOT NULL DEFAULT false;
