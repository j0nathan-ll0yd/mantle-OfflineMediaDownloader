# Cross-Repo Contract (OMD-iOS API)

## Purpose

Establish the OMD backend as the single canonical producer of the iOS API contract — the OpenAPI
document at `docs/api/openapi.yaml` — and ensure the iOS companion (`ios-OfflineMediaDownloader`)
never silently drifts from that contract after a backend schema change. The document is generated
credential-free from the committed Zod schemas and handler definitions (`package.json`
`generate:openapi` script). A drift-detection gate notifies the iOS repository when the committed
spec falls behind the source. Schema evolution is additive-only so iOS clients built against an
older spec continue to parse current payloads.

Source of truth for behavior: `package.json` (`generate:openapi` script),
`.github/workflows/codegen-drift.md` (drift gate specification),
`.github/workflows/codegen-drift.lock.yml` (drift gate workflow). The structural contract itself is
owned by `docs/api/openapi.yaml` — this spec describes behavioral invariants only and does NOT restate
its field-level shapes.

## Requirements

### Requirement: backend-is-sole-producer-of-openapi

The OMD backend SHALL be the only source that generates `docs/api/openapi.yaml`. No consumer
(iOS app or other service) SHALL independently derive or hardcode API contract definitions.
The iOS companion SHALL obtain the canonical contract by syncing the committed `docs/api/openapi.yaml`
via `bash Scripts/sync-openapi.sh` in `ios-OfflineMediaDownloader`.

#### Scenario: iOS companion needs updated API types

- **GIVEN** the iOS companion needs to regenerate its Swift APITypes from a changed backend schema
- **WHEN** the iOS repository regenerates its API types
- **THEN** it SHALL run `bash Scripts/sync-openapi.sh` against the OMD backend's committed
  `docs/api/openapi.yaml`
- **AND** it SHALL NOT independently regenerate endpoint definitions or hardcode API addresses

### Requirement: credential-free-openapi-generation

`mantle generate openapi` SHALL regenerate `docs/api/openapi.yaml` from the committed Zod schemas
and handler definitions without requiring any AWS credentials. This allows the drift-detection CI
job (`.github/workflows/codegen-drift.lock.yml`) and local pre-commit workflows to regenerate and
diff the spec without cloud access.

#### Scenario: Regeneration in a credential-free environment

- **GIVEN** an environment with no AWS credentials (CI runner or local pre-commit)
- **WHEN** `npx mantle generate openapi` runs
- **THEN** it SHALL emit a valid OpenAPI document without querying live AWS infrastructure
- **AND** the emitted document SHALL be diffable against the committed `docs/api/openapi.yaml`

### Requirement: drift-detection-notifies-ios-repo

The backend CI SHALL detect OpenAPI drift and notify the iOS repository. On every push to `main`
that touches `src/types/api-schema/` or `src/lambdas/api/` handler files, CI SHALL regenerate the
expected OpenAPI document and diff it against the committed `docs/api/openapi.yaml`. If the
documents differ, CI SHALL create a cross-repo GitHub issue in `ios-OfflineMediaDownloader` naming
the drift and citing `bash Scripts/sync-openapi.sh` as the resolution step
(`.github/workflows/codegen-drift.md`).

#### Scenario: Schema change committed without regenerating openapi.yaml

- **GIVEN** a push to `main` that changes a Zod API schema or handler without updating
  `docs/api/openapi.yaml`
- **WHEN** the codegen-drift CI job runs
- **THEN** the diff SHALL be non-empty and a GitHub issue SHALL be created in
  `ios-OfflineMediaDownloader`
- **AND** the issue body SHALL cite `bash Scripts/sync-openapi.sh` as the resolution step

#### Scenario: openapi.yaml is current

- **GIVEN** a push to `main` where `docs/api/openapi.yaml` already reflects the current schemas
  and handlers
- **WHEN** the codegen-drift CI job runs
- **THEN** the diff SHALL be empty and no issue SHALL be created

### Requirement: additive-only-schema-evolution

The OpenAPI schema SHALL evolve additively. A field present in a committed version of
`docs/api/openapi.yaml` SHALL NOT be removed in a subsequent version. A field that is no longer
populated SHALL be deprecated to `null` rather than deleted, so iOS clients built against an older
spec continue to parse current payloads without breaking.

#### Scenario: A response field is retired

- **GIVEN** a field in `docs/api/openapi.yaml` that the backend no longer populates
- **WHEN** the schema is updated
- **THEN** the field SHALL remain in the schema and be emitted as `null` rather than removed
