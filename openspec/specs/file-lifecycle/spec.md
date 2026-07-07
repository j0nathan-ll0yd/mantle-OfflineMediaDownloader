# File Lifecycle

## Purpose

Tracks the lifecycle of a media file from initial request through download completion, and fans out
per-user download-ready notifications after S3 upload. The lifecycle models four states: `Queued`
(requested, download not yet started), `Downloading` (actively being fetched), `Downloaded`
(successfully stored in S3 and ready to stream), and `Failed` (permanently failed after exhausting
retries). State transitions are driven by the `StartFileUpload` and `S3ObjectCreated` Lambdas.

Source of truth for behavior: `src/lambdas/s3/S3ObjectCreated/index.ts` (post-upload notification
fan-out), `src/lambdas/sqs/StartFileUpload/downloadOrchestrator.ts` (status transitions during
download), `src/types/enums.ts` (FileStatus values). The `FileStatus` enum and File entity shape are
owned by `src/types/enums.ts` and `src/types/domainModels.d.ts` — this spec does NOT restate them.

## Requirements

### Requirement: file-status-transitions

A file SHALL progress through a defined sequence of statuses. The status SHALL move from `Queued`
to `Downloading` when the download Lambda begins processing. On success the status SHALL become
`Downloaded`. On permanent failure (retries exhausted) the status SHALL become `Failed`. No other
transitions are valid; a file SHALL NOT move from `Downloaded` or `Failed` back to an earlier status
via the normal download path.

Verified by `test/integration/workflows/startFileUpload.workflow.integration.test.ts:1` (the
Queued→Downloading→Downloaded and Queued→Downloading→Failed sequences persist at the DSQL layer); the
StartFileUpload/S3ObjectCreated driving of these transitions and the no-backward-transition invariant are not
directly asserted by this test.

#### Scenario: Successful download progression

- **GIVEN** a file record with status `Queued`
- **WHEN** `StartFileUpload` begins processing the download request
- **THEN** the file status SHALL be updated to `Downloading`
- **AND** upon successful S3 upload, the file status SHALL be updated to `Downloaded`

#### Scenario: Permanent failure after retries

- **GIVEN** a file record whose download has failed beyond the maximum retry count
- **WHEN** `handleDownloadFailure` determines retries are exhausted
- **THEN** the file status SHALL be updated to `Failed`
- **AND** the Lambda SHALL NOT throw (preventing further SQS redelivery)

### Requirement: s3-event-triggers-per-user-notification

The system SHALL dispatch an SQS notification message to each user linked to a file when S3 emits
an `ObjectCreated` event for that media upload. Dispatch SHALL use `Promise.allSettled` so that a
failure for one user does not prevent notification of other users.

Verified by `test/lambdas/s3/S3ObjectCreated/index.test.ts:1` (an object-created event dispatches one SQS
message per linked user, both dispatches are attempted when one fails, a file with no linked users is a no-op,
and a key matching no File record throws `NotFoundError`).

#### Scenario: File upload notifies all linked users

- **GIVEN** an S3 object created event for a media file linked to two users
- **WHEN** `S3ObjectCreated` processes the event
- **THEN** an SQS notification message SHALL be dispatched for each of the two users
- **AND** both dispatches SHALL be attempted even if one fails

#### Scenario: No users linked to the file

- **GIVEN** an S3 object created event for a file with no UserFile records
- **WHEN** `S3ObjectCreated` processes the event
- **THEN** the Lambda SHALL return without dispatching any SQS messages and without error

#### Scenario: File not found by S3 key

- **GIVEN** an S3 object created event for a key that does not match any File record
- **WHEN** `S3ObjectCreated` processes the event
- **THEN** the Lambda SHALL throw a `NotFoundError`, propagating the failure for observability

### Requirement: download-completed-event-emitted-after-s3-upload

The `StartFileUpload` Lambda SHALL emit a `DownloadCompleted` EventBridge event only after the file
has been successfully uploaded to S3 and the File entity has been updated in the database. The event
SHALL be awaited before the handler returns, ensuring it is not silently dropped if Lambda
terminates.

Verified by `test/lambdas/sqs/StartFileUpload/downloadOrchestrator.test.ts:5` (the awaited DownloadCompleted
emission is invoked after the File upsert in call order, and is not emitted when the S3 download stage fails).

#### Scenario: Successful upload emits event

- **GIVEN** a media file that has been successfully downloaded and uploaded to S3
- **WHEN** the File entity is updated with final metadata
- **THEN** the Lambda SHALL emit a `DownloadCompleted` EventBridge event (awaited)
- **AND** the event SHALL NOT be emitted if the S3 upload failed

### Requirement: s3-idempotency-via-recovery-check

Before initiating a download, `StartFileUpload` SHALL check whether the target S3 object already
exists. If the object exists (from a prior partially-completed run), the Lambda SHALL recover the
database state from S3 metadata and return without re-downloading, ensuring that SQS redelivery
of the same message does not cause a duplicate download.

Verified by `test/lambdas/sqs/StartFileUpload/downloadOrchestrator.test.ts:4` (an existing S3 object recovers state and returns without invoking yt-dlp) and `test/lambdas/sqs/StartFileUpload/s3Recovery.test.ts:2` (the recovery path reconstructs state and emits completion, remaining resilient when YouTube metadata is unavailable).

#### Scenario: File already present in S3

- **GIVEN** a download request whose target S3 key already exists
- **WHEN** `StartFileUpload` processes the SQS message
- **THEN** it SHALL recover the database state from the existing S3 object
- **AND** SHALL NOT initiate a new yt-dlp download
