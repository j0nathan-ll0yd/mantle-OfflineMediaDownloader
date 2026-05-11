/**
 * ListFiles Lambda
 *
 * Returns the list of available files for a user.
 * Supports both authenticated users and anonymous demo mode.
 *
 * Trigger: API Gateway GET /files
 * Input: Authenticated or anonymous request
 * Output: APIGatewayProxyResult with file list
 *
 * @see {@link file://../../../services/file/fileInitService.ts} for file transformation
 */
import {buildValidatedResponse, defineLambda, UserStatus} from '@mantleframework/core'

defineLambda({staticAssets: ['videos/default-file.mp4'], bind: {SNS_QUEUE_URL: 'SendPushNotification'}})
import {metrics, MetricUnit} from '@mantleframework/observability'
import {defineApiHandler, z} from '@mantleframework/validation'
import {getDefaultFile} from '#config/constants'
import {fileListResponseSchema} from '#types/api-schema'
import {FileStatus} from '#types/enums'
import {getFilesByUser} from '#services/file/fileInitService'

const ListFilesQuerySchema = z.object({status: z.string().optional().default('downloaded')})

const api = defineApiHandler({auth: 'authorizer-optional', querySchema: ListFilesQuerySchema, operationName: 'ListFiles'})
export const handler = api(async ({context, userId, userStatus, query}) => {
  if (userStatus === UserStatus.Anonymous) {
    const myResponse = {contents: [getDefaultFile()], keyCount: 1}
    return buildValidatedResponse(context, 200, myResponse, fileListResponseSchema)
  }

  const statusParam = query.status ?? 'downloaded'
  const showAllStatuses = statusParam === 'all'

  const files = await getFilesByUser(userId as string)
  const filteredFiles = showAllStatuses ? files : files.filter((file) => file.status === FileStatus.Downloaded)

  const myResponse = {
    contents: filteredFiles.sort((a, b) => new Date(b.publishDate).getTime() - new Date(a.publishDate).getTime()),
    keyCount: filteredFiles.length
  }

  metrics.addMetric('FilesReturned', MetricUnit.Count, myResponse.keyCount)

  return buildValidatedResponse(context, 200, myResponse, fileListResponseSchema)
})
