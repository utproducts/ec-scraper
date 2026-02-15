/**
 * Fix parseBatting — direct string replacement
 * Usage: node patch-batting-fix.mjs
 */

import fs from 'fs';

const file = 'ec-polling-service.mjs';
let code = fs.readFileSync(file, 'utf-8');

// Find the current parseBatting function — search for it between markers
const startMarker = '// ─── PARSE STATS';
const endMarker = 'function parsePitching';

const startIdx = code.indexOf(startMarker);
const endIdx = code.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
  console.log('⚠️  Could not find parse section markers');
  process.exit(1);
}

// Replace everything between the markers
const before = code.substring(0, startIdx);
const after = code.substring(endIdx);

const newParseBatting = `// ─── PARSE STATS ─────────────────────────────────────────
function parseBatting(tableText) {
  const lines = tableText.split('\\n').map(l => l.trim()).filter(l => l);
  const players = [];
  
  // Find where headers end — headers are LINEUP, AB, R, H, RBI, BB, SO
  let i = 0;
  const headers = new Set(['LINEUP', 'AB', 'R', 'H', 'RBI', 'BB', 'SO']);
  while (i < lines.length && headers.has(lines[i])) i++;
  
  // Now parse player rows: Name, #Jersey (Pos), then 6 stat numbers
  while (i < lines.length) {
    if (lines[i] === 'TEAM') break;
    
    const name = lines[i];
    i++;
    
    // Next should be jersey line like "#24 (LF)" or "#99 (3B, P)"
    let jersey = '';
    let pos = '';
    if (i < lines.length && lines[i].startsWith('#')) {
      const jLine = lines[i];
      const jMatch = jLine.match(/^#(\\d+)\\s*(?:\\(([^)]+)\\))?/);
      if (jMatch) {
        jersey = jMatch[1];
        pos = jMatch[2] || '';
      }
      i++;
    }
    
    // Next 6 lines are stats: AB, R, H, RBI, BB, SO
    if (i + 5 < lines.length) {
      const ab = parseInt(lines[i]) || 0;
      const r = parseInt(lines[i + 1]) || 0;
      const h = parseInt(lines[i + 2]) || 0;
      const rbi = parseInt(lines[i + 3]) || 0;
      const bb = parseInt(lines[i + 4]) || 0;
      const so = parseInt(lines[i + 5]) || 0;
      
      players.push({ name, jersey, pos, ab, r, h, rbi, bb, so });
      i += 6;
    } else {
      break;
    }
  }
  
  return players;
}

`;

code = before + newParseBatting + after;
fs.writeFileSync(file, code);
console.log('✅ parseBatting() completely replaced!');
console.log('\\nNow run:');
console.log("  GC_PASSWORD='Tournaments1234!' node ec-polling-service.mjs");
