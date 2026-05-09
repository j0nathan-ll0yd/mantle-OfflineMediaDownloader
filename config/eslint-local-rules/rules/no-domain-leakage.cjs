/**
 * ESLint rule: no-domain-leakage
 * 
 * Prevents domain layer (src/lib/domain) from importing outer layers.
 * Domain logic should remain pure and not depend on infrastructure or Lambda concerns.
 * 
 * Forbidden imports from src/lib/domain:
 * - src/lambdas/*
 * - src/lib/vendor/AWS/*
 * 
 * Allowed imports:
 * - src/types/*
 * - src/util/*
 * - Node.js built-ins
 * - npm packages
 */

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Prevent domain layer from importing outer layers',
      category: 'Architecture',
      recommended: true
    },
    messages: {
      domainLeakage: 'Domain layer cannot import from "{{importPath}}". Domain logic must remain pure.'
    },
    schema: []
  },
  create(context) {
    // Only check files in src/lib/domain
    const filename = context.filename || context.getFilename()
    if (!filename.includes('/src/lib/domain/')) {
      return {}
    }

    const forbiddenPrefixes = [
      '/src/lambdas/',
      '/src/lib/vendor/AWS/',
      '#lambdas/',
      '#lib/vendor/AWS/'
    ]

    return {
      ImportDeclaration(node) {
        const importPath = node.source.value

        for (const prefix of forbiddenPrefixes) {
          if (importPath.includes(prefix) || importPath.startsWith(prefix.slice(1))) {
            context.report({
              node,
              messageId: 'domainLeakage',
              data: {importPath}
            })
            return
          }
        }
      }
    }
  }
}
