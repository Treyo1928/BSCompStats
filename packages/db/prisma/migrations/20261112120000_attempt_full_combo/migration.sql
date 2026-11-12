-- BeatLeader's full-combo flag on each recorded run. Null on runs stored before now.
ALTER TABLE "Attempt" ADD COLUMN "fullCombo" BOOLEAN;

-- Have the worker read everyone's runs again on its next pass, which fills the flag in on the runs already stored.
UPDATE "Player" SET "attemptsSyncedAt" = NULL WHERE "attemptsPublic" = true;
