/**
 * Shapes returned by the BeatLeader API, narrowed to the fields this app uses.
 * Verified against api.beatleader.com responses; anything we do not read is
 * left off rather than guessed at.
 */

export interface BLModifiersRating {
  ssPredictedAcc?: number;
  ssPassRating?: number;
  ssAccRating?: number;
  ssTechRating?: number;
  ssStars?: number;
  fsStars?: number;
  sfStars?: number;
  [key: string]: number | undefined;
}

export interface BLDifficulty {
  id: number;
  /** 1 Easy, 3 Normal, 5 Hard, 7 Expert, 9 ExpertPlus */
  value: number;
  /** 1 = Standard */
  mode: number;
  difficultyName: string;
  modeName: string;
  customDifficultyName?: string | null;
  status: number;
  maxScore?: number;
  stars?: number | null;
  accRating?: number | null;
  passRating?: number | null;
  techRating?: number | null;
  predictedAcc?: number | null;
  modifiersRating?: BLModifiersRating | null;

  // Chart shape, present on the /map/hash difficulty objects.
  njs?: number | null;
  nps?: number | null;
  notes?: number | null;
  bombs?: number | null;
  walls?: number | null;
  chains?: number | null;
  sliders?: number | null;
  duration?: number | null;
  peakSustainedEBPM?: number | null;

  // BeatLeader's own tag bitfields.
  speedTags?: number | null;
  styleTags?: number | null;
  featureTags?: number | null;

  /** Present on /map/hash difficulties; absent on some other endpoints. */
  songId?: string;
  hash?: string;
}

export interface BLSong {
  id: string;
  hash: string;
  name: string;
  subName?: string;
  author?: string;
  mapper?: string;
  mapperId?: number;
  bpm?: number;
  duration?: number;
  coverImage?: string;
  fullCoverImage?: string;
  downloadUrl?: string;
  uploadTime?: number;
  difficulties?: BLDifficulty[];
}

export interface BLPlayer {
  id: string;
  name: string;
  avatar?: string;
  country?: string;
  pp?: number;
  rank?: number;
  countryRank?: number;
  banned?: boolean;
  inactive?: boolean;
  /** The skill triangle, in pp. */
  accPp?: number;
  techPp?: number;
  passPp?: number;
  /** Present when asked for with `?stats=true`. */
  scoreStats?: { rankedPlayCount?: number; totalPlayCount?: number } | null;
}

export interface BLScore {
  id: number;
  baseScore: number;
  modifiedScore: number;
  /** 0..1 */
  accuracy: number;
  playerId: string;
  pp: number;
  passPP?: number;
  accPP?: number;
  techPP?: number;
  rank?: number;
  replay?: string;
  modifiers?: string;
  badCuts?: number;
  missedNotes?: number;
  bombCuts?: number;
  wallsHit?: number;
  pauses?: number;
  fullCombo?: boolean;
  maxCombo?: number;
  hmd?: number;
  controller?: number;
  accLeft?: number;
  accRight?: number;
  /** Unix seconds, as a string. */
  timeset?: string;
  platform?: string;
  player?: BLPlayer;
  leaderboard?: BLLeaderboardInfo;
  leaderboardId?: string;
}

export interface BLLeaderboardInfo {
  id: string;
  song: BLSong;
  difficulty: BLDifficulty;
}

export interface BLLeaderboardPage extends BLLeaderboardInfo {
  scores?: BLScore[];
}

/** The standard `.bplist` playlist shape, as served by /playlist/{id}. */
export interface BPList {
  playlistTitle?: string;
  playlistAuthor?: string;
  playlistDescription?: string;
  /** Often a multi-megabyte base64 data URI. Never persist this. */
  image?: string;
  songs: BPListSong[];
}

export interface BPListSong {
  hash?: string;
  key?: string;
  songName?: string;
  levelAuthorName?: string;
  difficulties?: BPListDifficulty[];
}

export interface BPListDifficulty {
  /** Lowercase difficulty name, e.g. "expertPlus". */
  name: string;
  /** e.g. "Standard" */
  characteristic: string;
}
