#!/bin/bash
# Installs dependencies for Claude Code cloud sessions.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# The project pins Yarn 4 via "packageManager". Corepack's default download
# host (repo.yarnpkg.com) is not reachable from cloud sessions, so fetch Yarn
# from the npm registry instead.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_NPM_REGISTRY=https://registry.npmjs.org

# Expose corepack's yarn shim ahead of the globally installed Yarn 1.
COREPACK_BIN="$HOME/.local/corepack-bin"
mkdir -p "$COREPACK_BIN"
corepack enable --install-directory "$COREPACK_BIN" yarn
export PATH="$COREPACK_BIN:$PATH"

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
    echo "export COREPACK_NPM_REGISTRY=https://registry.npmjs.org"
    echo "export PATH=\"$COREPACK_BIN:\$PATH\""
  } >> "$CLAUDE_ENV_FILE"
fi

yarn install
