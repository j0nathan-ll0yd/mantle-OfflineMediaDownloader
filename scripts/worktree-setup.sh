#!/usr/bin/env sh
# Worktree setup script — Decision 0005 + speed optimizations (OpenTofu)
set -u

worktree="$(git rev-parse --show-toplevel)"
main="$(dirname "$(git rev-parse --git-common-dir)")"

[ "$worktree" = "$main" ] && exit 0

log() { printf 'worktree-setup: %s\n' "$1"; }

# 1) Synchronous (< 100ms): Seed specific gitignored files (copies, non-clobbering)
SHARED_ITEMS=".claude/settings.local.json .sops.yaml .env .envrc secrets/secrets.prod.yaml secrets/secrets.staging.yaml infra/tofu.tfvars infra/terraform.tfvars"
for item in $SHARED_ITEMS; do
  if [ ! -e "$worktree/$item" ] && [ ! -L "$worktree/$item" ] && [ -e "$main/$item" ]; then
    mkdir -p "$(dirname "$worktree/$item")"
    cp -R "$main/$item" "$worktree/$item" 2>/dev/null && log "seeded $item"
  fi
done

# 2) Direnv auto-allow
if command -v direnv >/dev/null 2>&1 && [ -f "$worktree/.envrc" ]; then
  ( cd "$worktree" && direnv allow >/dev/null 2>&1 || true )
fi

# 3) Async non-blocking dependency install & heavy background tasks (tofu init)
if [ "${WORKTREE_SKIP_INSTALL:-0}" != "1" ]; then
  (
    if [ -f "$worktree/pnpm-lock.yaml" ]; then
      ( cd "$worktree" && pnpm install --prefer-offline >/dev/null 2>&1 )
    fi
    if [ -d "$worktree/terraform" ] && command -v tofu >/dev/null 2>&1; then
      ( cd "$worktree/terraform" && tofu init -input=false >/dev/null 2>&1 || true )
    fi
  ) &
fi

log "done (background tasks PID $!)"
