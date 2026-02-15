/**
 * One-time setup: Log in to GameChanger manually (with 2FA code)
 * and save cookies so the scraper can reuse them.
 * 
 * Usage: node gc-save-session.mjs
 * 
 * 1. Chrome opens — log in manually as steve.hassett@usssa.org
 * 2. Enter the 2FA code when texted
 * 3. Once you're logged in and can see unblurred stats, press ENTER in the terminal
 * 4. Cookies are saved to gc-cookies.json
 * 5. The scraper will load these cookies instead of logging in fresh
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import readline from 'readline';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('🌐 Opening Chrome — log in to GameChanger manually...');
  console.log('   1. Go to https://web.gc.com/login');
  console.log('   2. Enter steve.hassett@usssa.org');
  console.log('   3. Enter password and 2FA code');
  console.log('   4. Navigate to a box score page to confirm stats are visible');
  console.log('   5. Come back here and press ENTER to save the session\n');

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--window-size=1920,1080'],
    userDataDir: './gc-browser-data'  // Persist browser data
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('https://web.gc.com/login', { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for user to log in manually
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  await new Promise(resolve => {
    rl.question('\n✅ Press ENTER once you are logged in and can see unblurred stats...', () => {
      rl.close();
      resolve();
    });
  });

  // Save cookies
  const cookies = await page.cookies();
  fs.writeFileSync('gc-cookies.json', JSON.stringify(cookies, null, 2));
  console.log(`\n💾 Saved ${cookies.length} cookies to gc-cookies.json`);

  // Also verify by going to a box score
  console.log('🔍 Verifying — loading box score...');
  await page.goto('https://web.gc.com/teams/D4CK5E1BGDsq/schedule/b60bffc5-0679-41fd-942f-49e782f9ad85/box-score', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  const data = await page.evaluate(() => {
    const tables = [...document.querySelectorAll('[data-testid="data-table"]')].map(t => t.innerText.substring(0, 200));
    const awayScore = document.querySelector('[data-testid="EventHeaderOngoing-awayScore"]')?.innerText?.trim();
    const homeScore = document.querySelector('[data-testid="EventHeaderOngoing-homeScore"]')?.innerText?.trim();
    return { tableCount: tables.length, firstTable: tables[0] || 'none', awayScore, homeScore };
  });

  console.log(`\n📊 Score: ${data.awayScore} - ${data.homeScore}`);
  console.log(`📊 Tables: ${data.tableCount}`);
  console.log(`📊 First table preview:\n${data.firstTable}\n`);

  if (data.firstTable.includes('Nolan') || data.firstTable.includes('Caleb') || !data.firstTable.includes('Gillespie')) {
    console.log('🎉 REAL STATS DETECTED! Premium is working!');
  } else {
    console.log('⚠️  Stats may still be fake — check the browser window');
  }

  console.log('\n💾 Session saved! The scraper will now use gc-browser-data/ for future logins.');
  console.log('   This means no more 2FA prompts.\n');
  
  await browser.close();
  console.log('Done! Now run the polling service:');
  console.log("  GC_PASSWORD='Tournaments1234!' node ec-polling-service.mjs");
}

main().catch(console.error);
