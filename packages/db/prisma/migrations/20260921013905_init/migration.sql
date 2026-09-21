-- CreateEnum
CREATE TYPE "GlobalRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "TournamentRole" AS ENUM ('OWNER', 'ORGANIZER', 'CAPTAIN', 'PLAYER', 'VIEWER');

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('PLAYER', 'CAPTAIN', 'COACH', 'SUB');

-- CreateEnum
CREATE TYPE "MatchState" AS ENUM ('SETUP', 'PICKBAN', 'PLAYING', 'COMPLETE');

-- CreateEnum
CREATE TYPE "MatchActionType" AS ENUM ('PICK', 'BAN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "role" "GlobalRole" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "beatLeaderId" TEXT NOT NULL,
    "scoreSaberId" TEXT,
    "name" TEXT NOT NULL,
    "avatar" TEXT,
    "country" TEXT,
    "userId" TEXT,
    "pp" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "countryRank" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerProfile" (
    "playerId" TEXT NOT NULL,
    "bias" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "accWeight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "passWeight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "techWeight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sigma" DOUBLE PRECISION NOT NULL DEFAULT 0.02,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "rSquared" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "meanAcc" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fcRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "missRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pauseRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "handBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "categoryAffinity" JSONB,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerProfile_pkey" PRIMARY KEY ("playerId")
);

-- CreateTable
CREATE TABLE "BeatMap" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subName" TEXT,
    "author" TEXT,
    "mapper" TEXT,
    "bpm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "coverImage" TEXT,
    "downloadUrl" TEXT,
    "uploadTime" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BeatMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Leaderboard" (
    "id" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "difficultyValue" INTEGER NOT NULL,
    "difficultyName" TEXT NOT NULL,
    "mode" INTEGER NOT NULL,
    "modeName" TEXT NOT NULL,
    "customName" TEXT,
    "maxScore" INTEGER NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 0,
    "ranked" BOOLEAN NOT NULL DEFAULT false,
    "stars" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "accRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "passRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "techRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "predictedAcc" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "njs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "nps" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" INTEGER NOT NULL DEFAULT 0,
    "bombs" INTEGER NOT NULL DEFAULT 0,
    "walls" INTEGER NOT NULL DEFAULT 0,
    "chains" INTEGER NOT NULL DEFAULT 0,
    "sliders" INTEGER NOT NULL DEFAULT 0,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "peakEBPM" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "speedTags" INTEGER NOT NULL DEFAULT 0,
    "styleTags" INTEGER NOT NULL DEFAULT 0,
    "featureTags" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Leaderboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Score" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "leaderboardId" TEXT NOT NULL,
    "beatLeaderScoreId" INTEGER,
    "baseScore" INTEGER NOT NULL,
    "modifiedScore" INTEGER NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "pp" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "accPP" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "passPP" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "techPP" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "modifiers" TEXT NOT NULL DEFAULT '',
    "missedNotes" INTEGER NOT NULL DEFAULT 0,
    "badCuts" INTEGER NOT NULL DEFAULT 0,
    "bombCuts" INTEGER NOT NULL DEFAULT 0,
    "wallsHit" INTEGER NOT NULL DEFAULT 0,
    "pauses" INTEGER NOT NULL DEFAULT 0,
    "fullCombo" BOOLEAN NOT NULL DEFAULT false,
    "maxCombo" INTEGER NOT NULL DEFAULT 0,
    "accLeft" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "accRight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hmd" INTEGER NOT NULL DEFAULT 0,
    "controller" INTEGER NOT NULL DEFAULT 0,
    "platform" TEXT,
    "replayUrl" TEXT,
    "timeset" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Score_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreEvent" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "leaderboardId" TEXT NOT NULL,
    "beatLeaderScoreId" INTEGER,
    "baseScore" INTEGER NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "modifiers" TEXT NOT NULL DEFAULT '',
    "missedNotes" INTEGER NOT NULL DEFAULT 0,
    "fullCombo" BOOLEAN NOT NULL DEFAULT false,
    "replayUrl" TEXT,
    "timeset" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tournament" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "ownerId" TEXT NOT NULL,
    "defaultFormat" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentMember" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "TournamentRole" NOT NULL DEFAULT 'VIEWER',
    "teamId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Division" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Division_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#4F46E5',
    "colorSecondary" TEXT NOT NULL DEFAULT '#A5B4FC',
    "logo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'PLAYER',
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MapPool" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MapPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoolMap" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "leaderboardId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT,
    "label" TEXT,
    "isTiebreaker" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PoolMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" "MatchState" NOT NULL DEFAULT 'SETUP',
    "teamAId" TEXT NOT NULL,
    "teamBId" TEXT NOT NULL,
    "coinFlipWinnerId" TEXT,
    "winnerId" TEXT,
    "format" JSONB,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchAction" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" "MatchActionType" NOT NULL,
    "teamId" TEXT NOT NULL,
    "poolMapId" TEXT NOT NULL,
    "actingUserId" TEXT,
    "onBehalfOfUserId" TEXT,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchMap" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "poolMapId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "isTiebreaker" BOOLEAN NOT NULL DEFAULT false,
    "pickedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lineup" (
    "id" TEXT NOT NULL,
    "matchMapId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lineup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineupSlot" (
    "id" TEXT NOT NULL,
    "lineupId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,

    CONSTRAINT "LineupSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchMapAttempt" (
    "id" TEXT NOT NULL,
    "matchMapId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "score" INTEGER NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'AUTO',
    "beatLeaderScoreId" INTEGER,
    "replayUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchMapAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'spectator',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Player_beatLeaderId_key" ON "Player"("beatLeaderId");

-- CreateIndex
CREATE UNIQUE INDEX "Player_scoreSaberId_key" ON "Player"("scoreSaberId");

-- CreateIndex
CREATE INDEX "Player_userId_idx" ON "Player"("userId");

-- CreateIndex
CREATE INDEX "Player_name_idx" ON "Player"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BeatMap_hash_key" ON "BeatMap"("hash");

-- CreateIndex
CREATE INDEX "BeatMap_name_idx" ON "BeatMap"("name");

-- CreateIndex
CREATE INDEX "Leaderboard_mapId_idx" ON "Leaderboard"("mapId");

-- CreateIndex
CREATE UNIQUE INDEX "Leaderboard_mapId_difficultyValue_mode_key" ON "Leaderboard"("mapId", "difficultyValue", "mode");

-- CreateIndex
CREATE INDEX "Score_leaderboardId_idx" ON "Score"("leaderboardId");

-- CreateIndex
CREATE INDEX "Score_playerId_idx" ON "Score"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "Score_playerId_leaderboardId_key" ON "Score"("playerId", "leaderboardId");

-- CreateIndex
CREATE INDEX "ScoreEvent_playerId_leaderboardId_timeset_idx" ON "ScoreEvent"("playerId", "leaderboardId", "timeset");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreEvent_playerId_leaderboardId_beatLeaderScoreId_key" ON "ScoreEvent"("playerId", "leaderboardId", "beatLeaderScoreId");

-- CreateIndex
CREATE UNIQUE INDEX "Tournament_slug_key" ON "Tournament"("slug");

-- CreateIndex
CREATE INDEX "Tournament_ownerId_idx" ON "Tournament"("ownerId");

-- CreateIndex
CREATE INDEX "TournamentMember_userId_idx" ON "TournamentMember"("userId");

-- CreateIndex
CREATE INDEX "TournamentMember_teamId_idx" ON "TournamentMember"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentMember_tournamentId_userId_key" ON "TournamentMember"("tournamentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Division_tournamentId_name_key" ON "Division"("tournamentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Team_divisionId_name_key" ON "Team"("divisionId", "name");

-- CreateIndex
CREATE INDEX "TeamMember_playerId_idx" ON "TeamMember"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_playerId_key" ON "TeamMember"("teamId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "MapPool_tournamentId_name_key" ON "MapPool"("tournamentId", "name");

-- CreateIndex
CREATE INDEX "PoolMap_poolId_idx" ON "PoolMap"("poolId");

-- CreateIndex
CREATE UNIQUE INDEX "PoolMap_poolId_leaderboardId_key" ON "PoolMap"("poolId", "leaderboardId");

-- CreateIndex
CREATE INDEX "Match_tournamentId_idx" ON "Match"("tournamentId");

-- CreateIndex
CREATE INDEX "Match_poolId_idx" ON "Match"("poolId");

-- CreateIndex
CREATE INDEX "MatchAction_matchId_idx" ON "MatchAction"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchAction_matchId_seq_key" ON "MatchAction"("matchId", "seq");

-- CreateIndex
CREATE INDEX "MatchMap_matchId_idx" ON "MatchMap"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchMap_matchId_order_key" ON "MatchMap"("matchId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "Lineup_matchMapId_teamId_key" ON "Lineup"("matchMapId", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "LineupSlot_lineupId_slot_key" ON "LineupSlot"("lineupId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "LineupSlot_lineupId_playerId_key" ON "LineupSlot"("lineupId", "playerId");

-- CreateIndex
CREATE INDEX "MatchMapAttempt_matchMapId_idx" ON "MatchMapAttempt"("matchMapId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchMapAttempt_matchMapId_playerId_attempt_key" ON "MatchMapAttempt"("matchMapId", "playerId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "ShareLink_token_key" ON "ShareLink"("token");

-- CreateIndex
CREATE INDEX "ShareLink_matchId_idx" ON "ShareLink"("matchId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerProfile" ADD CONSTRAINT "PlayerProfile_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leaderboard" ADD CONSTRAINT "Leaderboard_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "BeatMap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Score" ADD CONSTRAINT "Score_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Score" ADD CONSTRAINT "Score_leaderboardId_fkey" FOREIGN KEY ("leaderboardId") REFERENCES "Leaderboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreEvent" ADD CONSTRAINT "ScoreEvent_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreEvent" ADD CONSTRAINT "ScoreEvent_leaderboardId_fkey" FOREIGN KEY ("leaderboardId") REFERENCES "Leaderboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMember" ADD CONSTRAINT "TournamentMember_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMember" ADD CONSTRAINT "TournamentMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMember" ADD CONSTRAINT "TournamentMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Division" ADD CONSTRAINT "Division_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MapPool" ADD CONSTRAINT "MapPool_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolMap" ADD CONSTRAINT "PoolMap_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "MapPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolMap" ADD CONSTRAINT "PoolMap_leaderboardId_fkey" FOREIGN KEY ("leaderboardId") REFERENCES "Leaderboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "MapPool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_teamAId_fkey" FOREIGN KEY ("teamAId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_teamBId_fkey" FOREIGN KEY ("teamBId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_coinFlipWinnerId_fkey" FOREIGN KEY ("coinFlipWinnerId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchAction" ADD CONSTRAINT "MatchAction_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchAction" ADD CONSTRAINT "MatchAction_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchAction" ADD CONSTRAINT "MatchAction_poolMapId_fkey" FOREIGN KEY ("poolMapId") REFERENCES "PoolMap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchAction" ADD CONSTRAINT "MatchAction_actingUserId_fkey" FOREIGN KEY ("actingUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchAction" ADD CONSTRAINT "MatchAction_onBehalfOfUserId_fkey" FOREIGN KEY ("onBehalfOfUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMap" ADD CONSTRAINT "MatchMap_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMap" ADD CONSTRAINT "MatchMap_poolMapId_fkey" FOREIGN KEY ("poolMapId") REFERENCES "PoolMap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMap" ADD CONSTRAINT "MatchMap_pickedById_fkey" FOREIGN KEY ("pickedById") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lineup" ADD CONSTRAINT "Lineup_matchMapId_fkey" FOREIGN KEY ("matchMapId") REFERENCES "MatchMap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lineup" ADD CONSTRAINT "Lineup_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineupSlot" ADD CONSTRAINT "LineupSlot_lineupId_fkey" FOREIGN KEY ("lineupId") REFERENCES "Lineup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineupSlot" ADD CONSTRAINT "LineupSlot_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMapAttempt" ADD CONSTRAINT "MatchMapAttempt_matchMapId_fkey" FOREIGN KEY ("matchMapId") REFERENCES "MatchMap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMapAttempt" ADD CONSTRAINT "MatchMapAttempt_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMapAttempt" ADD CONSTRAINT "MatchMapAttempt_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
