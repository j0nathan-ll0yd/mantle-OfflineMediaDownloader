#!/usr/bin/env node
/**
 * GraphRAG query interface for multi-hop reasoning
 * Enables complex queries across Lambda chains and entity relationships
 */

import fs from 'fs/promises'
import path from 'path'
import {fileURLToPath} from 'url'
// Type definitions (duplicated to avoid circular imports)
interface Node {
  id: string
  type: 'Lambda' | 'Entity' | 'Service' | 'External'
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
  metadata: {created: string; version: string; description: string}
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Load knowledge graph from file
 */
async function loadKnowledgeGraph(): Promise<KnowledgeGraph> {
  const graphPath = path.join(__dirname, 'knowledge-graph.json')
  const data = await fs.readFile(graphPath, 'utf-8')
  return JSON.parse(data)
}

/**
 * Multi-hop query functions
 */
export class GraphQuery {
  constructor(private graph: KnowledgeGraph) {}

  /**
   * Find all paths between two nodes
   */
  findPaths(startId: string, endId: string, maxHops: number = 5): string[][] {
    const paths: string[][] = []
    const visited = new Set<string>()

    const dfs = (current: string, path: string[]) => {
      if (path.length > maxHops) {
        return
      }
      if (current === endId) {
        paths.push([...path])
        return
      }

      visited.add(current)
      const edges = this.graph.edges.filter((e) => e.source === current)

      for (const edge of edges) {
        if (!visited.has(edge.target)) {
          dfs(edge.target, [...path, edge.target])
        }
      }
      visited.delete(current)
    }

    dfs(startId, [startId])
    return paths
  }

  /**
   * Find impact of changes to a node (what depends on it)
   */
  findImpact(nodeId: string, depth: number = 3): Map<number, string[]> {
    const impact = new Map<number, string[]>()
    const visited = new Set<string>()
    const queue: Array<{node: string; level: number}> = [{node: nodeId, level: 0}]

    while (queue.length > 0) {
      const {node, level} = queue.shift()!
      if (level > depth || visited.has(node)) {
        continue
      }

      visited.add(node)
      if (!impact.has(level)) {
        impact.set(level, [])
      }
      impact.get(level)!.push(node)

      // Find all nodes that this node affects
      const edges = this.graph.edges.filter((e) => e.target === node)
      for (const edge of edges) {
        queue.push({node: edge.source, level: level + 1})
      }
    }

    return impact
  }

  /**
   * Find dependencies of a node (what it depends on)
   */
  findDependencies(nodeId: string, depth: number = 3): Map<number, string[]> {
    const deps = new Map<number, string[]>()
    const visited = new Set<string>()
    const queue: Array<{node: string; level: number}> = [{node: nodeId, level: 0}]

    while (queue.length > 0) {
      const {node, level} = queue.shift()!
      if (level > depth || visited.has(node)) {
        continue
      }

      visited.add(node)
      if (!deps.has(level)) {
        deps.set(level, [])
      }
      deps.get(level)!.push(node)

      // Find all nodes that this node depends on
      const edges = this.graph.edges.filter((e) => e.source === node)
      for (const edge of edges) {
        queue.push({node: edge.target, level: level + 1})
      }
    }

    return deps
  }

  /**
   * Complex query: What happens if a file is deleted?
   * Note: fileId parameter would be used to find specific file relationships
   */
  fileDeleteImpact(_fileId: string): {affectedUsers: string[]; affectedLambdas: string[]; cascadeOperations: string[]} {
    const result = {affectedUsers: [] as string[], affectedLambdas: [] as string[], cascadeOperations: [] as string[]}

    // Find UserFiles entries for this file (used for determining affected users)
    this.graph.edges.filter((e) => e.target === 'entity:Files' && e.source.includes('UserFiles'))

    // Find users through UserFiles
    const userEdges = this.graph.edges.filter((e) => e.source === 'entity:UserFiles' && e.target === 'entity:Users')
    result.affectedUsers = userEdges.map((e) => e.target)

    // Find Lambdas that access Files entity
    const lambdaEdges = this.graph.edges.filter((e) => e.target === 'entity:Files' && e.source.startsWith('lambda:'))
    result.affectedLambdas = lambdaEdges.map((e) => e.source.replace('lambda:', ''))

    // Cascade operations
    result.cascadeOperations = ['Delete UserFiles entries', 'Remove S3 object', 'Send deletion notification', 'Update user quota']

    return result
  }

  /**
   * Complex query: What is the data flow for file upload?
   */
  fileUploadFlow(): Array<{step: number; node: string; action: string}> {
    const flow = [
      {step: 1, node: 'API Gateway', action: 'Receive POST /files/upload request'},
      {step: 2, node: 'lambda:StartFileUpload', action: 'Validate user and generate S3 presigned URL'},
      {step: 3, node: 'entity:Files', action: 'Create file record with pending status'},
      {step: 4, node: 'entity:UserFiles', action: 'Create user-file relationship'},
      {step: 5, node: 'S3', action: 'Client uploads file directly'},
      {step: 6, node: 'lambda:S3ObjectCreated', action: 'Triggered by S3 upload event'},
      {step: 7, node: 'entity:Files', action: 'Update status to downloaded'},
      {step: 8, node: 'lambda:SendPushNotification', action: 'Notify user of completion'}
    ]
    return flow
  }

  /**
   * Find circular dependencies
   */
  findCircularDependencies(): string[][] {
    const cycles: string[][] = []
    const visited = new Set<string>()
    const recursionStack = new Set<string>()

    const dfs = (node: string, path: string[]): boolean => {
      visited.add(node)
      recursionStack.add(node)

      const edges = this.graph.edges.filter((e) => e.source === node)
      for (const edge of edges) {
        if (!visited.has(edge.target)) {
          if (dfs(edge.target, [...path, edge.target])) {
            return true
          }
        } else if (recursionStack.has(edge.target)) {
          // Found a cycle
          const cycleStart = path.indexOf(edge.target)
          if (cycleStart !== -1) {
            cycles.push(path.slice(cycleStart))
          }
        }
      }

      recursionStack.delete(node)
      return false
    }

    for (const node of this.graph.nodes) {
      if (!visited.has(node.id)) {
        dfs(node.id, [node.id])
      }
    }

    return cycles
  }

  /**
   * Community detection: Find clusters of related nodes
   */
  findCommunities(): Map<string, string[]> {
    const communities = new Map<string, string[]>()

    // Simple community detection based on node types and connections
    const lambdaCommunity: string[] = []
    const entityCommunity: string[] = []
    const serviceCommunity: string[] = []

    for (const node of this.graph.nodes) {
      switch (node.type) {
        case 'Lambda':
          lambdaCommunity.push(node.id)
          break
        case 'Entity':
          entityCommunity.push(node.id)
          break
        case 'Service':
        case 'External':
          serviceCommunity.push(node.id)
          break
      }
    }

    communities.set('Lambda Functions', lambdaCommunity)
    communities.set('Data Model', entityCommunity)
    communities.set('Infrastructure', serviceCommunity)

    return communities
  }

  /**
   * Answer complex questions about the system
   */
  answerQuestion(question: string): unknown {
    const lowerQuestion = question.toLowerCase()

    if (lowerQuestion.includes('file') && lowerQuestion.includes('delete')) {
      return this.fileDeleteImpact('file-123')
    }

    if (lowerQuestion.includes('upload') && lowerQuestion.includes('flow')) {
      return this.fileUploadFlow()
    }

    if (lowerQuestion.includes('circular') || lowerQuestion.includes('cycle')) {
      return this.findCircularDependencies()
    }

    if (lowerQuestion.includes('communities') || lowerQuestion.includes('clusters')) {
      return this.findCommunities()
    }

    if (lowerQuestion.includes('impact')) {
      const match = question.match(/impact.*?(\w+)/i)
      if (match) {
        const nodeId = `lambda:${match[1]}`
        return this.findImpact(nodeId)
      }
    }

    if (lowerQuestion.includes('depend')) {
      const match = question.match(/depend.*?(\w+)/i)
      if (match) {
        const nodeId = `lambda:${match[1]}`
        return this.findDependencies(nodeId)
      }
    }

    return {
      error: 'Question not understood',
      suggestions: [
        'What happens if a file is deleted?',
        'What is the upload flow?',
        'Are there circular dependencies?',
        'What are the system communities?',
        'What is the impact of changing ListFiles?',
        'What does WebhookFeedly depend on?'
      ]
    }
  }
}

/**
 * CLI interface for testing queries
 */
async function main() {
  const graph = await loadKnowledgeGraph()
  const query = new GraphQuery(graph)

  console.log('GraphRAG Query Interface\n')

  // Example queries
  const examples = [
    'What happens if a file is deleted?',
    'What is the upload flow?',
    'Are there circular dependencies?',
    'What is the impact of changing ListFiles?',
    'What does WebhookFeedly depend on?'
  ]

  for (const example of examples) {
    console.log(`\nQ: ${example}`)
    const result = query.answerQuestion(example)
    console.log('A:', JSON.stringify(result, null, 2))
  }

  // Multi-hop reasoning example
  console.log('\n=== Multi-hop Reasoning ===')
  const paths = query.findPaths('lambda:StartFileUpload', 'lambda:SendPushNotification')
  console.log('Paths from StartFileUpload to SendPushNotification:')
  paths.forEach((path, i) => {
    console.log(`  Path ${i + 1}: ${path.join(' → ')}`)
  })

  // Impact analysis
  console.log('\n=== Impact Analysis ===')
  const impact = query.findImpact('entity:Users', 2)
  console.log('Impact of changing Users entity:')
  for (const [level, nodes] of impact) {
    console.log(`  Level ${level}: ${nodes.join(', ')}`)
  }

  // Dependency analysis
  console.log('\n=== Dependency Analysis ===')
  const deps = query.findDependencies('lambda:UserDelete', 2)
  console.log('UserDelete Lambda dependencies:')
  for (const [level, nodes] of deps) {
    console.log(`  Level ${level}: ${nodes.join(', ')}`)
  }
}

// Run if executed directly
if (import.meta.url === `file://${__filename}`) {
  main().catch(console.error)
}
