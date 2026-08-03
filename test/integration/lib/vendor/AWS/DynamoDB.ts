/**
 * DynamoDB Test Vendor Wrapper
 *
 * Encapsulates AWS SDK DynamoDB operations used in integration tests.
 * This wrapper exists to maintain the AWS SDK Encapsulation Policy even in test code.
 */

import {CreateTableCommand, DeleteTableCommand} from '@aws-sdk/client-dynamodb'
import type {CreateTableCommandInput} from '@aws-sdk/client-dynamodb'
import {createDynamoDBClient} from '@j0nathan-ll0yd/aws'

const dynamoDBClient = createDynamoDBClient()

/**
 * Destroys the DynamoDB client to release HTTP connections.
 * Call this during global teardown.
 */
export function destroyClient(): void {
  dynamoDBClient.destroy()
}

/**
 * Creates a DynamoDB table
 * @param input - Table configuration matching AWS SDK CreateTableCommandInput
 */
export async function createTable(input: CreateTableCommandInput): Promise<void> {
  await dynamoDBClient.send(new CreateTableCommand(input))
}

/**
 * Deletes a DynamoDB table
 * @param tableName - Name of the table to delete
 */
export async function deleteTable(tableName: string): Promise<void> {
  await dynamoDBClient.send(new DeleteTableCommand({TableName: tableName}))
}
