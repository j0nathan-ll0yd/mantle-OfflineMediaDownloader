#!/usr/bin/env bash

# test-integration.sh
# Runs integration tests against LocalStack
# Usage: pnpm run test:integration or ./bin/test-integration.sh

set -euo pipefail # Exit on error, undefined vars, pipe failures

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${PROJECT_ROOT}/docker/docker-compose.localstack.yml"
POSTGRES_COMPOSE_FILE="${PROJECT_ROOT}/docker/docker-compose.test.yml"

# Per-worktree ports/container names (no-op in the main checkout)
cd "${PROJECT_ROOT}"
# shellcheck source=bin/worktree-ports.sh
. "${SCRIPT_DIR}/worktree-ports.sh"

LOCALSTACK_HEALTH_URL="http://localhost:${LOCALSTACK_PORT:-4566}/_localstack/health"
TEST_DB_CONTAINER="${TEST_DB_CONTAINER_NAME:-media-downloader-test-db}"
LOCALSTACK_CONTAINER="${LOCALSTACK_CONTAINER_NAME:-aws-media-downloader-localstack}"
MAX_HEALTH_RETRIES=30
HEALTH_RETRY_DELAY=1

# Color constants
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Error handler (available for future use)
# shellcheck disable=SC2329
error() {
  echo -e "${RED}✗${NC} Error: $1" >&2
  exit "${2:-1}"
}

# Function to check LocalStack health
check_localstack_health() {
  local retry_count=0

  echo -e "${YELLOW}Waiting for LocalStack to be ready...${NC}"

  while [ $retry_count -lt $MAX_HEALTH_RETRIES ]; do
    if curl -sf "$LOCALSTACK_HEALTH_URL" > /dev/null 2>&1; then
      echo -e "${GREEN}✓${NC} LocalStack is healthy"

      # Show service status
      local health_status
      health_status=$(curl -s "$LOCALSTACK_HEALTH_URL" | jq -r '.services | to_entries | map("\(.key): \(.value)") | join(", ")')
      echo -e "${BLUE}Services: $health_status${NC}"
      echo ""
      return 0
    fi

    retry_count=$((retry_count + 1))

    if [ $retry_count -lt $MAX_HEALTH_RETRIES ]; then
      echo -n "."
      sleep $HEALTH_RETRY_DELAY
    fi
  done

  echo ""
  echo -e "${RED}Error: LocalStack failed to become healthy after ${MAX_HEALTH_RETRIES} seconds${NC}"
  return 1
}

# Function to check PostgreSQL health
check_postgres_health() {
  local retry_count=0

  echo -e "${YELLOW}Waiting for PostgreSQL to be ready...${NC}"

  while [ $retry_count -lt $MAX_HEALTH_RETRIES ]; do
    if docker exec "$TEST_DB_CONTAINER" pg_isready -U test -d media_downloader_test > /dev/null 2>&1; then
      echo -e "${GREEN}✓${NC} PostgreSQL is healthy"
      echo ""
      return 0
    fi

    retry_count=$((retry_count + 1))

    if [ $retry_count -lt $MAX_HEALTH_RETRIES ]; then
      echo -n "."
      sleep $HEALTH_RETRY_DELAY
    fi
  done

  echo ""
  echo -e "${RED}Error: PostgreSQL failed to become healthy after ${MAX_HEALTH_RETRIES} seconds${NC}"
  return 1
}

main() {
  # Flags
  local cleanup_after=false
  local start_localstack=true
  local test_exit_code=0

  # Parse command line arguments
  while [[ $# -gt 0 ]]; do
    case $1 in
      --cleanup)
        cleanup_after=true
        shift
        ;;
      --no-start)
        start_localstack=false
        shift
        ;;
      *)
        echo -e "${RED}Unknown option: $1${NC}"
        echo "Usage: $0 [--cleanup] [--no-start]"
        echo "  --cleanup: Stop LocalStack after tests complete"
        echo "  --no-start: Don't start LocalStack (assume it's already running)"
        exit 1
        ;;
    esac
  done

  echo -e "${GREEN}Integration Test Runner${NC}"
  echo "======================="
  echo ""

  # Check required commands
  echo -e "${YELLOW}Checking prerequisites...${NC}"

  if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: docker is not installed${NC}"
    echo "Please install Docker Desktop: https://www.docker.com/products/docker-desktop"
    exit 1
  fi

  if ! docker compose version &> /dev/null; then
    echo -e "${RED}Error: docker compose is not available${NC}"
    echo "Please install Docker with Compose plugin or docker-compose standalone"
    exit 1
  fi

  echo -e "${GREEN}✓${NC} Docker and docker compose are available"
  echo ""

  # Start services if requested
  if [ "$start_localstack" = true ]; then
    # Start PostgreSQL for database tests
    echo -e "${YELLOW}Starting PostgreSQL...${NC}"
    if docker ps | grep -q "$TEST_DB_CONTAINER"; then
      echo -e "${BLUE}➜${NC} PostgreSQL is already running"
      echo ""
    else
      echo -e "${BLUE}➜${NC} Starting PostgreSQL container..."
      docker compose -f "$POSTGRES_COMPOSE_FILE" up -d
      echo ""
    fi

    # Wait for PostgreSQL to be healthy
    if ! check_postgres_health; then
      echo -e "${RED}PostgreSQL health check failed${NC}"
      echo ""
      echo "Troubleshooting:"
      echo "  1. Check PostgreSQL logs: docker logs $TEST_DB_CONTAINER"
      echo "  2. Restart PostgreSQL: docker compose -f docker/docker-compose.test.yml down && docker compose -f docker/docker-compose.test.yml up -d"
      exit 1
    fi

    # Start LocalStack for AWS services
    echo -e "${YELLOW}Starting LocalStack...${NC}"

    # Check if LocalStack is already running
    if docker ps | grep -q "$LOCALSTACK_CONTAINER"; then
      echo -e "${BLUE}➜${NC} LocalStack is already running"
      echo ""
    else
      echo -e "${BLUE}➜${NC} Starting LocalStack container..."
      docker compose -f "$COMPOSE_FILE" up -d
      echo ""
    fi

    # Wait for LocalStack to be healthy
    if ! check_localstack_health; then
      echo -e "${RED}LocalStack health check failed${NC}"
      echo ""
      echo "Troubleshooting:"
      echo "  1. Check LocalStack logs: pnpm run localstack:logs"
      echo "  2. Restart LocalStack: pnpm run localstack:stop && pnpm run localstack:start"
      echo "  3. Check Docker resources (memory, CPU)"
      exit 1
    fi
  else
    echo -e "${YELLOW}Skipping service startup (--no-start flag)${NC}"
    echo ""

    # Verify PostgreSQL is running
    if ! docker ps | grep -q "$TEST_DB_CONTAINER"; then
      echo -e "${RED}Error: PostgreSQL is not running${NC}"
      echo "Start PostgreSQL with: docker compose -f docker/docker-compose.test.yml up -d"
      exit 1
    fi

    # Check PostgreSQL health
    if ! check_postgres_health; then
      echo -e "${RED}PostgreSQL is running but not healthy${NC}"
      exit 1
    fi

    # Verify LocalStack is running
    if ! docker ps | grep -q "$LOCALSTACK_CONTAINER"; then
      echo -e "${RED}Error: LocalStack is not running${NC}"
      echo "Start LocalStack with: pnpm run localstack:start"
      exit 1
    fi

    # Check LocalStack health
    if ! check_localstack_health; then
      echo -e "${RED}LocalStack is running but not healthy${NC}"
      exit 1
    fi
  fi

  # Run integration tests
  echo -e "${YELLOW}Running integration tests...${NC}"
  echo ""

  cd "$PROJECT_ROOT"

  # Set environment variable for integration tests
  export USE_LOCALSTACK=true

  # Run Vitest with integration config
  if pnpm exec vitest run --config vitest.integration.config.mts; then
    test_exit_code=0
    echo ""
    echo -e "${GREEN}✓${NC} All integration tests passed!"
  else
    test_exit_code=$?
    echo ""
    echo -e "${RED}✗${NC} Integration tests failed"
  fi

  echo ""

  # Cleanup if requested
  if [ "$cleanup_after" = true ]; then
    echo -e "${YELLOW}Stopping services...${NC}"
    docker compose -f "$COMPOSE_FILE" down
    docker compose -f "$POSTGRES_COMPOSE_FILE" down
    echo -e "${GREEN}✓${NC} LocalStack and PostgreSQL stopped"
    echo ""
  else
    echo -e "${BLUE}➜${NC} Services are still running"
    echo "To stop LocalStack: pnpm run localstack:stop"
    echo "To stop PostgreSQL: docker compose -f docker/docker-compose.test.yml down"
    echo "To view LocalStack logs: pnpm run localstack:logs"
    echo ""
  fi

  # Summary
  echo -e "${GREEN}Test Run Complete${NC}"
  echo "=================="
  echo ""
  echo -e "${BLUE}➜${NC} Test location: test/integration/"
  echo -e "${BLUE}➜${NC} Exit code: $test_exit_code"
  echo ""

  if [ $test_exit_code -eq 0 ]; then
    echo "Next steps:"
    echo "  - Review test coverage"
    echo "  - Add more integration tests as needed"
    echo "  - Run unit tests: pnpm test"
  else
    echo "Troubleshooting:"
    echo "  - Check LocalStack logs: pnpm run localstack:logs"
    echo "  - Review test output above"
    echo "  - Verify LocalStack services are healthy: pnpm run localstack:health"
  fi

  echo ""

  exit $test_exit_code
}

main "$@"
