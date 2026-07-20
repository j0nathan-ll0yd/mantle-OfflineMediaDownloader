# shellcheck shell=sh
# Per-worktree host-port assignment. SOURCE this file (do not execute):
#   . bin/worktree-ports.sh
#
# Main checkout: exports nothing — compose/test defaults (4566/5432/5433 and the
# fixed container names) apply, so a bare checkout behaves exactly as before.
# Linked worktree: exports LOCALSTACK_PORT / TEST_POSTGRES_PORT / CLONE_POSTGRES_PORT,
# the endpoint/DSN vars derived from them, unique container names, and a unique
# COMPOSE_PROJECT_NAME (both compose files live in docker/, so every checkout would
# otherwise share the project name "docker" and collide on networks/containers).
# The offset is a deterministic hash of the worktree path, so re-sourcing always
# yields the same assignment. Pre-set env vars are respected.
#
# Offsets are multiples of 10 in 10..2000; the bases (4566/5432/5433) are pairwise
# distinct mod 10, so no cross-service collision is possible between two worktrees.
# Same-offset collisions require a path-hash collision (200 buckets) and can be
# resolved by exporting LOCALSTACK_PORT etc. explicitly before sourcing.

if [ "$(git rev-parse --path-format=absolute --git-dir 2> /dev/null)" != "$(git rev-parse --path-format=absolute --git-common-dir 2> /dev/null)" ]; then
  _wt_top="$(git rev-parse --show-toplevel)"
  _wt_hash="$(printf '%s' "${_wt_top}" | cksum | cut -d' ' -f1)"
  _wt_offset=$(((_wt_hash % 200 + 1) * 10))

  : "${LOCALSTACK_PORT:=$((4566 + _wt_offset))}"
  : "${TEST_POSTGRES_PORT:=$((5432 + _wt_offset))}"
  : "${CLONE_POSTGRES_PORT:=$((5433 + _wt_offset))}"
  export LOCALSTACK_PORT TEST_POSTGRES_PORT CLONE_POSTGRES_PORT

  : "${AWS_ENDPOINT_URL:=http://localhost:${LOCALSTACK_PORT}}"
  : "${TEST_DATABASE_URL:=postgres://test:test@localhost:${TEST_POSTGRES_PORT}/media_downloader_test}"
  export AWS_ENDPOINT_URL TEST_DATABASE_URL

  : "${LOCALSTACK_CONTAINER_NAME:=aws-media-downloader-localstack-${_wt_hash}}"
  : "${TEST_DB_CONTAINER_NAME:=media-downloader-test-db-${_wt_hash}}"
  : "${COMPOSE_PROJECT_NAME:=media-downloader-wt-${_wt_hash}}"
  export LOCALSTACK_CONTAINER_NAME TEST_DB_CONTAINER_NAME COMPOSE_PROJECT_NAME

  unset _wt_top _wt_hash _wt_offset
fi
