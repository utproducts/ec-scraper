/**
 * Fix score scraping — uses EventHeaderOngoing-awayScore and homeScore
 * Usage: node patch-score-fix2.mjs
 */
import fs from 'fs';

const file = 'ec-polling-service.mjs';
let code = fs.readFileSync(file, 'utf-8');

// Find the big evaluate block and replace the score extraction part
// The key selectors are:
//   [data-testid="EventHeaderOngoing-awayScore"] → away score
//   [data-testid="EventHeaderOngoing-homeScore"] → home score
//   FINAL text in header → status

const oldScoreBlock = `      // Grab the REAL score from the page header (not from batting stats)
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
      }`;

const newScoreBlock = `      // Grab the REAL score from the page header
      let awayScore = null;
      let homeScore = null;
      let status = null;
      
      // Direct selectors for scores
      const awayScoreEl = document.querySelector('[data-testid="EventHeaderOngoing-awayScore"]');
      const homeScoreEl = document.querySelector('[data-testid="EventHeaderOngoing-homeScore"]');
      
      if (awayScoreEl) awayScore = parseInt(awayScoreEl.innerText.trim()) || null;
      if (homeScoreEl) homeScore = parseInt(homeScoreEl.innerText.trim()) || null;
      
      // Get status from header
      const headerEl = document.querySelector('[data-testid="Event-Header-LineScoreFinal"]');
      if (headerEl) {
        const headerText = headerEl.innerText || '';
        if (headerText.includes('FINAL')) status = 'final';
      }
      if (!status) {
        const liveHeader = document.querySelector('[data-testid="Event-Header-LineScoreLive"]');
        if (liveHeader) status = 'live';
      }
      
      // Also grab the line score (inning by inning) and RHE
      let lineScore = null;
      const awayInnings = document.querySelector('[data-testid="away-row-innings"]');
      const homeInnings = document.querySelector('[data-testid="home-row-innings"]');
      const awayRHE = document.querySelector('[data-testid="away-row-rhe"]');
      const homeRHE = document.querySelector('[data-testid="home-row-rhe"]');
      const inningHeaders = document.querySelector('[data-testid="inning-header"]');
      
      if (awayInnings && homeInnings) {
        lineScore = {
          innings: inningHeaders ? inningHeaders.innerText.split('\\t').map(s => s.trim()).filter(s => s) : [],
          away: awayInnings.innerText.split('\\t').map(s => s.trim()).filter(s => s),
          home: homeInnings.innerText.split('\\t').map(s => s.trim()).filter(s => s),
          awayRHE: awayRHE ? awayRHE.innerText.split('\\t').map(s => s.trim()).filter(s => s) : [],
          homeRHE: homeRHE ? homeRHE.innerText.split('\\t').map(s => s.trim()).filter(s => s) : [],
        };
      }`;

if (code.includes(oldScoreBlock)) {
  code = code.replace(oldScoreBlock, newScoreBlock);
  
  // Also update the return to include lineScore
  code = code.replace(
    `return { away, home, tables, legends, awayScore, homeScore, headerStatus: status };`,
    `return { away, home, tables, legends, awayScore, homeScore, headerStatus: status, lineScore };`
  );
  
  fs.writeFileSync(file, code);
  console.log('✅ Score scraping fixed! Now uses exact data-testid selectors.');
  console.log('   - EventHeaderOngoing-awayScore');
  console.log('   - EventHeaderOngoing-homeScore');
  console.log('   - Also grabs inning-by-inning line score');
  console.log('\nRun the polling service to test:');
  console.log("  GC_PASSWORD='Tournaments1234!' node ec-polling-service.mjs");
} else {
  console.log('⚠️  Could not find the score block to replace.');
  console.log('   The file may have already been patched or has a different format.');
}
