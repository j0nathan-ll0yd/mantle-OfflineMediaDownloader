/**
 * Content-aware file writing utility
 *
 * Only updates files when actual content changes, preserving existing timestamps
 * when content is identical. This prevents unnecessary git diffs from generator scripts.
 *
 * Usage:
 *   const result = writeIfChanged(filePath, contentWithPlaceholder, timestampPattern)
 *   // result.written: boolean - whether file was written
 *   // result.reason: 'new' | 'changed' | 'unchanged'
 */
import {existsSync, readFileSync, writeFileSync} from 'fs'

export interface WriteResult {
  written: boolean
  reason: 'new' | 'changed' | 'unchanged'
  path: string
}

/**
 * Strip timestamp lines from content for comparison.
 * Matches common timestamp patterns in generated files.
 */
function stripTimestamps(content: string): string {
  return content // ISO timestamps: 2024-01-19T12:34:56.789Z
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?/g, 'TIMESTAMP') // Comment lines with "Generated at:" or "Generated:"
    .replace(/^.*Generated at:.*$/gm, 'GENERATED_LINE').replace(/^.*Generated:.*$/gm, 'GENERATED_LINE')
}

/**
 * Write file only if content has changed (ignoring timestamp differences).
 *
 * @param filePath - Path to write to
 * @param newContent - New content with current timestamp
 * @returns WriteResult indicating whether file was written
 */
export function writeIfChanged(filePath: string, newContent: string): WriteResult {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, newContent)
    return {written: true, reason: 'new', path: filePath}
  }

  const existingContent = readFileSync(filePath, 'utf-8')
  const existingNormalized = stripTimestamps(existingContent)
  const newNormalized = stripTimestamps(newContent)

  if (existingNormalized === newNormalized) {
    return {written: false, reason: 'unchanged', path: filePath}
  }

  writeFileSync(filePath, newContent)
  return {written: true, reason: 'changed', path: filePath}
}
