/**
 * Shared primitive types and schemas.
 *
 * Single source of truth for enums used in both Zod schemas and TypeScript code.
 * Derives Zod schemas from TypeScript enums to eliminate duplication.
 */
import {z} from '@j0nathan-ll0yd/validation'
import {DownloadStatus, FileStatus, ResponseStatus} from './enums'

/**
 * Zod schema derived from FileStatus enum.
 * Use for validating file status values in API requests/responses.
 */
export const fileStatusZodSchema = z.nativeEnum(FileStatus)

/**
 * Zod schema derived from DownloadStatus enum.
 * Use for validating download orchestration status values.
 */
export const downloadStatusZodSchema = z.nativeEnum(DownloadStatus)

/**
 * Zod schema derived from ResponseStatus enum.
 * Use for validating async operation response status values.
 */
export const responseStatusZodSchema = z.nativeEnum(ResponseStatus)

// Re-export enums for convenience when importing from shared-primitives
export { DownloadStatus, FileStatus, ResponseStatus }
