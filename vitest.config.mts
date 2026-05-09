import {resolve} from 'path'
import {cpus} from 'os'
import {defineConfig} from 'vitest/config'

// Optimize worker count based on environment
// CI: 4 workers (typical runner has 2 cores, hyperthreading gives 4)
// Local: Use available cores (capped at 8 to avoid memory pressure)
const isCI = process.env.CI === 'true'
const maxWorkers = isCI ? 4 : Math.min(cpus().length, 8)

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'build/**', 'test/integration/**', 'layers/**'],
    clearMocks: true,
    testTimeout: 10000,
    pool: 'threads',
    maxWorkers,
    env: {
      ENVIRONMENT: 'test',
      METRICS_NAMESPACE: 'MediaDownloaderTest'
    },
    coverage: {
      enabled: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/test/**', '**/*.json'],
      provider: 'v8',
      reportsDirectory: './coverage/unit'
    },
    resolve: {
      alias: {
        '#entities': resolve(__dirname, 'src/entities'),
        '#db': resolve(__dirname, 'src/db'),
        '#domain': resolve(__dirname, 'src/domain'),
        '#services': resolve(__dirname, 'src/services'),
        '#integrations': resolve(__dirname, 'src/integrations'),
        '#errors': resolve(__dirname, 'src/errors'),
        '#utils': resolve(__dirname, 'src/utils'),
        '#lib': resolve(__dirname, 'src/lib'),
        '#config': resolve(__dirname, 'src/config'),
        '#types': resolve(__dirname, 'src/types'),
        '#test': resolve(__dirname, 'test'),
        '#lambdas': resolve(__dirname, 'src/lambdas')
      },
      dedupe: [
        '@mantleframework/core',
        '@mantleframework/aws',
        '@mantleframework/database',
        '@mantleframework/errors',
        '@mantleframework/env',
        '@mantleframework/observability',
        '@mantleframework/resilience',
        '@mantleframework/validation',
        '@mantleframework/auth',
        '@mantleframework/security',
        'drizzle-orm',
        'zod'
      ]
    },
    alias: {
      'drizzle-orm': resolve(__dirname, 'node_modules/@mantleframework/database/node_modules/drizzle-orm'),
      'zod': resolve(__dirname, 'node_modules/@mantleframework/validation/node_modules/zod')
    },
    setupFiles: ['./test/setup.ts'],
    silent: process.env.LOG_LEVEL === 'SILENT'
  }
})
