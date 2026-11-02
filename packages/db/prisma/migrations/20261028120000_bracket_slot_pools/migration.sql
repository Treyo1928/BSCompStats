-- A bracket slot can play its own pool instead of the bracket's default.
ALTER TABLE "BracketNode" ADD COLUMN "poolId" TEXT;

CREATE INDEX "BracketNode_poolId_idx" ON "BracketNode"("poolId");

ALTER TABLE "BracketNode" ADD CONSTRAINT "BracketNode_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "MapPool"("id") ON DELETE SET NULL ON UPDATE CASCADE;
