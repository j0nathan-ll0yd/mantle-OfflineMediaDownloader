/**
 * Tests for aws-sdk-mock-pattern ESLint rule
 */

const {RuleTester} = require('eslint')
const rule = require('../rules/aws-sdk-mock-pattern.cjs')

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  }
})

ruleTester.run('aws-sdk-mock-pattern', rule, {
  valid: [
    // Allowed: using mock helpers
    {
      code: "import {createSQSMock, resetAllAwsMocks} from '#test/helpers/aws-sdk-mock'",
      filename: 'src/lambdas/SendMessage/test/index.test.ts'
    },
    // Allowed: not a Lambda test file
    {
      code: "import {mockClient} from 'aws-sdk-client-mock'",
      filename: 'test/helpers/aws-sdk-mock.ts'
    },
    // Allowed: non-test file
    {
      code: "import {SQSClient} from '@aws-sdk/client-sqs'",
      filename: 'src/lib/vendor/AWS/SQS.ts'
    },
    // Allowed: using helpers correctly
    {
      code: `
        import {createSQSMock} from '#test/helpers/aws-sdk-mock'
        const sqsMock = createSQSMock()
      `,
      filename: 'src/lambdas/WebhookFeedly/test/index.test.ts'
    },
    // Allowed: mocking non-AWS module
    {
      code: "vi.mock('#entities/queries', () => ({}))",
      filename: 'src/lambdas/ListFiles/test/index.test.ts'
    }
  ],
  invalid: [
    // Forbidden: direct aws-sdk-client-mock import
    {
      code: "import {mockClient} from 'aws-sdk-client-mock'",
      filename: 'src/lambdas/StartFileUpload/test/index.test.ts',
      errors: [{messageId: 'noDirectMockClient'}]
    },
    // Forbidden: aws-sdk-client-mock submodule import
    {
      code: "import {mockClient} from 'aws-sdk-client-mock/vitest'",
      filename: 'src/lambdas/S3ObjectCreated/test/index.test.ts',
      errors: [{messageId: 'noDirectMockClient'}]
    },
    // Forbidden: direct mockClient usage
    {
      code: `
        import {mockClient} from 'aws-sdk-client-mock'
        const sqsMock = mockClient(SQSClient)
      `,
      filename: 'src/lambdas/SendPushNotification/test/index.test.ts',
      errors: [{messageId: 'noDirectMockClient'}, {messageId: 'useHelper'}]
    },
    // Forbidden: vi.mock for AWS SDK client
    {
      code: "vi.mock('@aws-sdk/client-sqs', () => ({SQSClient: vi.fn()}))",
      filename: 'src/lambdas/WebhookFeedly/test/index.test.ts',
      errors: [{messageId: 'noViMockAwsSdk'}]
    },
    // Forbidden: vi.mock for AWS SDK lib
    {
      code: "vi.mock('@aws-sdk/client-dynamodb', () => ({}))",
      filename: 'src/lambdas/ListFiles/test/index.test.ts',
      errors: [{messageId: 'noViMockAwsSdk'}]
    }
  ]
})

console.log('aws-sdk-mock-pattern: All tests passed!')
