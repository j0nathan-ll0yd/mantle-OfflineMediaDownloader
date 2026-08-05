#!/usr/bin/env bash
# Script: test-hook.sh
# Purpose: Smoke-test the FeedlyWebhook endpoint (POST /feedly/webhook)
# Usage: ./bin/test-hook.sh --env staging [--article-url <youtube-url>]
#
# MUTATES STAGING, AND TRIGGERS A REAL DOWNLOAD. On a first run for a given
# video the handler creates a file record, links it to the caller, and emits a
# DownloadRequested event -> SQS DownloadQueue -> StartFileUpload, which really
# fetches the video with yt-dlp and writes it to S3. Repeat runs are cheap: the
# Powertools idempotency store short-circuits within its TTL, and once the file
# reaches status=Downloaded the handler returns 200 Dispatched instead of
# re-emitting.
#
# `/feedly/webhook` is NOT in MULTI_AUTHENTICATION_PATH_PARTS, so it requires a
# real principal. From the reserved test IP the authorizer's isRemoteTestRequest()
# grants the synthetic test user; from anywhere else this returns 401/403.
#
# The default article URL is the one from the pre-Mantle fixture
# (src/lambdas/WebhookFeedly/test/fixtures/handleFeedlyEvent-200-OK.json), which
# was deleted in #275 -- this script has been unrunnable ever since, because
# `curl --data @<missing-file>` fails outright.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=bin/remote-api.sh
. "${SCRIPT_DIR}/remote-api.sh"

USAGE="Usage: ./bin/test-hook.sh --env staging [--article-url <youtube-url>]"

# Must match one of the patterns getVideoID() accepts in src/services/youtube/youtube.ts.
readonly DEFAULT_ARTICLE_URL='https://www.youtube.com/watch?v=wRG7lAGdRII'

ENVIRONMENT=""
ARTICLE_URL="${DEFAULT_ARTICLE_URL}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --env)
      ENVIRONMENT="$2"
      shift 2
      ;;
    --article-url)
      ARTICLE_URL="$2"
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

  local payload
  payload=$(jq -n --arg articleURL "${ARTICLE_URL}" '{articleURL: $articleURL}')

  remote_api_warn "This can trigger a real yt-dlp download into ${ENVIRONMENT} S3 for ${ARTICLE_URL}"

  # The API key is a credential: log the path, never the query string.
  remote_api_step "POST ${REMOTE_API_URL}/feedly/webhook"
  remote_api_request "${REMOTE_API_URL}/feedly/webhook?ApiKey=${REMOTE_API_KEY}" \
    -X POST --data "${payload}"
}

main
