# Media Download

## Purpose

Downloads media content (primarily YouTube videos) to S3 using yt-dlp, coordinated by the
`StartFileUpload` Lambda. Handles retries via SQS redelivery, creates GitHub issues on permanent
failure, and uses a container image on x86_64 because yt-dlp's native binary requires that
architecture (documented exception to C20 per `AGENTS.md`).

Source of truth for behavior: `src/lambdas/sqs/StartFileUpload/downloadOrchestrator.ts`,
`src/lambdas/sqs/StartFileUpload/failureHandler.ts`,
`src/lambdas/sqs/StartFileUpload/index.ts` (`defineLambda` config for architecture and container).
The `downloadQueueMessageSchema` that validates the SQS body is owned by `src/types/schemas.ts`
and the `DownloadStatus` / `FileStatus` enums by `src/types/enums.ts` — this spec does NOT restate
them.

## Requirements

### Requirement: x86-64-architecture-for-yt-dlp

The `StartFileUpload` Lambda SHALL run on the `x86_64` architecture as a container image. This is a
deliberate exception to the default `arm64` preference (C20 exception documented in `AGENTS.md`)
because the yt-dlp binary distributed in the Lambda layer is a native x86_64 Linux executable and
has no ARM equivalent in the current deployment.

#### Scenario: Lambda configured as x86_64 container

- **GIVEN** the `StartFileUpload` Lambda definition in `src/lambdas/sqs/StartFileUpload/index.ts`
- **WHEN** `mantle generate infra` processes the Lambda config
- **THEN** the generated infrastructure SHALL specify `x86_64` architecture and `container` package type

### Requirement: s3-recovery-before-download

Before initiating a yt-dlp download, the system SHALL check whether the target S3 key already
exists. If the object is found, the Lambda SHALL restore database state from the S3 object and
return successfully without invoking yt-dlp. This prevents duplicate downloads when SQS redelivers
a message after a Lambda timeout that completed the upload but did not acknowledge the message.

#### Scenario: Target file already in S3

- **GIVEN** an SQS message for a file whose S3 key already has an object
- **WHEN** `processDownloadRequest` runs
- **THEN** it SHALL call the S3 recovery path and return
- **AND** SHALL NOT call yt-dlp to re-download the content

### Requirement: download-pipeline-sequence

A successful download SHALL execute in a fixed sequence: (1) fetch video metadata via yt-dlp,
(2) stream video to S3, (3) upsert the File entity with final metadata, (4) await emission of a
`DownloadCompleted` EventBridge event. The `DownloadCompleted` event SHALL NOT be emitted unless
steps 1-3 all succeeded.

#### Scenario: Happy-path completes all four steps

- **GIVEN** a valid YouTube URL and no pre-existing S3 object
- **WHEN** `processDownloadRequest` runs successfully
- **THEN** video metadata SHALL be fetched before streaming begins
- **AND** the File entity SHALL be upserted before the `DownloadCompleted` event is emitted
- **AND** `emitEvent` SHALL be awaited

### Requirement: retriable-failure-propagates-for-sqs-retry

The Lambda SHALL re-throw an error when `handleDownloadFailure` determines the failure is retriable
(retry count below the maximum), causing SQS to redeliver the message. The system SHALL NOT
silently swallow retriable errors.

#### Scenario: Transient yt-dlp failure triggers SQS retry

- **GIVEN** a download request that fails due to a transient yt-dlp error within retry limits
- **WHEN** `handleDownloadFailure` returns `shouldRetry: true`
- **THEN** the Lambda SHALL throw the error
- **AND** SQS SHALL redeliver the message

### Requirement: permanent-failure-files-github-issue

When retries are exhausted (`shouldRetry: false`), the system SHALL set the file status to `Failed`
and SHALL create a GitHub issue documenting the failure. The Lambda SHALL NOT throw after a
permanent failure — it SHALL complete normally to prevent further SQS redelivery.

#### Scenario: Max retries exhausted

- **GIVEN** a download that has failed beyond the maximum retry count
- **WHEN** `handleDownloadFailure` returns `shouldRetry: false`
- **THEN** the file status SHALL be updated to `Failed`
- **AND** a GitHub issue SHALL be created via `createVideoDownloadFailureIssue`
- **AND** the Lambda SHALL return without throwing

### Requirement: cookie-expiration-issue-closed-on-success

After a successful download, the system SHALL attempt to close any open GitHub issue that was filed
for a previous cookie expiration error on the same account. This is a best-effort fire-and-forget
call — it SHALL NOT block the Lambda response or cause a failure if the GitHub API is unavailable.

#### Scenario: Successful download closes cookie issue

- **GIVEN** a download that completes successfully
- **WHEN** `tryCloseCookieExpirationIssue` is called
- **THEN** it SHALL attempt to close any open cookie-expiration GitHub issue
- **AND** a failure to close the issue SHALL not cause the Lambda to throw
