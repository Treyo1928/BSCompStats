import { describe, it, expect } from 'vitest';
import { validateLineups, legalAdditions, duoKey, type LineupInput } from './rules.js';
import { MSU_DUOS_FORMAT, matchFormatSchema } from './format.js';

// The real MSU Fall WK3 scrim, read off the match spreadsheet.
const MAROON = ['erin', 'trey', 'mia', 'will'];
const names: Record<string, string> = {
  erin: 'Erin',
  trey: 'Trey',
  mia: 'Mia',
  will: 'Will',
  kaiden: 'Kaiden',
  kadence: 'Kadence',
  alex: 'Alex',
};
const nameOf = (id: string) => names[id] ?? id;

/** Maroon's actual lineups: four maps of duos plus the tiebreaker. */
const maroonLineups: LineupInput[] = [
  { matchMapId: 'm1', mapLabel: 'Map 1 - Madeleine', isTiebreaker: false, playerIds: ['erin', 'will'] },
  { matchMapId: 'm2', mapLabel: 'Map 2 - CASINO RAVE', isTiebreaker: false, playerIds: ['erin', 'trey'] },
  { matchMapId: 'm3', mapLabel: 'Map 3 - Sentiment', isTiebreaker: false, playerIds: ['will', 'mia'] },
  { matchMapId: 'm4', mapLabel: 'Map 4 - Konpeito', isTiebreaker: false, playerIds: ['trey', 'mia'] },
  { matchMapId: 'tb', mapLabel: "Tiebreaker - Girls' Night", isTiebreaker: true, playerIds: ['erin', 'mia'] },
];

describe('the duo rule, against the real scrim', () => {
  it("accepts Maroon's lineups exactly as played", () => {
    const result = validateLineups({
      format: MSU_DUOS_FORMAT,
      lineups: maroonLineups,
      roster: MAROON,
      playerName: nameOf,
    });

    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(true);
    // Four maps x two slots over four players: everyone plays exactly twice.
    expect(result.appearances).toEqual({ erin: 2, trey: 2, mia: 2, will: 2 });
  });

  it('exempts the tiebreaker, even though Erin and Mia have both already played', () => {
    // Erin played maps 1 and 2, Mia played maps 3 and 4 - both are at the
    // 2-map cap, and the pair is legal only because the tiebreaker is exempt.
    const withTiebreaker = validateLineups({
      format: MSU_DUOS_FORMAT,
      lineups: maroonLineups,
      roster: MAROON,
      playerName: nameOf,
    });
    expect(withTiebreaker.valid).toBe(true);

    // Exempt means it is not counted at all: two appearances each, not three.
    expect(withTiebreaker.appearances).toEqual({ erin: 2, trey: 2, mia: 2, will: 2 });

    // Counted as an ordinary map it would be their third. Five duo maps over
    // four players force someone to play three, so that is allowed - but it
    // is counted, which is the difference the exemption makes.
    const asNormalMap = validateLineups({
      format: MSU_DUOS_FORMAT,
      lineups: maroonLineups.map((l) =>
        l.matchMapId === 'tb' ? { ...l, isTiebreaker: false } : l,
      ),
      roster: MAROON,
      playerName: nameOf,
    });
    expect(asNormalMap.appearances).toEqual({ erin: 3, trey: 2, mia: 3, will: 2 });
  });

  it('catches a repeated duo and names both maps', () => {
    const lineups = maroonLineups.map((l) =>
      l.matchMapId === 'm4' ? { ...l, playerIds: ['erin', 'will'] } : l,
    );

    const result = validateLineups({
      format: MSU_DUOS_FORMAT,
      lineups,
      roster: MAROON,
      playerName: nameOf,
    });

    const duo = result.violations.find((v) => v.code === 'DUPLICATE_DUO');
    expect(duo).toBeDefined();
    expect(duo!.severity).toBe('ERROR');
    expect(duo!.message).toContain('Erin + Will');
    expect(duo!.message).toContain('Map 1 - Madeleine');
    expect(duo!.matchMapIds).toEqual(['m1', 'm4']);
    expect(result.valid).toBe(false);
  });

  it("accepts White's real lineups: a short roster cannot avoid what they did", () => {
    // White only fielded three players - their fourth is literally named "the
    // secret cooler fourth player" in the sheet and never appears - so they
    // could not cover four maps without repeating Kaiden+Kadence.
    const white = ['kaiden', 'kadence', 'alex'];
    const lineups: LineupInput[] = [
      { matchMapId: 'm1', mapLabel: 'Map 1', isTiebreaker: false, playerIds: ['kaiden', 'kadence'] },
      { matchMapId: 'm2', mapLabel: 'Map 2', isTiebreaker: false, playerIds: ['kadence', 'alex'] },
      { matchMapId: 'm3', mapLabel: 'Map 3', isTiebreaker: false, playerIds: ['kaiden', 'alex'] },
      { matchMapId: 'm4', mapLabel: 'Map 4', isTiebreaker: false, playerIds: ['kaiden', 'kadence'] },
      { matchMapId: 'tb', mapLabel: 'Tiebreaker', isTiebreaker: true, playerIds: ['kaiden', 'kadence'] },
    ];

    const result = validateLineups({
      format: MSU_DUOS_FORMAT,
      lineups,
      roster: white,
      playerName: nameOf,
    });

    // Three players make three duos and cover six of eight slots at two maps
    // each. One repeated pairing and a third map for two of them is the least
    // they could do, so none of it is a violation. (This used to be flagged,
    // and needed an organiser to override it on the night.)
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.appearances).toEqual({ kaiden: 3, kadence: 3, alex: 2 });
  });
});

describe('partial input while a captain is still choosing', () => {
  it('warns rather than errors on an unfinished lineup', () => {
    const result = validateLineups({
      format: MSU_DUOS_FORMAT,
      lineups: [
        { matchMapId: 'm1', mapLabel: 'Map 1', isTiebreaker: false, playerIds: ['erin'] },
      ],
      roster: MAROON,
      playerName: nameOf,
    });

    expect(result.complete).toBe(false);
    expect(result.valid).toBe(true); // nothing blocks yet
    expect(result.violations[0]?.code).toBe('INCOMPLETE_LINEUP');
    expect(result.violations[0]?.severity).toBe('WARNING');
  });

  it('does not accuse a half-filled map of repeating a duo', () => {
    // Erin is on map 1 with Will. Putting Erin alone on map 2 must not be read
    // as the Erin+Will pair again just because Will is the other name present.
    const result = validateLineups({
      format: MSU_DUOS_FORMAT,
      lineups: [
        { matchMapId: 'm1', mapLabel: 'Map 1', isTiebreaker: false, playerIds: ['erin', 'will'] },
        { matchMapId: 'm2', mapLabel: 'Map 2', isTiebreaker: false, playerIds: ['erin'] },
      ],
      roster: MAROON,
      playerName: nameOf,
    });
    expect(result.violations.some((v) => v.code === 'DUPLICATE_DUO')).toBe(false);
  });

  it('only demands a minimum once every lineup is filled', () => {
    const partial = validateLineups({
      format: MSU_DUOS_FORMAT,
      lineups: [
        { matchMapId: 'm1', mapLabel: 'Map 1', isTiebreaker: false, playerIds: ['erin'] },
      ],
      roster: MAROON,
      playerName: nameOf,
    });
    expect(partial.violations.some((v) => v.code === 'TOO_FEW_APPEARANCES')).toBe(false);
  });
});

describe('other legality checks', () => {
  it('rejects a player who is not on the roster', () => {
    const result = validateLineups({
      format: MSU_DUOS_FORMAT,
      lineups: [
        { matchMapId: 'm1', mapLabel: 'Map 1', isTiebreaker: false, playerIds: ['erin', 'kaiden'] },
      ],
      roster: MAROON,
      playerName: nameOf,
    });
    const v = result.violations.find((x) => x.code === 'NOT_ON_ROSTER');
    expect(v?.message).toContain('Kaiden');
  });

  it('rejects the same player twice on one map', () => {
    const result = validateLineups({
      format: MSU_DUOS_FORMAT,
      lineups: [
        { matchMapId: 'm1', mapLabel: 'Map 1', isTiebreaker: false, playerIds: ['erin', 'erin'] },
      ],
      roster: MAROON,
      playerName: nameOf,
    });
    expect(result.violations.some((v) => v.code === 'DUPLICATE_PLAYER_IN_MAP')).toBe(true);
  });

  it('rejects an over-filled map', () => {
    const result = validateLineups({
      format: MSU_DUOS_FORMAT,
      lineups: [
        { matchMapId: 'm1', mapLabel: 'Map 1', isTiebreaker: false, playerIds: ['erin', 'will', 'mia'] },
      ],
      roster: MAROON,
      playerName: nameOf,
    });
    expect(result.violations.some((v) => v.code === 'TOO_MANY_PLAYERS')).toBe(true);
  });

  it('skips the duo rule entirely for a solo format', () => {
    const solo = matchFormatSchema.parse({
      playersPerMap: 1,
      rules: { uniqueDuos: false, minAppearances: null, maxAppearances: null },
    });
    const result = validateLineups({
      format: solo,
      lineups: [
        { matchMapId: 'm1', mapLabel: 'Map 1', isTiebreaker: false, playerIds: ['erin'] },
        { matchMapId: 'm2', mapLabel: 'Map 2', isTiebreaker: false, playerIds: ['erin'] },
      ],
      roster: MAROON,
    });
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(true);
  });
});

describe('legalAdditions', () => {
  it('steers the captain away from a pick that would repeat a duo', () => {
    // Maps 1-3 as played; map 4 has Trey on it. Adding Mia is the legal move.
    const lineups: LineupInput[] = [
      { matchMapId: 'm1', mapLabel: 'Map 1', isTiebreaker: false, playerIds: ['erin', 'will'] },
      { matchMapId: 'm2', mapLabel: 'Map 2', isTiebreaker: false, playerIds: ['erin', 'trey'] },
      { matchMapId: 'm3', mapLabel: 'Map 3', isTiebreaker: false, playerIds: ['will', 'mia'] },
      { matchMapId: 'm4', mapLabel: 'Map 4', isTiebreaker: false, playerIds: ['trey'] },
    ];

    const options = legalAdditions({
      format: MSU_DUOS_FORMAT,
      lineups,
      roster: MAROON,
      playerName: nameOf,
      targetMapId: 'm4',
    });
    const byId = Object.fromEntries(options.map((o) => [o.playerId, o]));

    expect(byId.mia?.legal).toBe(true);
    expect(byId.trey?.legal).toBe(false); // already on this map
    // Erin would be a third appearance; Will would too.
    expect(byId.erin?.legal).toBe(false);
    expect(byId.will?.legal).toBe(false);
  });
});

describe('duoKey', () => {
  it('is order-independent', () => {
    expect(duoKey(['b', 'a'])).toBe(duoKey(['a', 'b']));
  });
});

describe('a roster bigger than the format expects', () => {
  // Six players, four duo maps: eight slots. "Everyone plays twice" would need
  // twelve, so taken literally no lineup could ever be legal.
  const SIX = ['erin', 'trey', 'mia', 'will', 'kaiden', 'alex'];
  const lineups: LineupInput[] = [
    { matchMapId: 'm1', mapLabel: 'Map 1', isTiebreaker: false, playerIds: ['erin', 'trey'] },
    { matchMapId: 'm2', mapLabel: 'Map 2', isTiebreaker: false, playerIds: ['mia', 'will'] },
    { matchMapId: 'm3', mapLabel: 'Map 3', isTiebreaker: false, playerIds: ['kaiden', 'alex'] },
    { matchMapId: 'm4', mapLabel: 'Map 4', isTiebreaker: false, playerIds: ['erin', 'mia'] },
    { matchMapId: 'tb', mapLabel: 'Tiebreaker', isTiebreaker: true, playerIds: ['erin', 'trey'] },
  ];

  it('lowers the minimum to what the slots allow instead of rejecting everything', () => {
    const result = validateLineups({ format: MSU_DUOS_FORMAT, lineups, roster: SIX, playerName: nameOf });
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('still refuses to bench someone entirely', () => {
    const benched = lineups.map((l) =>
      l.matchMapId === 'm3' ? { ...l, playerIds: ['trey', 'will'] } : l,
    );
    const result = validateLineups({ format: MSU_DUOS_FORMAT, lineups: benched, roster: SIX, playerName: nameOf });
    expect(result.violations.map((v) => v.code)).toContain('TOO_FEW_APPEARANCES');
  });

  it('keeps the maximum, so nobody plays everything', () => {
    const greedy = lineups.map((l) =>
      l.matchMapId === 'm2' ? { ...l, playerIds: ['erin', 'will'] } : l,
    );
    const result = validateLineups({ format: MSU_DUOS_FORMAT, lineups: greedy, roster: SIX, playerName: nameOf });
    expect(result.violations.map((v) => v.code)).toContain('TOO_MANY_APPEARANCES');
  });
});

describe('a roster smaller than the format expects', () => {
  const four = (pairs: string[][]): LineupInput[] =>
    pairs.map((playerIds, i) => ({
      matchMapId: `m${i + 1}`,
      mapLabel: `Map ${i + 1}`,
      isTiebreaker: false,
      playerIds,
    }));

  it('lets three players repeat one pairing and play a third map, since they must', () => {
    // Three players make three duos; four maps force one repeat, and eight
    // slots over three players force someone to play three times.
    const result = validateLineups({
      format: MSU_DUOS_FORMAT,
      roster: ['erin', 'trey', 'mia'],
      playerName: nameOf,
      lineups: four([['erin', 'trey'], ['erin', 'mia'], ['trey', 'mia'], ['erin', 'trey']]),
    });
    expect(result.violations).toEqual([]);
  });

  it('still objects to a second repeat that nothing forced', () => {
    const result = validateLineups({
      format: MSU_DUOS_FORMAT,
      roster: ['erin', 'trey', 'mia'],
      playerName: nameOf,
      lineups: four([['erin', 'trey'], ['erin', 'trey'], ['erin', 'trey'], ['trey', 'mia']]),
    });
    expect(result.violations.map((v) => v.code)).toContain('DUPLICATE_DUO');
  });

  it('accepts the same duo on every map from a two-player team', () => {
    const result = validateLineups({
      format: MSU_DUOS_FORMAT,
      roster: ['erin', 'trey'],
      playerName: nameOf,
      lineups: [
        ...four([['erin', 'trey'], ['erin', 'trey'], ['erin', 'trey'], ['erin', 'trey']]),
        { matchMapId: 'tb', mapLabel: 'Tiebreaker', isTiebreaker: true, playerIds: ['erin', 'trey'] },
      ],
    });
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
