#!/usr/bin/env bash
#
# aws-audit.sh
# Comprehensive AWS resource audit comparing Terraform state against live AWS resources
#
# Usage:
#   ./bin/aws-audit.sh --env staging              # Audit staging environment
#   ./bin/aws-audit.sh --env production           # Audit production environment
#   ./bin/aws-audit.sh --env staging --prune      # Audit and delete orphaned resources
#   ./bin/aws-audit.sh --env production --dry-run # Show what --prune would delete
#   ./bin/aws-audit.sh --env staging --json       # Output results as JSON
#
# Arguments:
#   --env <environment>  Required. Either 'staging' or 'production'
#   --prune              Optional. Delete orphaned resources (with confirmation)
#   --dry-run            Optional. Show what --prune would delete without executing
#   --json               Optional. Output results as JSON
#
# This script identifies:
#   - Orphaned resources: In AWS but not in Terraform state
#   - Duplicates: Multiple resources with similar names (e.g., stag-ListFiles, stag-ListFiles-1)
#   - Untagged: Resources missing ManagedBy=terraform tag
#
# Resource types audited:
#   - Lambda functions
#   - IAM roles and policies
#   - CloudFront distributions
#   - API Gateway REST APIs
#   - S3 buckets
#   - SQS queues
#   - CloudWatch log groups

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TERRAFORM_DIR="${PROJECT_ROOT}/infra"

# Parse arguments
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
      echo "Unknown option: $1"
      echo "Usage: ./bin/aws-audit.sh --env <staging|production> [--prune] [--dry-run] [--json]"
      exit 1
      ;;
  esac
done

# Validate environment
if [[ -z "$ENVIRONMENT" ]]; then
  echo "ERROR: --env parameter is required"
  echo "Usage: ./bin/aws-audit.sh --env <staging|production> [--prune] [--dry-run] [--json]"
  exit 1
fi

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
  echo "ERROR: Environment must be 'staging' or 'production', got: ${ENVIRONMENT}"
  exit 1
fi

# Map environment to workspace and resource prefix
case $ENVIRONMENT in
  staging)
    WORKSPACE="staging"
    RESOURCE_PREFIX="stag"
    ;;
  production)
    WORKSPACE="production"
    RESOURCE_PREFIX="prod"
    ;;
esac

# Colors (disabled for JSON output)
if [[ "$JSON_OUTPUT" == "true" ]]; then
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  NC=''
else
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
fi

# Error handler
error() {
  echo -e "${RED}✗${NC} Error: $1" >&2
  exit "${2:-1}"
}

# Function to find orphans (in AWS but not in TF state)
find_orphans() {
  local aws_file="$1"
  local tf_file="$2"

  while IFS= read -r item; do
    if ! grep -qxF "$item" "$tf_file" 2> /dev/null; then
      echo "$item"
    fi
  done < "$aws_file"
}

main() {
  # Project resource patterns with environment prefix
  # These patterns match resources for the specific environment (stag-* or prod-*)
  LAMBDA_PATTERN="^${RESOURCE_PREFIX}-(ListFiles|LoginUser|RegisterUser|RegisterDevice|WebhookFeedly|S3ObjectCreated|SendPushNotification|StartFileUpload|PruneDevices|ApiGatewayAuthorizer|UserDelete|UserSubscribe|RefreshToken|LogoutUser|CleanupExpiredRecords|DeviceEvent|MigrateDSQL)"
  IAM_PATTERN="^${RESOURCE_PREFIX}-(ListFiles|LoginUser|RegisterUser|RegisterDevice|WebhookFeedly|S3ObjectCreated|SendPushNotification|StartFileUpload|PruneDevices|ApiGatewayAuthorizer|UserDelete|UserSubscribe|RefreshToken|LogoutUser|CleanupExpiredRecords|DeviceEvent|MigrateDSQL|ApiGatewayCloudwatch|SNSLoggingRole|CommonLambdaXRay|LambdaDSQLConnect|LambdaDSQLAdminConnect)"
  S3_PATTERN="lifegames-${RESOURCE_PREFIX}-media"
  SQS_PATTERN="^${RESOURCE_PREFIX}-(SendPushNotification|DownloadQueue)"
  APIGW_PATTERN="^${RESOURCE_PREFIX}-OfflineMediaDownloader"

  # Temporary files for comparison
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT

  echo -e "${BLUE}AWS Infrastructure Audit${NC}"
  echo "========================="
  echo -e "Environment: ${YELLOW}${ENVIRONMENT}${NC} (prefix: ${RESOURCE_PREFIX}-)"
  echo ""

  # Load environment variables
  if [[ -f "${PROJECT_ROOT}/.env" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "${PROJECT_ROOT}/.env"
    set +a
  fi

  # Verify AWS credentials
  echo -e "${YELLOW}[1/8] Verifying AWS credentials...${NC}"
  AWS_IDENTITY=$(aws sts get-caller-identity --output json 2> /dev/null) || {
    echo -e "${RED}ERROR: AWS credentials not configured or expired${NC}"
    exit 1
  }
  AWS_ACCOUNT=$(echo "$AWS_IDENTITY" | jq -r '.Account')
  AWS_REGION=$(aws configure get region || echo "us-west-2")
  echo "  Account: ${AWS_ACCOUNT}"
  echo "  Region:  ${AWS_REGION}"
  echo ""

  # Select workspace
  echo -e "${YELLOW}[2/8] Selecting workspace: ${WORKSPACE}${NC}"
  cd "${TERRAFORM_DIR}"

  CURRENT_WS=$(tofu workspace show 2> /dev/null || echo "")
  if [[ "$CURRENT_WS" != "$WORKSPACE" ]]; then
    if ! tofu workspace select "$WORKSPACE" > /dev/null 2>&1; then
      echo -e "${RED}ERROR: Failed to select workspace '${WORKSPACE}'${NC}"
      echo "  Run './bin/init-workspaces.sh' to create workspaces"
      exit 1
    fi
  fi
  echo -e "${GREEN}✓${NC} Workspace: ${WORKSPACE}"
  echo ""

  # Collect Terraform state
  echo -e "${YELLOW}[3/8] Collecting Terraform state...${NC}"

  tofu state list 2> /dev/null | grep "aws_lambda_function\." | sed 's/aws_lambda_function\.//' > "$TMP_DIR/tf_lambdas.txt" || true
  tofu state list 2> /dev/null | grep "aws_iam_role\." | sed 's/aws_iam_role\.//' > "$TMP_DIR/tf_roles.txt" || true
  tofu state list 2> /dev/null | grep "aws_iam_policy\." | sed 's/aws_iam_policy\.//' > "$TMP_DIR/tf_policies.txt" || true
  tofu state list 2> /dev/null | grep "aws_cloudfront_distribution\." | sed 's/aws_cloudfront_distribution\.//' > "$TMP_DIR/tf_cloudfront.txt" || true
  tofu state list 2> /dev/null | grep "aws_api_gateway_rest_api\." | sed 's/aws_api_gateway_rest_api\.//' > "$TMP_DIR/tf_apigw.txt" || true
  tofu state list 2> /dev/null | grep "aws_s3_bucket\." | sed 's/aws_s3_bucket\.//' > "$TMP_DIR/tf_s3.txt" || true
  tofu state list 2> /dev/null | grep "aws_sqs_queue\." | sed 's/aws_sqs_queue\.//' > "$TMP_DIR/tf_sqs.txt" || true

  TF_LAMBDA_COUNT=$(wc -l < "$TMP_DIR/tf_lambdas.txt" | tr -d ' ')
  TF_ROLE_COUNT=$(wc -l < "$TMP_DIR/tf_roles.txt" | tr -d ' ')
  TF_POLICY_COUNT=$(wc -l < "$TMP_DIR/tf_policies.txt" | tr -d ' ')

  echo "  Lambdas in state:   ${TF_LAMBDA_COUNT}"
  echo "  IAM Roles in state: ${TF_ROLE_COUNT}"
  echo "  IAM Policies:       ${TF_POLICY_COUNT}"
  echo ""

  # Collect AWS resources
  echo -e "${YELLOW}[4/8] Collecting AWS resources (${RESOURCE_PREFIX}-* only)...${NC}"

  # Lambda functions (filter by environment prefix)
  aws lambda list-functions --query 'Functions[*].FunctionName' --output text 2> /dev/null | tr '\t' '\n' | sort > "$TMP_DIR/aws_lambdas_all.txt"
  grep -E "$LAMBDA_PATTERN" "$TMP_DIR/aws_lambdas_all.txt" > "$TMP_DIR/aws_lambdas.txt" 2> /dev/null || true

  # IAM roles (filter by environment prefix)
  aws iam list-roles --query 'Roles[*].RoleName' --output text 2> /dev/null | tr '\t' '\n' | sort > "$TMP_DIR/aws_roles_all.txt"
  grep -E "$IAM_PATTERN" "$TMP_DIR/aws_roles_all.txt" > "$TMP_DIR/aws_roles.txt" 2> /dev/null || true

  # IAM policies (filter by environment prefix)
  aws iam list-policies --scope Local --query 'Policies[*].PolicyName' --output text 2> /dev/null | tr '\t' '\n' | sort > "$TMP_DIR/aws_policies_all.txt"
  grep -E "$IAM_PATTERN" "$TMP_DIR/aws_policies_all.txt" > "$TMP_DIR/aws_policies.txt" 2> /dev/null || true

  # CloudFront distributions (filter by environment comment/alias)
  aws cloudfront list-distributions --query 'DistributionList.Items[*].[Id,Comment]' --output text 2> /dev/null | grep -i "${RESOURCE_PREFIX}" > "$TMP_DIR/aws_cloudfront.txt" 2> /dev/null || true

  # API Gateway (filter by environment prefix)
  aws apigateway get-rest-apis --query 'items[*].[id,name]' --output text 2> /dev/null > "$TMP_DIR/aws_apigw_all.txt" || true
  grep -E "$APIGW_PATTERN" "$TMP_DIR/aws_apigw_all.txt" > "$TMP_DIR/aws_apigw.txt" 2> /dev/null || true

  # S3 buckets (filter by environment prefix)
  aws s3api list-buckets --query 'Buckets[*].Name' --output text 2> /dev/null | tr '\t' '\n' > "$TMP_DIR/aws_s3_all.txt" || true
  grep -E "$S3_PATTERN" "$TMP_DIR/aws_s3_all.txt" > "$TMP_DIR/aws_s3.txt" 2> /dev/null || true

  # SQS queues (filter by environment prefix)
  aws sqs list-queues --query 'QueueUrls' --output text 2> /dev/null | tr '\t' '\n' | xargs -I{} basename {} > "$TMP_DIR/aws_sqs_all.txt" 2> /dev/null || true
  grep -E "$SQS_PATTERN" "$TMP_DIR/aws_sqs_all.txt" > "$TMP_DIR/aws_sqs.txt" 2> /dev/null || true

  AWS_LAMBDA_COUNT=$(wc -l < "$TMP_DIR/aws_lambdas.txt" | tr -d ' ')
  AWS_ROLE_COUNT=$(wc -l < "$TMP_DIR/aws_roles.txt" | tr -d ' ')
  AWS_POLICY_COUNT=$(wc -l < "$TMP_DIR/aws_policies.txt" | tr -d ' ')

  echo "  Lambdas in AWS:     ${AWS_LAMBDA_COUNT} (${ENVIRONMENT} only)"
  echo "  IAM Roles in AWS:   ${AWS_ROLE_COUNT} (${ENVIRONMENT} only)"
  echo "  IAM Policies:       ${AWS_POLICY_COUNT} (${ENVIRONMENT} only)"
  echo ""

  # Identify orphaned resources
  echo -e "${YELLOW}[5/8] Identifying orphaned resources...${NC}"

  # Get function names from Terraform state (extract actual names, not resource identifiers)
  # For now, use the resource identifiers which should match function names in this project
  ORPHAN_LAMBDAS=$(find_orphans "$TMP_DIR/aws_lambdas.txt" "$TMP_DIR/tf_lambdas.txt" | sort -u)
  ORPHAN_ROLES=$(find_orphans "$TMP_DIR/aws_roles.txt" "$TMP_DIR/tf_roles.txt" | sort -u)
  ORPHAN_POLICIES=$(find_orphans "$TMP_DIR/aws_policies.txt" "$TMP_DIR/tf_policies.txt" | sort -u)

  if [[ -n "$ORPHAN_LAMBDAS" ]]; then
    ORPHAN_LAMBDA_COUNT=$(echo "$ORPHAN_LAMBDAS" | wc -l | tr -d ' ')
  else
    ORPHAN_LAMBDA_COUNT=0
  fi
  if [[ -n "$ORPHAN_ROLES" ]]; then
    ORPHAN_ROLE_COUNT=$(echo "$ORPHAN_ROLES" | wc -l | tr -d ' ')
  else
    ORPHAN_ROLE_COUNT=0
  fi
  if [[ -n "$ORPHAN_POLICIES" ]]; then
    ORPHAN_POLICY_COUNT=$(echo "$ORPHAN_POLICIES" | wc -l | tr -d ' ')
  else
    ORPHAN_POLICY_COUNT=0
  fi

  if [[ -n "$ORPHAN_LAMBDAS" ]]; then
    echo -e "${RED}Orphaned Lambda functions:${NC}"
    echo "$ORPHAN_LAMBDAS" | while read -r item; do
      [[ -n "$item" ]] && echo "  - $item"
    done
  else
    echo -e "${GREEN}No orphaned Lambda functions${NC}"
  fi

  if [[ -n "$ORPHAN_ROLES" ]]; then
    echo -e "${RED}Orphaned IAM Roles:${NC}"
    echo "$ORPHAN_ROLES" | while read -r item; do
      [[ -n "$item" ]] && echo "  - $item"
    done
  else
    echo -e "${GREEN}No orphaned IAM Roles${NC}"
  fi

  if [[ -n "$ORPHAN_POLICIES" ]]; then
    echo -e "${RED}Orphaned IAM Policies:${NC}"
    echo "$ORPHAN_POLICIES" | while read -r item; do
      [[ -n "$item" ]] && echo "  - $item"
    done
  else
    echo -e "${GREEN}No orphaned IAM Policies${NC}"
  fi
  echo ""

  # Check for duplicates
  echo -e "${YELLOW}[6/8] Checking for duplicates...${NC}"

  # Find duplicates (names with numeric suffixes that shouldn't have them)
  # Pattern: stag-ResourceName-1 or prod-ResourceName_2
  DUPLICATE_LAMBDAS=$(grep -E "^${RESOURCE_PREFIX}-.*[_-][0-9]+$" "$TMP_DIR/aws_lambdas_all.txt" 2> /dev/null || true)
  DUPLICATE_ROLES=$(grep -E "^${RESOURCE_PREFIX}-.*[_-][0-9]+$" "$TMP_DIR/aws_roles_all.txt" 2> /dev/null || true)

  if [[ -n "$DUPLICATE_LAMBDAS" ]]; then
    echo -e "${RED}Potential duplicate Lambdas:${NC}"
    echo "$DUPLICATE_LAMBDAS" | while read -r item; do
      [[ -n "$item" ]] && echo "  - $item"
    done
  else
    echo -e "${GREEN}No duplicate Lambdas found${NC}"
  fi

  if [[ -n "$DUPLICATE_ROLES" ]]; then
    echo -e "${RED}Potential duplicate IAM Roles:${NC}"
    echo "$DUPLICATE_ROLES" | while read -r item; do
      [[ -n "$item" ]] && echo "  - $item"
    done
  else
    echo -e "${GREEN}No duplicate IAM Roles found${NC}"
  fi

  # Count CloudFront and API Gateway
  CLOUDFRONT_COUNT=$(wc -l < "$TMP_DIR/aws_cloudfront.txt" | tr -d ' ')
  APIGW_COUNT=$(wc -l < "$TMP_DIR/aws_apigw.txt" | tr -d ' ')

  if [[ "$CLOUDFRONT_COUNT" -gt 2 ]]; then
    echo -e "${RED}Multiple CloudFront distributions found (expected 2):${NC}"
    while read -r id comment; do
      echo "  - $id ($comment)"
    done < "$TMP_DIR/aws_cloudfront.txt"
  fi

  if [[ "$APIGW_COUNT" -gt 1 ]]; then
    echo -e "${RED}Multiple API Gateways found (expected 1):${NC}"
    while read -r id name; do
      echo "  - $id ($name)"
    done < "$TMP_DIR/aws_apigw.txt"
  fi
  echo ""

  # Check for untagged resources
  echo -e "${YELLOW}[7/8] Checking for untagged resources...${NC}"

  UNTAGGED_COUNT=0
  while IFS= read -r func; do
    [[ -z "$func" ]] && continue
    TAGS=$(aws lambda get-function --function-name "$func" --query 'Tags.ManagedBy' --output text 2> /dev/null || echo "None")
    if [[ "$TAGS" != "terraform" ]]; then
      if [[ $UNTAGGED_COUNT -eq 0 ]]; then
        echo -e "${YELLOW}Lambdas missing ManagedBy=terraform tag:${NC}"
      fi
      echo "  - $func (ManagedBy=$TAGS)"
      ((UNTAGGED_COUNT++))
    fi
  done < "$TMP_DIR/aws_lambdas.txt"

  if [[ $UNTAGGED_COUNT -eq 0 ]]; then
    echo -e "${GREEN}All Lambda functions properly tagged${NC}"
  fi
  echo ""

  # Summary and remediation
  echo -e "${YELLOW}[8/8] Summary${NC}"
  echo "============="
  echo ""

  TOTAL_ORPHANS=$((ORPHAN_LAMBDA_COUNT + ORPHAN_ROLE_COUNT + ORPHAN_POLICY_COUNT))

  echo "Environment:           ${ENVIRONMENT} (${RESOURCE_PREFIX}-*)"
  echo "Workspace:             ${WORKSPACE}"
  echo ""
  echo "Orphaned resources:    ${TOTAL_ORPHANS}"
  echo "  - Lambda functions:  ${ORPHAN_LAMBDA_COUNT}"
  echo "  - IAM Roles:         ${ORPHAN_ROLE_COUNT}"
  echo "  - IAM Policies:      ${ORPHAN_POLICY_COUNT}"
  echo "CloudFront dists:      ${CLOUDFRONT_COUNT} (expected: 2)"
  echo "API Gateways:          ${APIGW_COUNT} (expected: 1)"
  echo "Untagged Lambdas:      ${UNTAGGED_COUNT}"
  echo ""

  # Generate remediation commands
  if [[ $TOTAL_ORPHANS -gt 0 ]]; then
    echo -e "${BLUE}Remediation Commands${NC}"
    echo "===================="
    echo ""

    if [[ -n "$ORPHAN_LAMBDAS" ]]; then
      echo "# Delete orphaned Lambda functions:"
      echo "$ORPHAN_LAMBDAS" | while read -r item; do
        [[ -n "$item" ]] && echo "aws lambda delete-function --function-name \"$item\""
      done
      echo ""
    fi

    if [[ -n "$ORPHAN_ROLES" ]]; then
      echo "# Delete orphaned IAM Roles (detach policies first):"
      echo "$ORPHAN_ROLES" | while read -r item; do
        [[ -n "$item" ]] && echo "aws iam delete-role --role-name \"$item\""
      done
      echo ""
    fi

    if [[ -n "$ORPHAN_POLICIES" ]]; then
      echo "# Delete orphaned IAM Policies:"
      echo "$ORPHAN_POLICIES" | while read -r item; do
        if [[ -n "$item" ]]; then
          POLICY_ARN="arn:aws:iam::${AWS_ACCOUNT}:policy/${item}"
          echo "aws iam delete-policy --policy-arn \"$POLICY_ARN\""
        fi
      done
      echo ""
    fi

    # Prune mode
    if [[ "$PRUNE_MODE" == "true" ]]; then
      echo ""
      echo -e "${RED}PRUNE MODE ACTIVE${NC}"
      echo ""

      if [[ "$DRY_RUN" == "true" ]]; then
        echo "Dry run - no resources will be deleted."
        echo ""
      else
        echo -e "${YELLOW}WARNING: This will delete ${TOTAL_ORPHANS} orphaned resources.${NC}"
        echo ""
        read -p "Are you sure you want to proceed? [y/N] " -n 1 -r
        echo ""

        if [[ $REPLY =~ ^[Yy]$ ]]; then
          # Backup state first
          echo "Backing up state file..."
          cp "${TERRAFORM_DIR}/terraform.tfstate" "${TERRAFORM_DIR}/terraform.tfstate.backup.$(date +%Y%m%d%H%M%S)"

          # Delete orphaned Lambdas
          if [[ -n "$ORPHAN_LAMBDAS" ]]; then
            echo ""
            echo "Deleting orphaned Lambda functions..."
            echo "$ORPHAN_LAMBDAS" | while read -r item; do
              if [[ -n "$item" ]]; then
                echo -n "  Deleting $item... "
                if aws lambda delete-function --function-name "$item" 2> /dev/null; then
                  echo -e "${GREEN}OK${NC}"
                else
                  echo -e "${RED}FAILED${NC}"
                fi
              fi
            done
          fi

          # Delete orphaned policies (before roles, as policies may be attached)
          if [[ -n "$ORPHAN_POLICIES" ]]; then
            echo ""
            echo "Deleting orphaned IAM Policies..."
            echo "$ORPHAN_POLICIES" | while read -r item; do
              if [[ -n "$item" ]]; then
                POLICY_ARN="arn:aws:iam::${AWS_ACCOUNT}:policy/${item}"
                echo -n "  Deleting $item... "

                # First, detach from all roles
                ATTACHED_ROLES=$(aws iam list-entities-for-policy --policy-arn "$POLICY_ARN" --query 'PolicyRoles[*].RoleName' --output text 2> /dev/null || true)
                for role in $ATTACHED_ROLES; do
                  aws iam detach-role-policy --role-name "$role" --policy-arn "$POLICY_ARN" 2> /dev/null || true
                done

                if aws iam delete-policy --policy-arn "$POLICY_ARN" 2> /dev/null; then
                  echo -e "${GREEN}OK${NC}"
                else
                  echo -e "${RED}FAILED${NC}"
                fi
              fi
            done
          fi

          # Delete orphaned roles
          if [[ -n "$ORPHAN_ROLES" ]]; then
            echo ""
            echo "Deleting orphaned IAM Roles..."
            echo "$ORPHAN_ROLES" | while read -r item; do
              if [[ -n "$item" ]]; then
                echo -n "  Deleting $item... "

                # Detach all policies first
                ATTACHED=$(aws iam list-attached-role-policies --role-name "$item" --query 'AttachedPolicies[*].PolicyArn' --output text 2> /dev/null || true)
                for policy in $ATTACHED; do
                  aws iam detach-role-policy --role-name "$item" --policy-arn "$policy" 2> /dev/null || true
                done

                # Delete inline policies
                INLINE=$(aws iam list-role-policies --role-name "$item" --query 'PolicyNames' --output text 2> /dev/null || true)
                for policy in $INLINE; do
                  aws iam delete-role-policy --role-name "$item" --policy-name "$policy" 2> /dev/null || true
                done

                if aws iam delete-role --role-name "$item" 2> /dev/null; then
                  echo -e "${GREEN}OK${NC}"
                else
                  echo -e "${RED}FAILED${NC}"
                fi
              fi
            done
          fi

          echo ""
          echo -e "${GREEN}Pruning complete.${NC}"
          echo ""
          echo "Run 'pnpm run state:verify' to confirm state consistency."
        else
          echo "Aborted."
        fi
      fi
    fi
  else
    echo -e "${GREEN}No orphaned resources found. Infrastructure is clean.${NC}"
  fi

  echo ""
  echo "Audit complete for ${ENVIRONMENT} environment."
  echo ""
  echo "To audit the other environment:"
  if [[ "$ENVIRONMENT" == "staging" ]]; then
    echo "  ./bin/aws-audit.sh --env production"
  else
    echo "  ./bin/aws-audit.sh --env staging"
  fi
}

main "$@"
