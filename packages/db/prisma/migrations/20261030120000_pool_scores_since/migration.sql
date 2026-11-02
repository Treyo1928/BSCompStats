-- An organiser's cutoff per pool: scores and runs set before it are left out.
ALTER TABLE "MapPool" ADD COLUMN "scoresSince" TIMESTAMP(3);
