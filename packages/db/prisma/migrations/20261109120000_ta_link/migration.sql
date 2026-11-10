-- TournamentAssistant, run from the site: the worker holds the TA connection, so no separate bridge program
-- or TA coordinator app is needed. A map is loaded for its players first and started on a second press.
CREATE TABLE "TaLink" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "host" TEXT NOT NULL DEFAULT 'server.tournamentassistant.net',
    "port" INTEGER NOT NULL DEFAULT 8676,
    "token" TEXT,
    "tokenName" TEXT,
    "tokenUserId" TEXT,
    "signedInBy" TEXT,
    "taTournamentId" TEXT,
    "taTournamentName" TEXT,
    "options" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaLink_tournamentId_key" ON "TaLink"("tournamentId");

ALTER TABLE "TaLink" ADD CONSTRAINT "TaLink_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MatchMap" ADD COLUMN "playRequestedAt" TIMESTAMP(3);
