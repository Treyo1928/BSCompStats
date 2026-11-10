#!/usr/bin/env bash
# A mock tournament to click around in: throwaway Postgres + Redis (in Docker, RAM only), the test fixture
# (MSU Winter Test Cup: 4 teams, 3 pools, a bracket, API keys), and the app with a dev-only sign-in
# so you can be any of the fixture's users without Discord.
#
#   scripts/mock.sh                 http://127.0.0.1:3100   (Ctrl+C stops it and throws the data away)
#   PORT=3200 scripts/mock.sh
#   MOCK_FROM=https://bs.treyo.dev/t/<slug> scripts/mock.sh    copy that public tournament: real teams, players, pools
#                                   and brackets (same seeds, no results) plus the players' replays. This is the default
#                                   (MSU's October 2026 tourney). MOCK_FROM=fixture: the made-up test tournament instead.
#
#
#   With a test TournamentAssistant server (the whole-stack start.sh one level up runs one), also set
#   MOCK_TA_HOST, MOCK_TA_PORT, MOCK_TA_TOKEN (a token that server accepts) and MOCK_TA_TOURNAMENT (the TA tournament's
#   name): the mock tournament is then linked to it, and the worker, which holds the TA connection, is started too.
#   MOCK_WORKER_LOG: where the worker's log goes.
#
# Its data stores have their own names and ports, so it never touches a real dev database or the tests.
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL="postgresql://bscs_test:bscs_test@127.0.0.1:55433/bscs_test?schema=public"
export REDIS_URL="redis://127.0.0.1:56380"
export PORT="${PORT:-3100}"
export APP_URL="http://127.0.0.1:${PORT}"
export AUTH_SECRET="mock-tournament-only-not-a-secret"
export FIRST_USER_IS_ADMIN=false
export ENABLE_LIVE_SOCKET=false
export DEV_LOGIN=1
export NEXT_DIST_DIR=.next-mock     # its own build folder: the integration tests' dev server uses .next
FIXTURE_FILE="$PWD/apps/web/test/.mock-fixture.json"
# The app's log must live outside apps/web: next dev watches that folder, so a log inside it made every log line
# trigger a rebuild, which logged another line (an endless "Compiled" loop that also stalled page navigation).
APP_LOG="${MOCK_APP_LOG:-$(mktemp -d)/bscs-mock-app.log}"
unset DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET BEATLEADER_CLIENT_ID BEATLEADER_CLIENT_SECRET

command -v docker >/dev/null || { echo "Docker is needed for the data stores (Postgres + Redis)."; exit 1; }
compose() { docker compose -f docker-compose.mock.yml "$@"; }
app_pid=""
worker_pid=""
cleanup() {
  echo; echo "== stopping"
  [ -n "$worker_pid" ] && kill "$worker_pid" 2>/dev/null || true
  # the app runs in its own process group (setsid below): stop all of it, not just npx
  [ -n "$app_pid" ] && { kill -TERM -- "-$app_pid" 2>/dev/null || kill "$app_pid" 2>/dev/null; } || true
  compose down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "== data stores (fresh)"
compose down -v >/dev/null 2>&1 || true
compose up -d --wait >/dev/null
echo "== migrations"
npx prisma migrate deploy --schema packages/db/prisma/schema.prisma >/dev/null
echo "== mock tournament"
npm run build --workspace @bscs/core >/dev/null
MOCK_FROM="${MOCK_FROM:-https://bs.treyo.dev/t/msu-october-2026-beat-saber-tourney}"
made_up() { FIXTURE_MAPS=beatleader FIXTURE_BRACKET=double node --experimental-strip-types --no-warnings apps/web/test/fixture.ts "$FIXTURE_FILE"; }
if [ "$MOCK_FROM" = fixture ]; then
  made_up
elif ! MOCK_FROM="$MOCK_FROM" node --experimental-strip-types --no-warnings apps/web/test/mock-from-public.ts "$FIXTURE_FILE"; then
  echo "   could not copy $MOCK_FROM, using the made-up test tournament instead"
  compose down -v >/dev/null 2>&1; compose up -d --wait >/dev/null
  npx prisma migrate deploy --schema packages/db/prisma/schema.prisma >/dev/null
  made_up
fi

if [ -n "${MOCK_TA_HOST:-}" ]; then
  echo "== worker (holds the TournamentAssistant connection)"
  WORKER_LOG="${MOCK_WORKER_LOG:-$(dirname "$APP_LOG")/bscs-mock-worker.log}"
  npx tsc -b packages/db/tsconfig.json >/dev/null
  npm run build --workspace @bscs/worker >/dev/null
  ENABLE_SCORE_SYNC=false node apps/worker/dist/index.js > "$WORKER_LOG" 2>&1 &
  worker_pid=$!
fi

echo "== app on :$PORT (first page load compiles, give it a few seconds)"
(cd apps/web && exec setsid npx next dev -H 127.0.0.1 -p "$PORT") > "$APP_LOG" 2>&1 &
app_pid=$!
for i in $(seq 1 120); do
  curl -sf "$APP_URL/api/health" >/dev/null 2>&1 && break
  kill -0 "$app_pid" 2>/dev/null || { echo "the app exited:"; tail -30 "$APP_LOG"; exit 1; }
  sleep 1
done

python3 -I - "$FIXTURE_FILE" "$APP_URL" "$APP_LOG" <<'PY'
import json, sys
f, url = json.load(open(sys.argv[1])), sys.argv[2]
u, k = f["users"], f["keys"]
# a copied tournament lists its real captains; the made-up one has Maroon's and White's
caps = f.get("captains") or [{"team": "Maroon", "player": "Erin", "userId": u["captainMaroon"]}, {"team": "White", "player": "Kaiden", "userId": u["captainWhite"]}]
cap_lines = "\n".join(f"    {(c['team'] + ' captain (' + c['player'] + ')'):<27}{url}/api/dev/login?as={c['userId']}" for c in caps)
print(f"""
  Mock tournament is up:  {url}/t/{f["tournament"]["slug"]}{("   (copied from " + f["source"] + ")") if f.get("source") else ""}

  Sign in as (no Discord needed):
    organiser (runs matches)   {url}/api/dev/login?as={u["organiser"]}
{cap_lines}
    site admin                 {url}/api/dev/login?as={u["admin"]}
    (or pick from a list:      {url}/api/dev/login )

  API keys for an overlay or scripts (docs/api.md):
    organiser, can run matches   {k["organiser"]}
    organiser, read-only         {k["organiserRead"]}
  All ids and keys: {sys.argv[1]}
  App log: {sys.argv[3]}

  Ctrl+C stops everything and throws the data away.
""")
PY
wait "$app_pid"
