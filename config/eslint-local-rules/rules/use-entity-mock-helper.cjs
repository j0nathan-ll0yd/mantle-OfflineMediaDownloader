/**
 * use-entity-mock-helper
 * WARN: Legacy entity mocking patterns are deprecated
 *
 * With Drizzle query functions, tests should mock #entities/queries directly
 * using vi.fn() for each function. Legacy entity module mocks are deprecated.
 *
 * Mirrors: src/mcp/validation/rules/entity-mocking.ts
 */

const LEGACY_ENTITY_NAMES = ['Users', 'Files', 'Devices', 'UserFiles', 'UserDevices', 'Sessions', 'Accounts', 'Verifications', 'FileDownloads']

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Detect deprecated legacy entity mocking patterns - use #entities/queries with vi.fn() instead',
      category: 'Testing',
      recommended: true
    },
    messages: {
      legacyEntityMock:
        "Legacy entity mock detected for '{{path}}'. Use vi.mock('#entities/queries', () => ({...})) with vi.fn() for each query function instead.",
      deprecatedHelper: 'createEntityMock() helper is deprecated. Use direct vi.fn() mocks with #entities/queries.'
    },
    schema: []
  },
  create(context) {
    const filename = context.filename || context.getFilename()

    // Only apply to test files
    if (!filename.includes('.test.') && !filename.includes('/test/')) {
      return {}
    }

    // Skip helper and mock files
    if (filename.includes('entity-mock') || filename.includes('drizzle-mock')) {
      return {}
    }

    return {
      CallExpression(node) {
        const callee = node.callee

        // Check for vi.mock or jest.mock
        if (
          callee.type === 'MemberExpression' &&
          (callee.object.name === 'vi' || callee.object.name === 'jest') &&
          (callee.property.name === 'mock' || callee.property.name === 'unstable_mockModule')
        ) {
          if (node.arguments.length >= 1) {
            const modulePath = node.arguments[0]
            if (modulePath.type === 'Literal' && typeof modulePath.value === 'string') {
              const pathValue = modulePath.value

              // Check if mocking a legacy entity directly (not #entities/queries)
              const isLegacyEntityMock = LEGACY_ENTITY_NAMES.some((e) => pathValue === `#entities/${e}` || pathValue.endsWith(`/entities/${e}`))

              if (isLegacyEntityMock) {
                context.report({
                  node,
                  messageId: 'legacyEntityMock',
                  data: {path: pathValue}
                })
              }

              // Check for deprecated createEntityMock usage
              if (node.arguments.length >= 2) {
                const sourceCode = context.sourceCode || context.getSourceCode()
                const mockImpl = sourceCode.getText(node.arguments[1])

                if (mockImpl.includes('createEntityMock')) {
                  context.report({
                    node,
                    messageId: 'deprecatedHelper'
                  })
                }
              }
            }
          }
        }
      }
    }
  }
}
