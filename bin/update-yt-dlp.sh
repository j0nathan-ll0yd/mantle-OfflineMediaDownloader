#!/usr/bin/env bash

# update-yt-dlp.sh
# Checks for the latest yt-dlp release and optionally bumps the version.
# The single source of truth is the `ARG YTDLP_VERSION=` line in
# docker/Dockerfile.download (the StartFileUpload container's runtime binary).
# Usage: pnpm run update-yt-dlp [check|update]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOCKERFILE="${PROJECT_ROOT}/docker/Dockerfile.download"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Error handler
error() {
  echo -e "${RED}✗${NC} Error: $1" >&2
  exit "${2:-1}"
}

# Read the current version from the Dockerfile ARG (single source of truth).
read_current_version() {
  grep -E '^ARG YTDLP_VERSION=' "$DOCKERFILE" | head -1 | cut -d= -f2 | tr -d '[:space:]'
}

# Replace the Dockerfile ARG version. Portable across macOS/BSD and GNU sed
# (avoids the `sed -i` incompatibility) by writing through a temp file.
write_version() {
  local new_version="$1"
  local tmp
  tmp="$(mktemp)"
  sed "s|^ARG YTDLP_VERSION=.*|ARG YTDLP_VERSION=${new_version}|" "$DOCKERFILE" > "$tmp"
  mv "$tmp" "$DOCKERFILE"
}

main() {
  local MODE="${1:-check}"

  echo -e "${GREEN}yt-dlp Version Manager${NC}"
  echo "====================="
  echo ""

  if ! command -v gh &> /dev/null; then
    error "GitHub CLI (gh) is required but not installed. Install with: brew install gh"
  fi

  if [ ! -f "$DOCKERFILE" ]; then
    error "Dockerfile not found at ${DOCKERFILE}"
  fi

  echo -e "${BLUE}Fetching latest yt-dlp release...${NC}"
  local LATEST_VERSION
  LATEST_VERSION=$(gh api repos/yt-dlp/yt-dlp/releases --jq '[.[] | select(.prerelease == false)][0].tag_name')

  if [ -z "$LATEST_VERSION" ]; then
    error "Failed to fetch latest version from GitHub"
  fi

  echo -e "${GREEN}Latest version:${NC} ${LATEST_VERSION}"

  local CURRENT_VERSION
  CURRENT_VERSION="$(read_current_version)"
  if [ -z "$CURRENT_VERSION" ]; then
    error "Could not read current ARG YTDLP_VERSION from ${DOCKERFILE}"
  fi
  echo -e "${GREEN}Current version:${NC} ${CURRENT_VERSION}"

  echo ""

  if [ "$LATEST_VERSION" == "$CURRENT_VERSION" ]; then
    echo -e "${GREEN}✓${NC} Already on latest version"
    exit 0
  fi

  echo -e "${YELLOW}Update available:${NC} ${CURRENT_VERSION} → ${LATEST_VERSION}"
  echo ""

  if [ "$MODE" == "check" ]; then
    echo "Run with 'update' argument to bump the Dockerfile ARG:"
    echo "  pnpm run update-yt-dlp update"
    exit 0
  fi

  if [ "$MODE" == "update" ]; then
    echo -e "${BLUE}Updating docker/Dockerfile.download ARG YTDLP_VERSION...${NC}"
    write_version "$LATEST_VERSION"

    echo -e "${GREEN}✓${NC} Dockerfile ARG updated to ${LATEST_VERSION}"
    echo ""
    echo "Next steps:"
    echo "  1. Review the change: git diff ${DOCKERFILE}"
    echo "  2. Rebuild the container: pnpm run build (rebuilds the StartFileUpload image)"
    echo "  3. Commit the change: git add ${DOCKERFILE}"
    echo "     git commit -m \"chore(deps): update yt-dlp to ${LATEST_VERSION}\""
    echo "  4. Deploy: pnpm run deploy:staging"
    exit 0
  fi

  error "Unknown mode '${MODE}'. Usage: $0 [check|update]"
}

main "$@"
