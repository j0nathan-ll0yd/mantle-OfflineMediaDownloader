#!/usr/bin/env bash
# Script: test-registerDevice.sh
# Purpose: Smoke-test the DeviceRegister endpoint (POST /device/register)
# Usage: ./bin/test-registerDevice.sh --env staging
#
# MUTATES STAGING. The handler creates an SNS platform-application endpoint from
# the supplied APNS token and upserts a device row (plus a user_devices link when
# the caller is authorized as the synthetic test principal). The payload below is
# fixed synthetic data, so repeated runs upsert the SAME device rather than
# accumulating junk -- but the first run does create records.
#
# `/device/register` is one of MULTI_AUTHENTICATION_PATH_PARTS, so it is
# authorized without an Authorization header.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=bin/remote-api.sh
. "${SCRIPT_DIR}/remote-api.sh"

USAGE="Usage: ./bin/test-registerDevice.sh --env staging"

# Fixed synthetic device -- idempotent across runs. Must satisfy
# DeviceRegistrationRequestSchema in src/lambdas/api/device/register.post.ts.
readonly TEST_DEVICE_ID='00000000-0000-0000-0000-000000000001'
readonly TEST_DEVICE_TOKEN='0000000000000000000000000000000000000000000000000000000000000001'

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

  local payload
  payload=$(jq -n \
    --arg deviceId "${TEST_DEVICE_ID}" \
    --arg token "${TEST_DEVICE_TOKEN}" \
    '{deviceId: $deviceId, token: $token, name: "RemoteTestDevice", systemName: "iOS", systemVersion: "99.0.0"}')

  remote_api_warn "This registers a synthetic device in ${ENVIRONMENT} (idempotent: deviceId ${TEST_DEVICE_ID})."

  # The API key is a credential: log the path, never the query string.
  remote_api_step "POST ${REMOTE_API_URL}/device/register"
  remote_api_request "${REMOTE_API_URL}/device/register?ApiKey=${REMOTE_API_KEY}" \
    -X POST --data "${payload}"
}

main
