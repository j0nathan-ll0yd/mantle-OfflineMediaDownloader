# Push Notification Delivery

## Purpose

Delivers APNs push notifications to all registered iOS devices for a given user when a file
download event occurs. Isolates per-device failures so one unresponsive device does not prevent
delivery to others. Reactively cleans up disabled APNs endpoints (invalid token, app uninstalled)
when APNs rejects a push, removing the stale device registration to prevent future spurious sends.

Source of truth for behavior: `src/lambdas/sqs/SendPushNotification/index.ts`,
`src/lambdas/sqs/SendPushNotification/endpointCleanupHelpers.ts`,
`src/lambdas/sqs/SendPushNotification/pushHelpers.ts`. The SQS message attribute schema
(`pushNotificationAttributesSchema`) is owned by `src/types/schemas.ts` — this spec does NOT
restate it.

## Requirements

### Requirement: per-device-fanout-with-isolation

The system SHALL attempt delivery to all registered devices for the target user in a single
`Promise.allSettled` call, so that a failure on one device does not prevent delivery to other
devices. Per-device results SHALL be classified as succeeded, failed, or disabled-endpoint after the
settled batch completes.

#### Scenario: Multiple devices, one fails

- **GIVEN** a user with three registered devices, where one device has an unreachable APNs endpoint
- **WHEN** the `SendPushNotification` Lambda processes the SQS message
- **THEN** delivery SHALL be attempted to all three devices
- **AND** the two reachable devices SHALL receive the notification
- **AND** the failure for the unreachable device SHALL not abort delivery to the others

#### Scenario: No devices registered

- **GIVEN** a user with no registered device records
- **WHEN** the `SendPushNotification` Lambda processes the SQS message
- **THEN** the Lambda SHALL return without error and without attempting any delivery

### Requirement: disabled-endpoint-cleanup-on-invalid-token

When APNs signals that a device token is invalid (endpoint disabled), the system SHALL deregister
the SNS endpoint and remove the associated device records. Cleanup SHALL follow children-before-
parent ordering: UserDevice junction records first, then the SNS endpoint, then the Device record.
Cleanup is initiated asynchronously after the notification batch completes and SHALL NOT block the
SQS response. This requirement is verified by `test/lambdas/sqs/pushEndpointCleanup.test.ts`.

#### Scenario: Invalid token detected during delivery

- **GIVEN** APNs returns an error indicating a token is invalid for a device
- **WHEN** the notification batch settles
- **THEN** the system SHALL classify that device as a disabled endpoint
- **AND** SHALL initiate cleanup of UserDevice records, SNS endpoint, and Device record in children-first order
- **AND** notification results for non-disabled devices SHALL be reported independently

#### Scenario: Cleanup ordering is preserved

- **GIVEN** a device identified for disabled-endpoint cleanup
- **WHEN** `cleanupDisabledEndpoint` executes
- **THEN** UserDevice junction records SHALL be removed before the SNS endpoint is deregistered
- **AND** the SNS endpoint SHALL be deregistered before the Device record is deleted

### Requirement: all-devices-failed-triggers-sqs-retry

The Lambda SHALL throw an error when every delivery attempt in the batch fails (zero successes, one
or more failures), causing SQS to redeliver the message. Partial success (at least one device
received the notification) SHALL NOT trigger a retry.

#### Scenario: Total delivery failure triggers retry

- **GIVEN** a user with devices where all APNs delivery attempts fail with non-disabled-endpoint errors
- **WHEN** the notification batch settles
- **THEN** the Lambda SHALL throw an error
- **AND** SQS SHALL redeliver the message

#### Scenario: Partial success does not retry

- **GIVEN** a user with two devices where one delivery succeeds and one fails
- **WHEN** the notification batch settles
- **THEN** the Lambda SHALL complete without throwing
- **AND** the message SHALL NOT be redelivered

### Requirement: message-attributes-validated-before-delivery

The system SHALL validate required SQS message attributes (`notificationType`, `userId`) against the
schema before any delivery attempt. A message with missing or invalid attributes SHALL be discarded
with an error log and SHALL NOT trigger a delivery attempt or SQS retry.

#### Scenario: Missing userId attribute

- **GIVEN** an SQS message with a missing `userId` message attribute
- **WHEN** the Lambda processes the message
- **THEN** the Lambda SHALL log an error and return without attempting delivery
- **AND** the message SHALL NOT be redelivered
