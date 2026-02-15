/**
 * Fresh login — clears cookies/cache then logs in to GC
 * This forces a new session with Premium active
 * Usage: GC_PASSWORD='Tournaments1234!' node fresh-login-test.mjs
 */

import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
dotenv.config();

const GC_EMAIL = process.env.GC_EMAIL || 'steve.hassett@usssa.org';
const GC_PASSWORD = process.env.GC_PASSWORD;
const TEST_URL = 'https://web.gc.com/teams/D4CK5E1BGDsq/schedule/b60bffc5-0679-41fd-942f-49e782f9ad85/box-score';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('🧹 Launching Chrome with CLEAN profile (no cache)...');
  
  // Launch with a fresh user data dir — no cached sessions
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--window-size=1920,1080',
      '--incognito'
    ]
  });

  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // Clear everything just in case
  const client = await page.createCDPSession();
  await client.send('Network.clearBrowserCookies');
  await client.send('Network.clearBrowserCache');
  console.log('🧹 Cookies and cache cleared!');

  // Fresh login
  console.log('🔑 Logging in fresh as ' + GC_EMAIL + '...');
  await page.goto('https://web.gc.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);

  const emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
  if (emailInput) await emailInput.type(GC_EMAIL, { delay: 50 });

  const passwordInput = await page.$('input[type="password"]');
  if (passwordInput) await passwordInput.type(GC_PASSWORD, { delay: 50 });

  const submitBtn = await page.$('button[type="submit"]');
  if (submitBtn) await submitBtn.click();

  await sleep(5000);
  console.log('✅ Logged in!');

  // Navigate to box score
  console.log('📊 Loading box score...');
  await page.goto(TEST_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(5000);

  // Check what we see
  const data = await page.evaluate(() => {
    const tables = [...document.querySelectorAll('[data-testid="data-table"]')].map(t => t.innerText.substring(0, 300));
    const blurred = document.querySelectorAll('[class*="blurred"], [class*="Blurred"], [class*="blur"]');
    const paywall = document.querySelector('[class*="paywallContainer"], [data-testid="paywall"]');
    return {
      tableCount: tables.length,
      firstTable: tables[0] || 'NO TABLES',
      blurredElements: blurred.length,
      hasPaywall: !!paywall,
      paywallText: paywall?.innerText?.substring(0, 100) || 'none'
    };
  });

  console.log('\n=========================================');
  console.log('    RESULTS');
  console.log('=========================================');
  console.log('Tables found:', data.tableCount);
  console.log('Blurred elements:', data.blurredElements);
  console.log('Has paywall:', data.hasPaywall);
  console.log('Paywall text:', data.paywallText);
  console.log('\nFirst table preview:');
  console.log(data.firstTable);
  console.log('\n👀 CHECK THE BROWSER — are stats unblurred?');
  console.log('   If YES: premium is working, we just need to use incognito mode');
  console.log('   If NO: something else is going on');
  
  console.log('\nBrowser stays open for 60 seconds so you can look...');
  await sleep(60000);
  await browser.close();
  console.log('Done!');
}

main().catch(console.error);
