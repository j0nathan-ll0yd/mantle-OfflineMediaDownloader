#!/usr/bin/env bash

# adr-new.sh
# Creates a new Architecture Decision Record from template
# Usage: pnpm run adr:new "Title of your decision"

set -euo pipefail # Exit on error, undefined vars, pipe failures

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ADR_DIR="${PROJECT_ROOT}/docs/wiki/Decisions"

# Color constants
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check if title was provided
if [ -z "$1" ]; then
  echo -e "${RED}ERROR: Please provide a title for the ADR${NC}"
  echo "Usage: pnpm run adr:new \"Title of your decision\""
  exit 1
fi

TITLE="$1"

# Find the next ADR number
LAST_ADR=$(find "${ADR_DIR}" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-*.md' -exec basename {} \; 2> /dev/null | sort -r | head -1 | grep -oE '^[0-9]+' || echo "0000")
NEXT_NUM=$(printf "%04d" $((10#$LAST_ADR + 1)))

# Convert title to kebab-case filename
KEBAB_TITLE=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//' | sed 's/-$//')
FILENAME="${NEXT_NUM}-${KEBAB_TITLE}.md"
FILEPATH="${ADR_DIR}/${FILENAME}"

# Get today's date
TODAY=$(date +%Y-%m-%d)

# Create ADR from template
cat > "$FILEPATH" << EOF
# ADR-${NEXT_NUM}: ${TITLE}

## Status
Proposed

## Date
${TODAY}

## Context
What is the issue that we're seeing that is motivating this decision?

## Decision
What is the change that we're proposing and/or doing?

## Consequences

### Positive
- [Benefits of this decision]

### Negative
- [Trade-offs or downsides]

## Enforcement
How is this decision enforced? (MCP rules, ESLint, git hooks, code review)

## Related
- [Link to convention docs that implement this decision]
- [Link to related ADRs]
EOF

echo -e "${GREEN}Created: ${FILEPATH}${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Fill in the Context, Decision, and Consequences sections"
echo "  2. Update the ADR index in docs/wiki/Decisions/README.md"
echo "  3. Change Status from 'Proposed' to 'Accepted' after team review"
