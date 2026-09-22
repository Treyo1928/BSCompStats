# BSCompStats - context for Claude

Self-hosted Beat Saber tournament stats: map pools with live scores, pick/ban,
lineup advice, win predictions and player stats. Replaces the MSU league's
Google Sheets. Read README.md for what the app does and why the stats model is
built the way it is; this file is what a new session needs beyond that.

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
- Tests: `npx vitest run --root packages/core` (~190 tests, ~40s).
- Core must be rebuilt before the web typecheck sees changes to it:
  `npm run build --workspace @bscs/core`. Prisma client after schema changes:
  `npx prisma generate --schema packages/db/prisma/schema.prisma` (needs
  `apt-get install -y openssl` in the container first).
- Live site: `docker compose up -d --build` (~4 min). Migrations run in the
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
               match/ optimize/
packages/db    Prisma schema + migrations (additive only so far)
```

Key server modules in `apps/web/src/server/`:
- `stats.ts` - fits the skill model per tournament, cached per (tournament,
  platform, scope); concurrent requests share one in-flight fit.
- `score-sources.ts` - loads BeatLeader + ScoreSaber scores onto common map
  keys (song hash + difficulty), best run per map. Everything reads through it.
- `board.ts` - the pool board. `loadBoardMembers` decides who is on it.
- `player-stats.ts` - the stats pages: like-for-like standings, pp profiles,
  specialty labels, views (pool/ranked/all) and platform (both/BL/SS).
- `matches.ts` + `advice-thread.ts` - match advice on a worker thread.
- `answer-card.ts` - "if they field this, what should we field".
- `draft-actions.ts`, `custom-teams.ts` - captains' drafts and match-only teams.

## Design decisions worth knowing (each was arrived at the hard way)

- **Ranks are ranks of the number shown.** On the pool: average gap to
  teammates over maps *both* have played (`stats/standings.ts`); nobody in
  common = unranked, not last. A kind of map means exactly the maps called
  that - grouping kinds into families made two pages disagree.
- **Wider views rank by pp**, overall and per kind. Accuracy on shared maps
  only says who is more accurate. Specialty = where a player's pp comes from
  (`stats/pp-profile.ts`), per platform, averaged. Three earlier attempts
  (leans vs a model prediction; BeatLeader's skill triangle vs same-pp
  players; team-relative best/worst) all mislabelled known players and were
  removed. Don't reintroduce them.
- **Both platforms count equally.** pp is never added across sites; it's shown
  side by side and combined by standing. The tournament's own prediction
  scope (`statsScope`) is separate from the stats-page view.
- **History downloads go back forever and record completion**
  (`historyBackfilledTo`, `ssBackfilledAt`). A backfill that stopped at the
  first already-stored page silently lost most of players' history.
- **Win chances**: per-map figure is best lineup vs best lineup, where "best"
  is a genuine best response (they field what's hardest for us; we answer
  that), averaged with the reverse. The lineup panel models the opponent as a
  captain (alternating best responses, `BEST_RESPONSE_ROUNDS`) - assuming a
  roster rotation made a two-stars-two-passengers team a 97% favourite.
  Averaging over every possible lineup is shown only as detail.
- **The skill fit runs to convergence, and factors are shrunk hard.** Forty
  fixed sweeps left a one-factor fit mid-drift (a factor of -0.37 that settles
  at +0.33), and a factor ridge of 0.3 let ten acc-map scores put gayalex5 at
  93% on Spin Eternally, above LS who beats them everywhere - the outlook
  called the map lost. Now: sweep until nothing moves (`tolerance`), factor
  ridge 1-3 in the CV grid, and a more complex model must win held-out error
  by 1% or the simpler one is kept. `stats/fixtures/msu-fall-2026.json` is the
  regression case.
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
  player's score on the map, full weight - the user's rule, deliberately.
  A 17-second quit at 38% *is* what that player would have scored had they
  kept going, and numbers like that were never predicted before because
  nothing on a leaderboard shows them. Don't weight or soften it. On the
  board it is a score cell (heat colour, in the average, `isRun` with a ✗
  corner icon), not a warning box. Unplayed cells are capped by the player's
  real score on any easier map less the difficulty gap (`cappedBy` in
  `predictWith`): the additive fit cannot express "fine on acc maps, collapses
  on hard ones" and Huber treats such scores as outliers. The fail model
  takes runs as `outcomes`, never into a map's rate.
- **Anomalies are dramatic.** The abandoned-run floor is 60% of the player's
  median (was 85%: it wrote off PretzelBread's 74.5% and 70.4% on Hush and
  Pedi, which are real); below 35% is an anomaly outright even with no column
  (zolism's 0.08% and 0.01%). The user wants bad-but-real scores counted.
- **Map kinds** come from an organiser's tag (`PoolMap.category`, settable on
  the pool page) or a guess from BeatLeader ratings (`categorizeMap`). Kinds
  are spelling-normalised (`canonicalKind`). Changing a tag invalidates the
  model cache.
- **Match-only (`adHoc`) teams** are real Team rows; listed behind a tab,
  removed with their last match.

## State of play (2026-09-22)

`master` is at the ScoreSaber commit. Branch `match-only-tabs` holds
uncommitted work, all deployed and checked live: match-only team tabs, the
two win-chance fixes, the opponent-captain model, per-map outcomes in the
strategy panel, the answer-card modal with inference, the converged fit with
the tightened factor grid, the pool outlook's opponent expected-acc column
and column notes, and recorded runs from BeatLeader (fails on the board and
in the model, "Recorded runs" panel on the player page). Not yet checked in a
real browser: the Teams-page ScoreSaber search tabs and link button, the SS
markers on the pool board, and the answer-card modal itself (its action was
exercised directly).

Known rough edges: labels for players with <20 ranked scores still come from
shared maps and are approximate; the ratings guess for map kinds is often wrong
for unranked maps (organiser tags fix it per pool; BeatSaver tags were
discussed as a source, not built); the "Suggested pick" reason text is long.
