/**
 * Tests for integration-test-localstack ESLint rule
 */

const {RuleTester} = require('eslint')
const rule = require('../rules/integration-test-localstack.cjs')

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  }
})

ruleTester.run('integration-test-localstack', rule, {
  valid: [
    // Allowed: not an integration test file
    {
      code: "vi.mock('@aws-sdk/client-s3', () => ({}))",
      filename: 'src/lambdas/ListFiles/test/index.test.ts'
    },
    // Allowed: unit test file
    {
      code: "import {mockClient} from 'aws-sdk-client-mock'",
      filename: 'src/lambdas/StartFileUpload/test/index.test.ts'
    },
    // Allowed: integration test helpers directory
    {
      code: "import {S3Client} from '@aws-sdk/client-s3'",
      filename: 'test/integration/helpers/s3-helpers.ts'
    },
    // Allowed: integration test vendor directory
    {
      code: "import {S3Client} from '@aws-sdk/client-s3'",
      filename: 'test/integration/lib/vendor/AWS/S3.ts'
    },
    // Allowed: mocking non-AWS services in integration tests
    {
      code: "vi.mock('apns2', () => ({}))",
      filename: 'test/integration/workflows/pushNotification.workflow.integration.test.ts'
    },
    // Allowed: importing from LocalStack vendor wrappers
    {
      code: "import {getS3Object} from 'test/integration/lib/vendor/AWS/S3'",
      filename: 'test/integration/workflows/fileUpload.workflow.integration.test.ts'
    },
    // Allowed: vi.mock for non-AWS modules
    {
      code: "vi.mock('#lib/integrations/github/issueService', () => ({}))",
      filename: 'test/integration/workflows/userDelete.workflow.integration.test.ts'
    }
  ],
  invalid: [
    // Forbidden: vi.mock AWS SDK client in integration test
    {
      code: "vi.mock('@aws-sdk/client-s3', () => ({S3Client: vi.fn()}))",
      filename: 'test/integration/workflows/fileUpload.workflow.integration.test.ts',
      errors: [{messageId: 'noAwsSdkMock'}]
    },
    // Forbidden: vi.mock DynamoDB client in integration test
    {
      code: "vi.mock('@aws-sdk/client-dynamodb', () => ({}))",
      filename: 'test/integration/workflows/userData.workflow.integration.test.ts',
      errors: [{messageId: 'noAwsSdkMock'}]
    },
    // Forbidden: vi.mock lib-dynamodb in integration test
    {
      code: "vi.mock('@aws-sdk/lib-dynamodb', () => ({}))",
      filename: 'test/integration/workflows/userData.workflow.integration.test.ts',
      errors: [{messageId: 'noAwsSdkMock'}]
    },
    // Forbidden: import aws-sdk-client-mock in integration test
    {
      code: "import {mockClient} from 'aws-sdk-client-mock'",
      filename: 'test/integration/workflows/s3Upload.workflow.integration.test.ts',
      errors: [{messageId: 'noMockClient'}]
    },
    // Forbidden: import aws-sdk-client-mock submodule in integration test
    {
      code: "import {mockClient} from 'aws-sdk-client-mock/vitest'",
      filename: 'test/integration/workflows/dynamodb.workflow.integration.test.ts',
      errors: [{messageId: 'noMockClient'}]
    }
  ]
})

console.log('integration-test-localstack: All tests passed!')
