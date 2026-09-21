-- Match-only teams, and captains' drafts that build them.

ALTER TABLE "Team" ADD COLUMN "adHoc" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "teamAId" TEXT NOT NULL,
    "teamBId" TEXT NOT NULL,
    "order" TEXT NOT NULL DEFAULT 'SNAKE',
    "firstPick" TEXT NOT NULL DEFAULT 'A',
    "shareOdd" BOOLEAN NOT NULL DEFAULT false,
    "matchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DraftPlayer" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "pickNumber" INTEGER,
    "side" TEXT,

    CONSTRAINT "DraftPlayer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Draft_matchId_key" ON "Draft"("matchId");
CREATE INDEX "Draft_tournamentId_idx" ON "Draft"("tournamentId");
CREATE UNIQUE INDEX "DraftPlayer_draftId_playerId_key" ON "DraftPlayer"("draftId", "playerId");
CREATE UNIQUE INDEX "DraftPlayer_draftId_pickNumber_key" ON "DraftPlayer"("draftId", "pickNumber");

ALTER TABLE "Draft" ADD CONSTRAINT "Draft_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_teamAId_fkey" FOREIGN KEY ("teamAId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_teamBId_fkey" FOREIGN KEY ("teamBId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DraftPlayer" ADD CONSTRAINT "DraftPlayer_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "Draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DraftPlayer" ADD CONSTRAINT "DraftPlayer_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
