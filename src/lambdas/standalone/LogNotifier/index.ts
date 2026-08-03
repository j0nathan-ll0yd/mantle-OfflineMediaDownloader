import {defineLambda, withObservability} from '@j0nathan-ll0yd/core'
import {createLogSubscriptionNotifier} from '@j0nathan-ll0yd/observability'

defineLambda({timeout: 30, memorySize: 256})

export const handler = withObservability({operationName: 'LogNotifier'}, createLogSubscriptionNotifier())
