import * as lancedb from '@lancedb/lancedb'
import {Project} from 'ts-morph'
import {glob} from 'glob'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import {generateEmbedding} from './embeddings.js'

const DB_DIR = '.lancedb'
const TABLE_NAME = 'code_chunks'

/**
 * Maximum tokens for optimal embedding performance with AllMiniLML6V2
 */
const MAX_CHUNK_CHARS = 2000

/**
 * Get semantic hints based on file path to improve conceptual query matching
 */
function getPathHints(filePath: string): string {
  if (filePath.includes('lambdas/UserDelete/')) {
    return 'User deletion with cascade delete pattern using Promise.allSettled'
  }
  if (filePath.includes('lambdas/SendPushNotification/')) {
    return 'Push notification delivery to iOS devices via APNS'
  }
  if (filePath.includes('lambdas/StartFileUpload/')) {
    return 'Video download with retry logic and error handling'
  }
  if (filePath.includes('lambdas/ApiGatewayAuthorizer/')) {
    return 'Authentication and authorization flow'
  }
  if (filePath.includes('lambdas/RegisterDevice/')) {
    return 'Device registration and push notification setup'
  }
  if (filePath.includes('lambdas/')) {
    return 'AWS Lambda handler'
  }
  if (filePath.includes('entities/queries/')) {
    return 'Database query operations using Drizzle ORM'
  }
  if (filePath.includes('lib/vendor/AWS/')) {
    return 'AWS SDK wrapper for service integration'
  }
  if (filePath.includes('lib/vendor/')) {
    return 'External service integration wrapper'
  }
  if (filePath.includes('lib/domain/auth/')) {
    return 'Authentication and session management'
  }
  if (filePath.includes('lib/domain/video/')) {
    return 'Video download and error classification'
  }
  if (filePath.includes('lib/domain/device/')) {
    return 'Device management and push notifications'
  }
  if (filePath.includes('lib/domain/')) {
    return 'Business logic and domain service'
  }
  if (filePath.includes('lib/lambda/middleware/')) {
    return 'Request processing middleware'
  }
  if (filePath.includes('lib/lambda/responses')) {
    return 'API response formatting and error handling'
  }
  if (filePath.includes('lib/system/errors')) {
    return 'Error classes and error handling patterns'
  }
  if (filePath.includes('lib/system/retry')) {
    return 'Retry logic with exponential backoff'
  }
  if (filePath.includes('lib/system/')) {
    return 'System utilities'
  }
  if (filePath.includes('types/')) {
    return 'Type definitions'
  }
  return 'Source code'
}

/**
 * Type descriptions for better semantic matching
 */
const TYPE_CONTEXTS: Record<string, string> = {
  function: 'Function implementation',
  class: 'TypeScript class',
  interface: 'Type definition interface',
  variable: 'Exported constant or configuration'
}

interface CodeChunk {
  vector: number[]
  text: string
  filePath: string
  startLine: number
  endLine: number
  type: string
  name: string
  [key: string]: unknown // Index signature for LanceDB compatibility
}

interface KnowledgeGraphNode {
  id: string
  type: string
  properties: Record<string, unknown>
}

interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[]
  edges: Array<{source: string; target: string; relationship: string}>
}

export async function indexCodebase() {
  const projectRoot = process.cwd()
  const db = await lancedb.connect(DB_DIR)

  // Find all TypeScript files
  const files = await glob('src/**/*.ts', {ignore: ['**/*.test.ts', '**/node_modules/**'], cwd: projectRoot})

  console.log(`Found ${files.length} files to index...`)

  const project = new Project()
  const chunks: CodeChunk[] = []

  for (const file of files) {
    const filePath = path.join(projectRoot, file)
    const sourceFile = project.addSourceFileAtPath(filePath)

    console.log(`Processing ${file}...`)

    // Extract classes
    for (const cls of sourceFile.getClasses()) {
      chunks.push(await createChunk(cls, 'class', cls.getName() || 'anonymous', file))
    }

    // Extract functions
    for (const func of sourceFile.getFunctions()) {
      chunks.push(await createChunk(func, 'function', func.getName() || 'anonymous', file))
    }

    // Extract exported interfaces
    for (const iface of sourceFile.getInterfaces()) {
      if (iface.isExported()) {
        chunks.push(await createChunk(iface, 'interface', iface.getName(), file))
      }
    }

    // Extract top-level variables (like entity definitions)
    for (const varStmt of sourceFile.getVariableStatements()) {
      if (varStmt.isExported()) {
        for (const decl of varStmt.getDeclarations()) {
          chunks.push(await createChunk(decl, 'variable', decl.getName(), file))
        }
      }
    }
  }

  // Index TypeSpec files
  const typespecChunks = await indexTypeSpecFiles(projectRoot)
  chunks.push(...typespecChunks)

  // Index knowledge graph nodes for semantic search
  const graphChunks = await indexKnowledgeGraph(projectRoot)
  chunks.push(...graphChunks)

  console.log(`Generated ${chunks.length} chunks. Creating table...`)

  // Check if table exists, if so delete it to re-index
  const tableNames = await db.tableNames()
  if (tableNames.includes(TABLE_NAME)) {
    await db.dropTable(TABLE_NAME)
  }

  await db.createTable(TABLE_NAME, chunks)
  console.log('Successfully indexed codebase!')
}

/**
 * Extract JSDoc comment from a node if present
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractJsDoc(node: any): string {
  try {
    const jsDocs = node.getJsDocs?.() || []
    if (jsDocs.length > 0) {
      return jsDocs.map((d: {getText: () => string}) => d.getText()).join('\n')
    }
  } catch {
    // Node doesn't support getJsDocs
  }
  return ''
}

/**
 * Create a code chunk with enhanced context headers for better semantic matching
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createChunk(node: any, type: string, name: string, filePath: string): Promise<CodeChunk> {
  const text = node.getText()
  const startLine = node.getStartLineNumber()
  const endLine = node.getEndLineNumber()

  // Get semantic path hints
  const pathHints = getPathHints(filePath)
  const typeContext = TYPE_CONTEXTS[type] || type

  // Extract documentation if present
  const jsDoc = extractJsDoc(node)
  const docSection = jsDoc ? `\nDocumentation: ${jsDoc.replace(/\/\*\*|\*\/|\n\s*\*/g, ' ').trim()}\n` : ''

  // Create enhanced context header for better conceptual query matching
  const contextHeader = `File: ${filePath}
Type: ${typeContext}
Name: ${name}
Purpose: ${pathHints}${docSection}

`

  // Truncate very long chunks to stay within embedding model limits
  const truncatedText = text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) + '...' : text

  const vector = await generateEmbedding(contextHeader + truncatedText)

  return {vector, text: truncatedText, filePath, startLine, endLine, type, name}
}

/**
 * Index TypeSpec model and operation definitions
 */
async function indexTypeSpecFiles(projectRoot: string): Promise<CodeChunk[]> {
  const chunks: CodeChunk[] = []
  const tspFiles = ['tsp/models/models.tsp', 'tsp/operations/operations.tsp']

  for (const relativePath of tspFiles) {
    try {
      const content = await fs.readFile(path.join(projectRoot, relativePath), 'utf-8')
      console.log(`Processing ${relativePath}...`)

      // Extract model definitions
      const modelRegex = /\/\*\*([^*]|\*[^/])*\*\/\s*\nmodel\s+(\w+)\s*\{[^}]+\}/g
      let match
      let lineNum = 1
      while ((match = modelRegex.exec(content)) !== null) {
        const modelText = match[0]
        const modelName = match[2]
        lineNum = content.slice(0, match.index).split('\n').length

        const contextHeader =
          `File: ${relativePath}\nType: TypeSpec model\nName: ${modelName}\n\nAPI Contract: This TypeSpec model defines the schema for ${modelName}. Use with generated Zod schemas in src/types/api-schema/.\n\n`
        const vector = await generateEmbedding(contextHeader + modelText)

        chunks.push({
          vector,
          text: modelText,
          filePath: relativePath,
          startLine: lineNum,
          endLine: lineNum + modelText.split('\n').length,
          type: 'typespec-model',
          name: modelName
        })
      }

      // Extract enum definitions
      const enumRegex = /\/\*\*([^*]|\*[^/])*\*\/\s*\nenum\s+(\w+)\s*\{[^}]+\}/g
      while ((match = enumRegex.exec(content)) !== null) {
        const enumText = match[0]
        const enumName = match[2]
        lineNum = content.slice(0, match.index).split('\n').length

        const contextHeader = `File: ${relativePath}\nType: TypeSpec enum\nName: ${enumName}\n\n`
        const vector = await generateEmbedding(contextHeader + enumText)

        chunks.push({
          vector,
          text: enumText,
          filePath: relativePath,
          startLine: lineNum,
          endLine: lineNum + enumText.split('\n').length,
          type: 'typespec-enum',
          name: enumName
        })
      }

      // Extract interface (operation) definitions
      const interfaceRegex =
        /\/\*\*([^*]|\*[^/])*\*\/\s*\n@route\("[^"]+"\)\s*\n@tag\("[^"]+"\)\s*\ninterface\s+(\w+)\s*\{[\s\S]*?(?=\n\/\*\*|\ninterface|$)/g
      while ((match = interfaceRegex.exec(content)) !== null) {
        const ifaceText = match[0]
        const ifaceName = match[2]
        lineNum = content.slice(0, match.index).split('\n').length

        const contextHeader =
          `File: ${relativePath}\nType: TypeSpec interface (API operations)\nName: ${ifaceName}\n\nAPI Endpoint: This interface defines REST operations. Each operation maps to a Lambda handler.\n\n`
        const vector = await generateEmbedding(contextHeader + ifaceText)

        chunks.push({
          vector,
          text: ifaceText.slice(0, 2000), // Truncate large interfaces
          filePath: relativePath,
          startLine: lineNum,
          endLine: lineNum + ifaceText.split('\n').length,
          type: 'typespec-interface',
          name: ifaceName
        })
      }
    } catch {
      console.log(`  Skipping ${relativePath} (file not found)`)
    }
  }

  console.log(`  Indexed ${chunks.length} TypeSpec definitions`)
  return chunks
}

/**
 * Index knowledge graph nodes to enable semantic queries about architecture
 */
async function indexKnowledgeGraph(projectRoot: string): Promise<CodeChunk[]> {
  const chunks: CodeChunk[] = []
  const graphPath = path.join(projectRoot, 'graphrag', 'knowledge-graph.json')

  try {
    const content = await fs.readFile(graphPath, 'utf-8')
    const graph: KnowledgeGraph = JSON.parse(content)
    console.log(`Processing knowledge graph (${graph.nodes.length} nodes)...`)

    // Group nodes by type for more contextual embeddings
    const nodesByType = new Map<string, KnowledgeGraphNode[]>()
    for (const node of graph.nodes) {
      const nodes = nodesByType.get(node.type) || []
      nodes.push(node)
      nodesByType.set(node.type, nodes)
    }

    // Create summary chunks for each type
    for (const [type, nodes] of nodesByType) {
      const names = nodes.map((n) => n.properties.name || n.id.split(':')[1]).join(', ')
      const summaryText = `Architecture: ${type} components in the system: ${names}`

      // Find edges for this type
      const relevantEdges = graph.edges.filter((e) => nodes.some((n) => e.source === n.id || e.target === n.id))
      const edgeSummary = relevantEdges.slice(0, 10).map((e) => `${e.source} --${e.relationship}--> ${e.target}`).join('\n')

      const fullText = `${summaryText}\n\nRelationships:\n${edgeSummary}`
      const vector = await generateEmbedding(`Architecture summary for ${type} components:\n\n${fullText}`)

      chunks.push({
        vector,
        text: fullText,
        filePath: 'graphrag/knowledge-graph.json',
        startLine: 0,
        endLine: 0,
        type: `architecture-${type.toLowerCase()}`,
        name: `${type} Summary`
      })
    }

    // Create individual chunks for API endpoints with their connections
    const apiEndpoints = graph.nodes.filter((n) => n.type === 'ApiEndpoint')
    for (const endpoint of apiEndpoints) {
      const props = endpoint.properties as {name: string; route: string; method: string; description?: string}
      const edges = graph.edges.filter((e) => e.source === endpoint.id || e.target === endpoint.id)
      const connections = edges.map((e) => {
        const other = e.source === endpoint.id ? e.target : e.source
        return `${e.relationship}: ${other}`
      })

      const text = `API Endpoint: ${props.method} ${props.route}\nName: ${props.name}\nDescription: ${props.description || 'N/A'}\nConnections: ${
        connections.join(', ')
      }`
      const vector = await generateEmbedding(`How to add an API endpoint: ${text}`)

      chunks.push({vector, text, filePath: 'graphrag/knowledge-graph.json', startLine: 0, endLine: 0, type: 'api-endpoint', name: props.name})
    }

    console.log(`  Indexed ${chunks.length} knowledge graph summaries`)
  } catch (err) {
    console.log(`  Skipping knowledge graph (${err instanceof Error ? err.message : 'unknown error'})`)
  }

  return chunks
}

// Run when executed directly
indexCodebase().catch(console.error)
