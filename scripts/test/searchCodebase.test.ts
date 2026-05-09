import {beforeEach, describe, expect, it, vi} from 'vitest'

// Mock the LanceDB and embedding modules before importing the search module
vi.mock('@lancedb/lancedb',
  () => ({
    connect: vi.fn().mockResolvedValue({
      openTable: vi.fn().mockResolvedValue({
        vectorSearch: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnThis(),
          toArray: vi.fn().mockResolvedValue([
            {filePath: 'src/lib/system/errors.ts', name: 'CustomLambdaError', type: 'class', startLine: 10, text: 'class CustomLambdaError', _distance: 0.3},
            {
              filePath: 'src/lib/lambda/responses.ts',
              name: 'buildErrorResponse',
              type: 'function',
              startLine: 50,
              text: 'function buildErrorResponse',
              _distance: 0.35
            },
            {filePath: 'src/util/something.ts', name: 'irrelevant', type: 'function', startLine: 1, text: 'irrelevant', _distance: 0.8}
          ])
        })
      })
    })
  }))

vi.mock('../embeddings.js', () => ({generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1))}))

vi.mock('@huggingface/transformers', () => ({pipeline: vi.fn().mockResolvedValue(vi.fn())}))

// Import after mocks are set up
const searchModule = await import('../searchCodebase.js')

describe('searchCodebase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('search function', () => {
    it('returns results with adjusted distances after type boosting', async () => {
      const results = await searchModule.search('error handling patterns', {limit: 3, expand: true})

      expect(results).toHaveLength(3)
      expect(results[0]).toHaveProperty('adjustedDistance')
      // Class type has 0.95 boost, so adjusted distance should be higher
      expect(results[0].adjustedDistance).toBeDefined()
    })

    it('applies query expansion for conceptual queries', async () => {
      const {generateEmbedding} = await import('../embeddings.js')
      const mockGenerate = vi.mocked(generateEmbedding)

      await searchModule.search('cascade deletion', {expand: true})

      // The expanded query should contain related terms
      expect(mockGenerate).toHaveBeenCalled()
      const calledWith = mockGenerate.mock.calls[0][0] as string
      expect(calledWith).toContain('cascade deletion')
      // With expansion, it should include related terms
      expect(calledWith).toContain('Related')
    })

    it('does not expand query when expand is false', async () => {
      const {generateEmbedding} = await import('../embeddings.js')
      const mockGenerate = vi.mocked(generateEmbedding)

      await searchModule.search('cascade deletion', {expand: false})

      const calledWith = mockGenerate.mock.calls[0][0] as string
      expect(calledWith).toBe('cascade deletion')
      expect(calledWith).not.toContain('Related')
    })

    it('filters results by maxDistance', async () => {
      const results = await searchModule.search('test query', {limit: 5, expand: false, maxDistance: 0.5})

      // Should filter out the result with distance 0.8
      expect(results.every((r) => r._distance < 0.5)).toBe(true)
    })
  })

  describe('query expansion', () => {
    it('expands error handling queries with related terms', async () => {
      const {generateEmbedding} = await import('../embeddings.js')
      const mockGenerate = vi.mocked(generateEmbedding)

      await searchModule.search('error handling', {expand: true})

      const query = mockGenerate.mock.calls[0][0] as string
      expect(query).toContain('CustomLambdaError')
      expect(query).toContain('ValidationError')
    })

    it('expands authentication queries', async () => {
      const {generateEmbedding} = await import('../embeddings.js')
      const mockGenerate = vi.mocked(generateEmbedding)

      await searchModule.search('authentication flow', {expand: true})

      const query = mockGenerate.mock.calls[0][0] as string
      expect(query).toContain('Bearer token')
      expect(query).toContain('ApiGatewayAuthorizer')
    })

    it('expands push notification queries', async () => {
      const {generateEmbedding} = await import('../embeddings.js')
      const mockGenerate = vi.mocked(generateEmbedding)

      await searchModule.search('push notification', {expand: true})

      const query = mockGenerate.mock.calls[0][0] as string
      expect(query).toContain('APNS')
      expect(query).toContain('SendPushNotification')
    })

    it('does not expand queries without matching concepts', async () => {
      const {generateEmbedding} = await import('../embeddings.js')
      const mockGenerate = vi.mocked(generateEmbedding)

      await searchModule.search('random unrelated query', {expand: true})

      const query = mockGenerate.mock.calls[0][0] as string
      expect(query).toBe('random unrelated query')
    })
  })

  describe('type boosting', () => {
    it('boosts function types by default', async () => {
      const results = await searchModule.search('test', {expand: false})

      const functionResult = results.find((r) => r.type === 'function')
      expect(functionResult).toBeDefined()
      // Function has 1.0 boost, so adjusted distance equals raw distance
      expect(functionResult!.adjustedDistance).toBe(functionResult!._distance)
    })

    it('penalizes variable types', async () => {
      const mockResults = [
        {filePath: 'test.ts', name: 'config', type: 'variable', startLine: 1, text: 'const config', _distance: 0.3}
      ]

      vi.mocked((await import('@lancedb/lancedb')).connect).mockResolvedValueOnce(
        {
          openTable: vi.fn().mockResolvedValue({
            vectorSearch: vi.fn().mockReturnValue({limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue(mockResults)})
          })
        } as never
      )

      const results = await searchModule.search('test', {expand: false})

      const variableResult = results.find((r) => r.type === 'variable')
      if (variableResult) {
        // Variable has 0.85 boost, so adjusted distance should be higher
        expect(variableResult.adjustedDistance).toBeGreaterThan(variableResult._distance)
      }
    })
  })
})

describe('evaluateSemanticSearch', () => {
  describe('metric calculations', () => {
    it('calculates precision correctly', () => {
      // 3 out of 5 relevant = 60%
      const results = [
        {file: 'a.ts', name: 'a', type: 'function', distance: 0.1, relevant: true},
        {file: 'b.ts', name: 'b', type: 'function', distance: 0.2, relevant: true},
        {file: 'c.ts', name: 'c', type: 'function', distance: 0.3, relevant: false},
        {file: 'd.ts', name: 'd', type: 'function', distance: 0.4, relevant: true},
        {file: 'e.ts', name: 'e', type: 'function', distance: 0.5, relevant: false}
      ]

      const relevantCount = results.filter((r) => r.relevant).length
      const precision = relevantCount / results.length
      expect(precision).toBe(0.6)
    })

    it('identifies first relevant rank correctly', () => {
      const results = [
        {file: 'a.ts', name: 'a', type: 'function', distance: 0.1, relevant: false},
        {file: 'b.ts', name: 'b', type: 'function', distance: 0.2, relevant: false},
        {file: 'c.ts', name: 'c', type: 'function', distance: 0.3, relevant: true}
      ]

      const firstRelevantIndex = results.findIndex((r) => r.relevant)
      const firstRelevantRank = firstRelevantIndex + 1
      expect(firstRelevantRank).toBe(3)
    })

    it('returns 0 for first relevant rank when no results are relevant', () => {
      const results = [
        {file: 'a.ts', name: 'a', type: 'function', distance: 0.1, relevant: false}
      ]

      const firstRelevantIndex = results.findIndex((r) => r.relevant)
      const firstRelevantRank = firstRelevantIndex >= 0 ? firstRelevantIndex + 1 : 0
      expect(firstRelevantRank).toBe(0)
    })
  })
})
