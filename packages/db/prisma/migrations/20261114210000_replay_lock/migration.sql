-- Locking the replays shown on stream for a tournament (stream day). Additive only.
ALTER TABLE "Tournament" ADD COLUMN "replaysLockedAt" TIMESTAMP(3);
ALTER TABLE "TournamentPlayer" ADD COLUMN "lockedReplays" JSONB;
