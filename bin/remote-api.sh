# shellcheck shell=bash
# Shared helpers for the remote smoke-test scripts. SOURCE this file (do not
# execute it):
#
#   . "${SCRIPT_DIR}/remote-api.sh"
#
# Consumers: test-list.sh, test-hook.sh, test-registerDevice.sh
#
# WHY THIS FILE EXISTS
# --------------------
# All three remote scripts resolved the API the same way, and therefore rotted
# the same way -- three identical silent breakages that nobody noticed because
# none of these scripts run in CI:
#
#   1. They called `tofu workspace select <env>`. Mantle uses NO terraform
#      workspaces: the default workspace's backend key is already stage-scoped
#      (`infra-staging.tfstate`, see infra/backend.tf). `tofu workspace list`
#      returns only `default`, so the select always failed.
#   2. They read `api_gateway_subdomain` / `api_gateway_stage` /
#      `api_gateway_api_key`. None of those outputs exist. infra/outputs.tf
#      declares `api_url` (already stage-qualified, e.g.
#      https://<id>.execute-api.us-west-2.amazonaws.com/prod) and `api_key`.
#
# Keeping the resolution in ONE place means the next output rename is one edit
# instead of three independent silent breakages.

REMOTE_API_RED='\033[0;31m'
REMOTE_API_GREEN='\033[0;32m'
REMOTE_API_YELLOW='\033[1;33m'
REMOTE_API_NC='\033[0m'

remote_api_error() {
  echo -e "${REMOTE_API_RED}✗${REMOTE_API_NC} Error: $1" >&2
  exit "${2:-1}"
}

remote_api_step() {
  echo -e "${REMOTE_API_GREEN}▶${REMOTE_API_NC} $1"
}

remote_api_warn() {
  echo -e "${REMOTE_API_YELLOW}!${REMOTE_API_NC} $1" >&2
}

# remote_api_validate_env <environment> <usage-line>
#
# Only `staging` is accepted. mantle.config.ts pins `allowedStages: ['staging']`
# and the single default-workspace state holds ONLY staging resources, so
# `--env production` never addressed production -- it silently resolved the
# staging outputs and hit staging while claiming otherwise. Reject it rather
# than lie about the target.
remote_api_validate_env() {
  local environment="$1"
  local usage="$2"

  if [[ -z "${environment}" ]]; then
    echo "ERROR: --env parameter is required" >&2
    echo "${usage}" >&2
    exit 1
  fi

  if [[ "${environment}" != "staging" ]]; then
    echo "ERROR: environment must be 'staging', got: ${environment}" >&2
    echo "  mantle.config.ts sets allowedStages: ['staging']; this repo has no" >&2
    echo "  production state to address (see infra/backend.tf)." >&2
    exit 1
  fi
}

# remote_api_resolve <infra-dir>
#
# Sets REMOTE_API_URL and REMOTE_API_KEY from the OpenTofu outputs. Uses
# `tofu -chdir=` so the caller's working directory is left alone.
remote_api_resolve() {
  local infra_dir="$1"

  [[ -d "${infra_dir}" ]] || remote_api_error "infra directory not found: ${infra_dir}"

  # Deliberately NO `tofu workspace select` -- see the header. The default
  # workspace already points at the stage-scoped state key.
  REMOTE_API_URL=$(tofu -chdir="${infra_dir}" output -raw api_url 2> /dev/null) ||
    remote_api_error "could not read tofu output 'api_url' from ${infra_dir}.\n  Check AWS credentials (AWS_PROFILE=mantle-OfflineMediaDownloader) and that the stack is deployed."
  REMOTE_API_KEY=$(tofu -chdir="${infra_dir}" output -raw api_key 2> /dev/null) ||
    remote_api_error "could not read tofu output 'api_key' from ${infra_dir}.\n  Check AWS credentials (AWS_PROFILE=mantle-OfflineMediaDownloader) and that the stack is deployed."

  [[ -n "${REMOTE_API_URL}" ]] || remote_api_error "tofu output 'api_url' is empty"
  [[ -n "${REMOTE_API_KEY}" ]] || remote_api_error "tofu output 'api_key' is empty"

  export REMOTE_API_URL REMOTE_API_KEY
}

# remote_api_request <url> [extra curl args...]
#
# Issues the request, pretty-prints the response body, and FAILS on a non-2xx
# status. The originals piped `curl -v` into `jq`, which exits 0 on a 403 -- a
# smoke test that cannot fail is not a test.
#
# The `User-Agent: localhost@lifegames` header is load-bearing, not cosmetic:
# ApiGatewayAuthorizer's isRemoteTestRequest() only grants the synthetic test
# principal when the UA matches AND the caller's source IP equals
# RESERVED_CLIENT_IP (see src/lambdas/standalone/ApiGatewayAuthorizer/). From any
# other IP these scripts run as an anonymous caller.
remote_api_request() {
  local url="$1"
  shift

  local response status body
  response=$(curl -sS -w '\n%{http_code}' \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json' \
    -H 'User-Agent: localhost@lifegames' \
    "$@" \
    "${url}") || remote_api_error "curl failed"

  status="${response##*$'\n'}"
  body="${response%$'\n'*}"

  if [[ -n "${body}" ]]; then
    printf '%s\n' "${body}" | jq . 2> /dev/null || printf '%s\n' "${body}"
  fi

  if [[ "${status}" != 2* ]]; then
    remote_api_error "HTTP ${status}"
  fi

  remote_api_step "HTTP ${status}"
}
