# Cascade Deletion

## Purpose

Ensures referential integrity when removing entities (users, files, devices) from Aurora DSQL, which does
not enforce foreign key constraints at the database layer. Deletion of a parent record MUST be preceded
by deletion of all its child records — application code enforces the ordering the database cannot.

Source of truth for behavior: `src/entities/queries/cascadeOperations.ts` (all cascade operations),
`src/lambdas/sqs/SendPushNotification/endpointCleanupHelpers.ts` (endpoint cleanup ordering).
The table schemas (columns, FK declarations) are owned by `src/db/schema.ts` — this spec does NOT
restate them.

## Requirements

### Requirement: children-deleted-before-parent

The system SHALL delete all child records before deleting the parent record in every cascade
operation, verified by `test/lambdas/entities/cascadeOrdering.test.ts`.

For user deletion (`deleteUserCascade`): junction records (UserFiles, UserDevices) SHALL be deleted
first, then auth records (Sessions, Accounts), then the User. The parent User row SHALL NOT be
deleted until all child rows for that user are removed.

For file deletion (`deleteFileCascade`): the UserFile link SHALL be removed before checking for
orphan status. FileDownload records SHALL be removed before the File record. The File row SHALL only
be removed when no other UserFile links remain.

For endpoint cleanup (`cleanupDisabledEndpoint`): UserDevices junction records SHALL be removed
first, then the SNS platform endpoint, then the Device record.

#### Scenario: User cascade deletes junction tables before parent

- **GIVEN** a user with associated UserFile, UserDevice, Session, and Account records
- **WHEN** `deleteUserCascade` is called with that userId
- **THEN** UserFiles and UserDevices SHALL be deleted before Sessions and Accounts
- **AND** Sessions and Accounts SHALL be deleted before the User record

#### Scenario: Endpoint cleanup removes children before device

- **GIVEN** a device with an associated SNS endpoint ARN and UserDevice junction records
- **WHEN** `cleanupDisabledEndpoint` is called for that device
- **THEN** UserDevice junction records SHALL be deleted before the SNS endpoint is deregistered
- **AND** the SNS endpoint SHALL be deregistered before the Device record is deleted

### Requirement: orphan-check-before-file-removal

The system SHALL verify that a file has no remaining UserFile links before removing the file and its
download records. If other users still reference the file, only the requesting user's UserFile link
SHALL be removed — the file records SHALL remain.

#### Scenario: File has no remaining user links

- **GIVEN** exactly one UserFile record links a file to a user
- **WHEN** `deleteFileCascade` is called for that user and file
- **THEN** the UserFile link SHALL be removed, FileDownload records SHALL be removed, and the File record SHALL be removed

#### Scenario: File is shared with another user

- **GIVEN** two UserFile records link a file to two different users
- **WHEN** `deleteFileCascade` is called for one user and that file
- **THEN** only that user's UserFile link SHALL be removed
- **AND** the File record and its FileDownload records SHALL remain

### Requirement: cascade-operations-are-transactional

All cascade database operations SHALL execute within a single Aurora DSQL transaction (using
`defineQuery` with `transaction: true`). If any step within the cascade fails, the entire cascade
SHALL be rolled back — no partial deletions SHALL be committed to the database.

#### Scenario: Mid-cascade failure rolls back

- **GIVEN** a cascade operation spanning multiple tables
- **WHEN** an error occurs partway through the deletion sequence
- **THEN** no deletions from that cascade SHALL be visible in the database

### Requirement: batch-cleanup-isolates-partial-failures

The system SHALL use `Promise.allSettled` when cleaning up multiple disabled endpoints in a batch
(`cleanupDisabledEndpoints`) so that a failure on one device does not prevent cleanup of other
devices in the same batch.

#### Scenario: One device cleanup fails in a batch

- **GIVEN** multiple devices with disabled endpoints
- **WHEN** cleanup of one device throws an error
- **THEN** cleanup of the remaining devices SHALL still be attempted
- **AND** the batch SHALL complete with a result array containing both successes and the error
