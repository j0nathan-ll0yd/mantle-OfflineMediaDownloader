/**
 * aws-sdk-mock-pattern
 * MEDIUM: Unit tests should use aws-sdk-mock helpers instead of raw mockClient
 *
 * The test/helpers/aws-sdk-mock.ts helpers provide:
 * - Proper integration with vendor wrapper test client injection
 * - Centralized mock cleanup via resetAllAwsMocks()
 * - Type-safe mock creation
 *
 * @example
 * // Bad: Direct aws-sdk-client-mock usage
 * import {mockClient} from 'aws-sdk-client-mock'
 * const sqsMock = mockClient(SQSClient)
 *
 * // Good: Use mock helpers
 * import {createSQSMock, resetAllAwsMocks} from '#test/helpers/aws-sdk-mock'
 * const sqsMock = createSQSMock()
 */

const HELPER_FUNCTIONS = {
  SQSClient: 'createSQSMock',
  SNSClient: 'createSNSMock',
  S3Client: 'createS3Mock',
  DynamoDBClient: 'createDynamoDBMock',
  EventBridgeClient: 'createEventBridgeMock',
  LambdaClient: 'createLambdaMock'
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce using AWS SDK mock helpers instead of raw aws-sdk-client-mock',
      category: 'Testing',
      recommended: true
    },
    messages: {
      useHelper:
        "Use {{helper}}() from '#test/helpers/aws-sdk-mock' instead of mockClient({{client}}). The helper provides proper vendor wrapper integration and cleanup.",
      noDirectMockClient:
        "Import mock helpers from '#test/helpers/aws-sdk-mock' instead of aws-sdk-client-mock directly. Available helpers: createSQSMock, createSNSMock, createS3Mock, createDynamoDBMock, createEventBridgeMock, createLambdaMock.",
      noViMockAwsSdk:
        "Do not use vi.mock() for AWS SDK in unit tests. Use mock helpers from '#test/helpers/aws-sdk-mock' which integrate with the vendor wrapper test client injection."
    },
    schema: []
  },

  create(context) {
    const filename = context.filename || context.getFilename()

    // Only apply to Lambda unit test files
    if (!filename.includes('/lambdas/') || !filename.endsWith('.test.ts')) {
      return {}
    }

    // Skip test helper files
    if (filename.includes('test/helpers/')) {
      return {}
    }

    return {
      // Check for direct mockClient import
      ImportDeclaration(node) {
        const moduleSpecifier = node.source.value

        // Check for direct aws-sdk-client-mock import
        if (moduleSpecifier === 'aws-sdk-client-mock' || moduleSpecifier.startsWith('aws-sdk-client-mock/')) {
          context.report({node, messageId: 'noDirectMockClient'})
        }
      },

      // Check for mockClient() calls and vi.mock('@aws-sdk/...')
      CallExpression(node) {
        const callee = node.callee

        // Check for mockClient(SQSClient) pattern
        if (callee.type === 'Identifier' && callee.name === 'mockClient' && node.arguments.length > 0) {
          const clientArg = node.arguments[0]
          if (clientArg.type === 'Identifier') {
            const clientName = clientArg.name
            const helperName = HELPER_FUNCTIONS[clientName] || 'createXXXMock'

            context.report({
              node,
              messageId: 'useHelper',
              data: {client: clientName, helper: helperName}
            })
          }
        }

        // Check for vi.mock('@aws-sdk/...')
        if (
          callee.type === 'MemberExpression' &&
          callee.object.name === 'vi' &&
          callee.property.name === 'mock' &&
          node.arguments.length > 0
        ) {
          const arg = node.arguments[0]
          if (arg.type === 'Literal' && typeof arg.value === 'string') {
            if (arg.value.startsWith('@aws-sdk/client-')) {
              context.report({node, messageId: 'noViMockAwsSdk'})
            }
          }
        }
      }
    }
  }
}
