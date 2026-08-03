import {beforeEach, describe, expect, it, vi} from 'vitest'

// Mock the Powertools metrics
const mockAddDimension = vi.fn()
const mockAddMetric = vi.fn()
const mockSingleMetric = vi.fn(() => ({addDimension: mockAddDimension, addMetric: mockAddMetric}))

vi.mock('@j0nathan-ll0yd/observability',
  () => ({
    metrics: {singleMetric: mockSingleMetric},
    MetricUnit: {Count: 'Count', Milliseconds: 'Milliseconds', Seconds: 'Seconds', Bytes: 'Bytes'},
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn()
  }))

const {emitErrorMetrics, emitSuccessMetrics} = await import('#utils/errorMetrics.js')

describe('errorMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('emitErrorMetrics', () => {
    it('should emit ErrorCount metric with dimensions', () => {
      const error = new TypeError('Something went wrong')
      emitErrorMetrics(error, 'TestLambda')

      expect(mockSingleMetric).toHaveBeenCalled()
      expect(mockAddDimension).toHaveBeenCalledWith('LambdaName', 'TestLambda')
      expect(mockAddDimension).toHaveBeenCalledWith('ErrorType', 'TypeError')
      expect(mockAddMetric).toHaveBeenCalledWith('ErrorCount', 'Count', 1)
    })

    it('should emit ErrorByCategory when classification provided', () => {
      const error = new Error('test')
      const classification = {category: 'transient' as const, retryable: true, maxRetries: 3, reason: 'test', createIssue: false}

      emitErrorMetrics(error, 'TestLambda', classification)

      // Should have multiple singleMetric calls
      expect(mockSingleMetric).toHaveBeenCalledTimes(2)
      expect(mockAddDimension).toHaveBeenCalledWith('ErrorCategory', 'transient')
      expect(mockAddMetric).toHaveBeenCalledWith('ErrorByCategory', 'Count', 1)
    })

    it('should emit RetryExhausted for non-retryable with maxRetries > 0', () => {
      const error = new Error('test')
      const classification = {
        category: 'permanent' as const,
        retryable: false,
        maxRetries: 3, // Had retries but failed
        reason: 'test',
        createIssue: false
      }

      emitErrorMetrics(error, 'TestLambda', classification)

      // Should have 3 singleMetric calls (error, category, retry)
      expect(mockSingleMetric).toHaveBeenCalledTimes(3)
      expect(mockAddMetric).toHaveBeenCalledWith('RetryExhausted', 'Count', 1)
    })

    it('should not emit RetryExhausted for retryable errors', () => {
      const error = new Error('test')
      const classification = {category: 'transient' as const, retryable: true, maxRetries: 3, reason: 'test', createIssue: false}

      emitErrorMetrics(error, 'TestLambda', classification)

      // Should have 2 singleMetric calls (error, category) - no retry exhausted
      expect(mockSingleMetric).toHaveBeenCalledTimes(2)
      expect(mockAddMetric).not.toHaveBeenCalledWith('RetryExhausted', 'Count', 1)
    })

    it('should emit ErrorByStatusCode for HTTP errors', () => {
      const error = new Error('Not found') as Error & {statusCode: number}
      error.statusCode = 404

      emitErrorMetrics(error, 'TestLambda')

      expect(mockAddDimension).toHaveBeenCalledWith('StatusCode', '404')
      expect(mockAddMetric).toHaveBeenCalledWith('ErrorByStatusCode', 'Count', 1)
    })

    it('should use Error as fallback type name', () => {
      const error = new Error('test')
      // Clear the name property
      Object.defineProperty(error, 'name', {value: '', writable: true})

      emitErrorMetrics(error, 'TestLambda')

      expect(mockAddDimension).toHaveBeenCalledWith('ErrorType', 'Error')
    })
  })

  describe('emitSuccessMetrics', () => {
    it('should emit SuccessCount metric with Lambda dimension', () => {
      emitSuccessMetrics('TestLambda')

      expect(mockSingleMetric).toHaveBeenCalled()
      expect(mockAddDimension).toHaveBeenCalledWith('LambdaName', 'TestLambda')
      expect(mockAddMetric).toHaveBeenCalledWith('SuccessCount', 'Count', 1)
    })
  })
})
