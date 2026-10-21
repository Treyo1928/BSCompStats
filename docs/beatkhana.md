# BeatKhana: research and integration ideas

Research only, October 2026. Nothing here is built. Claims marked
*unverified* were not checked against a primary source.

## What BeatKhana is

BeatKhana (beatkhana.com) is the main hosted Beat Saber tournament site: a
SvelteKit front end on an Express API at `https://api.beatkhana.com/api`.

- **Registration**: solo or teams, team size limits, reserves, sign-up
  windows, country and platform filters, required Discord membership, a
  BeatLeader account requirement.
- **Sign-in**: Discord (through Authentik); BeatLeader, ScoreSaber and Twitch
  can be linked.
- **Staff roles**: organiser, co-organiser, admin, staff, coordinator, pooler,
  caster, host and their "head" variants, plus per-tournament permission grants.
- **Map pools**: collaborative pooling - suggestions, votes, comments, slots,
  publish/unpublish, `.bplist` import, a public archive of past pools.
- **Brackets**: its own engine (no Challonge). Divisions hold brackets, which
  hold matches linked by `nextMatchGuid` / `loserMatchGuid`. Single elim,
  double elim **with a grand-final reset**, Swiss, Battle Royale. Results are
  team scores plus `winnerGuid`, with `submittedBy` / `verifiedBy`.
- **Qualifiers** come from TournamentAssistant (TA), pushed to BeatKhana by
  webhook, scored by named presets.
- Scheduling, availability, referee/caster assignment, overlays, Discord sync.

## Its API

- Documented: Swagger at https://api.beatkhana.com/docs (~300 paths),
  Socket.IO events at https://api.beatkhana.com/socket/docs, a developer
  portal at https://beatkhana.com/developers.
- **Anonymous reads work** (checked with curl): `GET /tournaments`,
  `GET /tournament/{id}` with flags `teams`, `players`, `publishedPools`,
  `matches`, `qualifierStandings`, ...; `GET /tournaments/{id}/matches` (the
  whole bracket with results).
- Team members carry `blSteamId` / `blQuestId` / `ssSteamId`, which map
  straight onto our BeatLeader players. Pool maps carry hash +
  characteristic + difficulty, which is our map key (`score-sources.ts`).
- **Writes need OAuth 2.0** (authorization code + PKCE, scopes such as
  `rest:write`), and creating an OAuth app needs a global permission BeatKhana
  hands out. "Approval only for now" - *unverified at its source*.
- The public GitHub repos (`Beatkhana/bkServer`, `bkFrontEnd`) are the old
  2023 stack with no licence; the live code is closed.

## Where each is ahead

**BeatKhana**: grand-final reset (our known gap), Swiss and Battle Royale,
divisions, registration and eligibility, staff hierarchy, scheduling,
collaborative pooling, overlays, TA qualifiers, result verification, public
discovery, a documented API.

**BSCompStats**: per-player accuracy scoring - the match points curve applied
before averaging, perfect % per map, "percent difference". BeatKhana stores
only team points per match. Pulling match runs straight from BeatLeader
(shared start time, CHECK/WAITING, fails from `/map/scorestats`, No Fail
doubling) without TA. Per-map lineups, the player pool and duo-making,
captains' drafts, match-only teams. Brackets that recompute from shape and
results, so an undone result can never leave them half-updated.

## Integration options

| Option | Feasible | Notes |
|---|---|---|
| Import teams and players | Yes, no auth | `?teams=true`; match players by BeatLeader id |
| Import map pools | Yes, no auth | `?publishedPools=true`; hash + difficulty is our key |
| Import qualifier standings as seeds | Yes, no auth | `?qualifierStandings=true` |
| Mirror a BeatKhana bracket | Yes, read-only | Convert next/loser links to `winnerOf` / `loserOf` sources |
| Deep links | Trivial | `beatkhana.com/tournaments/{id}`, `/bracket`, `/pools` |
| Embed its bracket | *Unverified* | Stream routes exist; frame headers not checked |
| Push match results to BeatKhana | Gated | Needs an approved OAuth app and an organiser signing in; only team score + winner would sync |
| TA webhooks as a live score source | Possible | Payload fields *unverified* |

## Recommendation

1. **Import from BeatKhana, read-only**: given a tournament id, bring in its
   teams and players, published pools and qualifier seeds. No auth needed;
   additive (new rows plus an optional external reference column).
2. **Link out**: store the BeatKhana tournament id and link to its pages.
3. **Add the grand-final reset ourselves** rather than leaning on BeatKhana for
   brackets: a conditional second final in `doubleElimination`. Swiss later,
   if wanted.
4. **Hold off on writing results to BeatKhana** until an OAuth app is
   approved; even then only the team score and winner would go across.
5. Don't copy BeatKhana's registration, staff or overlay features. Our edge is
   per-map accuracy scoring and pulling runs from BeatLeader.
