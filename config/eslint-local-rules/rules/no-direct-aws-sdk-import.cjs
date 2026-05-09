/**
 * no-direct-aws-sdk-import
 * CRITICAL: Blocks direct AWS SDK imports outside vendor directory
 *
 * Mirrors: src/mcp/validation/rules/aws-sdk-encapsulation.ts
 *
 * Exceptions:
 * - Vendor wrapper directories (lib/vendor/AWS, lib/vendor/Powertools, etc.)
 * - Integration test helpers (test/integration/helpers)
 * - Type-only imports in test files (import type { ... } for mock typing)
 */

const FORBIDDEN_PACKAGES = [
  // AWS SDK v3
  '@aws-sdk/client-',
  '@aws-sdk/lib-',
  '@aws-sdk/util-',
  '@aws-sdk/credential-',
  '@aws-sdk/middleware-',
  'aws-sdk', // v2
  // AWS Lambda Powertools
  '@aws-lambda-powertools/'
]

const VENDOR_SUGGESTIONS = {
  // AWS SDK
  '@aws-sdk/client-dynamodb': 'lib/vendor/AWS/DynamoDB',
  '@aws-sdk/lib-dynamodb': 'lib/vendor/AWS/DynamoDB',
  '@aws-sdk/client-s3': 'lib/vendor/AWS/S3',
  '@aws-sdk/client-lambda': 'lib/vendor/AWS/Lambda',
  '@aws-sdk/client-sns': 'lib/vendor/AWS/SNS',
  '@aws-sdk/client-sqs': 'lib/vendor/AWS/SQS',
  '@aws-sdk/client-eventbridge': 'lib/vendor/AWS/EventBridge',
  '@aws-sdk/client-api-gateway': 'lib/vendor/AWS/ApiGateway',
  // AWS Lambda Powertools
  '@aws-lambda-powertools/logger': 'lib/vendor/Powertools',
  '@aws-lambda-powertools/tracer': 'lib/vendor/Powertools',
  '@aws-lambda-powertools/metrics': 'lib/vendor/Powertools',
  '@aws-lambda-powertools/idempotency': 'lib/vendor/Powertools/idempotency'
}

function getSuggestion(moduleSpecifier) {
  for (const [pattern, vendor] of Object.entries(VENDOR_SUGGESTIONS)) {
    if (moduleSpecifier.startsWith(pattern) || moduleSpecifier === pattern) {
      return `Import from '${vendor}' instead.`
    }
  }
  return 'Create a vendor wrapper in lib/vendor/AWS/ for this service.'
}

function isForbiddenImport(moduleSpecifier) {
  return FORBIDDEN_PACKAGES.some((pkg) => moduleSpecifier.startsWith(pkg))
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct AWS SDK imports outside vendor directory',
      category: 'Best Practices',
      recommended: true
    },
    messages: {
      forbidden: "Direct AWS SDK import forbidden: '{{module}}'. {{suggestion}}"
    },
    schema: []
  },
  create(context) {
    const filename = context.filename || context.getFilename()

    // Allow imports in vendor directories and integration test helpers
    // - lib/vendor/AWS/ - AWS SDK wrappers
    // - lib/vendor/Powertools/ - AWS Lambda Powertools wrappers
    // - lib/vendor/Drizzle/ - Drizzle ORM wrapper (needs Aurora DSQL client)
    // - test/integration/helpers/ - LocalStack setup (needs direct client access)
    if (
      filename.includes('lib/vendor/AWS') ||
      filename.includes('lib/vendor/Powertools') ||
      filename.includes('lib/vendor/Drizzle') ||
      filename.includes('test/integration/helpers')
    ) {
      return {}
    }

    return {
      ImportDeclaration(node) {
        const moduleSpecifier = node.source.value

        if (isForbiddenImport(moduleSpecifier)) {
          // Allow type-only imports in test files (for mock typing)
          // Test files need to import AWS SDK types to properly type their mocks
          const isTypeOnlyImport = node.importKind === 'type'
          const isTestFile = filename.includes('.test.ts') || filename.includes('.test.js')

          if (isTypeOnlyImport && isTestFile) {
            return // Allow type imports in tests
          }

          context.report({
            node,
            messageId: 'forbidden',
            data: {
              module: moduleSpecifier,
              suggestion: getSuggestion(moduleSpecifier)
            }
          })
        }
      },
      CallExpression(node) {
        // Check dynamic imports
        if (node.callee.type === 'Import' && node.arguments.length > 0) {
          const arg = node.arguments[0]
          if (arg.type === 'Literal' && typeof arg.value === 'string') {
            if (isForbiddenImport(arg.value)) {
              context.report({
                node,
                messageId: 'forbidden',
                data: {
                  module: arg.value,
                  suggestion: getSuggestion(arg.value)
                }
              })
            }
          }
        }
      }
    }
  }
}
