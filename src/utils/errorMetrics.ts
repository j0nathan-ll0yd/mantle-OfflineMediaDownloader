import {metrics, MetricUnit} from '@j0nathan-ll0yd/observability'
import type {ErrorClassification} from '#types/errorClassification'

/**
 * Emits CloudWatch metrics for errors.
 * Creates structured metrics with Lambda name and error type dimensions.
 *
 * @param error - The error that occurred
 * @param lambdaName - Name of the Lambda function
 * @param classification - Optional error classification for additional metrics
 */
export function emitErrorMetrics(error: Error, lambdaName: string, classification?: ErrorClassification): void {
  const errorType = error.name || error.constructor.name || 'Error'

  // Emit ErrorCount metric with dimensions
  const errorMetric = metrics.singleMetric()
  errorMetric.addDimension('LambdaName', lambdaName)
  errorMetric.addDimension('ErrorType', errorType)
  errorMetric.addMetric('ErrorCount', MetricUnit.Count, 1)

  // If we have a classification, emit additional metrics
  if (classification) {
    // Emit ErrorByCategory metric
    const categoryMetric = metrics.singleMetric()
    categoryMetric.addDimension('LambdaName', lambdaName)
    categoryMetric.addDimension('ErrorCategory', classification.category)
    categoryMetric.addMetric('ErrorByCategory', MetricUnit.Count, 1)

    // Emit RetryExhausted metric for non-retryable errors that had retries
    if (!classification.retryable && classification.maxRetries > 0) {
      const retryMetric = metrics.singleMetric()
      retryMetric.addDimension('LambdaName', lambdaName)
      retryMetric.addDimension('ErrorType', errorType)
      retryMetric.addMetric('RetryExhausted', MetricUnit.Count, 1)
    }
  }

  // Emit ErrorByStatusCode for HTTP errors
  if ('statusCode' in error && typeof (error as {statusCode: number}).statusCode === 'number') {
    const statusCode = (error as {statusCode: number}).statusCode
    const statusMetric = metrics.singleMetric()
    statusMetric.addDimension('LambdaName', lambdaName)
    statusMetric.addDimension('StatusCode', String(statusCode))
    statusMetric.addMetric('ErrorByStatusCode', MetricUnit.Count, 1)
  }
}

/**
 * Emits CloudWatch metrics for successful Lambda invocations.
 *
 * @param lambdaName - Name of the Lambda function
 */
export function emitSuccessMetrics(lambdaName: string): void {
  const metric = metrics.singleMetric()
  metric.addDimension('LambdaName', lambdaName)
  metric.addMetric('SuccessCount', MetricUnit.Count, 1)
}
