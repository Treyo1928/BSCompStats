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
| `GET /api/v1/tournaments/:slug` | `{ tournament, matches, brackets, pools, teams }`: pick the match to follow. `teams` is every team entered, as shown on stream: `{ id, name, color, colorSecondary, logo, players: [{ id, name, avatar, replays }] }` (see `teamA` below) |
| `GET /api/v1/matches/:matchId` | `{ match }`, everything about a match (below) |
| `GET /api/v1/brackets/:bracketId` | `{ bracket }`: every slot with section, round, teams, state, winner and its match (maps won), plus standings |
| `GET /api/v1/matches/:matchId/events` | server-sent events: `event: match` with the full match on connect and after every change; in TA mode also `event: live` while a song plays ([TA mode](#ta-mode)) |

The **match** object is what the match page shows:

- `state`: `PICKBAN`, `PLAYING`, `COMPLETE`. Also `format`, including `playOrder` (`PICKS_FIRST` / `PLAY_EACH_PICK`)
  and `playersPerMap`.
- `teamA`, `teamB`: names, colours, `logo`, rosters. `logo` is `null` (the default star), `"msu"` (the MSU Esports
  shield) or the path of an uploaded picture (`/api/img/<id>` on this site, public, cacheable for good). Each
  player is `{ id, name, avatar, replays, beatLeaderId, taPlatformId }`. `name` and `avatar` are as the tournament
  shows them: an organiser's nickname and uploaded picture where set (Teams page, "On stream"), else BeatLeader's;
  an uploaded `avatar` is a path like `logo`. `replays` are the replays the player chose to show on stream, as
  viewer links (`https://replay.beatleader.com/?scoreId=…`, or a `.bsor` address).
  `beatLeaderId` is the Steam64 id for Steam players (the same id TournamentAssistant uses) but BeatLeader's own
  id for Quest players, so an organiser can set `taPlatformId` (on the Teams page, "TA id") where TA knows them by
  another; it is `null` when unset. `coinFlipWinnerId`, `winnerId`.
- `taMode`: the match runs through TournamentAssistant (see [TA mode](#ta-mode)). `ta`: `{ host, port, liveUrl }`
  for such a match when the tournament is connected to TA, else `null`.
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
| `startMap` | `matchMapId` | TA mode, staff: load the map in TA for the players in its lineups |
| `playMap` | `matchMapId` | TA mode, staff: start the song for all of them at once (refused, 409, until TA reports everyone ready) |
| `restartMap` | `matchMapId` | TA mode, staff: load it again after a failed or aborted start, or to play it over |
| `cancelStart` | `matchMapId` | TA mode, staff: take the request back; players go back to the menu (fine if there is none) |

### Example: one step from a shell

```bash
curl -s -X POST "$SITE/api/v1/matches/$MATCH/actions" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"action":"pick","teamId":"…","poolMapId":"…"}'
```

## TA mode

For matches run through [TournamentAssistant](https://github.com/MatrikMoon/TournamentAssistant): an organiser
loads each map for the players in its lineups and then starts the song for all of them at the same moment, and the
scores come from TA rather than BeatLeader.

**The site does the TA side itself.** Its worker holds the connection to the TA server; a tournament admin connects
the tournament once on its **TA** page (which TA server, a sign-in, the TA tournament players join in game). There
is no separate bridge program and nothing to report over this API: you ask for a map to be loaded or started, and
read how it goes.

TA mode is set per match when the match is made (`taMode`), defaulting to the tournament's setting. In a TA-mode match:

- Only organisers pick and ban, for both teams. A captain's `pick`/`ban` is refused with **403**. Captains still set
  their own lineups.
- `pullScores` is refused (**409**) and the site hides its button.
- The map to play next (the first planned map whose scores are open, the tiebreaker last) can be loaded once both
  lineups are set and the tournament is connected to TA. A staff `startMap` records the request; anything else is
  **409** with the reason (lineups not set, not the next map, already requested, scores closed, not connected to TA).

Each planned map has `start`, `null` until a load is requested:

```json
"start": {
  "requestedAt": "2026-11-09T19:30:00.000Z",
  "requestedBy": { "id": "…", "name": "Org Anizer" },
  "playRequestedAt": null,
  "status": { "phase": "loading", "reportedAt": "2026-11-09T19:30:02.412Z",
              "players": [ { "playerId": "…", "state": "ready" }, { "playerId": "…", "state": "loading" } ] }
}
```

`status` is `null` for the moment before the worker picks the request up, then how it stands (with `reportedAt`,
server time):

| `phase` | Meaning |
|---|---|
| `waiting` | a lineup player is not connected to the TA tournament (`state: "missing"`); it carries on by itself when they join |
| `loading` | a TA match was made with the players and their games are fetching the map |
| `ready` | everyone has the map. Nothing more happens until `playMap` |
| `playing` | the song is running for all of them; `startedAt` says since when |
| `finished` | their scores are on the map, `source: "TA"`. `message` names anyone whose score is missing |
| `error` | it stopped; `message` says why (a map that would not load, the TA connection dropping). `restartMap` begins again |

`players[].state` is `loading`, `ready`, `playing`, `finished`, `failed` (could not load the map, or failed the
song), `quit` (left the song, or their game dropped off TA) or `missing`. Finished players carry `score` and
`accuracy` (0..1, of the whole map).

`playMap` sets `playRequestedAt` and the song starts within a second or two. `cancelStart` puts `start` back to
`null` and sends the players back to the menu; so does any change to either lineup of that map (TA must not start
the wrong players) and a replay being called. `restartMap` gives a new `requestedAt`, clears `status` and
`playRequestedAt`, and loads the map again: after a `finished` run that is "play it again", and when the song
starts the earlier scores of that run are dropped. After a team calls a replay, the next start is the map's run 2
and its scores are kept beside run 1's. Once the map's scores are closed, `start` stays as a record.

A song that ran cleanly closes its own map: when a score came from TA for every lineup player, the worker closes
the map in the same step as it enters the scores (the TA page's "Close the map by itself", on by default). If
someone left the song or dropped off TA the map stays open and an organiser closes it (`closeMap`) once it is sorted
out. A closed map makes the next one startable, and an organiser can reopen it (`reopenMap`). Scores can still be typed
(`scores`, marked `MANUAL`) where TA could not say, and a tool may enter them as TA's with `source: "TA"`
(organiser keys, TA-mode matches only; `accuracy` 0..1 and `misses` optional).

### Live scores and live replays

While a song plays, `GET /api/v1/matches/:id/events` also sends `event: live` about four times a second:

```json
{ "matchId": "…", "matchMapId": "…", "phase": "playing", "startedAt": 1794260096669, "at": 1794260101250,
  "players": [ { "playerId": "…", "teamId": "…", "slot": 0, "platformId": "7656119…", "score": 153694,
                 "accuracy": 0.9712, "combo": 212, "misses": 1, "songPosition": 41.3, "finished": false } ] }
```

`accuracy` here is of the notes so far, as shown in game. `startedAt` and `at` are Unix milliseconds. One last
event with `phase: "over"` follows when the song is finished or cancelled. A key that may not see a hidden (blind)
lineup does not get that lineup's players.

TA also streams each player's live replay (when the TA tournament has replay streaming on, which the TA page shows
and switches). The match's `ta.liveUrl`, with `{platformId}` replaced by a player's `platformId` from a `live`
event (or `taPlatformId ?? beatLeaderId` beforehand), is that player's stream: a websocket of TA's
`ReplayStreamPacket` protobuf messages, silent until they start a song. A replay viewer that understands it can
draw the gameplay as it happens.

## Mock tournament (try it by hand)

`scripts/mock.sh` starts a throwaway copy with the same fixture tournament on http://127.0.0.1:3100 and prints
sign-in links for each role (a dev-only sign-in, so no Discord app is needed) plus the API keys. Ctrl+C throws
it all away. It needs Docker for Postgres and Redis only.

## Tests

`scripts/test-integration.sh` runs a throwaway Postgres + Redis, applies the migrations, seeds the fixture
tournament (`apps/web/test/fixture.ts`: four MSU-style teams, three pools, a bracket whose final has its own pool,
and keys for every role), starts the app and drives full matches through this API. `KEEP=1` leaves it running
to try by hand. The fixture's keys are in `apps/web/test/.fixture.json`.
