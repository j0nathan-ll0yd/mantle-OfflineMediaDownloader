# Bash Script Index

Complete reference for all shell scripts in the project.

## Script Categories

### Build & Deployment

| Script                    | Purpose                                              | Usage                                |
| ------------------------- | ---------------------------------------------------- | ------------------------------------ |
| `bin/cleanup.sh`          | Full cleanup cycle (build, format, lint, test, docs) | `./bin/cleanup.sh [--fast\|--check]` |
| `bin/pre-deploy-check.sh` | Pre-deployment validation                            | `./bin/pre-deploy-check.sh`          |

### Validation

| Script                     | Purpose                         | Usage                        |
| -------------------------- | ------------------------------- | ---------------------------- |
| `bin/validate-docs.sh`     | Verify documented scripts exist | `./bin/validate-docs.sh`     |
| `bin/validate-doc-sync.sh` | Sync code with documentation    | `./bin/validate-doc-sync.sh` |
| `bin/validate-graphrag.sh` | Check GraphRAG synchronization  | `./bin/validate-graphrag.sh` |
| `bin/verify-state.sh`      | Verify Terraform state health   | `./bin/verify-state.sh`      |

### Testing

| Script                       | Purpose                                                                     | Usage                                        |
| ---------------------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| `bin/test-list.sh`           | Smoke-test `GET /files` (read-only)                                         | `./bin/test-list.sh --env staging`           |
| `bin/test-hook.sh`           | Smoke-test `POST /feedly/webhook` (mutates; can trigger a real download)    | `./bin/test-hook.sh --env staging`           |
| `bin/test-registerDevice.sh` | Smoke-test `POST /device/register` (mutates; idempotent)                    | `./bin/test-registerDevice.sh --env staging` |
| `bin/test-integration.sh`    | Run integration test suite                                                  | `./bin/test-integration.sh`                  |
| `bin/remote-api.sh`          | Shared helper for the three remote smoke tests (**source, do not execute**) | `. bin/remote-api.sh`                        |

The three remote smoke tests hit real AWS and accept `--env staging` only: `mantle.config.ts`
pins `allowedStages: ['staging']`, so there is no production state to address. They are
deliberately **not** in CI, because they need live AWS credentials and mutate staging.

### Dependency Management

| Script                     | Purpose                          | Usage                        |
| -------------------------- | -------------------------------- | ---------------------------- |
| `bin/update-yt-dlp.sh`     | Update yt-dlp binary             | `./bin/update-yt-dlp.sh`     |
| `bin/update-agents-prs.sh` | Update AGENTS.md with PR history | `./bin/update-agents-prs.sh` |

### Infrastructure

| Script             | Purpose                                         | Usage                              |
| ------------------ | ----------------------------------------------- | ---------------------------------- |
| `bin/aws-audit.sh` | Find AWS resources orphaned from OpenTofu state | `./bin/aws-audit.sh --env staging` |

## Script Details

### cleanup.sh

Full cleanup cycle with multiple modes:

```bash
./bin/cleanup.sh          # Full cleanup with integration tests
./bin/cleanup.sh --fast   # Skip integration tests
./bin/cleanup.sh --check  # Dry-run, check only
```

**Steps Performed**:

1. TypeScript type checking
2. Build Lambda bundles
3. Format code (dprint)
4. Lint (ESLint)
5. Validate conventions
6. Run unit tests
7. Run integration tests (unless --fast)
8. Generate documentation

---

---

### aws-audit.sh

Finds **orphans**: resources that exist in AWS but are not in OpenTofu state. This is the one
question `tofu plan` cannot answer, since plan only reconciles what state already tracks.

```bash
pnpm run audit:aws:staging          # or: ./bin/aws-audit.sh --env staging
./bin/aws-audit.sh --env staging --json
./bin/aws-audit.sh --env staging --prune --dry-run
```

**Reports On** (orphans, per type):

- Lambda functions
- IAM roles and policies
- SQS queues
- S3 buckets
- API Gateway REST APIs
- CloudFront distributions
- Lambdas whose `ManagedBy` tag does not match what the stack applies

**Exit codes**: `0` clean, `1` usage/credential error, `2` orphans or tag drift found.

Both sides of the comparison are **derived**, not hardcoded: Terraform-managed names come from
`tofu show -json`, and the AWS-side filter is the stack's own `name_prefix`. Adding or renaming
a resource needs no edit to the script. (It previously matched against a hand-maintained list
of resource names that had drifted completely, so it compared two empty sets and always
reported a clean estate.)

`--prune` deletes only orphaned Lambda functions, IAM policies and IAM roles, after
confirmation. Orphaned queues, buckets, APIs and distributions are reported but never
auto-deleted.

---

### pre-deploy-check.sh

Pre-deployment validation:

```bash
./bin/pre-deploy-check.sh
```

**Validates**:

- All tests pass
- No lint errors
- Bundle sizes within limits
- Environment variables configured
- Terraform plan succeeds

---

### validate-doc-sync.sh

Validates documentation matches code:

```bash
./bin/validate-doc-sync.sh
```

**Checks**:

- Lambda handlers documented
- Entity schemas documented
- API endpoints documented
- Script purposes documented

---

## Script Conventions

All scripts follow patterns defined in [Script-Patterns.md](./Script-Patterns.md):

### Shebang

```bash
#!/usr/bin/env bash
```

### Error Handling

```bash
set -euo pipefail
```

### Help Flag

```bash
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: $0 [options]"
  exit 0
fi
```

### Color Output

```bash
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m'

echo -e "${GREEN}Success${NC}"
```

### Directory Resolution

```bash
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
```

## Adding New Scripts

1. Create script in `bin/` directory
2. Add shebang and error handling
3. Add help flag support
4. Document in this index
5. Run `./bin/validate-docs.sh` to verify

## Related Documentation

- [Script-Patterns.md](./Script-Patterns.md) - Coding patterns
- [Bash-Error-Handling.md](./Bash-Error-Handling.md) - Error handling
- [Variable-Naming.md](./Variable-Naming.md) - Naming conventions
- [User-Output-Formatting.md](./User-Output-Formatting.md) - Output formatting
