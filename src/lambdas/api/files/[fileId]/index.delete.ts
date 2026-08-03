/**
 * FileDelete Lambda
 *
 * Deletes a user's link to a file. If no other users are linked,
 * also removes the file from S3 and cleans up database records.
 *
 * Trigger: API Gateway DELETE /files/\{fileId\}
 * Input: Authenticated user context (userId from authorizer), fileId from path
 * Output: APIGatewayProxyResult confirming deletion
 */
import {buildValidatedResponse, defineLambda, S3BucketName} from '@j0nathan-ll0yd/core'
import {deleteObject} from '@j0nathan-ll0yd/aws'
import {NotFoundError} from '@j0nathan-ll0yd/errors'
import {logError, logInfo} from '@j0nathan-ll0yd/observability'
import {defineApiHandler, z} from '@j0nathan-ll0yd/validation'
import {getRequiredEnv} from '@j0nathan-ll0yd/env'
import {deleteFileCascade} from '#entities/queries'

defineLambda({})

const FileDeletePathSchema = z.object({fileId: z.string()})
const DeleteFileResponseSchema = z.object({deleted: z.boolean(), fileRemoved: z.boolean()})

const api = defineApiHandler({auth: 'authorizer', pathSchema: FileDeletePathSchema, operationName: 'FileDelete'})

export const handler = api(async ({context, userId, path}) => {
  const {fileId} = path

  logInfo('Deleting file for user', {userId, fileId})

  // Transactional cascade: unlink user, conditionally delete file records
  const result = await deleteFileCascade(userId, fileId)

  if (!result.existed) {
    throw new NotFoundError('File not found for this user')
  }

  // If file was orphaned, clean up S3 (outside transaction — idempotent)
  if (result.fileRemoved) {
    const bucket = S3BucketName(getRequiredEnv('BUCKET'))
    const key = `${fileId}.mp4`
    try {
      await deleteObject({Bucket: bucket, Key: key})
      logInfo('Deleted orphaned S3 object', {fileId, key})
    } catch (error) {
      // S3 deletion failure is acceptable — orphaned object, storage cost only
      const message = error instanceof Error ? error.message : String(error)
      logError('Failed to delete S3 object (orphaned)', {fileId, key, error: message})
    }
  }

  logInfo('File deletion completed', {userId, fileId, fileRemoved: result.fileRemoved})

  return buildValidatedResponse(context, 200, {deleted: true, fileRemoved: result.fileRemoved}, DeleteFileResponseSchema)
})
