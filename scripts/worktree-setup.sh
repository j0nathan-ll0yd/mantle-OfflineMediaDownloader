#!/usr/bin/env bash
set -u

worktree="$(git rev-parse --show-toplevel)"
main="$(dirname "$(git rev-parse --git-common-dir)")"

[ "$worktree" = "$main" ] && exit 0

log() { printf 'worktree-setup: %s\n' "$1"; }

for rel in \
  .claude/settings.local.json \
  .sops.yaml \
  .env \
  .envrc \
  secrets/secrets.prod.yaml \
  secrets/secrets.staging.yaml \
  infra/terraform.tfvars; do
  src="$main/$rel"
  dst="$worktree/$rel"
  if [ -f "$src" ] && [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
    if mkdir -p "$(dirname "$dst")" && cp -p "$src" "$dst"; then
      log "seeded $rel"
    else
      log "WARN: failed to seed $rel"
    fi
  fi
done

if [ "${WORKTREE_SKIP_INSTALL:-0}" != "1" ] && [ ! -d "$worktree/node_modules" ]; then
  log 'installing dependencies (pnpm install --prefer-offline)…'
  if (cd "$worktree" && pnpm install --prefer-offline >/dev/null 2>&1); then
    log 'dependencies installed'
  else
    log 'WARN: pnpm install failed — run pnpm install manually'
  fi

  log 'running background tasks…'
  (
    cd "$worktree"
    if [ -d "terraform" ] && command -v tofu >/dev/null 2>&1; then
      (cd terraform && tofu init -input=false >/dev/null 2>&1)
    fi
    if [ -f "graphrag/extract.ts" ]; then
      pnpm run graphrag:extract >/dev/null 2>&1 || true
    fi
    if [ -f "scripts/indexCodebase.ts" ]; then
      pnpm run index:codebase >/dev/null 2>&1 || true
    fi
    if command -v repomix >/dev/null 2>&1 || [ -f "node_modules/.bin/repomix" ]; then
      pnpm run pack:context >/dev/null 2>&1 || true
    fi
  ) &
fi

if command -v direnv >/dev/null 2>&1 && [ -f "$worktree/.envrc" ]; then
  ( cd "$worktree" && direnv allow >/dev/null 2>&1 || true )
fi

log 'done'
