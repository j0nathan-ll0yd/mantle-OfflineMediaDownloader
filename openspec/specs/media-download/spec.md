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
because yt-dlp is baked into the container image (`docker/Dockerfile.download`; binary at
`/opt/bin/yt-dlp`) as a native x86_64 Linux executable and has no ARM equivalent in the current
deployment.

#### Scenario: Lambda configured as x86_64 container

- **GIVEN** the `StartFileUpload` Lambda definition in `src/lambdas/sqs/StartFileUpload/index.ts`
- **WHEN** `mantle generate infra` processes the Lambda config
- **THEN** the generated infrastructure SHALL specify `x86_64` architecture and `container` package type

### Requirement: s3-recovery-before-download

Before initiating a yt-dlp download, the system SHALL check whether the target S3 key already
exists. If the object is found, the Lambda SHALL restore database state from the S3 object and
return successfully without invoking yt-dlp. This prevents duplicate downloads when SQS redelivers
a message after a Lambda timeout that completed the upload but did not acknowledge the message.

Verified by `test/lambdas/sqs/StartFileUpload/downloadOrchestrator.test.ts:1` (recovery short-circuits the pipeline before yt-dlp) and `test/lambdas/sqs/StartFileUpload/s3Recovery.test.ts:1` (checkS3FileExists presence semantics plus recoverFromS3 state reconstruction).

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

Verified by `test/lambdas/sqs/StartFileUpload/downloadOrchestrator.test.ts:2` (the happy path runs fetch,
download, upsert, then the awaited DownloadCompleted emission in that invocation order, and emits no
completion event when the fetch or download stage fails).

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

Verified by `test/lambdas/sqs/StartFileUpload/downloadOrchestrator.test.ts:3` (a retriable failure at the fetch or download stage re-throws so SQS redelivers) and `test/lambdas/sqs/StartFileUpload/failureHandler.test.ts:1` (a retriable classification within retry limits returns shouldRetry true).

#### Scenario: Transient yt-dlp failure triggers SQS retry

- **GIVEN** a download request that fails due to a transient yt-dlp error within retry limits
- **WHEN** `handleDownloadFailure` returns `shouldRetry: true`
- **THEN** the Lambda SHALL throw the error
- **AND** SQS SHALL redeliver the message

### Requirement: permanent-failure-files-github-issue

The system SHALL differentiate three non-retrying terminal failure paths based on error category
(`src/lambdas/sqs/StartFileUpload/failureHandler.ts:101–113`):

- **`category === 'permanent'`**: the system SHALL create a GitHub issue via
  `createVideoDownloadFailureIssue` documenting the failure.
- **`category === 'cookie_expired'`**: a cookie-expiration GitHub issue SHALL be filed via
  `createCookieExpirationIssue` instead; `createVideoDownloadFailureIssue` SHALL NOT be called.
- **Retry-exhausted transient** (retryable category, retry count ≥ maximum): no GitHub issue SHALL
  be created; the system SHALL record metrics and log the exhaustion only.

In all three paths the file status SHALL be updated to `Failed` and the Lambda SHALL return normally
without throwing, preventing further SQS redelivery.

Verified by `test/lambdas/sqs/StartFileUpload/failureHandler.test.ts:2` (a permanent classification files a
video-download issue; a cookie-expired classification files a cookie-expiration issue instead and never a
generic issue; a retry-exhausted transient failure files no issue; and all three set status Failed and return
without throwing).

#### Scenario: Permanently classified failure files GitHub issue

- **GIVEN** a download that fails with a permanently classified error (`category === 'permanent'`)
- **WHEN** `handleDownloadFailure` processes the failure
- **THEN** the file status SHALL be updated to `Failed`
- **AND** a GitHub issue SHALL be filed via `createVideoDownloadFailureIssue`
- **AND** the Lambda SHALL return without throwing

#### Scenario: Retry-exhausted transient failure — no GitHub issue filed

- **GIVEN** a download with a transient error category whose retry count equals or exceeds the
  configured maximum
- **WHEN** `handleDownloadFailure` processes the failure (`shouldRetry: false`)
- **THEN** the file status SHALL be updated to `Failed`
- **AND** no `createVideoDownloadFailureIssue` call SHALL be made
- **AND** the Lambda SHALL return without throwing

### Requirement: cookie-expiration-issue-closed-on-success

After a successful download, the system SHALL attempt to close any open GitHub issue that was filed
for a previous cookie expiration error on the same account. This is a best-effort fire-and-forget
call — it SHALL NOT block the Lambda response or cause a failure if the GitHub API is unavailable.

Verified by `test/integrations/github/issue-service.test.ts:1` (the issue-close routine closes an open
cookie-expiration issue and swallows GitHub API failures without throwing); the post-success invocation from
the download orchestrator is not directly asserted.

#### Scenario: Successful download closes cookie issue

- **GIVEN** a download that completes successfully
- **WHEN** `tryCloseCookieExpirationIssue` is called
- **THEN** it SHALL attempt to close any open cookie-expiration GitHub issue
- **AND** a failure to close the issue SHALL not cause the Lambda to throw
