#!/bin/sh
PUID=${PUID:-0}
PGID=${PGID:-0}

if [ "$PUID" -ne 0 ] && [ "$PGID" -ne 0 ]; then
    echo "Starting with UID: $PUID, GID: $PGID"
    # Ensure data directory has correct permissions
    chown -R $PUID:$PGID /app/data 2>/dev/null || true
    # Run node as the specified user
    exec gosu $PUID:$PGID node index.js
else
    exec node index.js
fi
