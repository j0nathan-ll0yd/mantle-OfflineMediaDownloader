# Comprehensive Dependency Upgrade

Perform a full dependency upgrade workflow: update all packages, fix breaking changes, create PR, and clean up dependabot PRs.

## Agentic Enhancements

This workflow now includes automated analysis features:

- **Breaking change detection** via changelog parsing
- **Impact analysis** using MCP `query_dependencies`
- **AWS SDK alignment verification**
- **Automatic Dependabot PR closure**

## Pre-flight Checks

1. First, list all open dependabot PRs:
```bash
unset GITHUB_TOKEN && gh pr list --author "app/dependabot" --state open --json number,title,headRefName
```

2. Check outdated packages:
```bash
pnpm outdated
```

## Workflow Steps

### Phase 1: Worktree Setup

Create an isolated worktree for the upgrade work. The branch name is dated
(`chore/upgrade-deps-YYYY-MM-DD`) so it never collides with a stale branch left
by a previous run. Base the worktree on `origin/main` (not local `HEAD`, which
may be behind the merged default branch):

```bash
git fetch origin
git worktree add -b chore/upgrade-deps-$(date +%Y-%m-%d) ../mantle-OfflineMediaDownloader-upgrade origin/main
cd ../mantle-OfflineMediaDownloader-upgrade
mkdir -p build
pnpm install --frozen-lockfile
```

> The dated branch name re-evaluates to the same value within a single day, so
> reuse the literal `chore/upgrade-deps-$(date +%Y-%m-%d)` in later phases
> (push, cleanup) rather than a hardcoded name.

### Phase 2: Dependency Updates

**Step 2.1: Align AWS SDK packages first (critical)**

All AWS SDK packages must be at the same version. Update them together:

```bash
pnpm update @aws-sdk/client-api-gateway@latest \
            @aws-sdk/client-cloudwatch@latest \
            @aws-sdk/client-dynamodb@latest \
            @aws-sdk/client-lambda@latest \
            @aws-sdk/client-s3@latest \
            @aws-sdk/client-sns@latest \
            @aws-sdk/client-sqs@latest \
            @aws-sdk/lib-dynamodb@latest \
            @aws-sdk/lib-storage@latest \
            @aws-sdk/util-dynamodb@latest
```

**Step 2.2: Update all other dependencies**

```bash
pnpm update --latest
```

### Phase 3: Fix Breaking Changes

Run type checking to identify breaking changes:

```bash
pnpm run check:types
```

**Common breaking change patterns to watch for:**

| Package | Breaking Change | Fix |
|---------|----------------|-----|
| Jest 29→30 | `toThrowError` removed | Use `toThrow` instead |
| Jest 29→30 | Mock type annotations stricter | Add parameter types to `jest.fn<(params) => ReturnType>()` |
| Joi major | Schema API changes | Check changelog, update validation code |
| glob major | Sync API changes | May need async conversion |
| better-auth | New model names in minified output | Add to `excludedSourceVariables` in `infrastructure.environment.test.ts` |

### Phase 4: Verify

Run the full local CI (`mantle ci --mode pre-push`):

```bash
pnpm run precheck
```

If tests fail, fix the issues and re-run. The pre-push hook runs the same `precheck` pipeline. Note: when running inside a sandbox, the container build step (StartFileUpload) may fail spuriously due to Docker access — re-run with the sandbox disabled to confirm before treating it as a real failure.

### Phase 5: Commit and Push

```bash
git add -A
git commit -m 'chore(deps): upgrade all dependencies to latest versions

- Align AWS SDK packages to X.X.X
- Update [list key packages]
- Fix [any breaking changes]
- Supersedes dependabot PRs #X, #Y, #Z'

git push -u origin chore/upgrade-deps-$(date +%Y-%m-%d)
```

**IMPORTANT**: No AI attribution in commits per project conventions.

### Phase 6: Create PR

```bash
unset GITHUB_TOKEN && gh pr create \
  --title "chore(deps): comprehensive dependency upgrade" \
  --body '## Summary
- Upgrades all outdated dependencies to latest versions
- Aligns AWS SDK packages
- Supersedes dependabot PRs #X, #Y, #Z

## Test Plan
- [x] Local CI passes
- [ ] GitHub CI passes'
```

### Phase 7: Monitor CI and Merge

```bash
# Watch CI status
unset GITHUB_TOKEN && gh pr checks --watch

# After all checks pass, merge with squash
unset GITHUB_TOKEN && gh pr merge --squash --delete-branch
```

### Phase 8: Close Dependabot PRs

Close each superseded dependabot PR:

```bash
unset GITHUB_TOKEN && gh pr close <PR_NUMBER> --comment "Superseded by comprehensive dependency upgrade in #<NEW_PR>"
```

### Phase 9: Cleanup

```bash
# Return to main repo
cd /Users/jlloyd/Repositories/mantle-OfflineMediaDownloader

# Pull merged changes
git fetch origin && git checkout main && git pull origin main

# Remove worktree
git worktree remove ../mantle-OfflineMediaDownloader-upgrade --force

# Delete local branch if still exists
git branch -D chore/upgrade-deps-$(date +%Y-%m-%d) 2>/dev/null || true

# Verify cleanup
git worktree list
```

## Automated Analysis

### Breaking Change Detection

Before upgrading, analyze changelogs for breaking changes:

```bash
# Check for major version bumps
pnpm outdated --format json | jq '[.[] | select(.current != .wanted) | select(.current | split(".")[0] != (.wanted | split(".")[0]))]'
```

For each major version bump:
1. Fetch the package changelog from npm/GitHub
2. Identify breaking changes section
3. Map to affected files in codebase using:

```
MCP Tool: query_dependencies
Query: dependents
File: node_modules/[package]/index.js
```

### AWS SDK Alignment Check

Verify all AWS SDK packages are at the same version:

```bash
pnpm list | grep '@aws-sdk' | awk '{print $2}' | sort -u
```

If multiple versions exist, alignment is needed before proceeding.

### Impact Analysis

For each outdated package, determine blast radius:

```
MCP Tool: query_dependencies
Query: transitive
```

Prioritize packages by:
1. Security vulnerabilities (highest priority)
2. Packages with most dependents
3. Packages blocking other updates

### Auto-Close Dependabot PRs

After successful merge, automatically close superseded Dependabot PRs:

```bash
# Get list of Dependabot PRs for packages we upgraded
UPGRADED_PACKAGES=$(git diff HEAD~1 package.json | grep '"@' | sed 's/.*"\(@[^"]*\)".*/\1/')

for pkg in $UPGRADED_PACKAGES; do
  # Find matching Dependabot PRs
  unset GITHUB_TOKEN && gh pr list --author "app/dependabot" --search "$pkg" --json number,title | jq -r '.[].number' | while read pr; do
    echo "Closing Dependabot PR #$pr (superseded by comprehensive upgrade)"
    unset GITHUB_TOKEN && gh pr close $pr --comment "Superseded by comprehensive dependency upgrade"
  done
done
```

---

## Human Checkpoints

1. **Review breaking change analysis** - Before applying any upgrades
2. **Verify local CI passes** - After `pnpm run precheck` completes
3. **Monitor GitHub CI** - After push, watch for failures
4. **Confirm merge** - Before squash-merging the PR
5. **Verify Dependabot PRs closed** - After merge completes

---

## CI Failure Rollback

If GitHub CI fails after push:

### Step 1: Analyze Failure

```bash
# Check which job failed
unset GITHUB_TOKEN && gh pr checks

# Get failure details
unset GITHUB_TOKEN && gh run view --log-failed
```

### Step 2: Fix in Worktree

```bash
# Return to worktree
cd ~/wt/mantle-OfflineMediaDownloader-upgrade

# Make fixes
# ... edit files ...

# Commit fix
git add -A
git commit -m 'fix(deps): resolve CI failure from upgrade'

# Push fix
git push
```

### Step 3: If Fix Not Possible - Rollback

```bash
# Close the PR
unset GITHUB_TOKEN && gh pr close --comment "Dependency upgrade caused unfixable CI failure. Rolling back."

# Clean up worktree
cd /Users/jlloyd/Repositories/mantle-OfflineMediaDownloader
git worktree remove ~/wt/mantle-OfflineMediaDownloader-upgrade --force

# Delete remote branch
git push origin --delete chore/upgrade-deps-$(date +%Y-%m-%d)
```

### Step 4: Worktree Cleanup (Always)

After successful merge OR rollback:

```bash
# Return to main repo
cd /Users/jlloyd/Repositories/mantle-OfflineMediaDownloader

# Pull merged changes (if merged)
git fetch origin && git checkout main && git pull origin main

# Remove worktree
git worktree remove ~/wt/mantle-OfflineMediaDownloader-upgrade --force

# Delete local branch
git branch -D chore/upgrade-deps-$(date +%Y-%m-%d) 2>/dev/null || true

# Verify cleanup
git worktree list
```

---

## Notes

- **GitHub auth**: If you see 401 errors, the `GITHUB_TOKEN` env var may be invalid. Use `unset GITHUB_TOKEN` to fall back to keyring auth.
- **AWS SDK alignment**: Per `docs/wiki/Methodologies/Dependabot-Resolution.md`, all AWS SDK packages must be updated together.
- **Major version upgrades**: Check changelogs for Jest, Joi, glob, and other major bumps before proceeding.
- **Pre-push hook**: The project runs `mantle ci` (the same pipeline as `pnpm run precheck`) on push, which includes integration tests with LocalStack.
