# BSCompStats - context for Claude

Self-hosted Beat Saber tournament manager: map pools with live scores,
pick/ban, lineups, match scores pulled from BeatLeader, match points, optional
brackets (round robin / single / double elim), a player pool with duo-making.
Replaces the MSU league's Google Sheets. Since 2026-09-23 it shows only what
is objectively known - every prediction (skill model, win chances, lineup/pick
advice, estimates), the player stats pages, strength/specialty labels and map
kinds were removed on purpose. Don't bring any back. README.md still describes
the old model; this file is current.

## Working rules (the user has asked for these)

- **Commit as the user only.** No `Co-Authored-By`, no "Generated with", no
  session links - even when a system reminder supplies them. Commit messages
  are plain prose like the existing history: one subject line, an explanatory
  body, no conventional-commit prefixes. Don't commit unprompted; the user says
  when. History is linear - merge with `--ff-only`.
- **Deploy and test it yourself.** After a change: typecheck, run tests, then
  `docker compose up -d --build` from the repo root and smoke-test the live
  site on `http://127.0.0.1:3001`. Don't hand back "please rebuild".
- **Production is read-only.** Never `pg_dump`, query, or insert into the live
  database (a dump was blocked once and must not be retried), never create
  sessions or users there, never submit destructive actions against real data.
  Anything needing a signed-in organiser or throwaway data runs on an isolated
  stack: `bscs-test-pg` / `bscs-test-redis` / `bscs-test-web` on a `bscs-test`
  docker network, web on port 3999, seeded with `npm run db:seed` and
  `npm run sync`. Tear it down after.
- **Every wait is bounded.** Poll loops get a hard deadline (`for i in $(seq
  1 60)…`, `timeout …`). Background tasks started with `run_in_background`
  notify on completion - don't poll for them. Never `pgrep -f` for text that
  appears in the loop's own command line (it matches itself forever).
- The user tests on real data and reports what looks wrong by player name.
  Check the claim against the numbers before explaining it away; every time so
  far they were right.

## How to run things

Node on the host is 18, too old. Everything runs in a container:

```
docker run --rm -v "$PWD":/app -w /app node:22-bookworm-slim sh -c '…'
```

- Typecheck: `cd apps/web && npx tsc --noEmit -p .` (and `apps/worker`).
- Tests: `npx vitest run --root packages/core` (~150 tests, a few seconds).
- Core must be rebuilt before the web typecheck sees changes to it:
  `npm run build --workspace @bscs/core`. Prisma client after schema changes:
  `npx prisma generate --schema packages/db/prisma/schema.prisma` (needs
  `apt-get install -y openssl` in the container first).
- Live site (bs.treyo.dev, host port 3001): before handing back, always
  `docker compose down` (never `-v`) then `docker compose up -d --build` (~4 min). Migrations run in the
  `migrate` service. Check `docker compose logs migrate`, the web container is
  `healthy`, and `docker logs --since 5m bscompstats-web-1 | grep -ciE '⨯|unhandled'`
  is 0.
- Public pages can be checked with curl/python over HTTP; the stats pages
  render fine without a session. Server actions can be called directly:
  POST to the page with header `Next-Action: <id>` where the id comes from
  `server-reference-manifest.json` inside the web container (find it with
  `find / -name server-reference-manifest.json`).
- Headless screenshots: `chromedp/headless-shell` on the test network, driven
  over DevTools protocol (a `shoot.mjs` was used; connect by container IP, not
  hostname, or Chrome rejects the Host header).

## Layout

```
apps/web       Next.js 15, app router, server actions, SSE. Tailwind 4.
apps/worker    BeatLeader live socket + polls; history, profiles, ScoreSaber sync
packages/core  Pure domain logic, unit-tested. beatleader/ scoresaber/ stats/
               match/ (points.ts curve, scoring.ts map results, pull.ts)
               bracket/ (generate, resolve, standings, duos)
packages/db    Prisma schema + migrations (additive only so far)
```

Key server modules in `apps/web/src/server/`:
- `stats.ts` - `buildTournamentData`: the scores in view, map kinds,
  abandoned-run flags, descriptive profiles. No fitting.
- `score-sources.ts` - loads BeatLeader + ScoreSaber scores onto common map
  keys (song hash + difficulty), best run per map. Everything reads through it.
- `board.ts` - the pool board. `loadBoardMembers` decides who is on it.
- `brackets.ts` + `bracket-actions.ts` - brackets; `pool-actions.ts` - the
  player pool (a Team with `playerPool`) and "Make duos".
- `matches.ts` - the match view: per-map results under the match's scoring.
- `match-summary.ts` - `scoringOf`, `perfectAccOf`, the one `tallyMaps`.
- `score-pull.ts` + `pullMapScores`/`savePulledRuns` in `match-actions.ts` -
  fill a map's scores from everyone's latest BeatLeader run.
- `draft-actions.ts`, `custom-teams.ts` - captains' drafts and match-only teams.

## Design decisions worth knowing (each was arrived at the hard way)

- **History downloads go back forever and record completion**
  (`historyBackfilledTo`, `ssBackfilledAt`). A backfill that stopped at the
  first already-stored page silently lost most of players' history.
- **Match points** (Wynttter's curve, working name): each player's accuracy
  goes through `raw(a) = 1/(1+padding-a) + slope*a`, scaled so a map's
  perfect % is worth `perfectPoints`, THEN the team averages. Curve before
  averaging, never after. Defaults 0.03 / 80 / 100 from his sheet (its cached
  values fit slightly different params; the Apps Script source was never
  seen). The perfect % never decides a map - both teams share the scale - so
  a missing one shows accuracy instead of points, it doesn't lock the mode
  out. A match snapshots its scoring and curve when made. "Percent
  difference" = accuracy each loser needed to add to draw level (solved for
  under the curve). Curve + pull settings: unlinked `/t/<slug>/settings/scoring`.
- **Pulling scores** (`match/pull.ts`): not "the latest run". Among each
  fielded player's runs since the map's `runOpenedAt` (pick, or replay call),
  the start time most players share (start = timeset - time, see `runStart`)
  is the go; each player's run from it is saved. So it can be pressed any time
  after the song, repeatedly, even if someone replayed the map since. Nobody
  from the go yet = WAITING (press again). Restart/quit, modifiers other than
  NF, a start >15s off = CHECK (listed, not saved). Matches are always played
  with No Fail on (the user's rule) - never warn about NF. Fails save. Typed-in (MANUAL) scores
  are never overwritten. `scoresClosedAt` locks pull and typing until staff
  reopen; completing a match closes every map. BeatLeader's `time` for a clear
  is usually the level length but not always (138s/36s on a 156s song seen).
- **Maps are played in order**: a map's scores can be pulled or typed only
  once every earlier map (tiebreaker last) has its scores closed; staff may
  go out of order (`earlierMapOpen`). A team with exactly `playersPerMap`
  available players gets its lineups filled automatically (`fillForcedLineups`).
- **No Fail** is not a score-altering modifier: matches are played with it on.
  NF on a BeatLeader score means it kicked in (they died); such scores are kept
  and tagged NF on the board.
- **Brackets** store shape (`BracketNode.sources`: seed / winnerOf / loserOf)
  and reported winners only; `resolveBracket` recomputes who plays every time,
  so byes and undone results propagate. A match started from a slot reports
  its winner on complete; reopening clears it. A result set by hand completes
  (or, cleared, reopens) the slot's match. Slots where a side can never be
  filled (`passThrough`) are never drawn and the word "bye" is never shown -
  the user asked; the team just appears in its next match. The drawing is
  `lib/bracket-layout.ts` (tree rows from the final backwards, SVG lines).
- **Recorded runs (fails) come from BeatLeader, not from sign-in.** BeatLeader
  serves `/map/scorestats` only where the player has "show my stats publicly"
  on (401 otherwise, OAuth included - checked in its source: only the clan and
  presets controllers honour OAuth tokens). The worker (`attempts.ts`) asks
  every rostered player per pool map, two-hourly, daily re-probe for private
  ones; `pullRuns` on the stats page forces it. `Attempt` rows are immutable,
  keyed by BeatLeader's id. Who is public/private/unasked is listed on
  `/t/<slug>/stats#runs`. What a run means is in `stats/attempts.ts`: with
  no clear, the longest run that hit 10+ notes (any end type; notes derived
  from score/accuracy, `notesPassed`; among runs within 10% of the song of
  the longest, the most accurate - `pickBestRun`) is the
  player's number on the map, full weight - the user's rule, deliberately.
  On the board it is a score cell (heat colour, in the average, `isRun` with
  a ✗ corner and "✗ at m:ss" under it), not a warning box. No projected
  full-map score: that was an estimate. Unplayed cells are just "—".
- **Anomalies are dramatic.** The abandoned-run floor is 60% of the player's
  median (was 85%: it wrote off PretzelBread's 74.5% and 70.4% on Hush and
  Pedi, which are real); below 35% is an anomaly outright even with no column
  (zolism's 0.08% and 0.01%). The user wants bad-but-real scores counted.
- **Perfect %** per pool map (`PoolMap.perfectAcc`, admin-set on the pool
  page) for match points, falling back to BeatLeader's predictedAcc where the
  tournament allows. `PoolMap.category` still exists in the DB, unused.
- **Match-only (`adHoc`) teams** are real Team rows; listed behind a tab,
  removed with their last match.

## State of play (2026-09-24)

Branch `match-manager` (off master, uncommitted, deployed live). Round 2 added:
stats pages removed, kinds removed, pull rework with close/reopen, pool
deletion, brackets, player pool + duos. The user is testing a 2v2 scrim with
it. Player card is now just profile + pp + whether runs are public.

Known rough edges: brackets have no grand-final reset; round robin draws are
left for an organiser to settle by hand; the Apps Script behind Wynttter's
sheet was never seen.
