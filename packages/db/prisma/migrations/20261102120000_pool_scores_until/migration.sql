-- The end of a pool's score window: scores and runs set after it are left out (qualifiers held over set dates).
ALTER TABLE "MapPool" ADD COLUMN "scoresUntil" TIMESTAMP(3);
