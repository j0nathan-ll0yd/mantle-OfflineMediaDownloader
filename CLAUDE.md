@AGENTS.md

<!-- Convention checks are injected per-session by the agent-enforcement retrieval
     system (~/Repositories/agent-enforcement/rules/mantle/) — the former static
     import of ~/.claude/principles/mantle-checks-high.md is retired. -->

## Mantle Convention Enforcement

This is a Mantle framework instance (the original project Mantle was extracted from). All code must conform to 95 convention checks (C1-C95).

- **Checks**: Imported above from `~/.claude/principles/mantle-checks.md`
- **Full principles**: `~/.claude/principles/mantle.md` — rationale and deep dives
- **Reviewer agent**: `~/.claude/agents/mantle-reviewer.md` — auto-reviews code changes via stop hook
- **Hierarchy**: `mantle.md` provides rationale and deep dives; `mantle-checks.md` is the structured enforcement list. On conflicts in check definitions, `mantle-checks.md` wins.

## Deploy

Always specify `--stage` when deploying. Never run bare `mantle deploy` — it defaults to `dev` which has no tfvars and will prompt interactively.

```bash
npx mantle build                          # build all Lambdas
npx mantle deploy --stage staging         # deploy to staging (staging- prefix)
npx mantle deploy --stage production      # deploy to production (prod- prefix)
```

## OpenAPI Spec Generation

```bash
pnpm run generate:openapi
```

Runs `mantle generate openapi --schema-prefix 'Models.' --output docs/api/openapi.yaml --html docs/api/index.html`, which:

- Resolves every Zod schema reachable from `defineApiHandler` calls via esbuild bundling
- Sibling-extracts barrel exports in `src/types/api-schema/schemas.ts` (exposes `Models.File`, `Models.FileStatus`, `Models.Device`, `Models.ErrorResponse`, `Models.UnauthorizedError`, `Models.ForbiddenError`, `Models.InternalServerError`, etc.)
- Emits error responses on every endpoint (400/500 for `auth: 'none'`; 400/401/403/500 for `auth: 'authorizer'`)
- Writes `docs/api/openapi.yaml` (the source of truth synced to `ios-OfflineMediaDownloader/APITypes/`)
- Writes `docs/api/index.html` (Redoc-rendered HTML docs)

**iOS consumer**: `ios-OfflineMediaDownloader/Scripts/sync-openapi.sh` copies `docs/api/openapi.yaml` into the iOS `APITypes` Swift package, where swift-openapi-generator produces `Components.Schemas.Models_period_File`, etc. The `Schema` suffix is stripped and `Models.` prefix is applied to match TypeSpec-era naming.

**Regenerate after touching**: schemas in `src/types/api-schema/schemas.ts`, request/response schemas on any `defineApiHandler` call, or the `openapi: { ... }` metadata block on any handler. Verify `swift build` in `ios-OfflineMediaDownloader/APITypes/` still succeeds before committing iOS downstream changes.
