#!/usr/bin/env node
/**
 * GraphRAG extraction for Lambda chains and entity relationships
 * Builds a knowledge graph from the codebase for multi-hop reasoning
 *
 * This script dynamically discovers:
 * - Lambdas from src/lambdas/ directory
 * - Entity relationships from src/entities/ directory
 * - Service dependencies from build/graph.json transitive dependencies
 *
 * Semantic metadata (triggers, purposes) is read from graphrag/metadata.json
 */

import fs from 'fs/promises'
import path from 'path'
import {Project, SyntaxKind} from 'ts-morph'
import {fileURLToPath} from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

interface Node {
  id: string
  type: 'Lambda' | 'Entity' | 'Service' | 'External' | 'ApiModel' | 'ApiEndpoint'
  properties: Record<string, unknown>
}

interface Edge {
  source: string
  target: string
  relationship: string
  properties?: Record<string, unknown>
}

interface KnowledgeGraph {
  nodes: Node[]
  edges: Edge[]
  metadata: {version: string; description: string; sources: {lambdas: string; dependencies: string; metadata: string}}
}

interface DependencyGraph {
  metadata: {generated: string; projectRoot: string; totalFiles: number}
  files: Record<string, {file: string; imports: string[]}>
  transitiveDependencies: Record<string, string[]>
}

interface LambdaMetadata {
  trigger: string
  purpose: string
}

interface ServiceMetadata {
  name: string
  type: string
  vendorPath?: string | null
  description?: string
}

interface Metadata {
  lambdas: Record<string, LambdaMetadata>
  externalServices: ServiceMetadata[]
  awsServices: ServiceMetadata[]
  entityRelationships: Array<{from: string; to: string; type: string}>
  lambdaInvocations: Array<{from: string; to: string; via: string}>
  serviceToServiceEdges: Array<{from: string; to: string; relationship: string; event?: string}>
  typeSpecModels?: TypeSpecModelMetadata[]
  typeSpecEndpoints?: TypeSpecEndpointMetadata[]
}

interface TypeSpecModelMetadata {
  name: string
  type: 'model' | 'enum'
  description?: string
  fields?: string[]
}

interface TypeSpecEndpointMetadata {
  name: string
  route: string
  method: string
  handler: string
  requestModel?: string
  responseModel?: string
  description?: string
}

interface LambdaEntry {
  name: string
  entryPoint: string
}

/**
 * Discover Lambda entry points from src/lambdas/ directory
 *
 * Supports two Lambda layout conventions:
 * - File-based routing (Mantle): `api/user/login.post.ts` -\> name `api/user/login`
 * - Directory-based: `sqs/SendPushNotification/index.ts` -\> name `sqs/SendPushNotification`
 *
 * Returns Lambda identifiers (relative paths from src/lambdas/) paired with
 * their entry point file paths (relative to project root, for graph.json lookup).
 */
async function discoverLambdas(): Promise<LambdaEntry[]> {
  const lambdasDir = path.join(projectRoot, 'src', 'lambdas')
  const lambdas: LambdaEntry[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, {withFileTypes: true})
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        // File-based routing: event.post.ts, index.get.ts, webhook.post.ts
        const routeMatch = entry.name.match(/^(.+)\.(post|get|delete|put|patch)\.ts$/)
        if (routeMatch) {
          const name = path.relative(lambdasDir, path.join(dir, routeMatch[1]))
          const entryPoint = `src/lambdas/${path.relative(lambdasDir, fullPath)}`
          lambdas.push({name, entryPoint})
          continue
        }
        // Directory-based: index.ts inside a named folder
        if (entry.name === 'index.ts') {
          const name = path.relative(lambdasDir, dir)
          const entryPoint = `src/lambdas/${path.relative(lambdasDir, fullPath)}`
          lambdas.push({name, entryPoint})
        }
      }
    }
  }

  await walk(lambdasDir)
  return lambdas.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Discover Entity names dynamically from Drizzle schema via ts-morph AST walk.
 *
 * Finds all exported VariableDeclarations whose initializer is a CallExpression
 * to `pgTable`, then extracts the variable name and PascalCases it.
 *
 * Replaces the previous regex-based scanner per C1 compiler-API discipline.
 */
async function discoverEntities(): Promise<string[]> {
  const schemaPath = path.join(projectRoot, 'src', 'db', 'schema.ts')
  const project = new Project({skipAddingFilesFromTsConfig: true, compilerOptions: {allowJs: true}})
  const sourceFile = project.addSourceFileAtPath(schemaPath)

  const entities: string[] = []
  for (const varStmt of sourceFile.getVariableStatements()) {
    if (!varStmt.isExported()) {
      continue
    }
    for (const decl of varStmt.getDeclarations()) {
      const init = decl.getInitializer()
      if (!init || !init.isKind(SyntaxKind.CallExpression)) {
        continue
      }
      const callTarget = init.getExpression()
      if (callTarget.isKind(SyntaxKind.Identifier) && callTarget.getText() === 'pgTable') {
        const varName = decl.getName()
        const entityName = varName.charAt(0).toUpperCase() + varName.slice(1)
        entities.push(entityName)
      }
    }
  }

  project.removeSourceFile(sourceFile)

  // Map 'verification' table to 'VerificationTokens' for consistency with existing naming
  return entities.map((e) => (e === 'Verification' ? 'VerificationTokens' : e))
}

/**
 * Discover TypeSpec models from tsp/models/models.tsp
 */
async function discoverTypeSpecModels(): Promise<TypeSpecModelMetadata[]> {
  const modelsPath = path.join(projectRoot, 'tsp', 'models', 'models.tsp')
  let content: string
  try {
    content = await fs.readFile(modelsPath, 'utf-8')
  } catch {
    return []
  }
  const models: TypeSpecModelMetadata[] = []

  // Parse model definitions
  const modelRegex = /\/\*\*\s*\n\s*\*\s*([^*]+)\s*\n[^*]*\*\/\s*\nmodel\s+(\w+)\s*\{/g
  let match
  while ((match = modelRegex.exec(content)) !== null) {
    const description = match[1].trim()
    const name = match[2]

    // Extract field names for context
    const modelStart = match.index + match[0].length
    const modelEnd = content.indexOf('}', modelStart)
    const modelBody = content.slice(modelStart, modelEnd)
    const fields = modelBody.split('\n').map((line) => line.trim()).filter((line) =>
      line && !line.startsWith('*') && !line.startsWith('/') && line.includes(':')
    ).map((line) => line.split(':')[0].replace('?', '').trim()).filter((field) => field.length > 0)

    models.push({name, type: 'model', description, fields})
  }

  // Parse enum definitions
  const enumRegex = /\/\*\*\s*\n\s*\*\s*([^*]+)\s*\n[^*]*\*\/\s*\nenum\s+(\w+)\s*\{/g
  while ((match = enumRegex.exec(content)) !== null) {
    const description = match[1].trim()
    const name = match[2]

    // Extract enum values
    const enumStart = match.index + match[0].length
    const enumEnd = content.indexOf('}', enumStart)
    const enumBody = content.slice(enumStart, enumEnd)
    const values = enumBody.split('\n').map((line) => line.trim()).filter((line) =>
      line && !line.startsWith('*') && !line.startsWith('/') && line.includes(':')
    ).map((line) => line.split(':')[0].trim()).filter((value) => value.length > 0)

    models.push({name, type: 'enum', description, fields: values})
  }

  return models
}

/**
 * Maps TypeSpec operation names to Lambda handler names.
 *
 * TypeSpec doesn't encode which Lambda handles each operation, so we maintain
 * this explicit mapping for the knowledge graph extraction.
 *
 * MAINTENANCE NOTE: This map must be updated when TypeSpec operations change.
 * If a new operation is added to tsp/operations/operations.tsp:
 * 1. Add the mapping here (operationName to LambdaName)
 * 2. Run `pnpm run graphrag:extract` to regenerate knowledge graph
 * 3. CI will fail if knowledge-graph.json is out of date
 *
 * @see tsp/operations/operations.tsp for current operations
 */
const OPERATION_TO_HANDLER: Record<string, string> = {
  listFiles: 'api/files/index',
  registerDevice: 'api/device/register',
  logClientEvent: 'api/device/event',
  processFeedlyWebhook: 'api/feedly/webhook',
  registerUser: 'api/user/register',
  loginUser: 'api/user/login',
  refreshToken: 'api/user/refresh',
  deleteUser: 'api/user/index',
  subscribeUser: 'api/user/subscribe'
}

/**
 * Parse TypeSpec interface blocks and extract endpoints
 */
function parseTypeSpecInterface(content: string, interfaceMatch: RegExpMatchArray): TypeSpecEndpointMetadata[] {
  const endpoints: TypeSpecEndpointMetadata[] = []

  // Extract base route from interface decorators
  const interfaceStartIndex = interfaceMatch.index!
  const beforeInterface = content.slice(Math.max(0, interfaceStartIndex - 200), interfaceStartIndex)
  const baseRouteMatch = beforeInterface.match(/@route\("([^"]+)"\)\s*(?:@\w+(?:\([^)]*\))?\s*)*$/s)
  const baseRoute = baseRouteMatch?.[1] || ''

  // Find interface body
  const interfaceStart = content.indexOf('{', interfaceStartIndex)
  let braceCount = 1
  let interfaceEnd = interfaceStart + 1
  while (braceCount > 0 && interfaceEnd < content.length) {
    if (content[interfaceEnd] === '{') {
      braceCount++
    }
    if (content[interfaceEnd] === '}') {
      braceCount--
    }
    interfaceEnd++
  }
  const interfaceBody = content.slice(interfaceStart + 1, interfaceEnd - 1)

  // Parse each operation in the interface using a simpler approach:
  // Find method names that are followed by ( and have HTTP decorators before them
  const methodPattern = /(\w+)\s*\(/g
  const skipWords = new Set(['header', 'body', 'doc', 'statusCode', 'if', 'return', 'expect', 'summary', 'route', 'tag'])

  let methodMatch
  while ((methodMatch = methodPattern.exec(interfaceBody)) !== null) {
    const operationName = methodMatch[1]

    // Skip decorator function names and common non-method words
    if (skipWords.has(operationName.toLowerCase())) {
      continue
    }

    // Look backwards for HTTP method decorators in the preceding context
    const beforeMethod = interfaceBody.slice(Math.max(0, methodMatch.index - 300), methodMatch.index)

    // Must have an HTTP method decorator
    let method = ''
    if (beforeMethod.includes('@get')) {
      method = 'GET'
    } else if (beforeMethod.includes('@post')) {
      method = 'POST'
    } else if (beforeMethod.includes('@delete')) {
      method = 'DELETE'
    } else if (beforeMethod.includes('@put')) {
      method = 'PUT'
    } else if (beforeMethod.includes('@patch')) {
      method = 'PATCH'
    }

    if (!method) {
      continue
    }

    // Check if this is a known operation
    const handler = OPERATION_TO_HANDLER[operationName]
    if (!handler) {
      continue
    }

    // Extract sub-route if present (looks for @route closest to the method)
    const subRouteMatch = beforeMethod.match(/@route\("([^"]+)"\)(?![\s\S]*@route)/)
    const subRoute = subRouteMatch?.[1] || ''
    const fullRoute = subRoute ? `${baseRoute}${subRoute}` : baseRoute

    // Extract summary
    const summaryMatch = beforeMethod.match(/@summary\("([^"]+)"\)/)
    const description = summaryMatch?.[1]

    // Extract request model from @body parameter - look forward from method name
    const afterMethod = interfaceBody.slice(methodMatch.index, methodMatch.index + 500)
    const signatureEnd = afterMethod.indexOf(')')
    const signature = afterMethod.slice(0, signatureEnd)
    const bodyParamMatch = signature.match(/@body\s+\w+:\s*(\w+)/)
    const requestModel = bodyParamMatch?.[1]

    // Extract response model from return type - look for ApiResponse<Model>
    let responseModel: string | undefined
    const colonAfterSignature = afterMethod.indexOf(':', signatureEnd)
    if (colonAfterSignature !== -1) {
      const returnType = afterMethod.slice(colonAfterSignature, colonAfterSignature + 200)
      const responseMatch = returnType.match(/ApiResponse<(\w+)>/)
      responseModel = responseMatch?.[1]
    }

    endpoints.push({
      name: operationName,
      route: fullRoute,
      method,
      handler,
      ...(requestModel && {requestModel}),
      ...(responseModel && {responseModel}),
      ...(description && {description})
    })
  }

  return endpoints
}

/**
 * Discover TypeSpec API endpoints from tsp/operations/operations.tsp
 *
 * Parses the TypeSpec file to extract:
 * - Interface base routes from `@route` decorators
 * - HTTP methods from `@get`, `@post`, `@delete` decorators
 * - Operation names and summaries
 * - Request/response models from `@body` parameters
 */
async function discoverTypeSpecEndpoints(): Promise<TypeSpecEndpointMetadata[]> {
  const operationsPath = path.join(projectRoot, 'tsp', 'operations', 'operations.tsp')
  let content: string
  try {
    content = await fs.readFile(operationsPath, 'utf-8')
  } catch {
    return []
  }
  const endpoints: TypeSpecEndpointMetadata[] = []

  // Find all interface definitions
  const interfaceRegex = /interface\s+(\w+)\s*\{/g
  let match
  while ((match = interfaceRegex.exec(content)) !== null) {
    const interfaceEndpoints = parseTypeSpecInterface(content, match)
    endpoints.push(...interfaceEndpoints)
  }

  return endpoints
}

/**
 * Load the dependency graph from build/graph.json
 */
async function loadDependencyGraph(): Promise<DependencyGraph> {
  const graphPath = path.join(projectRoot, 'build', 'graph.json')
  const content = await fs.readFile(graphPath, 'utf-8')
  return JSON.parse(content)
}

/**
 * Load semantic metadata from graphrag/metadata.json
 */
async function loadMetadata(): Promise<Metadata> {
  const metadataPath = path.join(__dirname, 'metadata.json')
  const content = await fs.readFile(metadataPath, 'utf-8')
  return JSON.parse(content)
}

/**
 * Extract AWS services used by a Lambda from its transitive dependencies
 */
function extractAwsServices(deps: string[], awsServices: ServiceMetadata[]): string[] {
  const services: Set<string> = new Set()
  for (const dep of deps) {
    // Match src/lib/vendor/AWS/* patterns
    const awsMatch = dep.match(/src\/lib\/vendor\/AWS\/(\w+)/)
    if (awsMatch) {
      const vendorName = awsMatch[1]
      // Find the service name from metadata
      const service = awsServices.find((s) => s.vendorPath === `AWS/${vendorName}`)
      if (service) {
        services.add(service.name)
      }
    }
  }
  return Array.from(services)
}

/**
 * Extract external services used by a Lambda from its transitive dependencies
 */
function extractExternalServices(deps: string[], externalServices: ServiceMetadata[]): string[] {
  const services: Set<string> = new Set()

  // Map vendor directories to external service names
  const vendorToService: Record<string, string> = {BetterAuth: 'Sign In With Apple', YouTube: 'YouTube'}

  for (const dep of deps) {
    // Match src/lib/vendor/* patterns (non-AWS)
    const vendorMatch = dep.match(/src\/lib\/vendor\/(\w+)/)
    if (vendorMatch && vendorMatch[1] !== 'AWS' && vendorMatch[1] !== 'Drizzle') {
      const vendorName = vendorMatch[1]
      // Check explicit mapping first
      if (vendorToService[vendorName]) {
        services.add(vendorToService[vendorName])
      } else {
        // Fall back to case-insensitive name matching
        const service = externalServices.find((s) => s.name.toLowerCase() === vendorName.toLowerCase())
        if (service) {
          services.add(service.name)
        }
      }
    }

    // Match src/types/vendor/* patterns (for Feedly, etc.)
    const typeVendorMatch = dep.match(/src\/types\/vendor\/\w+\/(\w+)/)
    if (typeVendorMatch) {
      const vendorName = typeVendorMatch[1]
      const service = externalServices.find((s) => s.name.toLowerCase() === vendorName.toLowerCase())
      if (service) {
        services.add(service.name)
      }
    }

    // Detect APNS usage via SNS platform application patterns
    if (dep.includes('SNS') && (dep.includes('Platform') || dep.includes('push') || dep.includes('Endpoint'))) {
      services.add('APNS')
    }

    // Detect GitHub usage via issue creation
    if (dep.includes('GitHub') || dep.includes('github')) {
      services.add('GitHub')
    }
  }
  return Array.from(services)
}

/**
 * Extract entities used by a Lambda from its transitive dependencies
 * Detects both direct entity imports and queries/ module access
 */
function extractEntities(deps: string[], knownEntities: string[]): string[] {
  const entities: Set<string> = new Set()

  // Map query modules to entity names they access
  const queryModuleToEntities: Record<string, string[]> = {
    'user-queries': ['Users'],
    'file-queries': ['Files', 'FileDownloads'],
    'device-queries': ['Devices'],
    'session-queries': ['Sessions', 'Accounts', 'VerificationTokens'],
    'relationship-queries': ['UserFiles', 'UserDevices']
  }

  for (const dep of deps) {
    // Match src/entities/queries/* patterns (Drizzle ORM pattern)
    const queryMatch = dep.match(/src\/entities\/queries\/(\w+-queries)/)
    if (queryMatch) {
      const queryModule = queryMatch[1]
      const mappedEntities = queryModuleToEntities[queryModule] || []
      mappedEntities.forEach((e) => entities.add(e))
    }

    // Match src/entities/queries barrel import (without specific file)
    // This handles paths like "src/entities/queries" or "src/entities/queries/index"
    if (dep === 'src/entities/queries' || dep.includes('src/entities/queries/index') || dep.includes('src/entities/queries.ts')) {
      // Barrel import means access to all entities - add common ones
      entities.add('Users')
      entities.add('Files')
      entities.add('Devices')
      entities.add('Sessions')
    }

    // Legacy: Match src/entities/* patterns (direct entity imports)
    const entityMatch = dep.match(/src\/entities\/(\w+)\.ts/)
    if (entityMatch) {
      const entityName = entityMatch[1]
      if (knownEntities.includes(entityName)) {
        entities.add(entityName)
      }
    }
  }
  return Array.from(entities)
}

/**
 * Extract knowledge graph from codebase
 */
export async function extractKnowledgeGraph(): Promise<KnowledgeGraph> {
  const nodes: Node[] = []
  const edges: Edge[] = []

  // Load all data sources
  const [lambdaEntries, entityNames, depGraph, metadata, typeSpecModels, typeSpecEndpoints] = await Promise.all([
    discoverLambdas(),
    discoverEntities(),
    loadDependencyGraph(),
    loadMetadata(),
    discoverTypeSpecModels(),
    discoverTypeSpecEndpoints()
  ])

  const lambdaNames = lambdaEntries.map((e) => e.name)
  const lambdaEntryPoints = new Map(lambdaEntries.map((e) => [e.name, e.entryPoint]))

  console.log(`  Discovered ${lambdaNames.length} Lambdas`)
  console.log(`  Discovered ${entityNames.length} Entities`)
  console.log(`  Discovered ${typeSpecModels.length} TypeSpec Models`)
  console.log(`  Discovered ${typeSpecEndpoints.length} TypeSpec Endpoints`)

  // 1. Add Lambda nodes
  for (const name of lambdaNames) {
    const lambdaMeta = metadata.lambdas[name] || {trigger: 'Unknown', purpose: 'Unknown'}
    nodes.push({id: `lambda:${name}`, type: 'Lambda', properties: {name, trigger: lambdaMeta.trigger, purpose: lambdaMeta.purpose}})
  }

  // 2. Add Entity nodes
  for (const name of entityNames) {
    nodes.push({id: `entity:${name}`, type: 'Entity', properties: {name}})
  }

  // 3. Add AWS Service nodes
  for (const service of metadata.awsServices) {
    nodes.push({id: `service:${service.name}`, type: 'Service', properties: {name: service.name, type: service.type}})
  }

  // 4. Add External Service nodes
  for (const service of metadata.externalServices) {
    nodes.push({id: `external:${service.name}`, type: 'External', properties: {name: service.name, type: service.type, description: service.description}})
  }

  // 5. Add TypeSpec Model nodes
  for (const model of typeSpecModels) {
    nodes.push({
      id: `apimodel:${model.name}`,
      type: 'ApiModel',
      properties: {name: model.name, modelType: model.type, description: model.description, fields: model.fields}
    })
  }

  // 6. Add TypeSpec Endpoint nodes
  for (const endpoint of typeSpecEndpoints) {
    nodes.push({
      id: `apiendpoint:${endpoint.name}`,
      type: 'ApiEndpoint',
      properties: {name: endpoint.name, route: endpoint.route, method: endpoint.method, description: endpoint.description}
    })

    // Add endpoint → handler Lambda edge
    if (endpoint.handler && lambdaNames.includes(endpoint.handler)) {
      edges.push({source: `apiendpoint:${endpoint.name}`, target: `lambda:${endpoint.handler}`, relationship: 'implemented_by'})
    }

    // Add endpoint → request model edge
    if (endpoint.requestModel) {
      edges.push({source: `apiendpoint:${endpoint.name}`, target: `apimodel:${endpoint.requestModel}`, relationship: 'accepts'})
    }

    // Add endpoint → response model edge
    if (endpoint.responseModel) {
      edges.push({source: `apiendpoint:${endpoint.name}`, target: `apimodel:${endpoint.responseModel}`, relationship: 'returns'})
    }
  }

  // Add Lambda → ApiModel validation edges (based on generated type imports)
  const lambdaToModelMap: Record<string, string[]> = {
    'api/user/login': ['UserLoginRequest'],
    'api/user/register': ['UserRegistrationRequest'],
    'api/device/register': ['DeviceRegistrationRequest'],
    'api/user/subscribe': ['UserSubscriptionRequest'],
    'api/feedly/webhook': ['FeedlyWebhookRequest']
  }

  for (const [lambdaName, models] of Object.entries(lambdaToModelMap)) {
    for (const model of models) {
      if (typeSpecModels.some((m) => m.name === model)) {
        edges.push({source: `lambda:${lambdaName}`, target: `apimodel:${model}`, relationship: 'validates_with'})
      }
    }
  }

  // 7. Add Lambda → Service/External edges (derived from dependency graph)
  for (const lambdaName of lambdaNames) {
    const entryPoint = lambdaEntryPoints.get(lambdaName) || ''
    const deps = depGraph.transitiveDependencies[entryPoint] || []

    // AWS Services
    const awsServices = extractAwsServices(deps, metadata.awsServices)
    for (const serviceName of awsServices) {
      edges.push({source: `lambda:${lambdaName}`, target: `service:${serviceName}`, relationship: 'uses'})
    }

    // External Services
    const extServices = extractExternalServices(deps, metadata.externalServices)
    for (const serviceName of extServices) {
      edges.push({source: `lambda:${lambdaName}`, target: `external:${serviceName}`, relationship: 'uses'})
    }

    // Entities
    const entities = extractEntities(deps, entityNames)
    for (const entityName of entities) {
      edges.push({source: `lambda:${lambdaName}`, target: `entity:${entityName}`, relationship: 'accesses'})
    }

    // Add trigger service edge based on metadata
    const lambdaMeta = metadata.lambdas[lambdaName]
    if (lambdaMeta) {
      // Map trigger names to AWS service names
      const triggerToService: Record<string, string> = {
        'API Gateway': 'API Gateway',
        'S3 Event': 'S3',
        SQS: 'SQS',
        'CloudWatch Events': 'CloudWatch',
        CloudFront: 'CloudFront',
        Manual: '' // Manual triggers don't have a service
      }

      const serviceName = triggerToService[lambdaMeta.trigger] || lambdaMeta.trigger
      if (serviceName) {
        const triggerService = metadata.awsServices.find((s) => s.name === serviceName)
        if (triggerService) {
          edges.push({source: `service:${triggerService.name}`, target: `lambda:${lambdaName}`, relationship: 'triggers'})
        }
      }
    }
  }

  // 6. Add Lambda → Lambda invocation edges (from metadata)
  for (const invocation of metadata.lambdaInvocations) {
    edges.push({source: `lambda:${invocation.from}`, target: `lambda:${invocation.to}`, relationship: 'invokes', properties: {via: invocation.via}})
  }

  // 7. Add Entity → Entity relationship edges (from metadata)
  for (const rel of metadata.entityRelationships) {
    edges.push({source: `entity:${rel.from}`, target: `entity:${rel.to}`, relationship: rel.type})
  }

  // 8. Add Service → Service edges (from metadata)
  for (const edge of metadata.serviceToServiceEdges) {
    const props: Record<string, unknown> = {}
    if (edge.event) {
      props.event = edge.event
    }

    edges.push({
      source: `service:${edge.from}`,
      target: `service:${edge.to}`,
      relationship: edge.relationship,
      ...(Object.keys(props).length > 0 && {properties: props})
    })
  }

  return {
    nodes,
    edges,
    metadata: {
      version: '3.0.0',
      description: 'Media Downloader knowledge graph with Lambda chains, entities, and API contracts (auto-generated)',
      sources: {lambdas: 'src/lambdas/', entities: 'src/entities/', typespec: 'tsp/', dependencies: 'build/graph.json', metadata: 'graphrag/metadata.json'}
    }
  }
}

/**
 * Save knowledge graph to file
 */
async function saveKnowledgeGraph(graph: KnowledgeGraph, outputPath: string) {
  await fs.writeFile(outputPath, JSON.stringify(graph, null, 2) + '\n')
  console.log(`✓ Knowledge graph saved to ${outputPath}`)
  console.log(`  Nodes: ${graph.nodes.length}`)
  console.log(`  Edges: ${graph.edges.length}`)
}

/**
 * Generate graph statistics
 */
function analyzeGraph(graph: KnowledgeGraph) {
  const stats = {
    nodeTypes: {} as Record<string, number>,
    relationshipTypes: {} as Record<string, number>,
    mostConnected: [] as Array<{node: string; connections: number}>,
    lambdaChains: [] as string[][],
    missingMetadata: [] as string[]
  }

  // Count node types
  for (const node of graph.nodes) {
    stats.nodeTypes[node.type] = (stats.nodeTypes[node.type] || 0) + 1
  }

  // Count relationship types
  for (const edge of graph.edges) {
    stats.relationshipTypes[edge.relationship] = (stats.relationshipTypes[edge.relationship] || 0) + 1
  }

  // Find most connected nodes
  const connections: Record<string, number> = {}
  for (const edge of graph.edges) {
    connections[edge.source] = (connections[edge.source] || 0) + 1
    connections[edge.target] = (connections[edge.target] || 0) + 1
  }

  stats.mostConnected = Object.entries(connections).sort(([, a], [, b]) => b - a).slice(0, 10).map(([node, count]) => ({node, connections: count}))

  // Find Lambda chains
  const findChains = (start: string, visited: Set<string> = new Set()): string[][] => {
    if (visited.has(start)) {
      return []
    }
    visited.add(start)

    const chains: string[][] = []
    const outgoing = graph.edges.filter((e) => e.source === start && e.relationship === 'invokes')

    if (outgoing.length === 0) {
      return [[start]]
    }

    for (const edge of outgoing) {
      const subChains = findChains(edge.target, new Set(visited))
      for (const subChain of subChains) {
        chains.push([start, ...subChain])
      }
    }

    return chains
  }

  // Find all Lambda invocation chains
  const lambdaNodes = graph.nodes.filter((n) => n.type === 'Lambda').map((n) => n.id)
  for (const lambda of lambdaNodes) {
    const chains = findChains(lambda)
    if (chains.length > 0 && chains.some((c) => c.length > 1)) {
      stats.lambdaChains.push(...chains.filter((c) => c.length > 1))
    }
  }

  // Find Lambdas missing metadata
  for (const node of graph.nodes) {
    if (node.type === 'Lambda' && node.properties.trigger === 'Unknown') {
      stats.missingMetadata.push(node.properties.name as string)
    }
  }

  return stats
}

// Main execution
async function main() {
  try {
    console.log('Extracting knowledge graph...')
    const graph = await extractKnowledgeGraph()

    const outputPath = path.join(__dirname, 'knowledge-graph.json')
    await saveKnowledgeGraph(graph, outputPath)

    console.log('\nGraph Statistics:')
    const stats = analyzeGraph(graph)
    console.log('Node Types:', stats.nodeTypes)
    console.log('Relationship Types:', stats.relationshipTypes)

    console.log('\nMost Connected Nodes:')
    stats.mostConnected.forEach((item) => {
      console.log(`  ${item.node}: ${item.connections} connections`)
    })

    if (stats.lambdaChains.length > 0) {
      console.log('\nLambda Invocation Chains:')
      stats.lambdaChains.forEach((chain) => {
        console.log('  ' + chain.join(' → '))
      })
    }

    if (stats.missingMetadata.length > 0) {
      console.log('\n⚠️  Lambdas missing metadata in graphrag/metadata.json:')
      stats.missingMetadata.forEach((name) => {
        console.log(`  - ${name}`)
      })
    }
  } catch (error) {
    console.error('Error extracting knowledge graph:', error)
    process.exit(1)
  }
}

// Run if executed directly
if (import.meta.url === `file://${__filename}`) {
  main()
}

export { Edge, KnowledgeGraph, Node }
