#!/usr/bin/env bash
# Comprehensive cleanup: validate, fix, generate, and test everything
#
# Usage:
#   ./bin/cleanup.sh           # Run full cleanup with integration tests
#   ./bin/cleanup.sh --fast    # Skip integration tests (faster)
#   ./bin/cleanup.sh --check   # Dry-run: check only, no fixes/generation

set -euo pipefail

# Per-worktree LocalStack port (no-op in the main checkout)
# shellcheck source=bin/worktree-ports.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/worktree-ports.sh"

# Parse arguments
FAST_MODE=false
CHECK_ONLY=false
for arg in "$@"; do
  case $arg in
    --fast)
      FAST_MODE=true
      ;;
    --check)
      CHECK_ONLY=true
      ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Error handler (used by sourcing scripts)
# shellcheck disable=SC2329
error() {
  echo -e "${RED}✗${NC} Error: $1" >&2
  exit "${2:-1}"
}

log_step() { echo -e "\n${BLUE}[$1/$TOTAL]${NC} $2"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() {
  echo -e "${RED}✗${NC} $1"
  ERRORS=$((ERRORS + 1))
}

run_cmd() {
  local desc="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    log_success "$desc"
    return 0
  else
    log_error "$desc"
    return 1
  fi
}

# shellcheck disable=SC2329
run_cmd_verbose() {
  local desc="$1"
  shift
  echo -e "   Running: $*"
  if "$@"; then
    log_success "$desc"
    return 0
  else
    log_error "$desc"
    return 1
  fi
}

main() {
  # Calculate total steps
  if [ "$FAST_MODE" = true ]; then
    TOTAL=27
  elif [ "$CHECK_ONLY" = true ]; then
    TOTAL=21
  else
    TOTAL=30
  fi
  STEP=0
  ERRORS=0

  echo -e "${BLUE}═══════════════════════════════════════${NC}"
  if [ "$CHECK_ONLY" = true ]; then
    echo -e "${BLUE}  Cleanup Check (dry-run)${NC}"
  elif [ "$FAST_MODE" = true ]; then
    echo -e "${BLUE}  Cleanup (fast mode)${NC}"
  else
    echo -e "${BLUE}  Full Cleanup${NC}"
  fi
  echo -e "${BLUE}═══════════════════════════════════════${NC}"

  # Phase 1: Dependencies & Build
  log_step $((++STEP)) "Installing dependencies..."
  run_cmd "Dependencies installed" pnpm install --frozen-lockfile

  log_step $((++STEP)) "Generating dependency graph..."
  run_cmd "Dependency graph generated" pnpm run --silent generate:graph

  log_step $((++STEP)) "Building Terraform types..."
  run_cmd "Terraform types built" pnpm run --silent build:dependencies

  log_step $((++STEP)) "Building Lambda bundles..."
  run_cmd "Lambda bundles built" pnpm run --silent build

  # Phase 2: Type Checking
  log_step $((++STEP)) "Checking TypeScript types..."
  run_cmd "TypeScript types valid" pnpm run --silent check:types

  log_step $((++STEP)) "Checking test types..."
  run_cmd "Test types valid" pnpm run --silent check:test:types

  # Phase 3: Formatting
  if [ "$CHECK_ONLY" = true ]; then
    log_step $((++STEP)) "Checking code formatting..."
    run_cmd "Code formatting valid" pnpm run --silent format:check

    log_step $((++STEP)) "Checking bash formatting..."
    run_cmd "Bash formatting valid" pnpm run --silent format:bash:check
  else
    log_step $((++STEP)) "Formatting code..."
    run_cmd "Code formatted" pnpm run --silent format

    log_step $((++STEP)) "Formatting bash scripts..."
    run_cmd "Bash scripts formatted" pnpm run --silent format:bash
  fi

  # Phase 4: Linting
  if [ "$CHECK_ONLY" = true ]; then
    log_step $((++STEP)) "Checking lint..."
    run_cmd "Lint check passed" pnpm run --silent lint
  else
    log_step $((++STEP)) "Linting (with auto-fix)..."
    run_cmd "Lint passed" pnpm run --silent lint:fix
  fi

  # Optional: GitHub workflows lint (skip if actionlint not installed)
  if command -v actionlint &> /dev/null; then
    log_step $((++STEP)) "Linting GitHub workflows..."
    run_cmd "Workflow lint passed" pnpm run --silent lint:workflows
  else
    log_step $((++STEP)) "Skipping GitHub workflow lint (actionlint not installed)"
    log_warn "Install actionlint for workflow validation"
  fi

  log_step $((++STEP)) "Testing ESLint rules..."
  run_cmd "ESLint rules valid" pnpm run --silent test:eslint:rules

  # Phase 5: Validation
  log_step $((++STEP)) "Validating conventions (skipped — module removed during Mantle migration)..."
  # run_cmd "Conventions valid" pnpm run --silent check:conventions

  log_step $((++STEP)) "Validating config..."
  run_cmd "Config valid" pnpm run --silent validate:config

  log_step $((++STEP)) "Validating API paths..."
  run_cmd "API paths aligned" pnpm run --silent validate:api-paths

  log_step $((++STEP)) "Validating docs..."
  run_cmd "Docs valid" pnpm run --silent validate:docs

  log_step $((++STEP)) "Validating doc sync..."
  run_cmd "Doc sync valid" pnpm run --silent validate:doc-sync

  log_step $((++STEP)) "Validating GraphRAG..."
  run_cmd "GraphRAG valid" pnpm run --silent validate:graphrag

  log_step $((++STEP)) "Checking dependencies..."
  run_cmd "Dependency rules passed" pnpm run --silent deps:check

  log_step $((++STEP)) "Checking TypeSpec..."
  run_cmd "TypeSpec valid" pnpm run --silent typespec:check

  # Phase 6: Testing
  log_step $((++STEP)) "Running unit tests..."
  TEST_OUTPUT=$(pnpm run test 2>&1)
  TEST_EXIT_CODE=$?

  if [ $TEST_EXIT_CODE -eq 0 ]; then
    log_success "Unit tests passed"
  else
    log_error "Unit tests failed"
  fi

  # Validate test output is clean
  log_step $((++STEP)) "Validating test output..."
  TEST_ISSUES=0

  # Check for Vitest deprecation warnings
  if echo "$TEST_OUTPUT" | grep -q "DEPRECATED"; then
    log_error "Found Vitest deprecation warnings in test output"
    echo "$TEST_OUTPUT" | grep "DEPRECATED" | head -3
    TEST_ISSUES=$((TEST_ISSUES + 1))
  fi

  # Check for EMF metrics spam (Powertools not silenced)
  if echo "$TEST_OUTPUT" | grep -q '"_aws".*"CloudWatchMetrics"'; then
    log_error "Found Powertools EMF metrics in test output (should be silenced)"
    TEST_ISSUES=$((TEST_ISSUES + 1))
  fi

  # Check for MCR source content warnings
  if echo "$TEST_OUTPUT" | grep -q "\[MCR\] not found source content"; then
    log_error "Found MCR source content warnings in test output"
    echo "$TEST_OUTPUT" | grep "\[MCR\] not found" | head -3
    TEST_ISSUES=$((TEST_ISSUES + 1))
  fi

  if [ $TEST_ISSUES -eq 0 ]; then
    log_success "Test output is clean"
  else
    ERRORS=$((ERRORS + TEST_ISSUES))
  fi

  # Phase 7: Documentation (skip in check mode)
  if [ "$CHECK_ONLY" = false ]; then
    log_step $((++STEP)) "Generating source docs..."
    run_cmd "Source docs generated" pnpm run --silent document-source

    log_step $((++STEP)) "Generating Terraform docs..."
    run_cmd "Terraform docs generated" pnpm run --silent document-terraform

    log_step $((++STEP)) "Generating API docs..."
    run_cmd "API docs generated" pnpm run --silent document-api
  fi

  # Phase 8: Context & Knowledge (skip in check mode)
  if [ "$CHECK_ONLY" = false ]; then
    log_step $((++STEP)) "Extracting GraphRAG..."
    run_cmd "GraphRAG extracted" pnpm run --silent graphrag:extract

    log_step $((++STEP)) "Packing context..."
    run_cmd "Context packed" pnpm run --silent pack:context
  fi

  # Phase 9: Integration Tests (skip in fast mode and check mode)
  if [ "$FAST_MODE" = false ] && [ "$CHECK_ONLY" = false ]; then
    log_step $((++STEP)) "Starting LocalStack..."
    if pnpm run --silent localstack:start > /dev/null 2>&1; then
      log_success "LocalStack started"

      # Wait for LocalStack to be ready
      echo "   Waiting for LocalStack to be ready..."
      RETRIES=30
      while [ $RETRIES -gt 0 ]; do
        if curl -s "http://localhost:${LOCALSTACK_PORT:-4566}/_localstack/health" | grep -q '"ready"' 2> /dev/null; then
          break
        fi
        RETRIES=$((RETRIES - 1))
        sleep 1
      done

      if [ $RETRIES -eq 0 ]; then
        log_error "LocalStack failed to become ready"
      else
        log_step $((++STEP)) "Running integration tests..."
        if pnpm run --silent test:integration; then
          log_success "Integration tests passed"
        else
          log_error "Integration tests failed"
        fi
      fi

      log_step $((++STEP)) "Stopping LocalStack..."
      run_cmd "LocalStack stopped" pnpm run --silent localstack:stop
    else
      log_error "LocalStack failed to start"
      log_warn "Install Docker and docker compose for integration tests"
    fi
  fi

  # Summary
  echo ""
  echo -e "${BLUE}═══════════════════════════════════════${NC}"
  if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}  All cleanup checks passed!${NC}"
  else
    echo -e "${RED}  Cleanup completed with $ERRORS error(s)${NC}"
  fi
  echo -e "${BLUE}═══════════════════════════════════════${NC}"

  exit $ERRORS
}

main "$@"
