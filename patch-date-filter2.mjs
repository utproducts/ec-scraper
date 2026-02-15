/**
 * Fix date filtering — check date from box score header, not schedule text
 * 
 * Usage: node patch-date-filter2.mjs
 */
import fs from 'fs';

const file = 'ec-polling-v2.mjs';
let code = fs.readFileSync(file, 'utf-8');

// Remove the old date filtering and sample debug, replace with simple pass-through
const oldBlock = `    // Filter games by event dates
    let filteredGames = games;
    if (team.startDate && team.endDate) {
      const start = new Date(team.startDate + 'T00:00:00');
      const end = new Date(team.endDate + 'T23:59:59');
      
      filteredGames = games.filter(g => {
        const text = g.text.toLowerCase();
        // Look for date patterns like "Feb 14", "Feb 15", "Sun Feb 15"
        const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const mon = months[d.getMonth()];
          const day = d.getDate();
          if (text.includes(mon + ' ' + day) || text.includes(mon + '  ' + day)) {
            return true;
          }
        }
        return false;
      });
    }
    
    games.slice(0,3).forEach(g => console.log("   SAMPLE:", g.text)); console.log(\`   📅 Found \${games.length} total games, \${filteredGames.length} within event dates\`);
    
    for (const game of filteredGames) {`;

const newBlock = `    console.log(\`   📅 Found \${games.length} total games on schedule\`);
    
    for (const game of games) {`;

if (code.includes(oldBlock)) {
  code = code.replace(oldBlock, newBlock);
  console.log('✅ Removed text-based date filter');
} else {
  console.log('⚠️  Could not find old date filter block, trying alternate...');
  // Try without the debug line
  const altOld = code.match(/\/\/ Filter games by event dates[\s\S]*?for \(const game of filteredGames\) \{/);
  if (altOld) {
    code = code.replace(altOld[0], `console.log(\`   📅 Found \${games.length} total games on schedule\`);\n    \n    for (const game of games) {`);
    console.log('✅ Removed text-based date filter (alt match)');
  }
}

// Now add date check AFTER scraping each game, before saving
// Find the saveGame call and add a date check before it
const oldSave = `      const score = \`\${data.away} \${data.awayScore ?? '?'}, \${data.home} \${data.homeScore ?? '?'}\`;
      const statusIcon = data.headerStatus === 'live' ? '🔴' : data.headerStatus === 'final' ? '✅' : '⏳';
      console.log(\`  \${statusIcon} \${score} (\${data.headerStatus || 'unknown'})\`);
      
      await saveGame(game.url, data, team.ageGroup, team.eventName);
      newGames++;`;

const newSave = `      // Check if game date falls within event dates
      if (team.startDate && team.endDate && data.gameTime) {
        const eventStart = new Date(team.startDate + 'T00:00:00');
        const eventEnd = new Date(team.endDate + 'T23:59:59');
        
        // Parse date from gameTime like "Sun Feb 15, 12:00 PM - 1:00 PM ET"
        const dateMatch = data.gameTime.match(/(\\w+)\\s+(\\w+)\\s+(\\d+)/);
        if (dateMatch) {
          const monthNames = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
          const month = monthNames[dateMatch[2].toLowerCase().substring(0, 3)];
          const day = parseInt(dateMatch[3]);
          if (month !== undefined && day) {
            const gameDate = new Date(2026, month, day);
            if (gameDate < eventStart || gameDate > eventEnd) {
              console.log(\`  ⏭️  Skipping — \${data.gameTime} outside event dates (\${team.startDate} to \${team.endDate})\`);
              await sleep(1000);
              continue;
            }
          }
        }
      }
      
      const score = \`\${data.away} \${data.awayScore ?? '?'}, \${data.home} \${data.homeScore ?? '?'}\`;
      const statusIcon = data.headerStatus === 'live' ? '🔴' : data.headerStatus === 'final' ? '✅' : '⏳';
      console.log(\`  \${statusIcon} \${score} (\${data.headerStatus || 'unknown'})\`);
      
      await saveGame(game.url, data, team.ageGroup, team.eventName);
      newGames++;`;

if (code.includes(oldSave)) {
  code = code.replace(oldSave, newSave);
  console.log('✅ Added date check after scraping (uses box score header date)');
} else {
  console.log('⚠️  Could not find save block');
}

fs.writeFileSync(file, code);
console.log('\nDone! Now re-run the scraper.');
console.log("  GC_PASSWORD='Tournaments1234!' node ec-polling-v2.mjs");
console.log('\nIt will scrape each game but SKIP saving any outside Feb 14-15.');
console.log('This is slower (visits every game page) but accurate.');
