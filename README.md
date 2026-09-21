# BSCompStats

Self-hosted Beat Saber competitive stats, map pools and match management.

Replaces the Google Sheets + Apps Script setup the MSU Beat Saber league runs
on: a qualifiers board that pulls scores from BeatLeader, and a per-match sheet
that tracks pick/ban, duo lineups and combined scores. This does both, live,
with accounts — and adds the things a spreadsheet cannot do: predictions for
maps nobody has played, a fail model, and a recommendation engine that will tell
a captain when to deliberately give a map away.

```bash
cp .env.example .env     # set AUTH_SECRET and POSTGRES_PASSWORD at minimum
docker compose up -d
```

Then open http://localhost:3000. The first account to sign in becomes the
administrator.

---

## What it does

**Map pools from a playlist.** Paste a BeatLeader playlist link, a direct link
to any `.bplist`, or upload the file. Every map resolves to its BeatLeader
leaderboard, with the authoritative max score, in one API call per song.

**A live pool board.** Every player against every map, with score, accuracy and
replay links, shaded per column so a 98% on an easy map is not confused with a
91% on a hard one. Scores arrive within a second of being set — BeatLeader
broadcasts every score on a websocket, and the worker filters it to the players
you track. No refresh button required (there is one anyway).

**Matches with real pick/ban.** Each captain signs in and makes their own picks
and bans. The server replays the action log to decide whose turn it is, so a
stale tab cannot pick a banned map and two captains clicking at once cannot both
succeed. Organisers can act for a captain, and it is recorded as such.

**Lineup rules that are actually enforced.** The duo rule — no pairing used
twice, tiebreaker exempt — is validated across the whole card as the captain
builds it, because it is a constraint *between* maps and no single control can
see it. Incomplete lineups warn; illegal ones block. An organiser can override,
and a captain who is also an organiser can override their own, which is the
normal case for friendly scrims.

**Recommendations, including when to lose on purpose.** See
[The recommendation engine](#the-recommendation-engine).

**Custom matches and captains' drafts.** For sides that are not tournament
teams - a mixed scrim, a stand-in roster. Name both sides outright (the same
player may be on both), or pick two captains and a pool of players and let them
take turns, snake or alternating, each from their own phone. With an odd number
the last player left can play for both teams. The sides are real teams for the
length of the match, so lineups, advice and captain permissions all work, and
they are tidied away when the match is deleted.

**Player stats.** On the pool, players are ranked on like-for-like comparisons:
the average gap to teammates over the maps both have actually played, overall
and per kind of map, and the rank is always a rank of the number shown beside
it. Across whole histories that only says who is more accurate, so the Ranked
and All views rank by pp instead - overall and earned on each kind of map - and
a player's specialty is read from where their pp comes from. Tap any player,
anywhere, for a card with their overview and links on.

**BeatLeader and ScoreSaber, equally.** Steam players are linked to ScoreSaber
by themselves; anyone else pastes a profile, or an organiser finds them from
the roster. Scores from both feed the same stats - a player's score on a map is
their best on either site - and a Platform switch shows one site alone. pp from
the two is never added: it is shown side by side and combined by standing.

**Map kinds you can correct.** A map's kind (Acc, Tech, Speed...) is guessed
from BeatLeader's ratings until an organiser sets it on the pool page.

**Built for a phone.** Match night happens standing next to a headset.

**Deep player stats.** Skill and consistency derived from the score matrix,
per-map predictions with confidence, fail probability, hand balance, FC and miss
rates, category affinity, and score history built from the live feed.

---

## How the stats work

The obvious approach is to model each player against BeatLeader's per-map
`accRating` / `passRating` / `techRating` vector. That does not work here, and
it is worth knowing why before you go looking for it.

**Tournament pools are unranked.** Of the seven maps in the MSU pool, exactly
one is ranked. The other six return `null` for stars and every rating. A model
built on those features would have no features at all. What unranked maps *do*
expose is `maxScore`, note counts, NJS and NPS — and, more importantly, the
scores of everyone else who played them.

So the model learns from the score matrix itself:

```
logit(acc[player][map]) ≈ μ + playerSkill[player] + mapDifficulty[map]
```

Four things make it hold up in practice:

- **Logit space.** Accuracy clusters between 0.90 and 0.99, where an additive
  model on raw values wastes its range and can predict above 100%.
- **Robust fitting with a scale per map.** Spin Eternally scatters the field
  across forty points; Sentiment holds it within two. Residuals are judged
  against their own map's spread, a high-scatter map counts for less when
  estimating a player's general level, and predictions on it carry visibly
  wider uncertainty whatever their mean.
- **Anchoring to real scores.** Where a player has played a map, the prediction
  moves most of the way to what they actually scored. See below for why.
- **Ridge shrinkage.** A player with two scores is pulled toward the field
  average rather than crowned on a sample of two.

### Two kinds of terrible score

The MSU board has four scores far below their player's norm, and they are not
the same thing:

- **Alex, 20.36% on Madeleine.** Everyone else on that map is between 96% and
  98%. An abandoned run. Counting it would predict 20% for him on the easiest
  map in the pool.
- **Kadence 50.45%, Wyatt 51.53%, Mia 70.97% on Spin Eternally.** They did fail
  it, but it is a map beyond them, in a column that runs from 50% to 92%. Those
  are their real scores on it. A captain asking "can Kadence play Spin?" needs
  the answer 50%.

An earlier version flagged all four, using only the player's own history, and
told that captain 88%. A player's history cannot tell these cases apart; the
map's column can. A score is an anomaly only when it is **both** far below the
player's own median **and** an extreme low outlier among everyone else's scores
on that map (more than 4 robust deviations, leave-one-out, in logit space):

| Score | vs own median | deviations below column | Verdict |
|---|---|---|---|
| Alex / Madeleine 20.36% | 0.21× | 15.3 | anomaly |
| Kadence / Spin 50.45% | 0.53× | 2.3 | real score |
| Wyatt / Spin 51.53% | 0.54× | 2.2 | real score |
| Mia / Spin 70.97% | 0.74× | 1.1 | real score |
| Kaiden / Sentiment 89.83% | 1.00× | 5.8 | real score |

Kaiden's row is why the column test alone is not enough: it would flag a
genuinely weaker player for being weaker. With fewer than three other scores on
a map there is no column to judge by, and a bad score is taken at face value
until there is.

Anomalies are down-weighted in the fit, shown dark red on the board, left out
of field means and player averages, never anchor a prediction, and feed a small
separate probability of throwing a run away. Everything else is a score.

### Why predictions are anchored, not modelled better

The tempting fix for "the model says 88% where she scored 50%" is a richer
model. That was tried and it does not work. Blind prediction - hold the score
out, refit, predict it:

| Model | Kadence on Spin, blind | Blind error on Spin | on other maps |
|---|---|---|---|
| *actual* | *50.5%* | | |
| Additive | 86.2% | 14.1 | 1.00 |
| + per-map discrimination (IRT-style), λ=0.5 | 85.9% | 13.4 | 1.07 |
| + per-map discrimination, λ=0.05 | 80.4% | 15.0 | 1.41 |
| + 1 latent factor | 86.1% | 16.5 | 1.37 |

At λ=0.05 the *in-sample* gap collapsed to under 5 points, which looked like a
fix and was memorisation. Nothing predicts that a 96% player will score 50% on
one particular map from seven scores a map. The discrimination term was removed.

It also does not need predicting: she has played the map. The model's miss on a
played cell is part repeatable and part run-to-run noise, and leaderboard scores
are personal bests that repeat well. So the prediction moves at least 85% of the
way to the real score, and further where the map's scatter dwarfs run-to-run
noise - on Spin Eternally, 96%:

| | Model alone | Actual | Prediction used |
|---|---|---|---|
| Kadence / Spin | 83.7% | 50.45% | 52.8% (47.6-58.0) |
| Wyatt / Spin | 85.3% | 51.53% | 53.0% (47.8-58.2) |
| Mia / Spin | 85.9% | 70.97% | 72.0% (67.7-76.1) |
| Cat / Spin | 89.0% | 90.46% | 90.4% (88.4-92.0) |

This changes real advice. With the 50s written off, the engine rated Spin
Eternally the *least* certain map for Cat's team against Kadence's. It is one of
their strongest.

What this does not fix: a player who has **not** played a high-scatter map still
gets a prediction from general skill. Alex on Spin Eternally reads 84%, and he
may well be another 50%. The band is wider there (78-90%) but not that wide.
Held-out scores land inside the stated one-sigma band 57% of the time against a
nominal 68%.

### The latent-factor result

The model supports low-rank "style" factors — the data-driven version of the
spreadsheet's hand-written *Acc / Tech / Speed* column labels. On the real MSU
board they make things **worse**:

| Model | Training R² | Held-out error, typical | Held-out error, mean |
|---|---|---|---|
| Additive only | 0.822 | **0.68 accuracy points** | **2.82** |
| + 1 latent factor | 0.823 | 0.95 | 2.91 |
| + 2 latent factors | 0.824 | 0.90 | 3.00 |

One latent dimension adds 17 parameters to a 55-score matrix and buys nothing.
So the default is the plain additive model, which predicts a typical held-out
score to within about **0.7 accuracy points**. The mean is four times the median
because it includes the Spin Eternally scores, which nothing predicts blind -
see above.

The machinery is kept, because a player's full BeatLeader history is hundreds of
scores rather than seven, and `fitBestModel` re-runs that comparison by
cross-validation on whatever data it is actually given. If factors start earning
their keep on your data, it will use them.

### Choosing what the model sees

Per tournament, defaulting to pool maps only:

| Setting | Effect |
|---|---|
| `source` | `POOL_ONLY` (default), `FULL_HISTORY`, or `RANKED_ONLY` |
| `maxAgeDays` | Ignore scores older than this |
| `halfLifeDays` | Weight recent scores more, halving every N days |
| `outlierSigmas` | Drop runs far below a player's own median (low side only — a career best is real evidence) |
| `excludeFails` | Drop flagged anomalies (abandoned runs) entirely rather than down-weighting them |
| `minAccuracy` | Hard floor |
| `maxScoresPerPlayer` | Cap per player, newest first |
| `minPlayersPerMap` | Ignore maps too few people have played |

Pool-only is the default because it is the most directly relevant evidence and
keeps a fresh instance quick to sync. Widen it when a pool is new and nobody has
practised it yet.

---

## The recommendation engine

Two objectives, and the difference between them is the whole point.

**Maximise expected margin** spreads your strong players where they add the most
raw score.

**Maximise win probability** does something else. Once a map is lost it does not
matter how badly, so this objective will concede a map it cannot win — parking
the two weakest players there — to free the strong ones for maps that are
actually close. That is sandbagging, and it falls out of the objective rather
than being coded in. Both are shown side by side, with what the gamble costs.

Under the hood: scores are drawn once from each player's predicted distribution
and reused across every candidate lineup (common random numbers), so two
lineups are judged against the same imagined nights and a difference between
them is real rather than simulation noise. Small formats are solved exactly —
the real four-player duos format has 432 legal lineups — and the result says
whether it searched exhaustively or heuristically, because "this is the best
lineup" and "this is the best one I found" are different claims.

When no legal lineup exists at all, it says so and why: *"No player may appear
more than 2 times, so 3 players can only cover 6 of the 8 slots. Add 1 more
player."*

Pick and ban advice scores every pool map by playing it out on its own, crossing
each side's possible groups against the other's. Three numbers come out: what
happens if neither captain out-thinks the other, what the map is worth if you
commit your best duo, and whether it holds up when they answer with theirs.

---

## Setup

### Requirements

Docker and Docker Compose. Nothing else.

### Configuration

Everything lives in `.env`; see `.env.example` for the annotated list. The
minimum is `AUTH_SECRET` (`openssl rand -base64 32`) and `POSTGRES_PASSWORD`.

**Sign-in** needs at least one OAuth app:

- **Discord** — https://discord.com/developers/applications → OAuth2.
  Redirect URI: `${APP_URL}/api/auth/callback/discord`
- **BeatLeader** — https://beatleader.com/developer → new OAuth2 application,
  scope `profile`. Also links the player's profile, so their scores are picked
  up without an organiser pasting IDs.
  Redirect URI: `${APP_URL}/api/auth/callback/beatleader`

The click-by-click version, including linking both providers to one account and
troubleshooting, is in [docs/auth-setup.md](docs/auth-setup.md).

**The first admin.** There is no password login, so `FIRST_USER_IS_ADMIN=true`
(the default) promotes the first account to sign in. Turn it off once your
admins exist if the instance is reachable from the internet, and use
`BOOTSTRAP_ADMINS` — a comma-separated list of Discord IDs or emails — instead.

### HTTPS

```bash
SITE_ADDRESS=stats.example.com docker compose --profile tls up -d
```

Caddy handles certificates. Its config already disables buffering on the
server-sent events route, without which live updates arrive in bursts.

---

## Development

```bash
npm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis
npm run db:migrate
npm run db:seed        # loads the real MSU setup from the spreadsheets
npm run dev            # http://localhost:3000
npm run dev:worker     # score ingestion, in another terminal
```

The dev overlay publishes Postgres and Redis on the host. The plain compose file
deliberately does not — nothing outside the compose network should reach them in
production.

| Command | Does |
|---|---|
| `npm test` | The core test suite |
| `npm run sync` | One-off score pull, then exit |
| `npm run db:studio` | Browse the database |
| `npm run typecheck` | Typecheck everything |

### Layout

```
apps/web       Next.js 15 — UI, API routes, server actions, SSE
apps/worker    Score ingestion: live websocket + periodic poll
packages/db    Prisma schema, migrations, seed
packages/core  All the domain logic, framework-free and unit-tested:
                 beatleader/  API client, leaderboard-id derivation, playlists
                 stats/       normalisation, skill model, scope filters
                 match/       pick-ban machine, lineup rules, permissions
                 optimize/    simulation, lineup search, pick/ban advice
```

`packages/core` depends on nothing. That is what makes the stats and the
optimiser testable, and every interesting claim in this README is pinned by a
test against the real spreadsheet data.

---

## Notes from building this

**Leaderboard IDs are derivable.** `songId + difficultyValue + mode` — song
`2d93e` at Expert/Standard is leaderboard `2d93e71`. No lookup table, and a
playlist import costs one request per *song* rather than per difficulty.

**An `x` in a leaderboard ID is not a typo.** It marks a re-uploaded map
version. The MSU Config sheet has `44b4dxxxxxxxxxxx51`, which resolves to a max
score of 488,635 — matching the sheet's own SONGINFO row — while the plain
`44b4d51` is a different upload at 487,715. Using the wrong one silently skews
every accuracy in that column.

**BeatLeader playlists embed their cover art.** The response for playlist 110086
is 2.23 MB, of which 2.23 MB is one base64 field. It is stripped on the way in;
the parsed pool is 2.1 KB.

**Completed matches are frozen.** BeatLeader reports a player's *current* best,
not what they scored on the night. Re-pulling a finished match would quietly
rewrite its result weeks later as people improve on the same maps.

**The live feed beats a webhook.** `wss://sockets.api.beatleader.com/scores`
carries every score set anywhere, in real time. Nothing to register, nothing to
expose, and it covers every player at once. The periodic poll stays as a safety
net, because sockets drop.

---

## Verification against the real data

The seed loads the MSU league from the two spreadsheets, and every player's
average accuracy on the pool reproduces the sheet exactly:

| Player | Maps | This app | Sheet |
|---|---|---|---|
| Cat | 7 | 95.22% | 95.22% |
| Treyo | 6 | 94.37% | 94.37% |
| Will | 3 | 98.05% | 98.05% |
| Mia | 7 | 91.21% | 91.21% |
| Kaiden | 5 | 89.00% | 89.00% |
| Kadence | 7 | 88.05% | 88.05% |
| Wyatt | 7 | 87.79% | 87.79% |
| Alex | 4 | 77.06% | 77.06% |

The anomaly detector flags exactly one run - Alex's abandoned Madeleine - and
leaves the Spin Eternally scores alone, the model independently ranks Wynttter top and Kaiden last, and it ranks Spin
Eternally and Konpeito as the two hardest maps — without being told any of it.

## Licence

MIT.
