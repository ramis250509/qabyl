#!/bin/bash
# SessionStart hook — prepares a Claude Code on the web container for this repo.
#
# Installs the two things a remote session cannot do its job without:
#   1. graphify — the repo's own rule (CLAUDE.md, and the PreToolUse hooks in settings.json) is to
#      consult the knowledge graph BEFORE grepping or reading source. Without the CLI those hooks
#      fire on every read and demand a command that does not exist, so the agent silently falls
#      back to grep and the graph in graphify-out/ goes unused.
#   2. node_modules — `bun test` runs fine without them, but eslint/prettier do not exist until
#      they are installed, so lint feedback is impossible in a fresh container.
#
# Local machines are left alone: developers here already have their own setup, and the pip install
# below would fight with it.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# --- 1. graphify ------------------------------------------------------------------------------
# PyPI name is `graphifyy` (two y's) — `graphify` is a different, unrelated package. The [sql]
# extra pulls tree_sitter_sql; without it every file under supabase/migrations/ is parsed to
# nothing, which for this repo means ~100 migrations missing from the graph — including the whole
# schema the booking engine is built on.
#
# Non-fatal on purpose: a PyPI hiccup should degrade the session to "grep instead of graph", not
# refuse to start it.
if ! pip install --quiet --disable-pip-version-check --root-user-action=ignore "graphifyy[sql]"; then
  echo "WARNING: graphify install failed — graph queries will be unavailable this session." >&2
fi

# --- 2. JS dependencies -----------------------------------------------------------------------
# `|| true` is load-bearing, not laziness. bun.lock pins tarball URLs on a private Lovable registry
# mirror that answers 403 from outside Lovable's own build environment, so a handful of packages
# always fail here. bun still resolves and writes everything else, which is enough for eslint,
# prettier and typescript — so a partial install is genuinely useful and a hard failure would only
# cost the session its linter.
bun install || echo "NOTE: bun install finished with errors (private registry packages are expected to 403); node_modules is still usable for lint and typecheck." >&2

echo "Session ready: graphify $(graphify --help >/dev/null 2>&1 && echo ok || echo unavailable), node_modules $([ -x node_modules/.bin/eslint ] && echo ok || echo missing)."
