# Team rules (teamctx)

Your Claude Code session shares a live context server with your teammates' sessions. A team
digest is injected at the start of every session; treat the shared tools as your first stop.

You work on **your own branch** (`teamctx/<you>`) in your own worktree, so you can move
independently. Share work by committing and pushing/PR-ing. Everyone talks to the same context
server — coordinate there: post findings, log decisions, and check who's working on what.

- **Before starting any task**, call `get_context` — see what the team already knows and who is
  working on what. Don't rediscover a gotcha a teammate already posted.
- **After you learn anything a teammate could hit** (an API limit, a broken assumption, a config
  quirk), call `post_finding` with a short, specific note.
- **Before you start a piece of work**, call `claim_task` so nobody duplicates it. Call
  `release_task` when you're done.
- **When you make an irreversible or team-wide choice** (schema, dependency, API contract), call
  `log_decision` with a one-line rationale.

Keep findings and decisions short and concrete — teammates act on them directly. Call `get_digest`
anytime for a fresh snapshot of team state.
