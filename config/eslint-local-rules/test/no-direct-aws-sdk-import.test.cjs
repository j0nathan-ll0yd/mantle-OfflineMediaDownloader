/**
 * Tests for no-direct-aws-sdk-import ESLint rule
 */

const {RuleTester} = require('eslint')
const rule = require('../rules/no-direct-aws-sdk-import.cjs')

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  }
})

ruleTester.run('no-direct-aws-sdk-import', rule, {
  valid: [
    // Allowed: vendor directory imports
    {
      code: "import {DynamoDBClient} from '@aws-sdk/client-dynamodb'",
      filename: 'src/lib/vendor/AWS/DynamoDB.ts'
    },
    // Allowed: non-AWS imports
    {
      code: "import {something} from 'some-package'",
      filename: 'src/lambdas/ListFiles/src/index.ts'
    },
    // Allowed: internal vendor wrapper
    {
      code: "import {getDynamoDBClient} from '#lib/vendor/AWS/DynamoDB'",
      filename: 'src/lambdas/ListFiles/src/index.ts'
    },
    // Allowed: relative vendor import
    {
      code: "import {S3Client} from '../lib/vendor/AWS/S3'",
      filename: 'src/lambdas/StartFileUpload/src/index.ts'
    },
    // Allowed: Powertools vendor directory imports
    {
      code: "import {Logger} from '@aws-lambda-powertools/logger'",
      filename: 'src/lib/vendor/Powertools/index.ts'
    },
    // Allowed: internal Powertools vendor wrapper
    {
      code: "import {logger, tracer} from '#lib/vendor/Powertools'",
      filename: 'src/lambdas/WebhookFeedly/src/index.ts'
    }
  ],
  invalid: [
    // Forbidden: direct DynamoDB SDK import in Lambda
    {
      code: "import {DynamoDBClient} from '@aws-sdk/client-dynamodb'",
      filename: 'src/lambdas/ListFiles/src/index.ts',
      errors: [{messageId: 'forbidden'}]
    },
    // Forbidden: direct S3 SDK import in entity
    {
      code: "import {S3Client} from '@aws-sdk/client-s3'",
      filename: 'src/entities/Files.ts',
      errors: [{messageId: 'forbidden'}]
    },
    // Forbidden: direct Lambda SDK import
    {
      code: "import {LambdaClient, InvokeCommand} from '@aws-sdk/client-lambda'",
      filename: 'src/lambdas/FileCoordinator/src/index.ts',
      errors: [{messageId: 'forbidden'}]
    },
    // Forbidden: lib-dynamodb import
    {
      code: "import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb'",
      filename: 'src/lambdas/LoginUser/src/index.ts',
      errors: [{messageId: 'forbidden'}]
    },
    // Forbidden: AWS SDK v2
    {
      code: "import AWS from 'aws-sdk'",
      filename: 'src/lambdas/RegisterUser/src/index.ts',
      errors: [{messageId: 'forbidden'}]
    },
    // Forbidden: direct Powertools Logger import in Lambda
    {
      code: "import {Logger} from '@aws-lambda-powertools/logger'",
      filename: 'src/lambdas/WebhookFeedly/src/index.ts',
      errors: [{messageId: 'forbidden'}]
    },
    // Forbidden: direct Powertools Tracer import
    {
      code: "import {Tracer} from '@aws-lambda-powertools/tracer'",
      filename: 'src/util/lambda-helpers.ts',
      errors: [{messageId: 'forbidden'}]
    },
    // Forbidden: direct Powertools idempotency import
    {
      code: "import {makeIdempotent} from '@aws-lambda-powertools/idempotency'",
      filename: 'src/lambdas/WebhookFeedly/src/index.ts',
      errors: [{messageId: 'forbidden'}]
    }
  ]
})

console.log('no-direct-aws-sdk-import: All tests passed!')
