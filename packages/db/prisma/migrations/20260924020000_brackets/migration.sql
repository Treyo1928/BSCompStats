-- Brackets (round robin, single and double elimination) and the player pool.
-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "playerPool" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Bracket" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "poolId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bracket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BracketEntry" (
    "id" TEXT NOT NULL,
    "bracketId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "seed" INTEGER NOT NULL,

    CONSTRAINT "BracketEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BracketNode" (
    "id" TEXT NOT NULL,
    "bracketId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "sources" JSONB NOT NULL,
    "winnerId" TEXT,
    "matchId" TEXT,

    CONSTRAINT "BracketNode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bracket_tournamentId_idx" ON "Bracket"("tournamentId");

-- CreateIndex
CREATE UNIQUE INDEX "BracketEntry_bracketId_teamId_key" ON "BracketEntry"("bracketId", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "BracketEntry_bracketId_seed_key" ON "BracketEntry"("bracketId", "seed");

-- CreateIndex
CREATE UNIQUE INDEX "BracketNode_matchId_key" ON "BracketNode"("matchId");

-- CreateIndex
CREATE INDEX "BracketNode_bracketId_idx" ON "BracketNode"("bracketId");

-- CreateIndex
CREATE UNIQUE INDEX "BracketNode_bracketId_key_key" ON "BracketNode"("bracketId", "key");

-- AddForeignKey
ALTER TABLE "Bracket" ADD CONSTRAINT "Bracket_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bracket" ADD CONSTRAINT "Bracket_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "MapPool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BracketEntry" ADD CONSTRAINT "BracketEntry_bracketId_fkey" FOREIGN KEY ("bracketId") REFERENCES "Bracket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BracketEntry" ADD CONSTRAINT "BracketEntry_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BracketNode" ADD CONSTRAINT "BracketNode_bracketId_fkey" FOREIGN KEY ("bracketId") REFERENCES "Bracket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BracketNode" ADD CONSTRAINT "BracketNode_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE SET NULL ON UPDATE CASCADE;

