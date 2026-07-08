import {defineLambda, withObservability} from '@mantleframework/core'
import {createLogSubscriptionNotifier} from '@mantleframework/observability'

defineLambda({timeout: 30, memorySize: 256})

export const handler = withObservability({operationName: 'LogNotifier'}, createLogSubscriptionNotifier())
