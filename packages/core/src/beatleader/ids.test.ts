import { describe, it, expect } from 'vitest';
import {
  makeLeaderboardId,
  parseLeaderboardId,
  parseDifficulty,
  parseMode,
  extractLeaderboardId,
  extractPlaylistId,
  extractBeatSaverKey,
  difficultyLabel,
  displayDifficulty,
} from './ids.js';

describe('leaderboard id derivation', () => {
  // Both fixtures were read off live api.beatleader.com responses for the song
  // "BREAKME" (song id 2d93e), so they pin the real-world format.
  it('matches the id BeatLeader issues for Expert/Standard', () => {
    expect(makeLeaderboardId('2d93e', 7, 1)).toBe('2d93e71');
  });

  it('matches the id BeatLeader issues for ExpertPlus/Standard', () => {
    expect(makeLeaderboardId('2d93e', 9, 1)).toBe('2d93e91');
  });

  it('round-trips through parseLeaderboardId', () => {
    expect(parseLeaderboardId('2d93e71')).toEqual({
      songId: '2d93e',
      difficultyValue: 7,
      mode: 1,
    });
    expect(parseLeaderboardId('2d93e91')).toEqual({
      songId: '2d93e',
      difficultyValue: 9,
      mode: 1,
    });
  });

  it('handles song ids that contain digits without mis-splitting', () => {
    // "44b4d" ends in a digit-looking char; the split must take exactly two.
    expect(parseLeaderboardId(makeLeaderboardId('44b4d', 5, 1))).toEqual({
      songId: '44b4d',
      difficultyValue: 5,
      mode: 1,
    });
  });

  it('handles versioned song ids, which contain x characters', () => {
    // Real ids seen on the live score websocket: 4b07axx91, 52e44xxx91. The x
    // suffix marks a re-uploaded map version, and it is part of the song id -
    // so the derivation has to use whatever id the API gives for that hash
    // rather than assuming a fixed length.
    expect(makeLeaderboardId('4b07axx', 9, 1)).toBe('4b07axx91');
    expect(parseLeaderboardId('4b07axx91')).toEqual({
      songId: '4b07axx',
      difficultyValue: 9,
      mode: 1,
    });
    expect(parseLeaderboardId('52e44xxx91')).toEqual({
      songId: '52e44xxx',
      difficultyValue: 9,
      mode: 1,
    });
  });

  it('rejects ids whose difficulty digit is not a real difficulty', () => {
    // 4 is not a Beat Saber difficulty value, so this is not a leaderboard id.
    expect(parseLeaderboardId('2d93e41')).toBeNull();
    expect(parseLeaderboardId('ab')).toBeNull();
  });
});

describe('parseDifficulty', () => {
  it('accepts the spellings playlists and the API each use', () => {
    // Playlist files use lowercase camel, the API uses TitleCase.
    expect(parseDifficulty('expertPlus')).toBe(9);
    expect(parseDifficulty('ExpertPlus')).toBe(9);
    expect(parseDifficulty('Expert+')).toBe(9);
    expect(parseDifficulty('ex+')).toBe(9);
    expect(parseDifficulty('easy')).toBe(1);
    expect(parseDifficulty('Normal')).toBe(3);
    expect(parseDifficulty('hard')).toBe(5);
    expect(parseDifficulty('expert')).toBe(7);
  });

  it('accepts raw values and rejects nonsense', () => {
    expect(parseDifficulty(9)).toBe(9);
    expect(parseDifficulty(4)).toBeNull();
    expect(parseDifficulty('banana')).toBeNull();
  });
});

describe('parseMode', () => {
  it('treats ScoreSaber SoloStandard as Standard', () => {
    expect(parseMode('Standard')).toBe(1);
    expect(parseMode('SoloStandard')).toBe(1);
    expect(parseMode('Lawless')).toBe(7);
    expect(parseMode('nonsense')).toBeNull();
  });
});

describe('url extraction', () => {
  it('pulls ids out of pasted links', () => {
    expect(extractLeaderboardId('https://beatleader.com/leaderboard/global/2d93e91')).toBe('2d93e91');
    expect(extractLeaderboardId('https://beatleader.com/leaderboard/2d93e91')).toBe('2d93e91');
    expect(extractLeaderboardId('2d93e91')).toBe('2d93e91');
    expect(extractPlaylistId('https://beatleader.com/playlist/110086')).toBe('110086');
    expect(extractPlaylistId('110086')).toBe('110086');
    // The scrim sheet links maps by BeatSaver URL, so we accept those too.
    expect(extractBeatSaverKey('https://beatsaver.com/maps/3185d')).toBe('3185d');
  });
});

describe('difficultyLabel', () => {
  it('renders ExpertPlus the way players write it', () => {
    expect(difficultyLabel(9)).toBe('Expert+');
    expect(difficultyLabel(5)).toBe('Hard');
  });
});

describe('displayDifficulty', () => {
  it('does not repeat a difficulty the mapper already named', () => {
    // Real case from the MSU pool: CASINO RAVE's Hard is called "Safe bet
    // (Hard)", which naive concatenation renders "Safe bet (Hard) (Hard)".
    expect(displayDifficulty(5, 'Safe bet (Hard)')).toBe('Safe bet (Hard)');
    expect(displayDifficulty(9, 'BROKEN')).toBe('BROKEN (Expert+)');
    expect(displayDifficulty(7, 'Swirl')).toBe('Swirl (Expert)');
    expect(displayDifficulty(5, null)).toBe('Hard');
    expect(displayDifficulty(5, '  ')).toBe('Hard');
  });

  it('matches on the API spelling as well as the display one', () => {
    // "ExpertPlus" and "Expert+" are the same difficulty written two ways.
    expect(displayDifficulty(9, 'Chaos ExpertPlus')).toBe('Chaos ExpertPlus');
  });
});
