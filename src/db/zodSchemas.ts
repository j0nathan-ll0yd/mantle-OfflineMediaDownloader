/**
 * Drizzle-Zod Schema Generation
 *
 * Generates Zod validation schemas from Drizzle table definitions.
 * Domain code should import from this module for entity validation.
 */
import {createInsertSchema, createSelectSchema, createUpdateSchema} from 'drizzle-zod'
import {accounts, deviceEvents, devices, fileDownloads, files, sessions, userDevices, userFiles, users, verification} from './schema.js'
import {downloadStatusZodSchema, fileStatusZodSchema} from '#types/sharedPrimitives'

// User schemas
export const userInsertSchema = createInsertSchema(users)
export const userSelectSchema = createSelectSchema(users)
export const userUpdateSchema = createUpdateSchema(users)

// File schemas with status enum validation
export const fileInsertSchema = createInsertSchema(files, {status: () => fileStatusZodSchema})
export const fileSelectSchema = createSelectSchema(files)
export const fileUpdateSchema = createUpdateSchema(files, {status: () => fileStatusZodSchema.optional()})

// FileDownload schemas with status enum validation
export const fileDownloadInsertSchema = createInsertSchema(fileDownloads, {status: () => downloadStatusZodSchema})
export const fileDownloadSelectSchema = createSelectSchema(fileDownloads)
export const fileDownloadUpdateSchema = createUpdateSchema(fileDownloads, {status: () => downloadStatusZodSchema.optional()})

// Device schemas
export const deviceInsertSchema = createInsertSchema(devices)
export const deviceSelectSchema = createSelectSchema(devices)
export const deviceUpdateSchema = createUpdateSchema(devices)

// Session schemas (Better Auth)
export const sessionInsertSchema = createInsertSchema(sessions)
export const sessionSelectSchema = createSelectSchema(sessions)
export const sessionUpdateSchema = createUpdateSchema(sessions)

// Account schemas (Better Auth)
export const accountInsertSchema = createInsertSchema(accounts)
export const accountSelectSchema = createSelectSchema(accounts)
export const accountUpdateSchema = createUpdateSchema(accounts)

// Verification schemas (Better Auth)
export const verificationInsertSchema = createInsertSchema(verification)
export const verificationSelectSchema = createSelectSchema(verification)
export const verificationUpdateSchema = createUpdateSchema(verification)

// DeviceEvent schemas
export const deviceEventInsertSchema = createInsertSchema(deviceEvents)
export const deviceEventSelectSchema = createSelectSchema(deviceEvents)

// Relationship schemas (insert only - no updates on junction tables)
export const userFileInsertSchema = createInsertSchema(userFiles)
export const userFileSelectSchema = createSelectSchema(userFiles)

export const userDeviceInsertSchema = createInsertSchema(userDevices)
export const userDeviceSelectSchema = createSelectSchema(userDevices)

// Re-export factory functions for custom schema generation
export { createInsertSchema, createSelectSchema, createUpdateSchema }
