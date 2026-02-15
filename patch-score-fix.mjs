/**
 * Run this once to fix the score scraping in ec-polling-service.mjs
 * and test-gc-to-supabase.mjs
 * 
 * The issue: we were calculating score from batting R column,
 * but GameChanger's blurred stats are stale/incomplete.
 * The REAL score is in the Event Header at the top of the page.
 * 
 * Usage: node patch-score-fix.mjs
 */

import fs from 'fs';

// ─── Fix ec-polling-service.mjs ──────────────────────────────
const pollingFile = 'ec-polling-service.mjs';
if (fs.existsSync(pollingFile)) {
  let code = fs.readFileSync(pollingFile, 'utf-8');
  
  // Replace the scrapeGame function's page.evaluate to also grab scores
  const oldEval = `const data = await page.evaluate(() => {
      const away = document.querySelector('[data-testid="away-team-name"]')?.innerText?.trim() || '';
      const home = document.querySelector('[data-testid="home-team-name"]')?.innerText?.trim() || '';
      const tables = [...document.querySelectorAll('[data-testid="data-table"]')].map(t => t.innerText);
      const legends = [...document.querySelectorAll('[data-testid="box-score-legend"] dt, [data-testid="box-score-legend"] dd')].map(el => el.innerText);
      return { away, home, tables, legends };
    });`;
  
  const newEval = `const data = await page.evaluate(() => {
      const away = document.querySelector('[data-testid="away-team-name"]')?.innerText?.trim() || '';
      const home = document.querySelector('[data-testid="home-team-name"]')?.innerText?.trim() || '';
      const tables = [...document.querySelectorAll('[data-testid="data-table"]')].map(t => t.innerText);
      const legends = [...document.querySelectorAll('[data-testid="box-score-legend"] dt, [data-testid="box-score-legend"] dd')].map(el => el.innerText);
      
      // Grab the REAL score from the page header (not from batting stats)
      let awayScore = null;
      let homeScore = null;
      let status = null;
      
      // Try the line score header
      const headerEl = document.querySelector('[data-testid="Event-Header-LineScoreFinal"]') || 
                        document.querySelector('[data-testid="Event-Header-LineScoreLive"]') ||
                        document.querySelector('[class*="EventHeaderCommon"]');
      
      if (headerEl) {
        const headerText = headerEl.innerText || '';
        // Look for "FINAL" or inning indicators
        if (headerText.includes('FINAL')) status = 'final';
        else if (headerText.match(/TOP|BOT|MID|END/i)) status = 'live';
        
        // The header contains scores - try to extract them
        // Format is typically: team abbrev followed by inning scores then R H E
        const lines = headerText.split('\\n').map(l => l.trim()).filter(l => l);
        
        // Find lines that look like score lines (contain mostly numbers)
        const scoreLines = lines.filter(l => l.match(/^[A-Z]{2,5}\\s+[\\dX\\s]+$/));
        
        if (scoreLines.length >= 2) {
          // Extract R (runs) column - it's after the inning scores
          // The format is: TEAM 0 2 0 2 0 0 R H E
          const nums1 = scoreLines[0].match(/\\d+/g);
          const nums2 = scoreLines[1].match(/\\d+/g);
          if (nums1 && nums1.length >= 3) {
            // R is third from last (R, H, E)
            awayScore = parseInt(nums1[nums1.length - 3]);
          }
          if (nums2 && nums2.length >= 3) {
            homeScore = parseInt(nums2[nums2.length - 3]);
          }
        }
      }
      
      // Fallback: try to find score in large text elements
      if (awayScore === null || homeScore === null) {
        const allText = document.body.innerText;
        const scoreMatch = allText.match(/(\\d{1,2})\\s*(?:FINAL|final|Final)\\s*(\\d{1,2})/);
        if (scoreMatch) {
          awayScore = parseInt(scoreMatch[1]);
          homeScore = parseInt(scoreMatch[2]);
        }
      }
      
      return { away, home, tables, legends, awayScore, homeScore, headerStatus: status };
    });`;
  
  if (code.includes(oldEval)) {
    code = code.replace(oldEval, newEval);
    console.log('✅ Updated scrapeGame() in ec-polling-service.mjs');
  } else {
    console.log('⚠️  Could not find scrapeGame evaluate block in ec-polling-service.mjs — may already be patched');
  }
  
  // Replace the score calculation in saveGameToSupabase
  const oldScoreCalc = `  // Calculate scores from batting
  const awayScore = awayBatting.reduce((s, p) => s + p.r, 0);
  const homeScore = homeBatting.reduce((s, p) => s + p.r, 0);`;
  
  const newScoreCalc = `  // Use header score if available, otherwise calculate from batting
  const awayScore = scrapedData.awayScore !== null ? scrapedData.awayScore : awayBatting.reduce((s, p) => s + p.r, 0);
  const homeScore = scrapedData.homeScore !== null ? scrapedData.homeScore : homeBatting.reduce((s, p) => s + p.r, 0);`;
  
  if (code.includes(oldScoreCalc)) {
    code = code.replace(oldScoreCalc, newScoreCalc);
    console.log('✅ Updated score calculation in ec-polling-service.mjs');
  }
  
  // Replace status determination
  const oldStatus = `  // Determine status — if pitching IP adds up to a complete game, it's final
  const awayIP = awayPitching.reduce((s, p) => s + p.ip, 0);
  const homeIP = homePitching.reduce((s, p) => s + p.ip, 0);
  const status = (awayIP >= 4 && homeIP >= 4) ? 'final' : 'live';`;
  
  const newStatus = `  // Use header status if available, otherwise determine from pitching IP
  let status = scrapedData.headerStatus || null;
  if (!status) {
    const awayIP = awayPitching.reduce((s, p) => s + p.ip, 0);
    const homeIP = homePitching.reduce((s, p) => s + p.ip, 0);
    status = (awayIP >= 4 && homeIP >= 4) ? 'final' : 'live';
  }`;
  
  if (code.includes(oldStatus)) {
    code = code.replace(oldStatus, newStatus);
    console.log('✅ Updated status determination in ec-polling-service.mjs');
  }
  
  // Update the console.log to show header score
  const oldLog = `    console.log(\`  ✅ \${data.away} vs \${data.home} | \${data.tables.length} tables\`);`;
  const newLog = `    console.log(\`  ✅ \${data.away} vs \${data.home} | \${data.tables.length} tables | Header score: \${data.awayScore ?? '?'}-\${data.homeScore ?? '?'}\`);`;
  
  if (code.includes(oldLog)) {
    code = code.replace(oldLog, newLog);
  }
  
  fs.writeFileSync(pollingFile, code);
  console.log('✅ ec-polling-service.mjs patched!\n');
} else {
  console.log('⚠️  ec-polling-service.mjs not found\n');
}

// ─── Fix test-gc-scraper.mjs to also show header score ───────
const scraperFile = 'test-gc-scraper.mjs';
if (fs.existsSync(scraperFile)) {
  let code = fs.readFileSync(scraperFile, 'utf-8');
  
  // Check if it already has header score scraping
  if (!code.includes('Event-Header-LineScore')) {
    // Find the evaluate block and add header score extraction
    const oldBlock = `const legends = [...document.querySelectorAll('[data-testid="box-score-legend"] dt, [data-testid="box-score-legend"] dd')].map(el => el.innerText);`;
    const newBlock = `const legends = [...document.querySelectorAll('[data-testid="box-score-legend"] dt, [data-testid="box-score-legend"] dd')].map(el => el.innerText);
      
      // Grab header score
      const headerEl = document.querySelector('[data-testid="Event-Header-LineScoreFinal"]') || 
                        document.querySelector('[data-testid="Event-Header-LineScoreLive"]') ||
                        document.querySelector('[class*="EventHeaderCommon"]');
      const headerText = headerEl ? headerEl.innerText : 'no header found';`;
    
    if (code.includes(oldBlock)) {
      code = code.replace(oldBlock, newBlock);
      
      // Also add headerText to the return and console output
      code = code.replace(
        `return { away, home, tables, legends };`,
        `return { away, home, tables, legends, headerText };`
      );
      
      // Add header output to console
      const oldOutput = `console.log('Tables found:', data.tables.length);`;
      if (code.includes(oldOutput)) {
        code = code.replace(oldOutput, `console.log('Tables found:', data.tables.length);
    console.log('\\n----- HEADER SCORE -----');
    console.log(data.headerText);`);
      }
      
      fs.writeFileSync(scraperFile, code);
      console.log('✅ test-gc-scraper.mjs patched to show header score!\n');
    } else {
      console.log('⚠️  Could not find evaluate block in test-gc-scraper.mjs\n');
    }
  } else {
    console.log('✅ test-gc-scraper.mjs already has header score scraping\n');
  }
} else {
  console.log('⚠️  test-gc-scraper.mjs not found\n');
}

console.log('Done! Now run the test scraper to verify:');
console.log("  GC_PASSWORD='Tournaments1234!' node test-gc-scraper.mjs");
console.log('\nYou should see the HEADER SCORE section with the real score.');
