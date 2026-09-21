#!/bin/sh
set -e

# Migrations are applied by the dedicated `migrate` service, which compose runs
# to completion before this container starts. Keeping them out of here is what
# lets the runtime image stay trimmed to Next.js's standalone output.
echo "> starting web on port ${PORT:-3000}"
exec node apps/web/server.js
