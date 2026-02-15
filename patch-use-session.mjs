/**
 * Patch polling service to use saved browser session (gc-browser-data/)
 * instead of logging in fresh each time
 * 
 * Usage: node patch-use-session.mjs
 */

import fs from 'fs';

const file = 'ec-polling-service.mjs';
let code = fs.readFileSync(file, 'utf-8');

// Replace the launchBrowser function to use persisted browser data
const oldLaunch = `async function launchBrowser() {
  if (browser) return;
  console.log('🌐 Launching Chrome...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1920,1080'],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
}`;

const newLaunch = `async function launchBrowser() {
  if (browser) return;
  console.log('🌐 Launching Chrome with saved session...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1920,1080'],
    userDataDir: './gc-browser-data'  // Reuse saved session (Premium + 2FA)
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
}`;

if (code.includes(oldLaunch)) {
  code = code.replace(oldLaunch, newLaunch);
  console.log('✅ Updated launchBrowser() to use saved session');
} else {
  console.log('⚠️  Could not find launchBrowser() — may already be patched');
}

// Update loginToGC to check if already logged in before trying to log in
const oldLogin = `async function loginToGC() {
  if (isLoggedIn) return;
  console.log(\`🔑 Logging in as \${GC_EMAIL}...\`);

  await page.goto('https://web.gc.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);

  const emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
  if (emailInput) await emailInput.type(GC_EMAIL, { delay: 50 });

  const passwordInput = await page.$('input[type="password"]');
  if (passwordInput) await passwordInput.type(GC_PASSWORD, { delay: 50 });

  const submitBtn = await page.$('button[type="submit"]');
  if (submitBtn) await submitBtn.click();

  await sleep(5000);
  isLoggedIn = true;
  console.log('✅ Logged in!');
}`;

const newLogin = `async function loginToGC() {
  if (isLoggedIn) return;
  
  // Check if saved session is still valid by going to GC home
  console.log('🔑 Checking saved session...');
  await page.goto('https://web.gc.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);
  
  // Check if we're already logged in (look for user menu or account elements)
  const isAlreadyLoggedIn = await page.evaluate(() => {
    const body = document.body.innerText || '';
    // If we see "Sign In" button, we're NOT logged in
    // If we see user avatar/menu, we ARE logged in
    const signInBtn = document.querySelector('[data-testid="desktop-sign-in-button"]');
    return !signInBtn || signInBtn.offsetParent === null;
  });
  
  if (isAlreadyLoggedIn) {
    console.log('✅ Saved session still valid! Skipping login.');
    isLoggedIn = true;
    return;
  }
  
  // Session expired — need to log in fresh
  console.log('⚠️  Session expired. Logging in fresh...');
  console.log('   NOTE: If 2FA is required, run gc-save-session.mjs again');
  
  await page.goto('https://web.gc.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);

  const emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
  if (emailInput) await emailInput.type(GC_EMAIL, { delay: 50 });

  const passwordInput = await page.$('input[type="password"]');
  if (passwordInput) await passwordInput.type(GC_PASSWORD, { delay: 50 });

  const submitBtn = await page.$('button[type="submit"]');
  if (submitBtn) await submitBtn.click();

  await sleep(5000);
  isLoggedIn = true;
  console.log('✅ Logged in!');
}`;

if (code.includes(oldLogin)) {
  code = code.replace(oldLogin, newLogin);
  console.log('✅ Updated loginToGC() to check saved session first');
} else {
  console.log('⚠️  Could not find loginToGC() — may already be patched');
}

fs.writeFileSync(file, code);
console.log('\nDone! Now:');
console.log('  1. Run: node gc-save-session.mjs  (log in manually with 2FA)');
console.log("  2. Run: GC_PASSWORD='Tournaments1234!' node ec-polling-service.mjs");
