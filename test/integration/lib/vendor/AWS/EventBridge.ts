/**
 * EventBridge Test Vendor Wrapper
 *
 * Encapsulates AWS SDK EventBridge operations used in integration tests.
 * This wrapper exists to maintain the AWS SDK Encapsulation Policy even in test code.
 */
import {
  CreateEventBusCommand,
  DeleteEventBusCommand,
  DeleteRuleCommand,
  ListEventBusesCommand,
  ListRulesCommand,
  ListTargetsByRuleCommand,
  PutEventsCommand,
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand
} from '@aws-sdk/client-eventbridge'
import type {PutEventsCommandOutput, PutEventsRequestEntry} from '@aws-sdk/client-eventbridge'
import {createEventBridgeClient} from '@j0nathan-ll0yd/aws'

const eventBridgeClient = createEventBridgeClient()

/**
 * Destroys the EventBridge client to release HTTP connections.
 * Call this during global teardown.
 */
export function destroyClient(): void {
  eventBridgeClient.destroy()
}

/**
 * Creates an EventBridge event bus
 * @param busName - Name of the event bus to create
 */
export async function createEventBus(busName: string): Promise<string> {
  const result = await eventBridgeClient.send(new CreateEventBusCommand({Name: busName}))
  return result.EventBusArn!
}

/**
 * Deletes an EventBridge event bus and all its rules
 * @param busName - Name of the event bus to delete
 */
export async function deleteEventBus(busName: string): Promise<void> {
  // First, delete all rules on the bus
  const rulesResponse = await eventBridgeClient.send(new ListRulesCommand({EventBusName: busName}))
  if (rulesResponse.Rules) {
    for (const rule of rulesResponse.Rules) {
      // Remove all targets first
      const targetsResponse = await eventBridgeClient.send(new ListTargetsByRuleCommand({Rule: rule.Name!, EventBusName: busName}))
      if (targetsResponse.Targets && targetsResponse.Targets.length > 0) {
        await eventBridgeClient.send(new RemoveTargetsCommand({Rule: rule.Name!, EventBusName: busName, Ids: targetsResponse.Targets.map((t) => t.Id!)}))
      }
      await eventBridgeClient.send(new DeleteRuleCommand({Name: rule.Name!, EventBusName: busName}))
    }
  }
  await eventBridgeClient.send(new DeleteEventBusCommand({Name: busName}))
}

/**
 * Creates a rule on an event bus
 * @param busName - Name of the event bus
 * @param ruleName - Name of the rule
 * @param eventPattern - Event pattern to match
 */
export async function createRule(busName: string, ruleName: string, eventPattern: object): Promise<string> {
  const result = await eventBridgeClient.send(
    new PutRuleCommand({Name: ruleName, EventBusName: busName, EventPattern: JSON.stringify(eventPattern), State: 'ENABLED'})
  )
  return result.RuleArn!
}

/**
 * Adds an SQS target to a rule
 * @param busName - Name of the event bus
 * @param ruleName - Name of the rule
 * @param targetId - Target identifier
 * @param queueArn - SQS queue ARN
 */
export async function addSqsTarget(busName: string, ruleName: string, targetId: string, queueArn: string): Promise<void> {
  await eventBridgeClient.send(new PutTargetsCommand({Rule: ruleName, EventBusName: busName, Targets: [{Id: targetId, Arn: queueArn}]}))
}

/**
 * Publishes events to an event bus
 * @param entries - Event entries to publish
 */
export async function putEvents(entries: PutEventsRequestEntry[]): Promise<PutEventsCommandOutput> {
  return eventBridgeClient.send(new PutEventsCommand({Entries: entries}))
}

/**
 * Lists all rules on an event bus
 * @param busName - Name of the event bus
 */
export async function listRules(busName: string): Promise<string[]> {
  const result = await eventBridgeClient.send(new ListRulesCommand({EventBusName: busName}))
  return (result.Rules || []).map((rule) => rule.Name!).filter(Boolean)
}

/**
 * Lists all event buses (used for health checks)
 * @returns Array of event bus names
 */
export async function listEventBuses(): Promise<string[]> {
  const result = await eventBridgeClient.send(new ListEventBusesCommand({}))
  return (result.EventBuses || []).map((bus) => bus.Name!).filter(Boolean)
}
