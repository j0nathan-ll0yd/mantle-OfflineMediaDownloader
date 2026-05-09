/**
 * integration-test-localstack
 * HIGH: Integration tests should use LocalStack, not AWS SDK mocks
 *
 * Integration tests should use real AWS services via LocalStack for accurate testing.
 * AWS SDK mocks (vi.mock, aws-sdk-client-mock) should only be used in unit tests.
 *
 * Allowed in integration tests:
 * - test/integration/lib/vendor/AWS/ (LocalStack wrappers)
 * - test/integration/helpers/ (test utilities)
 * - Mocking non-AWS services (apns2, github, etc.)
 */

const AWS_SDK_PATTERNS = ['@aws-sdk/client-', '@aws-sdk/lib-', 'aws-sdk-client-mock', '@aws-sdk/util-']

function isAwsSdkImport(moduleSpecifier) {
  return AWS_SDK_PATTERNS.some((pattern) => moduleSpecifier.startsWith(pattern) || moduleSpecifier === pattern)
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Integration tests should use LocalStack, not AWS SDK mocks',
      category: 'Best Practices',
      recommended: true
    },
    messages: {
      noAwsSdkMock:
        "Integration tests should use LocalStack instead of vi.mock() for AWS SDK. Import from 'test/integration/lib/vendor/AWS/' for LocalStack-aware wrappers.",
      noMockClient:
        "Integration tests should use LocalStack instead of aws-sdk-client-mock. Import from 'test/integration/lib/vendor/AWS/' for LocalStack-aware wrappers."
    },
    schema: []
  },

  create(context) {
    const filename = context.filename || context.getFilename()

    // Only apply to integration test workflow files
    if (!filename.includes('test/integration/workflows/') || !filename.endsWith('.test.ts')) {
      return {}
    }

    return {
      // Check for vi.mock('@aws-sdk/...')
      CallExpression(node) {
        // Check for vi.mock('@aws-sdk/...')
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object.name === 'vi' &&
          node.callee.property.name === 'mock' &&
          node.arguments.length > 0
        ) {
          const arg = node.arguments[0]
          if (arg.type === 'Literal' && typeof arg.value === 'string') {
            if (isAwsSdkImport(arg.value)) {
              context.report({node, messageId: 'noAwsSdkMock'})
            }
          }
        }
      },

      // Check for import from aws-sdk-client-mock
      ImportDeclaration(node) {
        const moduleSpecifier = node.source.value

        if (moduleSpecifier === 'aws-sdk-client-mock' || moduleSpecifier.startsWith('aws-sdk-client-mock/')) {
          context.report({node, messageId: 'noMockClient'})
        }
      }
    }
  }
}
