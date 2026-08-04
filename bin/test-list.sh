#!/usr/bin/env bash
# Script: test-list.sh
# Purpose: Smoke-test the FilesGet API endpoint (GET /files) against staging
# Usage: ./bin/test-list.sh --env staging
#
# Read-only: GET /files mutates nothing, so this script is safe to run
# repeatedly. `/files` is one of MULTI_AUTHENTICATION_PATH_PARTS, so it is
# authorized without an Authorization header (ApiKey query param only).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=bin/remote-api.sh
. "${SCRIPT_DIR}/remote-api.sh"

USAGE="Usage: ./bin/test-list.sh --env staging"

ENVIRONMENT=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --env)
      ENVIRONMENT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "${USAGE}" >&2
      exit 1
      ;;
  esac
done

remote_api_validate_env "${ENVIRONMENT}" "${USAGE}"

main() {
  remote_api_resolve "${PROJECT_ROOT}/infra"

  # The API key is a credential: log the path, never the query string.
  remote_api_step "GET ${REMOTE_API_URL}/files"
  remote_api_request "${REMOTE_API_URL}/files?ApiKey=${REMOTE_API_KEY}"
}

main
