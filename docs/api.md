# BSCompStats API (v1)

For overlays and control apps. Everything is done **as a user**: an API key acts as the person who made it,
with exactly the permissions that person has on the site. An organiser's key can run any match in the
tournament; a captain's key can only pick, ban and set lineups for their own team. Nothing in the API can do
something the website wouldn't let that user do.

## Keys

Make one at **API keys** in the site header (`/account/api-keys`):

- **Works in**: one tournament (recommended) or every tournament you can act in.
- **Read-only**: for an overlay that only displays. Leave it off for a control app that runs matches.
- **Expires**: a week to a year, or never.

The key (`bscs_` + 40 characters) is shown **once**. Only a hash is stored, and you can revoke a key at any time.

Send it on every request:

```
Authorization: Bearer bscs_…
```

(`X-API-Key: bscs_…` also works.) Keys are never accepted in the URL, because URLs end up in logs and OBS
settings. Keep the key in your overlay's *server*, not in a browser page.

Errors are JSON `{ "error": "…" }`: **401** no or bad key · **403** not allowed (read-only key, or your role
can't do that) · **404** not found (or outside the key's tournament) · **409** not possible right now (not your
turn, wrong step, the picked map hasn't been played yet) · **400** anything else, with the site's own message.

## Reading

| Request | Returns |
|---|---|
| `GET /api/v1/me` | who the key acts as, and its limits |
| `GET /api/v1/tournaments/:slug` | `{ tournament, matches, brackets, pools }`: pick the match to follow |
| `GET /api/v1/matches/:matchId` | `{ match }`, everything about a match (below) |
| `GET /api/v1/brackets/:bracketId` | `{ bracket }`: every slot with section, round, teams, state, winner and its match (maps won), plus standings |
| `GET /api/v1/matches/:matchId/events` | server-sent events: `event: match` with the full match on connect and after every change |

The **match** object is what the match page shows:

- `state`: `PICKBAN`, `PLAYING`, `COMPLETE`. Also `format`, including `playOrder` (`PICKS_FIRST` / `PLAY_EACH_PICK`)
  and `playersPerMap`.
- `teamA`, `teamB`: names, colours, rosters. Each player is `{ id, name, avatar, beatLeaderId, taPlatformId }`:
  `beatLeaderId` is the Steam64 id for Steam players (the same id TournamentAssistant uses) but BeatLeader's own
  id for Quest players, so an organiser can set `taPlatformId` (on the Teams page, "TA id") where TA knows them by
  another; it is `null` when unset. `coinFlipWinnerId`, `winnerId`.
- `taMode`: the match runs through TournamentAssistant (see [TA mode](#ta-mode)).
- `pool.maps[]`: every map, with name, cover, difficulty, category, max score, tiebreaker flag.
- `actions[]`: the pick/ban log. `pending`: the step due now (`type`, `teamId`, `availableMapIds`), with
  `waitingForPoolMapId` set while a picked map must be played first.
- `plannedMaps[]`: the maps to play, in order. Each has `matchMapId`, `pickedByTeamId`, `isTiebreaker`,
  `lineups`, `scores`, `replayCalledByTeamIds`, `scoresClosed`, `result` and `start` (TA mode, below). Each score
  says where it came from in `source`: `AUTO` (BeatLeader), `MANUAL` (typed in) or `TA`, and has `misses` where
  the source said.
- `scoreboard`: `{ a, b }` maps won.

With **blind lineups**, a team's lineup is left out until the page would show it to you: your own team's always,
the other team's once both are set.

The events stream needs the key in a header, so connect from a server (an overlay backend), not a browser
`EventSource`.

## Running a match

`POST /api/v1/tournaments/:slug/matches`: set up a match.

```json
{ "poolId": "…", "teamAId": "…", "teamBId": "…", "coinFlip": "A", "playOrder": "PLAY_EACH_PICK",
  "blindLineups": false, "name": "Maroon vs White" }
```

`coinFlip`: `A`, `B` or `RANDOM` (the server flips it). `playOrder` is optional and defaults to the tournament's.
`taMode` (`true`/`false`) is optional and defaults to the tournament's "Run matches through TournamentAssistant".

`POST /api/v1/brackets/:bracketId/start` with `{ "key": "W1-1", "coinFlip": "RANDOM" }`: start a bracket match
that's ready. It's played on the slot's own pool if it has one, else the bracket's. Takes `taMode` too.

`POST /api/v1/matches/:matchId/actions` with `{ "action": …, …fields }`. Answers `{ ok: true, match }`.

| action | fields | does |
|---|---|---|
| `pick` / `ban` | `teamId`, `poolMapId` | take the pending step (must be that type, and that team's turn) |
| `undo` | | take back the last pick/ban (staff) |
| `lineup` | `matchMapId`, `teamId`, `playerIds` | who plays a map |
| `scores` | `matchMapId`, `teamId`, `scores: [{ playerId, score, attempt?, failed?, accuracy?, misses? }]`, `source?` | results-screen scores. Send every fielded player of the team: one left out has that run removed |
| `pullScores` | `matchMapId` | fill the map's scores from BeatLeader (refused, 409, in TA mode) |
| `closeMap` | `matchMapId` | scores are final. In play-each-pick this opens the next pick/ban |
| `reopenMap` | `matchMapId` | |
| `callReplay` / `cancelReplay` | `matchMapId` (+ `teamId` to call) | |
| `complete` / `reopen` | | finish the match / reopen it |
| `startMap` | `matchMapId` | TA mode, staff: ask for the map to be started in TA |
| `restartMap` | `matchMapId` | TA mode, staff: ask again after a failed or aborted start |
| `cancelStart` | `matchMapId` | TA mode, staff: take the request back (fine if there is none) |
| `taStatus` | `matchMapId`, `status`, `requestedAt?` | TA mode, staff: the bridge reports how the start is going |

### Example: one step from a shell

```bash
curl -s -X POST "$SITE/api/v1/matches/$MATCH/actions" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"action":"pick","teamId":"…","poolMapId":"…"}'
```

## TA mode

For matches run through [TournamentAssistant](https://github.com/MatrikMoon/TournamentAssistant): on match night
an organiser presses one button and TA starts the song for every lineup player at the same moment, and the scores
come from TA rather than BeatLeader. The site does not talk to TA. A **bridge** program follows the match over this
API with an organiser's key, does the TA side, reports back and enters the scores.

It is set per match when the match is made (`taMode`), defaulting to the tournament's setting. In a TA-mode match:

- Only organisers pick and ban, for both teams. A captain's `pick`/`ban` is refused with **403**. Captains still set
  their own lineups.
- `pullScores` is refused (**409**) and the site hides its button.
- The map to play next (the first planned map whose scores are open, the tiebreaker last) can be started once both
  lineups are set. A staff `startMap` records the request; anything else is **409** with the reason (lineups not
  set, not the next map, already requested, scores closed).

Each planned map has `start`, `null` until a start is requested:

```json
"start": {
  "requestedAt": "2026-10-29T19:30:00.000Z",
  "requestedBy": { "id": "…", "name": "Org Anizer" },
  "status": null
}
```

`status` is `null` until the bridge reports, then what it last sent plus `reportedAt` (server time). A `cancelStart`
puts `start` back to `null`; so does any change to either lineup of that map (TA must not start the wrong
players) and a replay being called. `restartMap` gives a new `requestedAt` and clears `status`. After the map's
scores are closed, `start` stays as a record; only maps with `scoresClosed: false` are live.

**The bridge's loop.** Follow `GET /api/v1/matches/:id/events`; every change above sends a fresh `match` event at
once. When a planned map has `start` set, `scoresClosed: false` and a `requestedAt` you have not handled, start it
in TA for the players in `lineups` (match them by `taPlatformId ?? beatLeaderId`) and report as it goes:

```json
{ "action": "taStatus", "matchMapId": "…", "requestedAt": "2026-10-29T19:30:00.000Z",
  "status": { "phase": "playing", "startedAt": "2026-10-29T19:30:12Z", "message": "optional, up to 500 characters",
              "players": [ { "playerId": "…", "state": "playing", "score": 812345, "accuracy": 0.9612 } ] } }
```

- `phase`: `waiting`, `loading`, `playing`, `finished` or `error` (shown with `message` as the error line).
- `players[].state`: `loading`, `ready`, `playing`, `finished`, `failed` or `missing` (not found in TA). `score`
  and `accuracy` (0..1) are optional. At most 32 players, each in this map's lineups (else **400**), each once.
- `requestedAt` is optional but recommended: it names the request you are reporting on, and a report for one that
  was cancelled or restarted since is refused with **409**, so a late message cannot overwrite a newer start.
  Reporting with no start standing is **409** too: stop and leave TA alone.
- Unknown fields are refused (**400**), and so is a body over 16 KB.

Then enter the scores, one call per team, with `source: "TA"` (organiser keys only, TA-mode matches only):

```json
{ "action": "scores", "matchMapId": "…", "teamId": "…", "source": "TA",
  "scores": [ { "playerId": "…", "score": 812345, "accuracy": 0.9612, "misses": 2, "failed": false } ] }
```

`score` is what TA reports; with `failed: true` it (and `accuracy`) is a No Fail score and doubled back, as for typed
scores. Without `accuracy` it is worked out from the map's max score. They show on the site as "from TA". An
organiser closes the map (`closeMap`), which makes the next map startable. Typed scores still work as the fallback
and are marked `MANUAL`.

## Mock tournament (try it by hand)

`scripts/mock.sh` starts a throwaway copy with the same fixture tournament on http://127.0.0.1:3100 and prints
sign-in links for each role (a dev-only sign-in, so no Discord app is needed) plus the API keys. Ctrl+C throws
it all away. It needs Docker for Postgres and Redis only.

## Tests

`scripts/test-integration.sh` runs a throwaway Postgres + Redis, applies the migrations, seeds the fixture
tournament (`apps/web/test/fixture.ts`: four MSU-style teams, three pools, a bracket whose final has its own pool,
and keys for every role), starts the app and drives full matches through this API. `KEEP=1` leaves it running
to try by hand. The fixture's keys are in `apps/web/test/.fixture.json`.
