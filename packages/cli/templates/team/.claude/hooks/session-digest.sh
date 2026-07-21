#!/usr/bin/env bash
# teamctx SessionStart hook.
#
# Claude Code injects a SessionStart hook's stdout into the session context (for the startup,
# resume, clear, compact, and fork sources). This script fetches the live team digest and prints
# it, so every fresh or resumed session — and every session after a context compaction — sees the
# current team state with zero manual steps.
#
# It is intentionally best-effort: if the context server is unreachable it prints a short note and
# exits 0, so it never blocks a session from starting.
set -uo pipefail

URL="${TEAMCTX_DIGEST_URL:-http://127.0.0.1:${TEAMCTX_PORT:-4517}/digest}"

if ! curl -fsS --max-time 3 "$URL" 2>/dev/null; then
  echo "(teamctx: shared context server not reachable at ${URL} — is 'teamctx host' running?)"
fi
