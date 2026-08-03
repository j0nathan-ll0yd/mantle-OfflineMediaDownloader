import type {File} from '#types/domainModels'
import {FileStatus} from '#types/enums'
import {getStaticAsset} from '@j0nathan-ll0yd/core'

/**
 * Cached default file to avoid repeated env var lookups
 */
let _defaultFile: File | undefined

/**
 * Returns the default file shown to new/anonymous users.
 * Uses lazy evaluation to avoid module-level env validation that breaks tests.
 * @returns The default file with properties from environment variables
 */
export function getDefaultFile(): File {
  if (!_defaultFile) {
    const asset = getStaticAsset('videos/default-file.mp4')
    _defaultFile = {
      fileId: 'default',
      size: asset.size,
      authorName: 'Lifegames',
      authorUser: 'sxephil',
      publishDate: new Date().toISOString(),
      description: 'Description',
      key: asset.key,
      url: asset.url,
      contentType: asset.contentType,
      title: 'Welcome! Tap to download.',
      status: FileStatus.Downloaded
    }
  }
  return _defaultFile
}
