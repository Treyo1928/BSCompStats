import { describe, expect, it } from 'vitest';
import { looksLikeSteamId, parseScoreSaberId } from './index.js';

describe('parseScoreSaberId', () => {
  it('takes a bare id or a profile link', () => {
    expect(parseScoreSaberId(' 76561198251130654 ')).toBe('76561198251130654');
    expect(parseScoreSaberId('https://scoresaber.com/u/76561198251130654?page=2&sort=top')).toBe('76561198251130654');
    expect(parseScoreSaberId('scoresaber.com/u/3225556157461414')).toBe('3225556157461414');
  });

  it('refuses anything else', () => {
    expect(parseScoreSaberId('corn')).toBeNull();
    expect(parseScoreSaberId('https://beatleader.com/u/76561198251130654')).toBeNull();
    expect(parseScoreSaberId('')).toBeNull();
  });
});

describe('looksLikeSteamId', () => {
  it('knows the one kind of id the two sites share', () => {
    expect(looksLikeSteamId('76561198251130654')).toBe(true);
    expect(looksLikeSteamId('3225556157461414')).toBe(false);
    expect(looksLikeSteamId('350045')).toBe(false);
  });
});
