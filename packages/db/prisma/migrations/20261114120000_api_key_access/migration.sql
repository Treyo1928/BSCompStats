-- API keys that work in several tournaments, and that let approved people sign in to the app the key is for.
-- Additive only: the old "tournamentId" column stays and is kept in step with the new table, so the app before
-- this migration still limits every key if it is run on the database after it.

CREATE TABLE "ApiKeyTournament" (
    "keyId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    CONSTRAINT "ApiKeyTournament_pkey" PRIMARY KEY ("keyId","tournamentId")
);
CREATE INDEX "ApiKeyTournament_tournamentId_idx" ON "ApiKeyTournament"("tournamentId");
ALTER TABLE "ApiKeyTournament" ADD CONSTRAINT "ApiKeyTournament_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKeyTournament" ADD CONSTRAINT "ApiKeyTournament_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- every key that was limited to one tournament stays limited to it
INSERT INTO "ApiKeyTournament" ("keyId", "tournamentId")
SELECT "id", "tournamentId" FROM "ApiKey" WHERE "tournamentId" IS NOT NULL;

CREATE TABLE "ApiKeyPerson" (
    "keyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    CONSTRAINT "ApiKeyPerson_pkey" PRIMARY KEY ("keyId","userId")
);
CREATE INDEX "ApiKeyPerson_userId_idx" ON "ApiKeyPerson"("userId");
ALTER TABLE "ApiKeyPerson" ADD CONSTRAINT "ApiKeyPerson_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKeyPerson" ADD CONSTRAINT "ApiKeyPerson_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApiKey" ADD COLUMN "signInUrl" TEXT;
