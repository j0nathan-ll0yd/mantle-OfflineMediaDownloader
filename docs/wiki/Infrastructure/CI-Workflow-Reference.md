# CI Workflow Reference

Complete reference for all GitHub Actions workflows in the project.

## Workflow Overview

| Workflow | Trigger | Schedule | Purpose |
|----------|---------|----------|---------|
| `unit-tests.yml` | push to main, called by `pr-checks.yml` | - | TypeSpec, types, lint, unit tests |
| `integration-tests.yml` | push to main, PR | - | LocalStack + PostgreSQL integration tests |
| `agent-compliance.yml` | push, PR to main | - | MCP convention validation |
| `mutation-tests.yml` | schedule | Sun 6 AM UTC | Stryker mutation testing |
| `dependency-check.yml` | push, PR | - | Architectural boundary validation |
| `auto-update-graphrag.yml` | push to main | - | Knowledge graph regeneration |
| `sync-wiki.yml` | push to main | - | GitHub Wiki synchronization |
| `update-yt-dlp.yml` | schedule | Sun 2 AM UTC | yt-dlp binary updates |
| `check-upstream-issues.yml` | schedule | Daily | Monitor upstream dependencies |

## Workflow Details

### unit-tests.yml

**Purpose**: Core CI pipeline for every PR head and every push to main.

**Triggers**:
- Push to main
- `workflow_call` from `pr-checks.yml` (`full-ci`), once per PR head. `pr-ready` gates on its result.

**Steps**:
1. TypeSpec compilation check
2. API documentation generation
3. API path validation
4. Lambda bundle build
5. **Bundle size check** (fails if limits exceeded)
6. GraphRAG validation
7. TypeScript type checking (source + tests)
8. ESLint + dprint format check
9. ESLint local rule tests
10. Documentation validation
11. Convention validation
12. Unit tests with coverage

**Key Checks**:
- All Lambda bundles must be under size limits
- No TypeScript errors
- No ESLint violations
- All tests pass

---

### integration-tests.yml

**Purpose**: Full integration tests with LocalStack and PostgreSQL.

**Triggers**:
- Push to main
- Pull request to main. This run produces the required `integration-tests` context.

**Services Started**:
- LocalStack (AWS service emulation)
- PostgreSQL (test database)

**Steps**:
1. Type checking
2. Lint
3. Start LocalStack and PostgreSQL containers
4. Wait for health checks
5. Run integration tests with coverage
6. Upload test artifacts

**Environment Variables**:
- `USE_LOCALSTACK=true`
- `TEST_DATABASE_URL=postgres://test:test@localhost:5432/media_downloader_test`

---

### agent-compliance.yml

**Purpose**: Validate code against project conventions.

**Triggers**:
- Push to main
- Pull request to main

**Validation**:
- Runs `pnpm run check:conventions`
- Checks 13+ convention rules via AST analysis

**Rules Validated**:
- AWS SDK encapsulation
- Entity mock patterns
- Response helpers
- Environment variable handling
- Cascade delete order
- And more

---

### mutation-tests.yml

**Purpose**: Weekly mutation testing to validate test quality.

**Triggers**:
- Schedule: Sunday 6 AM UTC
- Manual dispatch

**How It Works**:
1. Downloads previous incremental state
2. Runs Stryker mutation testing
3. Generates mutation score report
4. Uploads incremental state for next run

**Reports**:
- Mutation score percentage
- Killed/Survived/Timeout counts
- Available as artifact for 30 days

---

### dependency-check.yml

**Purpose**: Validate architectural boundaries.

**Triggers**:
- Push to main/develop
- Pull request to main/develop

**Checks**:
- Circular dependencies
- Cross-Lambda imports
- Direct AWS SDK imports (must use vendor wrappers)
- Entity cross-dependencies

**On Failure**:
- Generates dependency report artifact
- Comments on PR with violation details

---

### auto-update-graphrag.yml

**Purpose**: Keep knowledge graph in sync with codebase.

**Triggers**:
- Push to main with changes to:
  - `src/lambdas/**`
  - `src/entities/**`
  - `src/lib/vendor/**`
  - `graphrag/metadata.json`
  - `tsp/**`

**Behavior**:
1. Runs `pnpm run graphrag:extract`
2. Commits updated `knowledge-graph.json` if changed
3. Pushes commit to main

---

### sync-wiki.yml

**Purpose**: Synchronize docs/wiki to GitHub Wiki.

**Triggers**:
- Push to main with changes to:
  - `docs/wiki/**`
  - `.github/scripts/sync-wiki.sh`
  - `.github/scripts/generate-sidebar.sh`
- Manual dispatch

**Behavior**:
1. Clones wiki repository
2. Syncs content from `docs/wiki/`
3. Generates sidebar navigation
4. Generates footer with timestamp
5. Commits and pushes to wiki

---

### update-yt-dlp.yml

**Purpose**: Weekly yt-dlp binary updates with verification.

**Triggers**:
- Schedule: Sunday 2 AM UTC
- Manual dispatch

**Process**:
1. Check latest yt-dlp release (excludes pre-releases)
2. Download and verify SHA256 checksum
3. Test binary execution
4. Create branch and PR if update needed
5. PR includes rollback instructions

**Labels Applied**:
- `dependencies`
- `automated`
- `yt-dlp`
- `infrastructure`

---

### check-upstream-issues.yml

**Purpose**: Monitor upstream dependencies for breaking changes.

**Triggers**:
- Schedule: Daily

**Monitored**:
- yt-dlp issues
- AWS SDK issues
- Other critical dependencies

---

## Workflow Dependencies

```
unit-tests.yml
├── TypeSpec compilation
├── Build (generates bundles)
├── Bundle size check (requires build)
├── GraphRAG validation
└── Unit tests

integration-tests.yml
├── Type checking
├── LocalStack (container)
├── PostgreSQL (container)
└── Integration tests

dependency-check.yml
├── Dependency graph generation
└── Dependency cruiser rules

auto-update-graphrag.yml
├── graphrag:extract
└── Git commit/push
```

## Manual Workflow Triggers

Some workflows support manual dispatch:

```bash
# Trigger via GitHub CLI
gh workflow run mutation-tests.yml
gh workflow run update-yt-dlp.yml
gh workflow run sync-wiki.yml
```

## Troubleshooting

### unit-tests failing

1. Check TypeScript errors: `pnpm run check-types`
2. Check lint: `pnpm run lint`
3. Run tests locally: `pnpm test`
4. Check bundle sizes: `pnpm run check:bundle-size`

### integration-tests failing

1. Start services locally: `pnpm run localstack:start`
2. Check health: `pnpm run localstack:health`
3. Run tests: `pnpm run test:integration`

### dependency-check failing

1. Run locally: `pnpm run deps:check`
2. Generate report: `pnpm run deps:report`
3. Check for circular dependencies
4. Ensure vendor wrapper usage

### auto-update-graphrag failing

1. Run extraction: `pnpm run graphrag:extract`
2. Check metadata.json syntax
3. Commit changes manually if needed
