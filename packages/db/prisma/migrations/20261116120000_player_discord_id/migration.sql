-- A player's Discord account, set by an organiser (for a stream's Discord bot). Additive only.
ALTER TABLE "Player" ADD COLUMN "discordId" TEXT;
