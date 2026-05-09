import {DatabaseOperation} from '@mantleframework/database'
import {lt} from '@mantleframework/database/orm'
import type {InferInsertModel, InferSelectModel} from '@mantleframework/database/orm'
import {defineQuery} from '#db/defineQuery'
import {deviceEvents} from '#db/schema'

export type DeviceEventRow = InferSelectModel<typeof deviceEvents>

export type CreateDeviceEventInput = Omit<InferInsertModel<typeof deviceEvents>, 'id' | 'receivedAt'>

export const createDeviceEvents = defineQuery({tables: [{table: deviceEvents, operations: [DatabaseOperation.Select, DatabaseOperation.Insert]}]},
  async function createDeviceEvents(db, events: CreateDeviceEventInput[]): Promise<DeviceEventRow[]> {
    if (events.length === 0) {
      return []
    }
    return await db.insert(deviceEvents).values(events).onConflictDoNothing({target: [deviceEvents.deviceId, deviceEvents.correlationId]}).returning()
  })

export const deleteExpiredDeviceEvents = defineQuery({tables: [{table: deviceEvents, operations: [DatabaseOperation.Select, DatabaseOperation.Delete]}]},
  async function deleteExpiredDeviceEvents(db, cutoffTime: Date): Promise<number> {
    const result = await db.delete(deviceEvents).where(lt(deviceEvents.receivedAt, cutoffTime)).returning({id: deviceEvents.id})
    return result.length
  })
