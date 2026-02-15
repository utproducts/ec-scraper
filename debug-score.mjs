/**
 * Debug script — shows what's in the page header so we can find the real score
 * Usage: GC_PASSWORD='Tournaments1234!' node debug-score.mjs
 */

import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
dotenv.config();

const GC_EMAIL = process.env.GC_EMAIL || 'steve.hassett@usssa.org';
const GC_PASSWORD = process.env.GC_PASSWORD;
const TEST_URL = 'https://web.gc.com/teams/D4CK5E1BGDsq/schedule/b60bffc5-0679-41fd-942f-49e782f9ad85/box-score';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox', '--window-size=1920,1080'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // Login
  console.log('Logging in...');
  await page.goto('https://web.gc.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);
  const emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
  if (emailInput) await emailInput.type(GC_EMAIL, { delay: 50 });
  const passwordInput = await page.$('input[type="password"]');
  if (passwordInput) await passwordInput.type(GC_PASSWORD, { delay: 50 });
  const submitBtn = await page.$('button[type="submit"]');
  if (submitBtn) await submitBtn.click();
  await sleep(5000);
  console.log('Logged in!');

  // Go to box score
  console.log('Loading box score...');
  await page.goto(TEST_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  // Dump all data-testid elements
  const debug = await page.evaluate(() => {
    const results = {};
    
    // Get ALL elements with data-testid
    const allTestIds = document.querySelectorAll('[data-testid]');
    results.allTestIds = [...allTestIds].map(el => ({
      testid: el.getAttribute('data-testid'),
      tag: el.tagName,
      text: el.innerText?.substring(0, 200) || '',
    }));

    // Get anything with "score" in class or testid
    const scoreEls = document.querySelectorAll('[class*="score" i], [class*="Score" i], [data-testid*="score" i], [data-testid*="Score" i]');
    results.scoreElements = [...scoreEls].map(el => ({
      testid: el.getAttribute('data-testid'),
      className: el.className?.substring?.(0, 100) || '',
      text: el.innerText?.substring(0, 200) || '',
    }));

    // Get the EventHeader area
    const headerEls = document.querySelectorAll('[class*="EventHeader"], [data-testid*="Event"]');
    results.headerElements = [...headerEls].map(el => ({
      testid: el.getAttribute('data-testid'),
      className: el.className?.substring?.(0, 100) || '',
      text: el.innerText?.substring(0, 500) || '',
    }));

    // Try specific selectors
    results.lineScoreFinal = document.querySelector('[data-testid="Event-Header-LineScoreFinal"]')?.innerText || 'NOT FOUND';
    results.lineScoreLive = document.querySelector('[data-testid="Event-Header-LineScoreLive"]')?.innerText || 'NOT FOUND';
    results.eventNavbar = document.querySelector('[data-testid="event-navbar"]')?.innerText || 'NOT FOUND';
    
    // Get the main content area header
    const mainContent = document.querySelector('main');
    results.mainFirstText = mainContent?.innerText?.substring(0, 500) || 'NOT FOUND';

    return results;
  });

  console.log('\n=========================================');
  console.log('    DEBUG: SCORE ELEMENTS');
  console.log('=========================================\n');

  console.log('--- Line Score Final ---');
  console.log(debug.lineScoreFinal);
  
  console.log('\n--- Line Score Live ---');
  console.log(debug.lineScoreLive);

  console.log('\n--- Event Navbar ---');
  console.log(debug.eventNavbar);

  console.log('\n--- Header Elements ---');
  debug.headerElements.forEach(el => {
    console.log(`\n[${el.testid || 'no-testid'}] (${el.className.substring(0, 60)})`);
    console.log(el.text);
  });

  console.log('\n--- Score-related Elements ---');
  debug.scoreElements.forEach(el => {
    console.log(`\n[${el.testid || 'no-testid'}] (${el.className.substring(0, 60)})`);
    console.log(el.text);
  });

  console.log('\n--- All data-testid values ---');
  const uniqueIds = [...new Set(debug.allTestIds.map(el => el.testid))];
  uniqueIds.forEach(id => console.log('  ' + id));

  console.log('\n--- Main content first 500 chars ---');
  console.log(debug.mainFirstText);

  console.log('\n\nBrowser closing in 15 seconds...');
  await sleep(15000);
  await browser.close();
}

main().catch(console.error);
