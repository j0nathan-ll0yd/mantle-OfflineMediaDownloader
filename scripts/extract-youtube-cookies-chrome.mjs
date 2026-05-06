#!/usr/bin/env node
/* global console, process */
/**
 * Extract YouTube cookies using Chrome browser
 *
 * This script opens Chrome, lets you manually login to YouTube,
 * then saves cookies to the Lambda layer for deployment.
 *
 * Usage: node scripts/extract-youtube-cookies-chrome.mjs
 *
 * Requirements:
 * - Chrome browser installed
 * - pnpm install (for puppeteer-core)
 */

import puppeteer from 'puppeteer-core'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'

// Find Chrome executable based on OS
function findChromeExecutable() {
  const platform = process.platform
  if (platform === 'darwin') {
    // macOS
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  } else if (platform === 'win32') {
    // Windows
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  } else {
    // Linux
    return '/usr/bin/google-chrome'
  }
}

// Convert Puppeteer cookies to Netscape format
function convertToNetscapeFormat(cookies) {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Extracted by extract-youtube-cookies-chrome.mjs',
    ''
  ]
  for (const cookie of cookies) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const secure = cookie.secure ? 'TRUE' : 'FALSE'
    const expiry = cookie.expires > 0 ? Math.floor(cookie.expires) : '0'

    lines.push(`${domain}\t${includeSubdomains}\t${cookie.path}\t${secure}\t${expiry}\t${cookie.name}\t${cookie.value}`)
  }
  return lines.join('\n')
}

// Prompt user for input
function prompt(question) {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout})
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

// Save cookies to Lambda layer file
async function saveCookiesToLayer(netscapeCookies, cookieCount) {
  const cookiePath = path.join(process.cwd(), 'layers/yt-dlp/cookies/youtube-cookies.txt')
  try {
    await fs.promises.writeFile(cookiePath, netscapeCookies, 'utf-8')
    console.log('\n✓ Cookies saved to Lambda layer')
    console.log(`  Path: ${cookiePath}`)
    console.log(`  Cookie count: ${cookieCount}`)
  } catch (error) {
    console.error('\n✗ Failed to save cookies:', error.message)
    throw error
  }
}

async function main() {
  console.log('YouTube Cookie Extractor (Chrome)')
  console.log('==================================\n')

  const chromePath = findChromeExecutable()
  console.log(`Using Chrome at: ${chromePath}\n`)

  console.log('This script will:')
  console.log('  1. Open Chrome browser')
  console.log('  2. Navigate to YouTube')
  console.log('  3. Wait for you to login manually')
  console.log('  4. Extract cookies after login')
  console.log('  5. Save cookies to Lambda layer for deployment\n')

  await prompt('Press Enter to start...')

  let browser
  try {
    console.log('\nLaunching Chrome...')
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: false, // Show the browser so user can login
      defaultViewport: null, // Use default window size
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--start-maximized'
      ]
    })

    const page = await browser.newPage()

    // Set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    console.log('Navigating to YouTube...\n')
    await page.goto('https://www.youtube.com', {waitUntil: 'networkidle2'})

    console.log('============================================')
    console.log('Please login to YouTube in the browser window')
    console.log('============================================\n')
    console.log('Steps:')
    console.log('  1. Click "Sign in" button')
    console.log('  2. Enter your Google email')
    console.log('  3. Enter your password')
    console.log('  4. Complete any 2FA if required')
    console.log('  5. Wait until you see your avatar in the top right\n')

    await prompt('Press Enter when you are logged in and see your avatar...')

    // Navigate around to refresh cookies
    console.log('\nRefreshing session by visiting pages...')

    try {
      await page.goto('https://www.youtube.com/feed/subscriptions', {waitUntil: 'networkidle2', timeout: 30000})
    } catch {
      console.log('  (subscriptions page timed out, continuing)')
    }

    try {
      await page.goto('https://www.youtube.com/feed/history', {waitUntil: 'networkidle2', timeout: 30000})
    } catch {
      console.log('  (history page timed out, continuing)')
    }

    // Extract cookies
    console.log('\nExtracting cookies...')
    const allCookies = await page.cookies()

    // Filter to relevant domains
    const relevantDomains = ['.youtube.com', '.google.com', '.googlevideo.com', 'youtube.com', 'google.com']
    const youtubeCookies = allCookies.filter((c) => relevantDomains.some((d) => c.domain.endsWith(d) || c.domain === d.slice(1) || c.domain === d))

    console.log(`  Total cookies: ${allCookies.length}`)
    console.log(`  YouTube/Google cookies: ${youtubeCookies.length}`)

    // Check for auth cookies
    const authCookieNames = ['SID', 'SSID', 'HSID', 'APISID', 'SAPISID', 'LOGIN_INFO']
    const cookieNames = new Set(youtubeCookies.map((c) => c.name))
    const authCookiesFound = authCookieNames.filter((name) => cookieNames.has(name))

    console.log(`  Auth cookies found: ${authCookiesFound.length} (${authCookiesFound.join(', ')})`)

    if (authCookiesFound.length < 3) {
      console.log('\n⚠ Warning: Not enough auth cookies found. You may not be fully logged in.')
      const cont = await prompt('Continue anyway? (y/n): ')
      if (cont.toLowerCase() !== 'y') {
        console.log('Aborted.')
        return
      }
    }

    // Convert to Netscape format
    const netscapeCookies = convertToNetscapeFormat(youtubeCookies)

    // Save to Lambda layer
    console.log('\nSaving to Lambda layer...')
    await saveCookiesToLayer(netscapeCookies, youtubeCookies.length)

    console.log('\n✓ Done! Cookies extracted and saved successfully.')
    console.log('\nNext steps:')
    console.log('  1. Run: pnpm run deploy')
    console.log('  2. The Lambda will use these cookies for YouTube downloads')
  } catch (error) {
    console.error('\n✗ Error:', error.message)
    process.exit(1)
  } finally {
    if (browser) {
      console.log('\nClosing browser...')
      await browser.close()
    }
  }
}

main()
