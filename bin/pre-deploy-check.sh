#!/usr/bin/env bash
#
# pre-deploy-check.sh
# Runs tofu plan and validates state before deployment to detect drift
#
# Usage:
#   ./bin/pre-deploy-check.sh --env staging       # Check staging for drift
#   ./bin/pre-deploy-check.sh --env staging --force  # Check drift, proceed anyway
#
# Arguments:
#   --env <environment>  Required. Only 'staging' — the single default-workspace state
#                        (infra-staging.tfstate) serves staging only; other stages are
#                        refused until stage-scoped state keys exist (mantle Phase 2d).
#   --force              Optional. Proceed even if drift is detected
#
# Exit codes:
#   0 - No changes detected, safe to deploy
#   1 - tofu plan failed (syntax error, missing provider, etc.)
#   2 - Drift detected, deployment blocked (unless --force)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TERRAFORM_DIR="${PROJECT_ROOT}/infra"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Default values
ENVIRONMENT=""
FORCE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --env)
      ENVIRONMENT="$2"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    *)
      echo -e "${RED}Unknown argument: $1${NC}"
      echo "Usage: $0 --env staging [--force]"
      exit 1
      ;;
  esac
done

# Validate environment
if [[ -z "$ENVIRONMENT" ]]; then
  echo -e "${RED}ERROR: --env parameter is required${NC}"
  echo "Usage: $0 --env staging [--force]"
  exit 1
fi

if [[ "$ENVIRONMENT" != "staging" ]]; then
  echo -e "${RED}ERROR: Only 'staging' is deployable (allowedStages guard; stage-scoped state pending mantle Phase 2d), got: ${ENVIRONMENT}${NC}"
  exit 1
fi

# Map environment to workspace and tfvars
case $ENVIRONMENT in
  staging)
    TFVARS_FILE="environments/staging.tfvars"
    SECRETS_FILE="${PROJECT_ROOT}/secrets/secrets.staging.enc.yaml"
    ;;
esac

# Error handler
error() {
  echo -e "${RED}✗${NC} Error: $1" >&2
  exit "${2:-1}"
}

main() {
  echo -e "${BLUE}Pre-Deploy Drift Check${NC}"
  echo "======================="
  echo -e "Environment: ${YELLOW}${ENVIRONMENT}${NC}"
  echo ""

  # Check for required environment variables
  if [[ ! -f "${PROJECT_ROOT}/.env" ]]; then
    echo -e "${RED}ERROR: .env file not found${NC}"
    echo "Ensure .env is symlinked from main repository"
    exit 1
  fi

  # Load environment variables
  set -a
  # shellcheck source=/dev/null
  source "${PROJECT_ROOT}/.env"
  set +a

  # =============================================================================
  # Validate SOPS Secrets
  # =============================================================================
  echo -e "${BLUE}Validating SOPS secrets...${NC}"

  if [[ ! -f "${SECRETS_FILE}" ]]; then
    echo -e "${RED}✗${NC} $(basename "${SECRETS_FILE}") not found"
    echo "  Encrypted secrets file is required for deployment"
    exit 1
  fi

  # Verify file has SOPS encryption markers
  if ! grep -q "sops:" "${SECRETS_FILE}" 2> /dev/null; then
    echo -e "${RED}✗${NC} $(basename "${SECRETS_FILE}") does not appear to be SOPS-encrypted"
    echo "  File should contain 'sops:' metadata section"
    exit 1
  fi

  echo -e "${GREEN}✓${NC} SOPS secrets file validated ($(basename "${SECRETS_FILE}"))"
  echo ""

  # =============================================================================
  # Verify Terraform Backend
  # =============================================================================
  echo -e "${BLUE}Checking Terraform backend...${NC}"

  if [[ ! -f "${TERRAFORM_DIR}/backend.tf" ]]; then
    echo -e "${RED}ERROR: backend.tf not found${NC}"
    echo "Remote state backend configuration is required"
    exit 1
  fi

  echo -e "${GREEN}✓${NC} Remote backend configured (backend.tf)"

  # Ensure terraform is initialized with the backend AND that the module cache is
  # current. The presence of .terraform is NOT sufficient: a cache installed while
  # the module `source` addresses pointed somewhere else (for example the sibling
  # ../../mantle checkout before the registry cutover) makes every subsequent tofu
  # command fail with "Module source has changed", which used to abort this script
  # with no diagnostic. `tofu init` is idempotent and re-installs modules whenever
  # their source addresses change, so run it unconditionally and let it self-heal.
  cd "${TERRAFORM_DIR}"
  echo "  Initializing backend and module cache..."
  if ! INIT_OUTPUT=$(tofu init -input=false -no-color 2>&1); then
    echo -e "${RED}ERROR: Failed to initialize terraform backend${NC}"
    echo ""
    echo "$INIT_OUTPUT"
    exit 1
  fi
  echo "  State backend: S3 (remote)"
  echo ""

  # Mantle uses NO terraform workspaces: the default workspace's state key is
  # already stage-scoped (infra-staging.tfstate). Pin the container image var from
  # live state so an unchanged image does not read as drift (deploy injects it).
  # Reading the image from state is best-effort: a missing resource is fine (the
  # plan still runs, an image-only diff just reads as drift). But it must never
  # fail SILENTLY -- stderr was previously sent to /dev/null while `set -o pipefail`
  # made the failing pipeline abort the whole script, so a hard tofu error such as
  # "Module source has changed" surfaced only as a bare exit 1 with no message.
  # Capture stderr, disable -e for the duration, and report whatever went wrong.
  set +e
  IMAGE_STATE=$(tofu state show module.lambda_start_file_upload.aws_lambda_function.function 2>&1)
  IMAGE_STATE_EXIT=$?
  set -e

  IMAGE_VAR_ARGS=()
  if [[ ${IMAGE_STATE_EXIT} -ne 0 ]]; then
    echo -e "${YELLOW}warn${NC} Could not read the container image from state (tofu exit ${IMAGE_STATE_EXIT}):"
    echo "    ${IMAGE_STATE//$'\n'/$'\n'    }"
    echo "  Continuing without a pinned image; an unchanged image may read as drift."
  else
    IMAGE_URI=$(echo "${IMAGE_STATE}" | sed -n 's/^ *image_uri *= *"\(.*\)".*/\1/p' | head -1)
    if [[ -n "${IMAGE_URI}" ]]; then
      IMAGE_VAR_ARGS+=("-var=image_uri_start_file_upload=${IMAGE_URI}")
      echo -e "${GREEN}ok${NC} Pinned container image: ${IMAGE_URI##*/}"
    fi
  fi

  # Run tofu plan with detailed exit code
  echo -e "${YELLOW}Running tofu plan with ${TFVARS_FILE}...${NC}"

  # Capture plan output and exit code
  set +e
  # ${arr[@]+"${arr[@]}"} expands to nothing when the array is empty instead of
  # tripping `set -u`. The empty case is now reachable: the image lookup above
  # warns and continues where it previously aborted the script.
  PLAN_OUTPUT=$(tofu plan -var-file="${TFVARS_FILE}" ${IMAGE_VAR_ARGS[@]+"${IMAGE_VAR_ARGS[@]}"} -detailed-exitcode -input=false -no-color 2>&1)
  PLAN_EXIT=$?
  set -e

  case $PLAN_EXIT in
    0)
      echo ""
      echo -e "${GREEN}No changes detected.${NC}"
      echo "Infrastructure matches configuration. Safe to deploy."
      echo ""
      ;;
    1)
      echo ""
      echo -e "${RED}ERROR: tofu plan failed${NC}"
      echo ""
      echo "$PLAN_OUTPUT"
      echo ""
      echo "Fix the errors above before deploying."
      exit 1
      ;;
    2)
      echo ""
      echo -e "${YELLOW}DRIFT DETECTED: Changes required${NC}"
      echo ""
      echo "$PLAN_OUTPUT" | grep -E "^(  #|Plan:)" || echo "$PLAN_OUTPUT"
      echo ""

      # Report tofu's own "Plan: X to add, Y to change, Z to destroy." line verbatim
      # rather than re-deriving counts. The previous hand-rolled tally was wrong in
      # two ways: `grep -c` prints 0 AND exits 1 when there are no matches, so the
      # `|| echo 0` fallback appended a SECOND zero and produced garbled multi-line
      # output ("+0\n0 to add"); and it matched only "will be created"/"will be
      # destroyed", so a resource that "must be replaced" -- a destroy plus a
      # re-create -- was counted as neither and silently reported as "-0 to destroy".
      # Under-reporting a destroy in a deploy gate is the exact failure this check
      # exists to prevent.
      PLAN_SUMMARY=$(echo "$PLAN_OUTPUT" | grep -E "^Plan: " | tail -1)
      REPLACE_COUNT=$(echo "$PLAN_OUTPUT" | grep -cE "must be replaced" || true)

      echo "Summary: ${PLAN_SUMMARY:-<tofu emitted no Plan: line>}"
      if [[ "${REPLACE_COUNT}" -gt 0 ]]; then
        echo -e "${RED}WARNING:${NC} ${REPLACE_COUNT} resource(s) must be REPLACED (destroy + re-create):"
        echo "$PLAN_OUTPUT" | grep -E "must be replaced" | sed 's/^ *#/    /'
      fi
      echo ""

      if [[ "$FORCE" == "true" ]]; then
        echo -e "${YELLOW}--force flag set, proceeding with deployment...${NC}"
        exit 0
      else
        echo -e "${RED}Deployment blocked.${NC}"
        echo ""
        echo "Review the changes above. To proceed anyway, run:"
        echo "  $0 --env ${ENVIRONMENT} --force"
        echo ""
        echo "Or to investigate the drift:"
        echo "  cd infra && tofu plan -var-file=${TFVARS_FILE}"
        exit 2
      fi
      ;;
    *)
      echo -e "${RED}ERROR: Unexpected exit code from tofu plan: ${PLAN_EXIT}${NC}"
      echo "$PLAN_OUTPUT"
      exit 1
      ;;
  esac
}

main "$@"
