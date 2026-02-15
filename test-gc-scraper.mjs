/**
 * USSSA Event Central — Scraper Test
 * 
 * Run this with: node test-gc-scraper.mjs
 */

import puppeteer from 'puppeteer';

const GC_EMAIL = process.env.GC_EMAIL || 'steve.hassett@usssa.org';
const GC_PASSWORD = process.env.GC_PASSWORD || '';
const TEST_URL = 'https://web.gc.com/teams/D4CK5E1BGDsq/schedule/b60bffc5-0679-41fd-942f-49e782f9ad85/box-score';

async function main() {
  console.log('Starting GameChanger scraper test...\n');

  if (!GC_PASSWORD) {
    console.log('ERROR: Set GC_PASSWORD. Run like this:');
    console.log('GC_PASSWORD="YourPassword" node test-gc-scraper.mjs');
    process.exit(1);
  }

  console.log('1. Opening Chrome...');
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--window-size=1920,1080'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  try {
    console.log('2. Going to GameChanger login...');
    await page.goto('https://web.gc.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    console.log('3. Logging in as ' + GC_EMAIL + '...');
    const emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
    if (emailInput) {
      await emailInput.type(GC_EMAIL, { delay: 50 });
    }

    const passwordInput = await page.$('input[type="password"]');
    if (passwordInput) {
      await passwordInput.type(GC_PASSWORD, { delay: 50 });
    }

    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    }

    console.log('   Waiting for login...');
    await sleep(5000);

    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
      console.log('ERROR: Login failed. Still on login page.');
      await page.screenshot({ path: 'gc-login-failed.png' });
      await browser.close();
      return;
    }

    console.log('Login successful!\n');

    console.log('4. Going to 11u Scorps box score...');
    await page.goto(TEST_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(5000);

    console.log('5. Reading player stats...\n');

    const data = await page.evaluate(() => {
      const result = { tables: [], legend: [], homeTeam: '', awayTeam: '' };

      const home = document.querySelector('[data-testid="home-team-name"]');
      const away = document.querySelector('[data-testid="away-team-name"]');
      if (home) result.homeTeam = home.innerText.trim();
      if (away) result.awayTeam = away.innerText.trim();

      const dataTables = document.querySelectorAll('[data-testid="data-table"]');
      for (let i = 0; i < dataTables.length; i++) {
        result.tables.push({ index: i, text: dataTables[i].innerText });
      }

      const legends = document.querySelectorAll('[data-testid="box-score-legend"]');
      for (const l of legends) {
        result.legend.push(l.innerText);
      }

      return result;
    });

    console.log('=========================================');
    console.log('    GAMECHANGER BOX SCORE DATA');
    console.log('=========================================\n');
    console.log('Away Team: ' + data.awayTeam);
    console.log('Home Team: ' + data.homeTeam);
    console.log('Tables found: ' + data.tables.length);
    console.log('');

    for (const table of data.tables) {
      console.log('----- TABLE ' + table.index + ' -----');
      console.log(table.text);
      console.log('');
    }

    if (data.legend.length > 0) {
      console.log('----- LEGENDS -----');
      for (const l of data.legend) {
        console.log(l);
        console.log('');
      }
    }

    console.log('\nDone! If you see player names and stats above, it works!');
    console.log('Copy this entire output and send it back to Claude.');

  } catch (err) {
    console.log('ERROR: ' + err.message);
    await page.screenshot({ path: 'gc-error.png' });
  }

  console.log('\nBrowser closing in 10 seconds...');
  await sleep(10000);
  await browser.close();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main();