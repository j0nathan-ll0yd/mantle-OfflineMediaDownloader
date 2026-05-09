# Integration Tests

This directory contains integration tests that verify multi-service workflows using LocalStack.

## Overview

**Integration tests validate YOUR orchestration logic across multiple AWS services, not AWS SDK behavior.**

Unlike unit tests which mock AWS services, integration tests execute complete end-to-end workflows against LocalStack. The goal is to test YOUR code's orchestration, state management, and error handling—not to verify that S3 uploads work or DynamoDB queries succeed.

**Testing Philosophy:** See [`docs/wiki/Testing/Coverage-Philosophy.md`](../../docs/wiki/Testing/Coverage-Philosophy.md) and [`docs/wiki/Integration/LocalStack-Testing.md`](../../docs/wiki/Integration/LocalStack-Testing.md) for comprehensive testing philosophy and patterns.

## Running Integration Tests

### Prerequisites

1. **Docker**: Required to run LocalStack container (includes Compose plugin)
2. **jq**: Optional, for pretty-printing health check results

### Quick Start

```bash
# Start LocalStack
npm run localstack:start

# Wait for LocalStack to be ready
npm run localstack:health

# Run integration tests
npm run test:integration

# View LocalStack logs (if needed)
npm run localstack:logs

# Stop LocalStack when done
npm run localstack:stop
```

### Commands

- `npm run localstack:start` - Start LocalStack container in detached mode
- `npm run localstack:stop` - Stop and remove LocalStack container
- `npm run localstack:logs` - Stream LocalStack logs
- `npm run localstack:health` - Check LocalStack service health
- `npm run test:integration` - Run all integration tests

## Test Organization

Tests are organized by workflow, not by service:

```
test/integration/
├── setup.ts                                      # Global test setup
├── README.md                                     # This file
├── workflows/                                    # Workflow-based integration tests
│   ├── webhookFeedly.workflow.integration.test.ts
│   ├── fileCoordinator.workflow.integration.test.ts
│   ├── startFileUpload.workflow.integration.test.ts
│   └── listFiles.workflow.integration.test.ts
└── helpers/                                      # Test utilities
    ├── postgres-helpers.ts                       # Aurora DSQL test data helpers
    ├── s3-helpers.ts                             # S3 test utilities
    ├── sns-helpers.ts                            # SNS test utilities
    └── lambda-helpers.ts                         # Lambda invocation helpers
```

**Why Workflow-Based?**
- Tests YOUR multi-service orchestration, not individual AWS services
- Mirrors real production workflows (webhook → DynamoDB → Lambda → S3)
- Coverage of vendor wrappers happens naturally as a side effect

## Writing Integration Tests

Integration tests should:

1. **Test YOUR workflows, not AWS SDK behavior**:
   ```typescript
   // ✅ Correct - tests YOUR orchestration logic
   test('should complete video download workflow and update DynamoDB status', async () => {
     // Arrange: Create pending file in DynamoDB
     await insertFile({fileId: 'test-video', status: 'PendingDownload'})

     // Act: Execute YOUR Lambda handler
     await handler({fileId: 'test-video'}, mockContext)

     // Assert: Verify YOUR state management worked
     const file = await getFile('test-video')
     expect(file.status).toBe('Downloaded')  // YOUR status transition

     const s3Object = await headObject(bucket, 'test-video.mp4')
     expect(s3Object.ContentLength).toBeGreaterThan(0)  // YOUR upload succeeded
   })

   // ❌ Wrong - tests AWS SDK, not YOUR code
   test('should upload object to S3', async () => {
     const upload = createS3Upload(bucket, key, content)
     await upload.done()
     expect(await headObject(bucket, key)).toBeDefined()
   })
   ```

2. **Use vendor wrappers**, not AWS SDK directly:
   ```typescript
   // ✅ Correct - uses vendor wrapper
   import {headObject, createS3Upload} from '../../../src/lib/vendor/AWS/S3'

   // ❌ Wrong - violates AWS SDK Encapsulation Policy
   import {S3Client, HeadObjectCommand} from '@aws-sdk/client-s3'
   ```

3. **Test multi-service workflows**:
   ```typescript
   // ✅ Good - tests YOUR orchestration across services
   test('should process webhook, create DynamoDB record, and send SQS message', async () => {
     await handler(webhookPayload, context)

     const dbRecord = await getFile('video-id')  // DynamoDB check
     expect(dbRecord.status).toBe('Pending')

     const messages = await getSQSMessages(queueUrl)  // SQS check
     expect(messages).toHaveLength(1)
   })
   ```

4. **Clean up resources** after each test:
   ```typescript
   afterEach(async () => {
     await deleteFilesTable()
     await deleteS3Objects()
   })
   ```

5. **Follow naming convention**: `*.workflow.integration.test.ts`

## Environment Variables

Integration tests automatically set:

- `USE_LOCALSTACK=true` - Triggers vendor wrappers to use LocalStack clients
- `AWS_REGION=us-west-2` - Match production region for consistency

These are configured in `test/integration/setup.ts`.

## LocalStack Configuration

LocalStack is configured via `docker/docker-compose.localstack.yml`:

- **Endpoint**: http://localhost:4566
- **Services**: S3, DynamoDB, SNS, SQS, Lambda, CloudWatch, API Gateway
- **Storage**: Ephemeral (fresh state each run for consistent test results)
- **Debug Mode**: Enabled for troubleshooting

## Troubleshooting

### LocalStack not responding

```bash
# Check if LocalStack is running
docker ps | grep localstack

# View logs for errors
npm run localstack:logs

# Restart LocalStack
npm run localstack:stop
npm run localstack:start
```

### Tests timing out

Integration tests have a 30-second timeout. If tests are timing out:

1. Check LocalStack logs for errors
2. Verify LocalStack health: `npm run localstack:health`
3. Ensure LocalStack has sufficient resources (increase Docker memory if needed)

### Port conflicts

If port 4566 is already in use:

```bash
# Find process using port 4566
lsof -i :4566

# Kill the process or stop conflicting service
```

## CI/CD Integration

GitHub Actions workflow automatically:

1. Starts LocalStack before running tests
2. Runs integration tests with `npm run test:integration`
3. Uploads test results and coverage
4. Stops LocalStack after tests complete

See `.github/workflows/integration-tests.yml` for CI/CD configuration.
