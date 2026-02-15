/**
 * Add date filtering to schedule discovery
 * Only scrapes games from the event date range
 * 
 * ec-teams.txt format changes to include dates:
 * URL | Age Group | Event Name | Start Date | End Date
 * 
 * Usage: node patch-date-filter.mjs
 */
import fs from 'fs';

const file = 'ec-polling-v2.mjs';
let code = fs.readFileSync(file, 'utf-8');

// 1. Update readTeamConfig to parse dates
const oldReadConfig = `      const url = parts[0];
      const ageGroup = parts[1] || 'Unknown';
      const eventName = parts[2] || 'Unknown Event';
      
      if (url.includes('gc.com/teams/')) {
        teams.push({ url, ageGroup, eventName });
      }`;

const newReadConfig = `      const url = parts[0];
      const ageGroup = parts[1] || 'Unknown';
      const eventName = parts[2] || 'Unknown Event';
      const startDate = parts[3] || null;
      const endDate = parts[4] || null;
      
      if (url.includes('gc.com/teams/')) {
        teams.push({ url, ageGroup, eventName, startDate, endDate });
      }`;

if (code.includes(oldReadConfig)) {
  code = code.replace(oldReadConfig, newReadConfig);
  console.log('✅ readTeamConfig: added date parsing');
}

// 2. Update discoverGames to accept date range and filter
const oldDiscover = `async function discoverGames(teamUrl) {`;
const newDiscover = `async function discoverGames(teamUrl, startDate, endDate) {`;

if (code.includes(oldDiscover)) {
  code = code.replace(oldDiscover, newDiscover);
  console.log('✅ discoverGames: added date params');
}

// 3. Add date filtering to the game links after they're discovered
const oldReturn = `    // Deduplicate
      const seen = new Set();
      return links.filter(l => {
        const key = l.url.split('/box-score')[0];
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });`;

const newReturn = `    // Deduplicate
      const seen = new Set();
      return links.filter(l => {
        const key = l.url.split('/box-score')[0];
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });`;

// Actually, the date info is in the schedule page text. Let's filter AFTER discovery
// by checking the game text for date matches

// 4. Add date filtering after game discovery in the pollOnce function
const oldFoundGames = `    console.log(\`   📅 Found \${games.length} games on schedule\`);
    
    for (const game of games) {`;

const newFoundGames = `    // Filter games by event dates
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
    
    console.log(\`   📅 Found \${games.length} total games, \${filteredGames.length} within event dates\`);
    
    for (const game of filteredGames) {`;

if (code.includes(oldFoundGames)) {
  code = code.replace(oldFoundGames, newFoundGames);
  console.log('✅ Added date filtering in polling loop');
}

// 5. Update the discoverGames call to pass dates
const oldCall = `const games = await discoverGames(team.url);`;
const newCall = `const games = await discoverGames(team.url, team.startDate, team.endDate);`;

if (code.includes(oldCall)) {
  code = code.replace(oldCall, newCall);
  console.log('✅ Updated discoverGames call with dates');
}

// 6. Update the team display line
const oldDisplay = `teams.forEach(t => console.log(\`   \${t.ageGroup} | \${t.eventName} | \${t.url}\`));`;
const newDisplay = `teams.forEach(t => console.log(\`   \${t.ageGroup} | \${t.eventName} | \${t.startDate || 'no date'}-\${t.endDate || 'no date'} | \${t.url}\`));`;

if (code.includes(oldDisplay)) {
  code = code.replace(oldDisplay, newDisplay);
  console.log('✅ Updated team display to show dates');
}

fs.writeFileSync(file, code);

// 7. Update ec-teams.txt with dates
const teamsFile = `# USSSA Event Central — Team URLs
# Format: URL | Age Group | Event Name | Start Date | End Date
# Dates in YYYY-MM-DD format. Only games within these dates will be scraped.

# Space Coast Presidents Day - 11U (Feb 14-15, 2026)
https://web.gc.com/teams/fXEnuJhCgzAL | 11U | Space Coast Presidents Day | 2026-02-14 | 2026-02-15
https://web.gc.com/teams/4dj1c8ViBjU3 | 11U | Space Coast Presidents Day | 2026-02-14 | 2026-02-15
https://web.gc.com/teams/yAo2y8yv1DvH | 11U | Space Coast Presidents Day | 2026-02-14 | 2026-02-15
https://web.gc.com/teams/Loo08zcjs7Uj | 11U | Space Coast Presidents Day | 2026-02-14 | 2026-02-15
https://web.gc.com/teams/EFLIFGXbsKqQ | 11U | Space Coast Presidents Day | 2026-02-14 | 2026-02-15
https://web.gc.com/teams/dyDPDOqQrM3l | 11U | Space Coast Presidents Day | 2026-02-14 | 2026-02-15
https://web.gc.com/teams/D4CK5E1BGDsq | 11U | Space Coast Presidents Day | 2026-02-14 | 2026-02-15
https://web.gc.com/teams/RNZWvqcbYACe | 11U | Space Coast Presidents Day | 2026-02-14 | 2026-02-15
https://web.gc.com/teams/CTvHKLd3OkXs | 11U | Space Coast Presidents Day | 2026-02-14 | 2026-02-15
`;

fs.writeFileSync('ec-teams.txt', teamsFile);
console.log('✅ Updated ec-teams.txt with event dates');

console.log('\nNow clear bad data from Supabase, then re-run:');
console.log('  1. Clear DB in Supabase SQL Editor');
console.log("  2. GC_PASSWORD='Tournaments1234!' node ec-polling-v2.mjs");
