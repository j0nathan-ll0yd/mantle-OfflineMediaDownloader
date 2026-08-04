#!/usr/bin/env bash
#
# aws-audit.sh
# Compares live AWS resources against OpenTofu state to find ORPHANS: resources
# that exist in AWS but are not managed by the stack. This is the one question
# `tofu plan` cannot answer -- plan only reconciles what state already tracks.
#
# Usage:
#   ./bin/aws-audit.sh --env staging                 # Audit staging
#   ./bin/aws-audit.sh --env staging --json          # Machine-readable output
#   ./bin/aws-audit.sh --env staging --prune --dry-run
#   ./bin/aws-audit.sh --env staging --prune         # Delete orphans (confirmed)
#
# Arguments:
#   --env <environment>  Required. Only 'staging' exists (see below).
#   --prune              Delete orphaned Lambda functions, IAM policies and IAM
#                        roles, after confirmation. Orphaned queues, buckets,
#                        APIs and distributions are only ever reported.
#   --dry-run            With --prune, show what would be deleted.
#   --json               Emit a JSON report instead of the text report.
#                        (Previously this flag only disabled colours and still
#                        printed the text report -- it never emitted JSON.)
#
# Exit codes: 0 = clean, 1 = usage/credential error, 2 = orphans or mistags found.
#
# WHAT WAS BROKEN, AND WHY THIS IS A REWRITE
# ------------------------------------------
# This script reported a FALSE CLEAN for its entire post-Mantle life. Four
# independent breakages, every one of which failed *open* -- it printed
# "No orphaned Lambda functions" while comparing two empty sets:
#
#   1. It called `tofu workspace select <env>`. Mantle uses NO terraform
#      workspaces; the default workspace's backend key is already stage-scoped
#      (infra-staging.tfstate). `tofu workspace list` returns only `default`.
#      It then pointed the operator at `./bin/init-workspaces.sh`, deleted long ago.
#   2. The AWS side was filtered by a hand-maintained pattern,
#      `^stag-(ListFiles|LoginUser|RegisterUser|RegisterDevice|WebhookFeedly|...)`.
#      Live resources are `staging-FilesGet`, `staging-UserLogin`,
#      `staging-UserRegister`, `staging-DeviceRegister`, `staging-FeedlyWebhook`...
#      Neither the prefix (`stag-` vs `staging-`) nor a single base name still
#      matched, so the filter selected nothing.
#   3. The Terraform side listed resource ADDRESSES and stripped the type
#      prefix. Every lambda now lives in a module, so the addresses are
#      `module.lambda_files_get.aws_lambda_function.function` -- not comparable
#      to an AWS function name under any prefix.
#   4. The tag check required `ManagedBy=terraform`; mantle's core module tags
#      everything `ManagedBy=opentofu`.
#
# Refreshing those lists would just restage the same rot: the next renamed
# lambda silently reopens the hole. So both sides are now DERIVED instead of
# hardcoded. Terraform-managed names come from `tofu show -json` (the real
# `function_name` / `name` / `bucket` attributes, module nesting included), the
# AWS-side filter is the stack's own `name_prefix`, and the expected ManagedBy
# value is read out of the state. Adding or renaming a resource needs no edit here.

set -euo pipefail

# `comm` only works when both inputs share a collation order. The Terraform side
# is ordered by jq's `unique` (codepoint order), so the AWS side must be sorted
# the same way -- under a locale like en_US.UTF-8, `sort` would interleave
# `staging-lambda_...` differently from jq and comm would emit bogus orphans.
export LC_COLLATE=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TERRAFORM_DIR="${PROJECT_ROOT}/infra"

USAGE="Usage: ./bin/aws-audit.sh --env staging [--prune] [--dry-run] [--json]"

ENVIRONMENT=""
PRUNE_MODE=false
DRY_RUN=false
JSON_OUTPUT=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --env)
      ENVIRONMENT="$2"
      shift 2
      ;;
    --prune)
      PRUNE_MODE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --json)
      JSON_OUTPUT=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "${USAGE}" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${ENVIRONMENT}" ]]; then
  echo "ERROR: --env parameter is required" >&2
  echo "${USAGE}" >&2
  exit 1
fi

# Only staging exists: mantle.config.ts pins allowedStages: ['staging'] and the
# single default-workspace state holds only staging resources. `--env production`
# used to silently audit staging while printing "production" everywhere.
if [[ "${ENVIRONMENT}" != "staging" ]]; then
  echo "ERROR: environment must be 'staging', got: ${ENVIRONMENT}" >&2
  echo "  mantle.config.ts sets allowedStages: ['staging']; there is no production state." >&2
  exit 1
fi

if [[ "${JSON_OUTPUT}" == "true" ]]; then
  RED='' GREEN='' YELLOW='' BLUE='' NC=''
else
  RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' BLUE='\033[0;34m' NC='\033[0m'
fi

# Text-report output. Suppressed under --json so stdout stays parseable.
say() {
  [[ "${JSON_OUTPUT}" == "true" ]] || echo -e "$1"
}

error() {
  echo -e "${RED}✗${NC} Error: $1" >&2
  exit "${2:-1}"
}

TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT
SHOW_JSON="${TMP_DIR}/tofu-show.json"

# tf_names <resource_type> <name_attribute>
# Emits the real, sorted names of every resource of that type in state, at any
# module depth. `.address` is present only on resource objects, which keeps the
# recursive descent from matching nested attribute maps.
tf_names() {
  local type="$1" attr="$2"
  jq -r --arg T "${type}" --arg A "${attr}" '
    [ .values.root_module
      | .. | objects
      | select((.address? | type == "string") and .type? == $T)
      | .values[$A]? ]
    | map(select(. != null)) | unique | .[]
  ' "${SHOW_JSON}"
}

# Sorted AWS-side names filtered to this stack's prefix.
prefixed() {
  grep -E "^${NAME_PREFIX}-" || true
}

# orphans <aws_file> <tf_file> -- in AWS but not in state.
orphans() {
  comm -23 "$1" "$2"
}

# Render a findings section; returns 1 when the list is non-empty.
report_section() {
  local label="$1" items="$2"
  if [[ -n "${items}" ]]; then
    say "${RED}Orphaned ${label}:${NC}"
    while IFS= read -r item; do
      [[ -n "${item}" ]] && say "  - ${item}"
    done <<< "${items}"
    return 1
  fi
  say "${GREEN}No orphaned ${label}${NC}"
  return 0
}

count_lines() {
  if [[ -z "$1" ]]; then
    echo 0
  else
    printf '%s\n' "$1" | wc -l | tr -d ' '
  fi
}

# Total of every orphan list, as a single integer.
count_all() {
  local total=0 list
  for list in "$@"; do
    total=$((total + $(count_lines "${list}")))
  done
  echo "${total}"
}

main() {
  say "${BLUE}AWS Infrastructure Audit${NC}"
  say "========================="

  # ---- Credentials -------------------------------------------------------
  say "${YELLOW}[1/6] Verifying AWS credentials...${NC}"
  local identity
  identity=$(aws sts get-caller-identity --output json 2> /dev/null) ||
    error "AWS credentials not configured or expired (try AWS_PROFILE=mantle-OfflineMediaDownloader)"
  AWS_ACCOUNT=$(jq -r '.Account' <<< "${identity}")

  # Resolve the region and PIN it for every later call. The previous version
  # computed a region and then never used it, so any caller without a default
  # region (e.g. one exporting only static credentials via
  # `aws configure export-credentials`) died with NoRegion partway through.
  AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2> /dev/null || true)}}"
  AWS_REGION="${AWS_REGION:-us-west-2}"
  export AWS_DEFAULT_REGION="${AWS_REGION}"
  say "  Account: ${AWS_ACCOUNT}"
  say "  Region:  ${AWS_REGION}"

  # ---- Terraform state ---------------------------------------------------
  # No `tofu workspace select`: the default workspace's state key is already
  # stage-scoped (infra/backend.tf).
  say "${YELLOW}[2/6] Reading OpenTofu state...${NC}"
  tofu -chdir="${TERRAFORM_DIR}" show -json > "${SHOW_JSON}" 2> "${TMP_DIR}/show.err" ||
    error "$(printf 'tofu show failed:\n%s' "$(cat "${TMP_DIR}/show.err")")"

  # name_prefix is module.core's `var.environment`. Read it from the tfvars file
  # rather than assuming it equals --env, so a rename shows up here instead of
  # silently filtering everything out.
  local tfvars="${TERRAFORM_DIR}/environments/${ENVIRONMENT}.tfvars"
  [[ -f "${tfvars}" ]] || error "tfvars not found: ${tfvars}"
  NAME_PREFIX=$(sed -n 's/^[[:space:]]*environment[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "${tfvars}" | head -1)
  [[ -n "${NAME_PREFIX}" ]] || error "could not read 'environment' from ${tfvars}"

  # The ManagedBy value the stack actually applies, read from state.
  EXPECTED_MANAGED_BY=$(jq -r '
    [ .values.root_module | .. | objects
      | select((.address? | type == "string") and .type? == "aws_lambda_function")
      | .values.tags.ManagedBy? ]
    | map(select(. != null)) | unique | first // "opentofu"
  ' "${SHOW_JSON}")

  tf_names aws_lambda_function function_name > "${TMP_DIR}/tf_lambdas"
  tf_names aws_iam_role name > "${TMP_DIR}/tf_roles"
  tf_names aws_iam_policy name > "${TMP_DIR}/tf_policies"
  tf_names aws_sqs_queue name > "${TMP_DIR}/tf_queues"
  tf_names aws_s3_bucket bucket > "${TMP_DIR}/tf_buckets"
  tf_names aws_api_gateway_rest_api name > "${TMP_DIR}/tf_apis"
  tf_names aws_cloudfront_distribution id > "${TMP_DIR}/tf_distributions"

  say "  Name prefix:  ${NAME_PREFIX}-"
  say "  ManagedBy:    ${EXPECTED_MANAGED_BY}"
  say "  In state:     $(wc -l < "${TMP_DIR}/tf_lambdas" | tr -d ' ') lambdas, $(wc -l < "${TMP_DIR}/tf_roles" | tr -d ' ') roles, $(wc -l < "${TMP_DIR}/tf_policies" | tr -d ' ') policies"

  # ---- Live AWS resources ------------------------------------------------
  say "${YELLOW}[3/6] Collecting AWS resources (${NAME_PREFIX}-*)...${NC}"

  # stderr is deliberately NOT suppressed here. `set -o pipefail` makes any failed
  # aws call abort the script, and the previous version discarded the reason --
  # so a missing IAM permission produced a bare non-zero exit with no explanation.
  aws lambda list-functions --query 'Functions[*].FunctionName' --output text |
    tr '\t' '\n' | prefixed | sort > "${TMP_DIR}/aws_lambdas"
  aws iam list-roles --query 'Roles[*].RoleName' --output text |
    tr '\t' '\n' | prefixed | sort > "${TMP_DIR}/aws_roles"
  aws iam list-policies --scope Local --query 'Policies[*].PolicyName' --output text |
    tr '\t' '\n' | prefixed | sort > "${TMP_DIR}/aws_policies"
  aws sqs list-queues --query 'QueueUrls' --output text |
    tr '\t' '\n' | sed 's#.*/##' | prefixed | sort > "${TMP_DIR}/aws_queues"
  aws s3api list-buckets --query 'Buckets[*].Name' --output text |
    tr '\t' '\n' | prefixed | sort > "${TMP_DIR}/aws_buckets"
  aws apigateway get-rest-apis --query 'items[*].name' --output text |
    tr '\t' '\n' | prefixed | sort > "${TMP_DIR}/aws_apis"

  # CloudFront distributions carry no prefixable name, so they are compared by ID
  # across the whole account. (Comment is not usable as a filter: mantle leaves the
  # storage distribution's comment empty, so a comment-prefix match would silently
  # skip it.)
  aws cloudfront list-distributions --output json |
    jq -r '(.DistributionList.Items // [])[] | .Id' | sort > "${TMP_DIR}/aws_distributions"

  say "  In AWS:       $(wc -l < "${TMP_DIR}/aws_lambdas" | tr -d ' ') lambdas, $(wc -l < "${TMP_DIR}/aws_roles" | tr -d ' ') roles, $(wc -l < "${TMP_DIR}/aws_policies" | tr -d ' ') policies"

  # ---- Orphans -----------------------------------------------------------
  say "${YELLOW}[4/6] Identifying orphaned resources...${NC}"

  ORPHAN_LAMBDAS=$(orphans "${TMP_DIR}/aws_lambdas" "${TMP_DIR}/tf_lambdas")
  ORPHAN_ROLES=$(orphans "${TMP_DIR}/aws_roles" "${TMP_DIR}/tf_roles")
  ORPHAN_POLICIES=$(orphans "${TMP_DIR}/aws_policies" "${TMP_DIR}/tf_policies")
  ORPHAN_QUEUES=$(orphans "${TMP_DIR}/aws_queues" "${TMP_DIR}/tf_queues")
  ORPHAN_BUCKETS=$(orphans "${TMP_DIR}/aws_buckets" "${TMP_DIR}/tf_buckets")
  ORPHAN_APIS=$(orphans "${TMP_DIR}/aws_apis" "${TMP_DIR}/tf_apis")
  ORPHAN_DISTRIBUTIONS=$(orphans "${TMP_DIR}/aws_distributions" "${TMP_DIR}/tf_distributions")

  local found=0
  report_section "Lambda functions" "${ORPHAN_LAMBDAS}" || found=1
  report_section "IAM roles" "${ORPHAN_ROLES}" || found=1
  report_section "IAM policies" "${ORPHAN_POLICIES}" || found=1
  report_section "SQS queues" "${ORPHAN_QUEUES}" || found=1
  report_section "S3 buckets" "${ORPHAN_BUCKETS}" || found=1
  report_section "API Gateway REST APIs" "${ORPHAN_APIS}" || found=1
  report_section "CloudFront distributions" "${ORPHAN_DISTRIBUTIONS}" || found=1

  # ---- Tag drift ---------------------------------------------------------
  say "${YELLOW}[5/6] Checking ManagedBy tags...${NC}"

  # No `|| true` here: swallowing a failure would leave MISTAGGED empty and print
  # "All Lambda functions tagged", i.e. exactly the false green this rewrite exists
  # to eliminate. A failed call must abort via set -e / pipefail.
  MISTAGGED=$(aws resourcegroupstaggingapi get-resources \
    --resource-type-filters lambda:function --output json |
    jq -r --arg P "${NAME_PREFIX}-" --arg M "${EXPECTED_MANAGED_BY}" '
      (.ResourceTagMappingList // [])[]
      | (.ResourceARN | split(":") | last) as $name
      | select($name | startswith($P))
      | select(([.Tags[]? | select(.Key == "ManagedBy") | .Value] | first) != $M)
      | $name
    ' | sort)

  if [[ -n "${MISTAGGED}" ]]; then
    say "${YELLOW}Lambdas missing ManagedBy=${EXPECTED_MANAGED_BY}:${NC}"
    while IFS= read -r item; do
      [[ -n "${item}" ]] && say "  - ${item}"
    done <<< "${MISTAGGED}"
    found=1
  else
    say "${GREEN}All Lambda functions tagged ManagedBy=${EXPECTED_MANAGED_BY}${NC}"
  fi

  # ---- Summary -----------------------------------------------------------
  local orphan_total
  orphan_total=$(count_all "${ORPHAN_LAMBDAS}" "${ORPHAN_ROLES}" "${ORPHAN_POLICIES}" \
    "${ORPHAN_QUEUES}" "${ORPHAN_BUCKETS}" "${ORPHAN_APIS}" "${ORPHAN_DISTRIBUTIONS}")

  if [[ "${JSON_OUTPUT}" == "true" ]]; then
    emit_json "${orphan_total}"
    [[ ${found} -eq 0 ]] || exit 2
    return 0
  fi

  say "${YELLOW}[6/6] Summary${NC}"
  say "============="
  say "Environment:        ${ENVIRONMENT} (${NAME_PREFIX}-*)"
  say "Orphaned resources: ${orphan_total}"
  say "Mistagged lambdas:  $(count_lines "${MISTAGGED}")"

  if [[ ${orphan_total} -gt 0 ]]; then
    emit_remediation
    [[ "${PRUNE_MODE}" == "true" ]] && run_prune
  else
    say "${GREEN}No orphaned resources found. Infrastructure is clean.${NC}"
  fi

  [[ ${found} -eq 0 ]] || exit 2
}

json_array() {
  if [[ -z "$1" ]]; then
    echo '[]'
  else
    printf '%s\n' "$1" | jq -R . | jq -s .
  fi
}

emit_json() {
  jq -n \
    --arg environment "${ENVIRONMENT}" \
    --arg namePrefix "${NAME_PREFIX}" \
    --arg account "${AWS_ACCOUNT}" \
    --arg region "${AWS_REGION}" \
    --arg managedBy "${EXPECTED_MANAGED_BY}" \
    --argjson orphanTotal "$1" \
    --argjson lambdas "$(json_array "${ORPHAN_LAMBDAS}")" \
    --argjson roles "$(json_array "${ORPHAN_ROLES}")" \
    --argjson policies "$(json_array "${ORPHAN_POLICIES}")" \
    --argjson queues "$(json_array "${ORPHAN_QUEUES}")" \
    --argjson buckets "$(json_array "${ORPHAN_BUCKETS}")" \
    --argjson apis "$(json_array "${ORPHAN_APIS}")" \
    --argjson distributions "$(json_array "${ORPHAN_DISTRIBUTIONS}")" \
    --argjson mistagged "$(json_array "${MISTAGGED}")" \
    '{
      environment: $environment,
      namePrefix: $namePrefix,
      account: $account,
      region: $region,
      expectedManagedBy: $managedBy,
      orphanTotal: $orphanTotal,
      orphans: {
        lambdaFunctions: $lambdas,
        iamRoles: $roles,
        iamPolicies: $policies,
        sqsQueues: $queues,
        s3Buckets: $buckets,
        apiGatewayRestApis: $apis,
        cloudfrontDistributions: $distributions
      },
      mistaggedLambdas: $mistagged
    }'
}

# remediation_lines <items> <printf-template>
remediation_lines() {
  local items="$1" template="$2"
  [[ -z "${items}" ]] && return 0
  while IFS= read -r item; do
    # shellcheck disable=SC2059  # template is a trusted literal from the caller
    [[ -n "${item}" ]] && say "$(printf "${template}" "${item}")"
  done <<< "${items}"
}

emit_remediation() {
  say ""
  say "${BLUE}Remediation Commands${NC}"
  say "===================="

  [[ -n "${ORPHAN_LAMBDAS}" ]] && say "# Orphaned Lambda functions:"
  remediation_lines "${ORPHAN_LAMBDAS}" 'aws lambda delete-function --function-name "%s"'

  [[ -n "${ORPHAN_POLICIES}" ]] && say "# Orphaned IAM policies (detach from roles first):"
  remediation_lines "${ORPHAN_POLICIES}" "aws iam delete-policy --policy-arn \"arn:aws:iam::${AWS_ACCOUNT}:policy/%s\""

  [[ -n "${ORPHAN_ROLES}" ]] && say "# Orphaned IAM roles (detach policies first):"
  remediation_lines "${ORPHAN_ROLES}" 'aws iam delete-role --role-name "%s"'

  [[ -n "${ORPHAN_QUEUES}" ]] && say "# Orphaned SQS queues:"
  remediation_lines "${ORPHAN_QUEUES}" \
    "aws sqs delete-queue --queue-url \"https://sqs.${AWS_REGION}.amazonaws.com/${AWS_ACCOUNT}/%s\""

  # Deleting these is destructive and multi-step (emptying a bucket, disabling a
  # distribution before it can be removed), so the script reports them and stops
  # short of suggesting a one-liner that would fail or do real damage.
  if [[ -n "${ORPHAN_BUCKETS}${ORPHAN_APIS}${ORPHAN_DISTRIBUTIONS}" ]]; then
    say "# The following have NO automated remediation -- review each by hand:"
    remediation_lines "${ORPHAN_BUCKETS}" '#   S3 bucket: %s'
    remediation_lines "${ORPHAN_APIS}" '#   API Gateway REST API: %s'
    remediation_lines "${ORPHAN_DISTRIBUTIONS}" '#   CloudFront distribution: %s'
  fi
}

# Prune deletes only resources that are, by definition, absent from state, so it
# cannot corrupt state. (The previous version tried to `cp infra/terraform.tfstate`
# as a "backup" -- that file has never existed under the S3 backend, so with
# `set -e` the backup step would have aborted the prune outright.)
# Scope note: --prune only deletes Lambda functions, IAM policies and IAM roles.
# Orphaned buckets/APIs/distributions/queues are reported but never auto-deleted.
run_prune() {
  say ""
  say "${RED}PRUNE MODE${NC} (lambdas, IAM policies and IAM roles only)"

  if [[ -z "${ORPHAN_LAMBDAS}${ORPHAN_POLICIES}${ORPHAN_ROLES}" ]]; then
    say "Nothing prunable: the orphans found are of types --prune does not delete."
    return 0
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    say "Dry run - nothing will be deleted."
    return 0
  fi

  say "${YELLOW}WARNING: this deletes the resources listed above from AWS.${NC}"
  read -r -p "Proceed? [y/N] " reply
  if [[ ! "${reply}" =~ ^[Yy]$ ]]; then
    say "Aborted."
    return 0
  fi

  while IFS= read -r item; do
    [[ -z "${item}" ]] && continue
    say "  Deleting lambda ${item}"
    aws lambda delete-function --function-name "${item}" 2> /dev/null ||
      say "${RED}  FAILED: ${item}${NC}"
  done <<< "${ORPHAN_LAMBDAS}"

  # Policies before roles: a policy still attached to a role cannot be deleted.
  while IFS= read -r item; do
    [[ -z "${item}" ]] && continue
    local arn="arn:aws:iam::${AWS_ACCOUNT}:policy/${item}"
    say "  Deleting policy ${item}"
    for role in $(aws iam list-entities-for-policy --policy-arn "${arn}" \
      --query 'PolicyRoles[*].RoleName' --output text 2> /dev/null || true); do
      aws iam detach-role-policy --role-name "${role}" --policy-arn "${arn}" 2> /dev/null || true
    done
    aws iam delete-policy --policy-arn "${arn}" 2> /dev/null ||
      say "${RED}  FAILED: ${item}${NC}"
  done <<< "${ORPHAN_POLICIES}"

  while IFS= read -r item; do
    [[ -z "${item}" ]] && continue
    say "  Deleting role ${item}"
    for policy in $(aws iam list-attached-role-policies --role-name "${item}" \
      --query 'AttachedPolicies[*].PolicyArn' --output text 2> /dev/null || true); do
      aws iam detach-role-policy --role-name "${item}" --policy-arn "${policy}" 2> /dev/null || true
    done
    for policy in $(aws iam list-role-policies --role-name "${item}" \
      --query 'PolicyNames' --output text 2> /dev/null || true); do
      aws iam delete-role-policy --role-name "${item}" --policy-name "${policy}" 2> /dev/null || true
    done
    aws iam delete-role --role-name "${item}" 2> /dev/null ||
      say "${RED}  FAILED: ${item}${NC}"
  done <<< "${ORPHAN_ROLES}"

  say "${GREEN}Pruning complete.${NC} Run 'pnpm run state:verify:staging' to confirm."
}

main
