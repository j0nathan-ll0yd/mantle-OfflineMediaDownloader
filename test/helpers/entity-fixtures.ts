/**
 * Entity Fixture Factories
 *
 * Factory functions for creating mock entity rows in tests.
 * Each factory provides sensible defaults that can be overridden.
 *
 * @see {@link https://github.com/j0nathan-ll0yd/mantle-OfflineMediaDownloader/wiki/Vitest-Mocking-Strategy#entity-fixtures | Usage Examples}
 * @see src/lib/vendor/Drizzle/schema.ts for table definitions
 */

/**
 * Row types matching Drizzle schema
 * These are the shapes returned by `db.select().from(table)`
 */

export interface FileRow {
  fileId: string
  size: number
  authorName: string
  authorUser: string
  publishDate: string
  description: string
  key: string
  url: string | null
  contentType: string
  title: string
  status: string
  // Rich metadata fields (Issue #151)
  duration: number | null
  uploadDate: string | null
  viewCount: number | null
  thumbnailUrl: string | null
}

export interface DeviceRow {
  deviceId: string
  name: string
  token: string
  systemVersion: string
  systemName: string
  endpointArn: string
  lastSeenAt: Date | null
}

export interface UserRow {
  id: string
  email: string
  emailVerified: boolean
  name: string | null
  image: string | null
  firstName: string | null
  lastName: string | null
  createdAt: Date
  updatedAt: Date
}

export interface UserFileRow {
  userId: string
  fileId: string
  createdAt: Date
}

export interface UserDeviceRow {
  userId: string
  deviceId: string
  createdAt: Date
}

export interface SessionRow {
  id: string
  userId: string
  token: string
  expiresAt: Date
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
  updatedAt: Date
}

export interface FileDownloadRow {
  fileId: string
  status: string
  retryCount: number
  maxRetries: number
  retryAfter: Date | null
  errorCategory: string | null
  lastError: string | null
  scheduledReleaseTime: Date | null
  sourceUrl: string | null
  correlationId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface AccountRow {
  id: string
  userId: string
  accountId: string
  providerId: string
  accessToken: string | null
  refreshToken: string | null
  accessTokenExpiresAt: Date | null
  refreshTokenExpiresAt: Date | null
  scope: string | null
  idToken: string | null
  password: string | null
  createdAt: Date
  updatedAt: Date
}

export interface VerificationRow {
  id: string
  identifier: string
  value: string
  expiresAt: Date
  createdAt: Date | null
  updatedAt: Date | null
}

/**
 * Default UUIDs for consistent test data
 */
export const DEFAULT_USER_ID = 'abcdefgh-ijkl-mnop-qrst-uvwxyz123456'
export const DEFAULT_FILE_ID = 'dQw4w9WgXcQ'
export const DEFAULT_DEVICE_ID = '67C431DE-37D2-4BBA-9055-E9D2766517E1'
export const DEFAULT_SESSION_ID = 'session-1234-5678-9abc-def012345678'

/**
 * Create a mock file row with sensible defaults.
 * Defaults to a "Downloaded" YouTube video with typical metadata.
 */
export function createMockFile(overrides: Partial<FileRow> = {}): FileRow {
  const fileId = overrides.fileId ?? DEFAULT_FILE_ID
  return {
    fileId,
    size: 61548900,
    authorName: 'Philip DeFranco',
    authorUser: 'sxephil',
    publishDate: '2021-01-22T00:00:00.000Z',
    description: 'Test video description for unit tests',
    key: `${fileId}.mp4`,
    url: `https://example.cloudfront.net/${fileId}.mp4`,
    contentType: 'video/mp4',
    title: 'Test Video Title',
    status: 'Downloaded',
    // Rich metadata fields (Issue #151)
    duration: 612,
    uploadDate: '20210122',
    viewCount: 1250000,
    thumbnailUrl: `https://i.ytimg.com/vi/${fileId}/maxresdefault.jpg`,
    ...overrides
  }
}

/**
 * Create a mock device row with sensible defaults.
 * Defaults to an iPhone with valid APNS token and endpoint ARN.
 */
export function createMockDevice(overrides: Partial<DeviceRow> = {}): DeviceRow {
  const deviceId = overrides.deviceId ?? DEFAULT_DEVICE_ID
  return {
    deviceId,
    name: "Test User's iPhone",
    token: '6a077fd0efd36259b475f9d39997047eebbe45e1d197eed7d64f39d6643c7c23',
    systemVersion: '17.2.1',
    systemName: 'iOS',
    endpointArn: `arn:aws:sns:us-west-2:123456789012:endpoint/APNS_SANDBOX/MediaDownloader/${deviceId}`,
    lastSeenAt: null,
    ...overrides
  }
}

/**
 * Create a mock user row with sensible defaults.
 * Defaults to a verified user with Sign In With Apple fields populated.
 */
export function createMockUser(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date()
  return {
    id: DEFAULT_USER_ID,
    email: 'test@example.com',
    emailVerified: true,
    name: 'Test User',
    image: null,
    firstName: 'Test',
    lastName: 'User',
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

/**
 * Create a mock user-file relationship row.
 * Links a user to a file they have access to.
 */
export function createMockUserFile(overrides: Partial<UserFileRow> = {}): UserFileRow {
  return {userId: DEFAULT_USER_ID, fileId: DEFAULT_FILE_ID, createdAt: new Date(), ...overrides}
}

/**
 * Create a mock user-device relationship row.
 * Links a user to a device they have registered.
 */
export function createMockUserDevice(overrides: Partial<UserDeviceRow> = {}): UserDeviceRow {
  return {userId: DEFAULT_USER_ID, deviceId: DEFAULT_DEVICE_ID, createdAt: new Date(), ...overrides}
}

/**
 * Create a mock session row with sensible defaults.
 * Defaults to a valid session expiring in 24 hours.
 */
export function createMockSession(overrides: Partial<SessionRow> = {}): SessionRow {
  const now = new Date()
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  return {
    id: DEFAULT_SESSION_ID,
    userId: DEFAULT_USER_ID,
    token: 'test-session-token-abcdef123456',
    expiresAt: tomorrow,
    ipAddress: '127.0.0.1',
    userAgent: 'MediaDownloader/1.0 iOS/17.2.1',
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

/**
 * Create a mock file download row.
 * Defaults to a pending download with no errors.
 */
export function createMockFileDownload(overrides: Partial<FileDownloadRow> = {}): FileDownloadRow {
  const now = new Date()
  return {
    fileId: DEFAULT_FILE_ID,
    status: 'Pending',
    retryCount: 0,
    maxRetries: 5,
    retryAfter: null,
    errorCategory: null,
    lastError: null,
    scheduledReleaseTime: null,
    sourceUrl: 'https://www.youtube.com/watch?v=' + DEFAULT_FILE_ID,
    correlationId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

/**
 * Create a mock account row.
 * Defaults to a Sign In With Apple OAuth account with valid tokens.
 */
export function createMockAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  const now = new Date()
  return {
    id: 'account-1234-5678-9abc-def012345678',
    userId: DEFAULT_USER_ID,
    accountId: '001234.abcdef1234567890.1234',
    providerId: 'apple',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    accessTokenExpiresAt: new Date(now.getTime() + 3600000),
    refreshTokenExpiresAt: null,
    scope: null,
    idToken: 'test-id-token',
    password: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

/**
 * Create a mock verification row.
 * Defaults to a verification token expiring in 24 hours.
 */
export function createMockVerification(overrides: Partial<VerificationRow> = {}): VerificationRow {
  const now = new Date()
  return {
    id: 'verification-1234-5678-9abc-def012345678',
    identifier: 'test@example.com',
    value: 'verification-token-abc123',
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

/**
 * Create multiple mock files with sequential IDs.
 * Useful for testing list operations.
 */
export function createMockFiles(count: number, overrides: Partial<FileRow> = {}): FileRow[] {
  return Array.from({length: count}, (_, i) => createMockFile({fileId: `file-${i + 1}`, title: `Test Video ${i + 1}`, ...overrides}))
}

/**
 * Create multiple mock devices with sequential IDs.
 * Useful for testing multi-device scenarios.
 */
export function createMockDevices(count: number, overrides: Partial<DeviceRow> = {}): DeviceRow[] {
  return Array.from({length: count}, (_, i) => createMockDevice({deviceId: `device-${i + 1}`, name: `Test Device ${i + 1}`, ...overrides}))
}
