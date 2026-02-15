/**
 * Fix schedule discovery in ec-polling-v2.mjs
 * Uses: a.ScheduleListByMonth__event for game links
 * And clicks the SCHEDULE tab via the nav bar
 * 
 * Usage: node patch-schedule-discovery.mjs
 */
import fs from 'fs';

const file = 'ec-polling-v2.mjs';
let code = fs.readFileSync(file, 'utf-8');

// Replace the entire discoverGames function
const oldFunc = `async function discoverGames(teamUrl) {
  try {
    // Navigate to team's schedule page
    // Team URL: https://web.gc.com/teams/fXEnuJhCgzAL
    // Schedule should be at the same URL or /schedule
    await page.goto(teamUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);
    
    // The team page usually shows the schedule by default
    // No need to click a tab
    
    // Find all game links on the schedule page
    const games = await page.evaluate(() => {
      const links = [];
      
      // Look for links that contain /schedule/ and end with something like a game ID
      const allLinks = document.querySelectorAll('a[href*="/schedule/"]');
      for (const link of allLinks) {
        const href = link.href || link.getAttribute('href') || '';
        // Match game links — they have a UUID-like segment after /schedule/
        if (href.match(/\\/schedule\\/[a-f0-9-]{20,}/)) {
          // Get the game info text
          const parent = link.closest('[class*="event"], [class*="game"], [class*="schedule"], li, tr, div');
          const text = parent ? parent.innerText.substring(0, 200) : link.innerText.substring(0, 200);
          
          // Build box score URL
          let boxScoreUrl = href;
          if (!boxScoreUrl.includes('/box-score')) {
            boxScoreUrl = boxScoreUrl.replace(/\\/?$/, '/box-score');
          }
          
          links.push({
            url: boxScoreUrl,
            text: text.replace(/\\n/g, ' | ').substring(0, 150),
          });
        }
      }
      
      // Deduplicate by URL
      const seen = new Set();
      return links.filter(l => {
        const key = l.url.split('/box-score')[0];
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
    
    return games;
  } catch (err) {
    console.error(\`  ❌ Schedule discovery error: \${err.message}\`);
    return [];
  }
}`;

const newFunc = `async function discoverGames(teamUrl) {
  try {
    // Navigate to team page
    await page.goto(teamUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);
    
    // Click the SCHEDULE tab
    const scheduleLink = await page.$('a[href*="/schedule"]');
    if (scheduleLink) {
      await scheduleLink.click();
      await sleep(3000);
    }
    
    // Scroll down to load all games (GC may lazy-load)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1000);
    
    // Find all game links — they are <a class="ScheduleListByMonth__event">
    const games = await page.evaluate(() => {
      const links = [];
      
      // Primary selector: GC schedule game links
      const gameLinks = document.querySelectorAll('a[class*="ScheduleListByMonth__event"]');
      
      for (const link of gameLinks) {
        const href = link.href || link.getAttribute('href') || '';
        if (!href) continue;
        
        // Get the game info text (opponent, score, date)
        const text = link.innerText.replace(/\\n/g, ' | ').substring(0, 150);
        
        // Build full box score URL
        let fullUrl = href;
        if (!fullUrl.startsWith('http')) {
          fullUrl = window.location.origin + href;
        }
        if (!fullUrl.includes('/box-score')) {
          fullUrl = fullUrl.replace(/\\/?$/, '/box-score');
        }
        
        links.push({ url: fullUrl, text });
      }
      
      // Fallback: try any link with /schedule/ and a UUID
      if (links.length === 0) {
        const allLinks = document.querySelectorAll('a[href*="/schedule/"]');
        for (const link of allLinks) {
          const href = link.href || link.getAttribute('href') || '';
          if (href.match(/\\/schedule\\/[a-f0-9-]{20,}/)) {
            let fullUrl = href.startsWith('http') ? href : window.location.origin + href;
            if (!fullUrl.includes('/box-score')) fullUrl += '/box-score';
            const text = link.innerText.replace(/\\n/g, ' | ').substring(0, 150);
            links.push({ url: fullUrl, text });
          }
        }
      }
      
      // Deduplicate
      const seen = new Set();
      return links.filter(l => {
        const key = l.url.split('/box-score')[0];
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
    
    return games;
  } catch (err) {
    console.error(\`  ❌ Schedule discovery error: \${err.message}\`);
    return [];
  }
}`;

if (code.includes(oldFunc)) {
  code = code.replace(oldFunc, newFunc);
  fs.writeFileSync(file, code);
  console.log('✅ Schedule discovery fixed!');
  console.log('   - Clicks SCHEDULE tab');
  console.log('   - Scrolls to load all games');
  console.log('   - Uses ScheduleListByMonth__event selector');
  console.log('   - Falls back to href pattern matching');
} else {
  console.log('⚠️  Could not find discoverGames function to replace');
  console.log('   Trying line-by-line search...');
  
  // Try to find it by the function signature
  const funcStart = code.indexOf('async function discoverGames');
  const funcEnd = code.indexOf('// ─── SCRAPE A SINGLE GAME');
  
  if (funcStart !== -1 && funcEnd !== -1) {
    code = code.substring(0, funcStart) + newFunc + '\\n\\n' + code.substring(funcEnd);
    fs.writeFileSync(file, code);
    console.log('✅ Fixed with line search!');
  } else {
    console.log('❌ Could not fix automatically. The function structure may have changed.');
  }
}
