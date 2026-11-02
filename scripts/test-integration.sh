#!/usr/bin/env bash
# End-to-end tests against a real app: throwaway Postgres + Redis, migrations,
# the fixture tournament, `next dev` on a spare port, then the API tests.
#
#   scripts/test-integration.sh            run everything, tear down after
#   KEEP=1 scripts/test-integration.sh     leave the stack and app running to poke at
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL="postgresql://bscs_test:bscs_test@127.0.0.1:55432/bscs_test?schema=public"
export REDIS_URL="redis://127.0.0.1:56379"
export PORT="${PORT:-3110}"
export APP_URL="http://127.0.0.1:${PORT}"
export AUTH_SECRET="integration-tests-only-not-a-secret"
export FIRST_USER_IS_ADMIN=false
export ENABLE_LIVE_SOCKET=false
export TEST_APP_URL="$APP_URL"
export FIXTURE_FILE="$PWD/apps/web/test/.fixture.json"
# OAuth is not configured: the tests act through API keys, exactly as an overlay would.
unset DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET BEATLEADER_CLIENT_ID BEATLEADER_CLIENT_SECRET

compose() { docker compose -f docker-compose.test.yml "$@"; }
app_pid=""
cleanup() {
  [ -n "$app_pid" ] && kill "$app_pid" 2>/dev/null || true
  [ "${KEEP:-}" = 1 ] || compose down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== data stores (fresh)"
compose down -v >/dev/null 2>&1 || true
compose up -d --wait >/dev/null
echo "== migrations"
npx prisma migrate deploy --schema packages/db/prisma/schema.prisma >/dev/null
echo "== fixture"
npm run build --workspace @bscs/core >/dev/null
node --experimental-strip-types --no-warnings apps/web/test/fixture.ts "$FIXTURE_FILE"

echo "== app on :$PORT"
# the log lives outside apps/web: next dev watches that folder, and a log inside it rebuilds on every line
APP_LOG="${TEST_APP_LOG:-$(mktemp -d)/bscs-test-app.log}"
(cd apps/web && exec npx next dev -p "$PORT") > "$APP_LOG" 2>&1 &
app_pid=$!
for i in $(seq 1 120); do
  curl -sf "$APP_URL/api/health" >/dev/null 2>&1 && break
  kill -0 "$app_pid" 2>/dev/null || { echo "the app exited:"; tail -30 "$APP_LOG"; exit 1; }
  sleep 1
done
curl -sf "$APP_URL/api/health" >/dev/null || { echo "the app did not come up:"; tail -30 "$APP_LOG"; exit 1; }

echo "== tests"
npx vitest run --config apps/web/test/vitest.config.ts
if [ "${KEEP:-}" = 1 ]; then
  echo "Left running: app $APP_URL (pid $app_pid), keys in $FIXTURE_FILE. Stop with: kill $app_pid; docker compose -f docker-compose.test.yml down -v"
  app_pid=""
fi
