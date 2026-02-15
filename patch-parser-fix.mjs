/**
 * Fix the player name parser in ec-polling-service.mjs
 * The old parser expected names like "K Gillespie" (initial + space)
 * Real premium names are like "Nolan S" — full first name
 * 
 * Usage: node patch-parser-fix.mjs
 */

import fs from 'fs';

const file = 'ec-polling-service.mjs';
let code = fs.readFileSync(file, 'utf-8');

// Replace parseBatting function
const oldParseBatting = `function parseBatting(tableText) {
  const lines = tableText.split('\\n').map(l => l.trim()).filter(l => l);
  const players = [];
  let i = 0;

  // Skip header row (LINEUP, AB, R, H, RBI, BB, SO)
  while (i < lines.length && !lines[i].match(/^[A-Z]\\s/)) i++;

  while (i < lines.length) {
    const nameLine = lines[i];
    if (nameLine === 'TEAM') break;

    // Next line is jersey/position
    const jerseyLine = lines[i + 1] || '';
    const jerseyMatch = jerseyLine.match(/#(\\d+)\\s*\\(?([\\/\\w]*)\\)?/);

    const jersey = jerseyMatch ? jerseyMatch[1] : '';
    const pos = jerseyMatch ? jerseyMatch[2] : '';

    // Stats: AB, R, H, RBI, BB, SO
    const statsStart = jerseyMatch ? i + 2 : i + 1;
    const ab = parseInt(lines[statsStart]) || 0;
    const r = parseInt(lines[statsStart + 1]) || 0;
    const h = parseInt(lines[statsStart + 2]) || 0;
    const rbi = parseInt(lines[statsStart + 3]) || 0;
    const bb = parseInt(lines[statsStart + 4]) || 0;
    const so = parseInt(lines[statsStart + 5]) || 0;

    players.push({ name: nameLine, jersey, pos, ab, r, h, rbi, bb, so });
    i = statsStart + 6;
  }

  return players;
}`;

const newParseBatting = `function parseBatting(tableText) {
  const lines = tableText.split('\\n').map(l => l.trim()).filter(l => l);
  const players = [];
  let i = 0;

  // Skip header row — find first line that starts with # (jersey) after a name
  // Headers are: LINEUP, AB, R, H, RBI, BB, SO
  const headerKeys = ['LINEUP', 'AB', 'R', 'H', 'RBI', 'BB', 'SO'];
  while (i < lines.length && headerKeys.includes(lines[i])) i++;

  while (i < lines.length) {
    const nameLine = lines[i];
    if (nameLine === 'TEAM') {
      // Parse team totals
      i++;
      break;
    }

    // Check if next line is jersey/position (starts with #)
    const nextLine = lines[i + 1] || '';
    const jerseyMatch = nextLine.match(/^#(\\d+)\\s*\\(?([\\w/,\\s]*)\\)?/);

    let jersey = '';
    let pos = '';
    let statsStart;

    if (jerseyMatch) {
      jersey = jerseyMatch[1];
      pos = jerseyMatch[2] ? jerseyMatch[2].trim() : '';
      statsStart = i + 2;
    } else {
      // No jersey line — name might include jersey inline
      const inlineMatch = nameLine.match(/^(.+?)\\s+#(\\d+)\\s*\\(?([\\w/,\\s]*)\\)?$/);
      if (inlineMatch) {
        // Name has jersey inline like "Nolan S #24 (LF)"
        statsStart = i + 1;
        jersey = inlineMatch[2];
        pos = inlineMatch[3] ? inlineMatch[3].trim() : '';
      } else {
        statsStart = i + 1;
      }
    }

    // Read 6 stat values: AB, R, H, RBI, BB, SO
    if (statsStart + 5 < lines.length) {
      const ab = parseInt(lines[statsStart]) || 0;
      const r = parseInt(lines[statsStart + 1]) || 0;
      const h = parseInt(lines[statsStart + 2]) || 0;
      const rbi = parseInt(lines[statsStart + 3]) || 0;
      const bb = parseInt(lines[statsStart + 4]) || 0;
      const so = parseInt(lines[statsStart + 5]) || 0;

      players.push({ name: nameLine, jersey, pos, ab, r, h, rbi, bb, so });
      i = statsStart + 6;
    } else {
      i++;
    }
  }

  return players;
}`;

if (code.includes(oldParseBatting)) {
  code = code.replace(oldParseBatting, newParseBatting);
  console.log('✅ Fixed parseBatting()');
} else {
  console.log('⚠️  Could not find parseBatting() — may already be patched');
}

// Replace parsePitching function
const oldParsePitching = `function parsePitching(tableText) {
  const lines = tableText.split('\\n').map(l => l.trim()).filter(l => l);
  const pitchers = [];
  let i = 0;

  // Skip header
  while (i < lines.length && !lines[i].match(/^[A-Z]\\s/)) i++;

  while (i < lines.length) {
    const nameLine = lines[i];
    if (nameLine === 'TEAM') break;

    const jerseyLine = lines[i + 1] || '';
    const jerseyMatch = jerseyLine.match(/#(\\d+)/);
    const jersey = jerseyMatch ? jerseyMatch[1] : '';

    const statsStart = jerseyMatch ? i + 2 : i + 1;
    const ip = parseFloat(lines[statsStart]) || 0;
    const h = parseInt(lines[statsStart + 1]) || 0;
    const r = parseInt(lines[statsStart + 2]) || 0;
    const er = parseInt(lines[statsStart + 3]) || 0;
    const bb = parseInt(lines[statsStart + 4]) || 0;
    const so = parseInt(lines[statsStart + 5]) || 0;

    pitchers.push({ name: nameLine, jersey, ip, h, r, er, bb, so });
    i = statsStart + 6;
  }

  return pitchers;
}`;

const newParsePitching = `function parsePitching(tableText) {
  const lines = tableText.split('\\n').map(l => l.trim()).filter(l => l);
  const pitchers = [];
  let i = 0;

  // Skip headers: PITCHING, IP, H, R, ER, BB, SO
  const headerKeys = ['PITCHING', 'IP', 'H', 'R', 'ER', 'BB', 'SO'];
  while (i < lines.length && headerKeys.includes(lines[i])) i++;

  while (i < lines.length) {
    const nameLine = lines[i];
    if (nameLine === 'TEAM') break;

    // Check if next line is jersey (starts with #)
    const nextLine = lines[i + 1] || '';
    const jerseyMatch = nextLine.match(/^#(\\d+)/);

    let jersey = '';
    let statsStart;

    if (jerseyMatch) {
      jersey = jerseyMatch[1];
      statsStart = i + 2;
    } else {
      // Try inline jersey
      const inlineMatch = nameLine.match(/^(.+?)\\s+#(\\d+)/);
      if (inlineMatch) {
        jersey = inlineMatch[2];
      }
      statsStart = i + 1;
    }

    if (statsStart + 5 < lines.length) {
      const ip = parseFloat(lines[statsStart]) || 0;
      const h = parseInt(lines[statsStart + 1]) || 0;
      const r = parseInt(lines[statsStart + 2]) || 0;
      const er = parseInt(lines[statsStart + 3]) || 0;
      const bb = parseInt(lines[statsStart + 4]) || 0;
      const so = parseInt(lines[statsStart + 5]) || 0;

      pitchers.push({ name: nameLine, jersey, ip, h, r, er, bb, so });
      i = statsStart + 6;
    } else {
      i++;
    }
  }

  return pitchers;
}`;

if (code.includes(oldParsePitching)) {
  code = code.replace(oldParsePitching, newParsePitching);
  console.log('✅ Fixed parsePitching()');
} else {
  console.log('⚠️  Could not find parsePitching() — may already be patched');
}

// Also add console.log for parsed player count
const oldParsedLog = `  if (tables.length < 4) {
    console.log('  ⚠️  Less than 4 tables — game may not have started yet');
    return null;
  }

  const awayBatting = parseBatting(tables[0]);
  const awayPitching = parsePitching(tables[1]);
  const homeBatting = parseBatting(tables[2]);
  const homePitching = parsePitching(tables[3]);`;

const newParsedLog = `  if (tables.length < 4) {
    console.log('  ⚠️  Less than 4 tables — game may not have started yet');
    return null;
  }

  const awayBatting = parseBatting(tables[0]);
  const awayPitching = parsePitching(tables[1]);
  const homeBatting = parseBatting(tables[2]);
  const homePitching = parsePitching(tables[3]);
  
  console.log(\`  📋 Parsed: \${awayBatting.length} away batters, \${awayPitching.length} away pitchers, \${homeBatting.length} home batters, \${homePitching.length} home pitchers\`);
  if (awayBatting.length > 0) console.log(\`  👤 First batter: \${awayBatting[0].name} #\${awayBatting[0].jersey}\`);`;

if (code.includes(oldParsedLog)) {
  code = code.replace(oldParsedLog, newParsedLog);
  console.log('✅ Added parse logging');
} else {
  console.log('⚠️  Could not add parse logging');
}

fs.writeFileSync(file, code);
console.log('\nDone! Clear DB and re-run:');
console.log("  GC_PASSWORD='Tournaments1234!' node ec-polling-service.mjs");
