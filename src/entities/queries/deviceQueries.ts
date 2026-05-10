/**
 * Device Queries - Drizzle ORM queries for device operations.
 * All queries are instrumented with withQueryMetrics for CloudWatch metrics and X-Ray tracing.
 *
 * @see src/lib/vendor/Drizzle/schema.ts for table definitions
 * @see src/lib/vendor/Drizzle/instrumentation.ts for query metrics
 */
import {DatabaseOperation} from '@mantleframework/database'
import {eq, inArray} from '@mantleframework/database/orm'
import type {InferInsertModel, InferSelectModel} from '@mantleframework/database/orm'
import {defineQuery} from '#db/defineQuery'
import {devices} from '#db/schema'
import {deviceInsertSchema, deviceUpdateSchema} from '#db/zodSchemas'

export type DeviceRow = InferSelectModel<typeof devices>

export type CreateDeviceInput = InferInsertModel<typeof devices>
export type UpdateDeviceInput = Partial<Omit<InferInsertModel<typeof devices>, 'deviceId'>>

/**
 * Gets a device by ID.
 * @param deviceId - The device's unique identifier
 * @returns The device row or null if not found
 */
export const getDevice = defineQuery({tables: [{table: devices, operations: [DatabaseOperation.Select]}]},
  async function getDevice(db, deviceId: string): Promise<DeviceRow | null> {
    const result = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1)
    return result[0] ?? null
  })

/**
 * Gets multiple devices by IDs (batch operation).
 * @param deviceIds - Array of device IDs to retrieve
 * @returns Array of device rows
 */
export const getDevicesBatch = defineQuery({tables: [{table: devices, operations: [DatabaseOperation.Select]}]},
  async function getDevicesBatch(db, deviceIds: string[]): Promise<DeviceRow[]> {
    if (deviceIds.length === 0) {
      return []
    }
    return await db.select().from(devices).where(inArray(devices.deviceId, deviceIds))
  })

/**
 * Creates a new device.
 * @param input - The device data to create
 * @returns The created device row
 */
export const createDevice = defineQuery({tables: [{table: devices, operations: [DatabaseOperation.Select, DatabaseOperation.Insert]}]},
  async function createDevice(db, input: CreateDeviceInput): Promise<DeviceRow> {
    // Validate device input against schema
    const validatedInput = deviceInsertSchema.parse(input)
    const [device] = await db.insert(devices).values(validatedInput).returning()
    return device!
  })

/**
 * Upserts a device (create if not exists, update if exists).
 * Uses atomic ON CONFLICT DO UPDATE to avoid race conditions.
 * @param input - The device data to upsert
 * @returns The created or updated device row
 */
export const upsertDevice = defineQuery({
  tables: [{table: devices, operations: [DatabaseOperation.Select, DatabaseOperation.Insert, DatabaseOperation.Update]}]
}, async function upsertDevice(db, input: CreateDeviceInput): Promise<DeviceRow> {
  // Validate device input against schema
  const validatedInput = deviceInsertSchema.parse(input)
  const [result] = await db.insert(devices).values(validatedInput).onConflictDoUpdate({
    target: devices.deviceId,
    set: {name: input.name, token: input.token, systemVersion: input.systemVersion, systemName: input.systemName, endpointArn: input.endpointArn}
  }).returning()
  return result!
})

/**
 * Updates a device by ID.
 * @param deviceId - The device's unique identifier
 * @param data - The fields to update
 * @returns The updated device row
 */
export const updateDevice = defineQuery({tables: [{table: devices, operations: [DatabaseOperation.Select, DatabaseOperation.Update]}]},
  async function updateDevice(db, deviceId: string, data: UpdateDeviceInput): Promise<DeviceRow> {
    // Validate partial update data against schema
    const validatedData = deviceUpdateSchema.partial().parse(data)
    const [updated] = await db.update(devices).set(validatedData).where(eq(devices.deviceId, deviceId)).returning()
    return updated!
  })

/**
 * Deletes a device by ID.
 * @param deviceId - The device's unique identifier
 */
export const deleteDevice = defineQuery({tables: [{table: devices, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteDevice(db, deviceId: string): Promise<void> {
    await db.delete(devices).where(eq(devices.deviceId, deviceId))
  })

/**
 * Gets a device by SNS endpoint ARN.
 * @param endpointArn - The SNS platform endpoint ARN
 * @returns The device row or null if not found
 */
export const getDeviceByEndpointArn = defineQuery({tables: [{table: devices, operations: [DatabaseOperation.Select]}]},
  async function getDeviceByEndpointArn(db, endpointArn: string): Promise<DeviceRow | null> {
    const result = await db.select().from(devices).where(eq(devices.endpointArn, endpointArn)).limit(1)
    return result[0] ?? null
  })

/**
 * Gets all devices (for scheduled jobs like PruneDevices).
 * @returns Array of all device rows
 */
export const getAllDevices = defineQuery({tables: [{table: devices, operations: [DatabaseOperation.Select]}]},
  async function getAllDevices(db): Promise<DeviceRow[]> {
    return await db.select().from(devices)
  })
