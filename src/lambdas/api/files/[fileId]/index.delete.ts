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
import {buildValidatedResponse, defineLambda, S3BucketName} from '@mantleframework/core'
import {deleteObject} from '@mantleframework/aws'
import {NotFoundError, UnauthorizedError} from '@mantleframework/errors'
import {logError, logInfo} from '@mantleframework/observability'
import {defineApiHandler, z} from '@mantleframework/validation'
import {getRequiredEnv} from '@mantleframework/env'
import {deleteFileCascade} from '#entities/queries'

defineLambda({})

const DeleteFileResponseSchema = z.object({deleted: z.boolean(), fileRemoved: z.boolean()})

const api = defineApiHandler({auth: 'authorizer', operationName: 'FileDelete'})

export const handler = api(async ({event, context, userId}) => {
  if (!userId) {
    throw new UnauthorizedError('Authentication required')
  }

  const fileId = event.pathParameters?.fileId
  if (!fileId) {
    throw new NotFoundError('Missing fileId path parameter')
  }

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
