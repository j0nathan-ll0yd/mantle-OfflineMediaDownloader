import {resolve} from 'path'
import {cpus} from 'os'
import {defineConfig} from 'vitest/config'
import swc from 'unplugin-swc'
import {TIMEOUTS} from '@j0nathan-ll0yd/testing/integration'

const isCI = process.env.CI === 'true'
const maxWorkers = isCI ? 4 : Math.min(cpus().length, 6)

export default defineConfig({
  plugins: [swc.vite({jsc: {target: 'es2024', parser: {syntax: 'typescript', decorators: true}, transform: {decoratorVersion: '2023-11'}}})],
  resolve: {
    alias: {
      '#config': resolve(__dirname, 'src/config'),
      '#entities': resolve(__dirname, 'src/entities'),
      '#lambdas': resolve(__dirname, 'src/lambdas'),
      '#lib': resolve(__dirname, 'src/lib'),
      '#types': resolve(__dirname, 'src/types'),
      '#db': resolve(__dirname, 'src/db'),
      '#domain': resolve(__dirname, 'src/domain'),
      '#services': resolve(__dirname, 'src/services'),
      '#integrations': resolve(__dirname, 'src/integrations'),
      '#errors': resolve(__dirname, 'src/errors'),
      '#utils': resolve(__dirname, 'src/utils'),
      '#test': resolve(__dirname, 'test')
    },
    dedupe: [
      '@j0nathan-ll0yd/core',
      '@j0nathan-ll0yd/aws',
      '@j0nathan-ll0yd/database',
      '@j0nathan-ll0yd/errors',
      '@j0nathan-ll0yd/env',
      '@j0nathan-ll0yd/observability',
      '@j0nathan-ll0yd/resilience',
      '@j0nathan-ll0yd/validation',
      '@j0nathan-ll0yd/auth',
      '@j0nathan-ll0yd/security',
      'drizzle-orm',
      'zod'
    ]
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['test/integration/**/*.integration.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'build/**'],
    clearMocks: true,
    testTimeout: 30000,
    hookTimeout: isCI ? TIMEOUTS.hookTimeout : 60_000,
    pool: 'forks',
    maxWorkers,
    globalSetup: './test/integration/globalSetup.ts',
    setupFiles: ['./test/integration/setup.ts'],
    retry: isCI ? 2 : 0,
    reporters: isCI
      ? ['default', ['junit', {outputFile: 'test-results/integration-results.xml', suiteName: 'Integration Tests'}]]
      : ['default'],
    onConsoleLog: () => false,
    coverage: {
      enabled: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/test/**', '**/*.json'],
      provider: 'custom',
      customProviderModule: 'vitest-monocart-coverage',
      reportsDirectory: './coverage/integration'
    },
    env: {
      METRICS_NAMESPACE: 'MediaDownloaderTest',
      ENVIRONMENT: 'test',
      EVENT_BUS_NAME: 'MediaDownloader',
      EVENT_SOURCE: 'media-downloader',
      LOG_LEVEL: 'SILENT',
      POWERTOOLS_METRICS_DISABLED: 'true',
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5432/media_downloader_test',
      DSQL_ENDPOINT: process.env.DSQL_ENDPOINT ?? 'localhost',
      DSQL_REGION: 'us-west-2',
      DSQL_ROLE_NAME: 'test',
      AUTH_SECRET: 'test-secret-key-for-integration-tests-minimum-32-chars',
      AUTH_BASE_URL: 'http://localhost:3000',
      APPLE_CLIENT_ID: 'test.apple.client.id',
      APPLE_CLIENT_SECRET: 'test-apple-client-secret',
      APPLE_APP_BUNDLE_IDENTIFIER: 'lifegames.OfflineMediaDownloader',
      SNS_QUEUE_URL: `${process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566'}/000000000000/SendPushNotification`,
      PUSH_NOTIFICATION_TOPIC_ARN: 'arn:aws:sns:us-west-2:000000000000:push-notifications',
      PLATFORM_APPLICATION_ARN: 'arn:aws:sns:us-west-2:000000000000:app/APNS_SANDBOX/media-downloader',
      CLOUDFRONT_DOMAIN: 'test.cloudfront.net',
      MULTI_AUTHENTICATION_PATH_PARTS: 'login,register,webhook',
      GITHUB_PERSONAL_TOKEN: 'test-github-token',
      APNS_TEAM: 'TEST_TEAM',
      APNS_KEY_ID: 'TEST_KEY',
      APNS_SIGNING_KEY: 'test-signing-key',
      APNS_DEFAULT_TOPIC: 'lifegames.OfflineMediaDownloader',
      ASSET_VIDEOS_DEFAULT_FILE_KEY: 'videos/default-file.mp4',
      ASSET_VIDEOS_DEFAULT_FILE_URL: 'https://test.cloudfront.net/videos/default-file.mp4',
      ASSET_VIDEOS_DEFAULT_FILE_SIZE: '436743',
      ASSET_VIDEOS_DEFAULT_FILE_CONTENT_TYPE: 'video/mp4',
      BUCKET: 'test-media-bucket',
      RESOURCE_PREFIX: 'test',
      AWS_REGION: 'us-west-2',
      AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      USE_LOCALSTACK: 'true'
    },
    silent: process.env.LOG_LEVEL === 'SILENT'
  }
})
