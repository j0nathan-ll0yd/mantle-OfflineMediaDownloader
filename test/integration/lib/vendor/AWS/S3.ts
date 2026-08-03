/**
 * S3 Test Vendor Wrapper
 *
 * Encapsulates AWS SDK S3 operations used in integration tests.
 * This wrapper exists to maintain the AWS SDK Encapsulation Policy even in test code.
 */

import {CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command} from '@aws-sdk/client-s3'
import type {GetObjectCommandOutput, HeadObjectCommandOutput} from '@aws-sdk/client-s3'
import {createS3Client} from '@j0nathan-ll0yd/aws'

const s3Client = createS3Client()

/**
 * Destroys the S3 client to release HTTP connections.
 * Call this during global teardown.
 */
export function destroyClient(): void {
  s3Client.destroy()
}

/**
 * Creates an S3 bucket
 * @param bucketName - Name of the bucket to create
 */
export async function createBucket(bucketName: string): Promise<void> {
  await s3Client.send(new CreateBucketCommand({Bucket: bucketName}))
}

/**
 * Deletes an S3 bucket
 * @param bucketName - Name of the bucket to delete
 */
export async function deleteBucket(bucketName: string): Promise<void> {
  await s3Client.send(new DeleteBucketCommand({Bucket: bucketName}))
}

/**
 * Lists all objects in a bucket
 * @param bucketName - Name of the bucket
 */
export async function listObjectsV2(bucketName: string): Promise<{Contents?: Array<{Key?: string}>}> {
  return s3Client.send(new ListObjectsV2Command({Bucket: bucketName}))
}

/**
 * Deletes an object from S3
 * @param bucketName - Name of the bucket
 * @param key - Object key
 */
export async function deleteObject(bucketName: string, key: string): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({Bucket: bucketName, Key: key}))
}

/**
 * Gets object metadata (HEAD request)
 * @param bucketName - Name of the bucket
 * @param key - Object key
 */
export async function headObject(bucketName: string, key: string): Promise<HeadObjectCommandOutput> {
  return s3Client.send(new HeadObjectCommand({Bucket: bucketName, Key: key}))
}

/**
 * Gets object content
 * @param bucketName - Name of the bucket
 * @param key - Object key
 */
export async function getObject(bucketName: string, key: string): Promise<GetObjectCommandOutput> {
  return s3Client.send(new GetObjectCommand({Bucket: bucketName, Key: key}))
}
