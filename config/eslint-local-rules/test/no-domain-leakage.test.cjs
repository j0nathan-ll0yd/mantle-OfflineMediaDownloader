/**
 * Tests for no-domain-leakage ESLint rule
 */

const rule = require('../rules/no-domain-leakage.cjs')

// Mock ESLint context
function createContext(filename = '/src/lib/domain/user-service.ts') {
  const errors = []
  return {
    getFilename: () => filename,
    report: (error) => errors.push(error),
    getErrors: () => errors
  }
}

// Test case 1: Valid import from types
function testValidTypeImport() {
  const node = {
    source: {value: '#types/domainModels'}
  }
  
  const context = createContext()
  const visitor = rule.create(context)
  visitor.ImportDeclaration(node)
  
  if (context.getErrors().length === 0) {
    console.log('✅ Test 1 passed: Valid import from types')
  } else {
    console.error('❌ Test 1 failed')
    console.error(context.getErrors())
    process.exit(1)
  }
}

// Test case 2: Valid import from util
function testValidUtilImport() {
  const node = {
    source: {value: '#util/logging'}
  }
  
  const context = createContext()
  const visitor = rule.create(context)
  visitor.ImportDeclaration(node)
  
  if (context.getErrors().length === 0) {
    console.log('✅ Test 2 passed: Valid import from util')
  } else {
    console.error('❌ Test 2 failed')
    console.error(context.getErrors())
    process.exit(1)
  }
}

// Test case 3: Invalid import from lambdas
function testInvalidLambdaImport() {
  const node = {
    source: {value: '#lambdas/StartFileUpload/src/index'}
  }
  
  const context = createContext()
  const visitor = rule.create(context)
  visitor.ImportDeclaration(node)
  
  if (context.getErrors().length === 1 && context.getErrors()[0].messageId === 'domainLeakage') {
    console.log('✅ Test 3 passed: Invalid Lambda import detected')
  } else {
    console.error('❌ Test 3 failed')
    console.error(context.getErrors())
    process.exit(1)
  }
}

// Test case 4: Invalid import from AWS vendor
function testInvalidAwsVendorImport() {
  const node = {
    source: {value: '#lib/vendor/AWS/S3'}
  }
  
  const context = createContext()
  const visitor = rule.create(context)
  visitor.ImportDeclaration(node)
  
  if (context.getErrors().length === 1 && context.getErrors()[0].messageId === 'domainLeakage') {
    console.log('✅ Test 4 passed: Invalid AWS vendor import detected')
  } else {
    console.error('❌ Test 4 failed')
    console.error(context.getErrors())
    process.exit(1)
  }
}

// Test case 5: Should not check files outside domain directory
function testIgnoresNonDomainFiles() {
  const node = {
    source: {value: '#lib/vendor/AWS/S3'}
  }
  
  const context = createContext('/src/util/helpers.ts')
  const visitor = rule.create(context)
  
  // Should return empty object for non-domain files
  if (Object.keys(visitor).length === 0) {
    console.log('✅ Test 5 passed: Non-domain files ignored')
  } else {
    console.error('❌ Test 5 failed')
    process.exit(1)
  }
}

// Run all tests
console.log('Running no-domain-leakage rule tests...')
testValidTypeImport()
testValidUtilImport()
testInvalidLambdaImport()
testInvalidAwsVendorImport()
testIgnoresNonDomainFiles()
console.log('✅ All no-domain-leakage tests passed')
