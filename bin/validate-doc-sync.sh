#!/usr/bin/env bash

# validate-doc-sync.sh
# Validates documentation stays in sync with codebase
# Usage: pnpm run validate:doc-sync or ./bin/validate-doc-sync.sh
#
# This script detects documentation drift by checking:
#   1. Entity count matches src/entities/*.ts files
#   2. Lambda count matches trigger table in AGENTS.md
#   3. MCP rule count matches documentation
#   4. Documented paths exist in filesystem
#   5. No stale patterns (Prettier, wrong vendor path)
#   6. GraphRAG metadata includes all entities
#   7. Wiki internal links resolve (BLOCKING)
#   8. Documentation structure (markdown in wiki/, machine files in root)
#   9. Code path references in wiki docs
#  10. Import alias validation in code blocks
#  11. TypeSpec covers all API endpoints
#
# Issue #145: Living Documentation System with Stale Page Detection

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Color constants
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Error handler
error() {
  echo -e "${RED}✗${NC} Error: $1" >&2
  exit "${2:-1}"
}

main() {
  echo -e "${YELLOW}Validating documentation sync...${NC}"
  echo ""

  cd "$PROJECT_ROOT"

  ERRORS=""
  WARNINGS=""

  # =============================================================================
  # Check 1: Entity query file count matches documentation
  # =============================================================================
  echo -n "  [1/11] Checking entity query files... "
  # Count query files in src/entities/queries/ (excluding index.ts and test files)
  QUERY_FILE_COUNT=$(find src/entities/queries -name "*.ts" ! -name "*.test.ts" ! -name "index.ts" 2> /dev/null | wc -l | tr -d ' ')

  # Count query files listed in AGENTS.md between entities/ and lambdas/ sections
  # Each query file is listed with │   │       ├── or │   │       └──
  # Count all .ts files (queries, operations, etc.) excluding index.ts
  DOCUMENTED_QUERY_COUNT=$(awk '/entities\/.*query functions/,/lambdas\/.*Lambda/' AGENTS.md 2> /dev/null | grep -E '│.*\.(ts)' | grep -vc 'index\.ts' || echo 0)

  if [ "$QUERY_FILE_COUNT" -ne "$DOCUMENTED_QUERY_COUNT" ]; then
    echo -e "${RED}MISMATCH${NC}"
    ERRORS="$ERRORS\n  - Query file count: found $QUERY_FILE_COUNT files in src/entities/queries/, documented $DOCUMENTED_QUERY_COUNT in AGENTS.md"
  else
    echo -e "${GREEN}OK${NC} ($QUERY_FILE_COUNT query files)"
  fi

  # =============================================================================
  # Check 2: Lambda count matches documentation
  # =============================================================================
  echo -n "  [2/11] Checking Lambda count... "
  # Count Lambda entry points: file-based routing (*.post.ts, *.get.ts, *.delete.ts)
  # and directory-based (index.ts inside named folders, excluding test files)
  LAMBDA_COUNT=$(find src/lambdas \( -name "*.post.ts" -o -name "*.get.ts" -o -name "*.delete.ts" -o -name "*.put.ts" -o -name "*.patch.ts" -o -name "index.ts" \) ! -name "*.test.ts" 2> /dev/null | wc -l | tr -d ' ')

  # Count rows in Lambda Trigger Patterns table (lines starting with | and a word char, excluding header)
  # Skip lines containing "Trigger Type" or "---" (header/separator rows)
  # Table is in docs/wiki/Architecture/System-Diagrams.md
  TRIGGER_TABLE_COUNT=$(awk '/## Lambda Trigger Patterns/,/## Data Access/' docs/wiki/Architecture/System-Diagrams.md 2> /dev/null | grep -E '^\| [A-Za-z]' | grep -v 'Trigger Type' | grep -vc '\-\-\-' || echo 0)

  if [ "$LAMBDA_COUNT" -ne "$TRIGGER_TABLE_COUNT" ]; then
    echo -e "${RED}MISMATCH${NC}"
    ERRORS="$ERRORS\n  - Lambda count: found $LAMBDA_COUNT entry points in src/lambdas/, documented $TRIGGER_TABLE_COUNT in trigger table"
  else
    echo -e "${GREEN}OK${NC} ($LAMBDA_COUNT Lambdas)"
  fi

  # =============================================================================
  # Check 3: Convention validation (managed by Mantle)
  # =============================================================================
  echo -n "  [3/11] Convention validation... "
  echo -e "${GREEN}SKIP${NC} (managed by mantle check)"

  # =============================================================================
  # Check 4: Critical paths exist
  # =============================================================================
  echo -n "  [4/11] Checking documented paths exist... "
  PATHS_OK=true

  REQUIRED_PATHS=(
    "src/entities/queries"
    "src/lambdas"
    "test/helpers"
    "graphrag"
  )

  for path in "${REQUIRED_PATHS[@]}"; do
    if [ ! -e "$path" ]; then
      ERRORS="$ERRORS\n  - Missing documented path: $path"
      PATHS_OK=false
    fi
  done

  if [ "$PATHS_OK" = true ]; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${RED}MISSING${NC}"
  fi

  # =============================================================================
  # Check 5: Forbidden patterns in AGENTS.md
  # =============================================================================
  echo -n "  [5/11] Checking for stale patterns... "
  STALE_OK=true

  # Check for old Prettier reference (should be dprint)
  if grep -q "Prettier" AGENTS.md 2> /dev/null; then
    ERRORS="$ERRORS\n  - AGENTS.md references 'Prettier' but project uses 'dprint'"
    STALE_OK=false
  fi

  # Check for wrong vendor path (lib/vendor without src/ prefix, not in a comment)
  # Only flag if there's NO src/lib/vendor reference anywhere
  if ! grep -q "src/lib/vendor" AGENTS.md 2> /dev/null; then
    ERRORS="$ERRORS\n  - AGENTS.md missing src/lib/vendor reference"
    STALE_OK=false
  fi

  if [ "$STALE_OK" = true ]; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${RED}STALE${NC}"
  fi

  # =============================================================================
  # Check 6: GraphRAG metadata completeness
  # =============================================================================
  echo -n "  [6/11] Checking GraphRAG metadata... "
  GRAPHRAG_OK=true

  # Get query file names from entities/queries/ directory
  FS_QUERY_FILES=$(find src/entities/queries -name "*-queries.ts" -exec basename {} .ts \; 2> /dev/null | sort)

  # Check each query module is represented in metadata.json entityRelationships
  # The metadata has entity names like "Users", "Files" - we check those exist
  for query_file in $FS_QUERY_FILES; do
    # Map query files to expected entities (e.g., user-queries -> Users)
    case "$query_file" in
      user-queries) expected="Users" ;;
      file-queries) expected="Files" ;;
      device-queries) expected="Devices" ;;
      session-queries) expected="Sessions" ;;
      relationship-queries) expected="UserFiles" ;;
      *) expected="" ;;
    esac

    if [ -n "$expected" ] && ! grep -q "\"$expected\"" graphrag/metadata.json 2> /dev/null; then
      WARNINGS="$WARNINGS\n  - Entity '$expected' (from $query_file.ts) not found in graphrag/metadata.json"
      GRAPHRAG_OK=false
    fi
  done

  if [ "$GRAPHRAG_OK" = true ]; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${YELLOW}INCOMPLETE${NC} (warning only)"
  fi

  # =============================================================================
  # Check 7: Wiki internal links resolve
  # =============================================================================
  echo -n "  [7/11] Checking wiki links... "
  WIKI_OK=true
  BROKEN_LINKS=""

  # Find all markdown files in docs/wiki and check their internal links
  while IFS= read -r md_file; do
    while IFS= read -r link; do
      [ -z "$link" ] && continue
      [[ "$link" == http* ]] && continue
      [[ "$link" == "#"* ]] && continue
      link_path="${link%%#*}"
      [ -z "$link_path" ] && continue

      # Resolve relative path from the markdown file's directory
      md_dir=$(dirname "$md_file")
      target_path="$md_dir/$link_path"

      if [ ! -f "$target_path" ]; then
        BROKEN_LINKS="$BROKEN_LINKS\n  - $md_file: broken link to '$link_path'"
        WIKI_OK=false
      fi
    done < <(awk 'BEGIN{c=0; bt=sprintf("%c",96); pat="^" bt bt bt} $0 ~ pat {c=1-c; next} c==0{print}' "$md_file" 2> /dev/null | grep -oE '\]\([^)]+\.md[^)]*\)' | sed 's/\](\([^)]*\))/\1/' | sed 's/#.*//' || true)
  done < <(find docs/wiki -name "*.md" 2> /dev/null)

  # Also scan AGENTS.md and CLAUDE.md for links to docs/wiki/ paths
  for root_doc in AGENTS.md CLAUDE.md; do
    [ ! -f "$root_doc" ] && continue
    while IFS= read -r link; do
      [ -z "$link" ] && continue
      [[ "$link" == http* ]] && continue
      [[ "$link" == "#"* ]] && continue
      link_path="${link%%#*}"
      [ -z "$link_path" ] && continue

      # Only check links that target docs/wiki/
      [[ "$link_path" != docs/wiki/* ]] && continue

      if [ ! -f "$link_path" ]; then
        BROKEN_LINKS="$BROKEN_LINKS\n  - $root_doc: broken link to '$link_path'"
        WIKI_OK=false
      fi
    done < <(awk 'BEGIN{c=0; bt=sprintf("%c",96); pat="^" bt bt bt} $0 ~ pat {c=1-c; next} c==0{print}' "$root_doc" 2> /dev/null | grep -oE '\]\([^)]+\.md[^)]*\)' | sed 's/\](\([^)]*\))/\1/' | sed 's/#.*//' || true)
  done

  if [ "$WIKI_OK" = true ]; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${RED}BROKEN LINKS${NC}"
    ERRORS="$ERRORS$BROKEN_LINKS"
  fi

  # =============================================================================
  # Check 8: Documentation structure (markdown in wiki/, machine files in root)
  # =============================================================================
  echo -n "  [8/11] Checking docs/ structure... "
  DOCS_OK=true

  # Allowed files in docs/ root
  ALLOWED_ROOT_FILES=(
    "doc-code-mapping.json"
    "doc-code-mapping.schema.json"
    "llms.txt"
    "llms-full.txt"
    "terraform.md"
  )

  # Allowed subdirectories in docs/
  ALLOWED_SUBDIRS=("wiki" "api" "source")

  # Check files in docs/ root
  for file in docs/*; do
    [ ! -e "$file" ] && continue
    basename=$(basename "$file")

    if [ -f "$file" ]; then
      # Check if file is in allowed list
      is_allowed=false
      for allowed in "${ALLOWED_ROOT_FILES[@]}"; do
        if [ "$basename" = "$allowed" ]; then
          is_allowed=true
          break
        fi
      done

      if [ "$is_allowed" = false ]; then
        if [[ "$basename" == *.md ]]; then
          ERRORS="$ERRORS\n  - Markdown file '$basename' should be in docs/wiki/, not docs/ root"
        else
          WARNINGS="$WARNINGS\n  - Unexpected file '$basename' in docs/ root"
        fi
        DOCS_OK=false
      fi
    elif [ -d "$file" ]; then
      # Check if directory is in allowed list
      is_allowed=false
      for allowed in "${ALLOWED_SUBDIRS[@]}"; do
        if [ "$basename" = "$allowed" ]; then
          is_allowed=true
          break
        fi
      done

      if [ "$is_allowed" = false ]; then
        ERRORS="$ERRORS\n  - Unexpected subdirectory 'docs/$basename/' - move markdown to docs/wiki/"
        DOCS_OK=false
      fi
    fi
  done

  if [ "$DOCS_OK" = true ]; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${RED}STRUCTURE VIOLATION${NC}"
  fi

  # =============================================================================
  # Check 9: Code path references in wiki docs
  # =============================================================================
  echo -n "  [9/11] Checking code path references... "
  CODE_PATHS_OK=true
  STALE_PATHS=""

  # Check for common stale path patterns in wiki docs
  # Use a single awk pass per file to extract backtick-wrapped paths outside code blocks
  while IFS= read -r md_file; do
    # Extract all backtick-wrapped paths in a single awk pass (skip fenced code blocks)
    # This avoids nested loops and process substitutions that cause memory issues
    paths=$(awk '
      BEGIN { in_code = 0 }
      /^```/ { in_code = !in_code; next }
      !in_code {
        # Match backtick-wrapped content and print it
        while (match($0, /`[^`]+`/)) {
          path = substr($0, RSTART+1, RLENGTH-2)
          print path
          $0 = substr($0, RSTART+RLENGTH)
        }
      }
    ' "$md_file" 2> /dev/null || true)

    # Check each extracted path
    while IFS= read -r path; do
      [ -z "$path" ] && continue

      # Skip bare directory names (types/, util/, lib/) - these are conceptual references
      [[ "$path" == "types/" ]] && continue
      [[ "$path" == "util/" ]] && continue
      [[ "$path" == "lib/" ]] && continue

      # Only check paths that look like file/directory references
      if [[ "$path" =~ ^(src|test|util|types|build|graphrag|infra|bin|scripts)/ ]]; then
        # Skip glob patterns (*, **, etc.)
        [[ "$path" == *"*"* ]] && continue
        # Skip template patterns ([name], {name}, etc.)
        [[ "$path" == *"["* ]] && continue
        [[ "$path" == *"{"* ]] && continue
        # Skip line number references (file.ts:123)
        [[ "$path" =~ :[0-9] ]] && continue
        # Skip generated files that may not exist (in .gitignore)
        [[ "$path" == "build/graph.json" ]] && continue
        # Skip template/example paths in documentation
        [[ "$path" == *"VendorName"* ]] && continue
        [[ "$path" == *"NewService"* ]] && continue
        [[ "$path" == "test/test" ]] && continue
        [[ "$path" == "test/fixtures/"* ]] && continue
        # Skip planned test files documented in audit (may not exist yet)
        [[ "$path" == *"/test/"*".test.ts" ]] && continue
        [[ "$path" == "test/helpers/"* ]] && continue
        [[ "$path" == "test/integration/helpers/"* ]] && continue

        # Check if path exists
        if [ ! -e "$path" ]; then
          STALE_PATHS="$STALE_PATHS\n  - $md_file: stale path '$path'"
          CODE_PATHS_OK=false
        fi
      elif [[ "$path" =~ ^lib/ ]]; then
        # Check for common error: lib/ without src/ prefix
        correct_path="src/$path"
        if [ -e "$correct_path" ]; then
          STALE_PATHS="$STALE_PATHS\n  - $md_file: path '$path' should be '$correct_path'"
          CODE_PATHS_OK=false
        fi
      fi
    done <<< "$paths"
  done < <(find docs/wiki -name "*.md" 2> /dev/null)

  if [ "$CODE_PATHS_OK" = true ]; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${YELLOW}STALE PATHS${NC} (warning only)"
    WARNINGS="$WARNINGS$STALE_PATHS"
  fi

  # =============================================================================
  # Check 10: Import alias validation in code blocks
  # =============================================================================
  echo -n "  [10/11] Checking import aliases... "
  IMPORTS_OK=true
  STALE_IMPORTS=""

  # Map import alias to actual path (bash 3 compatible)
  get_alias_path() {
    case "$1" in
      "#lib") echo "src/lib" ;;
      "#entities") echo "src/entities" ;;
      "#types") echo "src/types" ;;
      "#test") echo "test" ;;
      "#util") echo "src/util" ;;
      *) echo "" ;;
    esac
  }

  while IFS= read -r md_file; do
    in_code_block=false
    in_legacy_example=false

    while IFS= read -r line; do
      if [[ "$line" =~ ^\`\`\`(typescript|ts|javascript|js)?$ ]]; then
        in_code_block=true
        in_legacy_example=false # Reset legacy flag for new code block
        continue
      fi

      if [[ "$line" == '```' ]] && [ "$in_code_block" = true ]; then
        in_code_block=false
        in_legacy_example=false
        continue
      fi

      if [ "$in_code_block" = true ]; then
        # Track if we're in a legacy/wrong example section within the code block
        if [[ "$line" == *"LEGACY"* ]] || [[ "$line" == *"WRONG"* ]] || [[ "$line" == *"❌"* ]]; then
          in_legacy_example=true
        fi
        # Reset legacy flag when we see CURRENT/CORRECT example
        if [[ "$line" == *"CURRENT"* ]] || [[ "$line" == *"CORRECT"* ]] || [[ "$line" == *"✅"* ]]; then
          in_legacy_example=false
        fi

        # Skip imports in legacy example sections
        [ "$in_legacy_example" = true ] && continue

        # Look for import statements with aliases
        if [[ "$line" =~ import.*from[[:space:]]+[\'\"]#([a-z]+)/([^\'\"/]*)[\'\"] ]]; then
          alias="#${BASH_REMATCH[1]}"
          import_path="${BASH_REMATCH[2]}"

          alias_base=$(get_alias_path "$alias")
          if [ -n "$alias_base" ]; then
            full_path="$alias_base/$import_path"
            # Check if it's a valid module (file, .d.ts declaration, or directory with index)
            if [ ! -f "$full_path.ts" ] && [ ! -f "$full_path.d.ts" ] && [ ! -f "$full_path/index.ts" ] && [ ! -d "$full_path" ]; then
              STALE_IMPORTS="$STALE_IMPORTS\n  - $md_file: import '$alias/$import_path' may not exist"
              IMPORTS_OK=false
            fi
          fi
        fi
      fi
    done < "$md_file"
  done < <(find docs/wiki -name "*.md" 2> /dev/null)

  if [ "$IMPORTS_OK" = true ]; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${YELLOW}STALE IMPORTS${NC} (warning only)"
    WARNINGS="$WARNINGS$STALE_IMPORTS"
  fi

  # =============================================================================
  # Check 11: TypeSpec covers all API endpoints
  # =============================================================================
  echo -n "  [11/11] Checking TypeSpec endpoint coverage... "
  COVERAGE_OK=true

  # Non-HTTP Lambdas to skip (authorizers, scheduled, event-triggered)
  # These don't have TypeSpec operationIds because they're not API endpoints
  NON_HTTP_LAMBDAS="ApiGatewayAuthorizer"

  # Generated OpenAPI uses HTTP method/path operationIds rather than Lambda
  # names. Keep this mapping explicit so real endpoint coverage gaps remain
  # visible while documented router naming stays warning-free.
  declare -A API_OPERATION_IDS=(
    [DeviceEvent]=postDeviceEvent
    [DeleteFile]=deleteFilesByFileId
    [ListFiles]=getFiles
    [LoginUser]=postUserLogin
    [RefreshToken]=postUserRefresh
    [LogoutUser]=postUserLogout
    [RegisterDevice]=postDeviceRegister
    [RegisterUser]=postUserRegister
    [UserDelete]=deleteUser
    [UserSubscribe]=postUserSubscribe
    [WebhookFeedly]=postFeedlyWebhook
  )

  # Get API Lambda names from System-Diagrams.md trigger table (API Gateway triggered)
  API_LAMBDAS=$(awk '/## Lambda Trigger Patterns/,/## Data Access/' docs/wiki/Architecture/System-Diagrams.md 2> /dev/null |
    grep -E '^\| [A-Z].*API Gateway' |
    awk -F'|' '{print $2}' | tr -d ' ')

  # Get operationIds from TypeSpec-generated OpenAPI
  if [ -f "docs/api/openapi.yaml" ]; then
    TYPESPEC_OPS=$(grep "operationId:" docs/api/openapi.yaml 2> /dev/null |
      sed 's/.*operationId: //' | tr -d ' ')

    for lambda in $API_LAMBDAS; do
      # Skip non-HTTP Lambdas (authorizers don't have TypeSpec endpoints)
      if echo "$lambda" | grep -qE "^($NON_HTTP_LAMBDAS)$"; then
        continue
      fi

      expected_operation_id="${API_OPERATION_IDS[$lambda]:-}"
      if [ -z "$expected_operation_id" ]; then
        WARNINGS="$WARNINGS\n  - Lambda '$lambda' has no documented OpenAPI operationId mapping"
        COVERAGE_OK=false
      elif ! echo "$TYPESPEC_OPS" | grep -qx "$expected_operation_id"; then
        WARNINGS="$WARNINGS\n  - Lambda '$lambda' is missing OpenAPI operationId '$expected_operation_id'"
        COVERAGE_OK=false
      fi
    done

    if [ "$COVERAGE_OK" = true ]; then
      echo -e "${GREEN}OK${NC}"
    else
      echo -e "${YELLOW}INCOMPLETE${NC} (warning only)"
    fi
  else
    echo -e "${YELLOW}SKIPPED${NC} (run pnpm run document-api first)"
  fi

  # =============================================================================
  # Summary
  # =============================================================================
  echo ""

  # Show warnings if any
  if [ -n "$WARNINGS" ]; then
    echo -e "${YELLOW}Warnings:${NC}"
    echo -e "$WARNINGS"
    echo ""
  fi

  # Fail on errors
  if [ -n "$ERRORS" ]; then
    echo -e "${RED}Documentation sync validation failed:${NC}"
    echo -e "$ERRORS"
    echo ""
    echo "To fix these issues:"
    echo "  1. Update AGENTS.md to reflect current codebase state"
    echo "  2. Update graphrag/metadata.json if entities changed"
    echo "  3. Run 'pnpm run graphrag:extract' to regenerate knowledge graph"
    echo "  4. Fix any broken wiki links"
    exit 1
  fi

  echo -e "${GREEN}Documentation is in sync with codebase${NC}"
}

main "$@"
