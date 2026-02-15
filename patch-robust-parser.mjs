/**
 * Bulletproof parser fix — handles all youth baseball data edge cases
 * 
 * Handles:
 *   "Nolan S" → "#24 (LF)" → stats          (normal)
 *   "Dylan M" → "(1B)" → stats               (no jersey number)
 *   "Jeremiah C" → stats                      (no jersey/position at all)
 *   "Brayden K" → "(LF)" → stats             (no jersey number)  
 *   "Trevor" → "#26" → stats                  (jersey but no position)
 *   "RJ D" → "(RF)" → stats                   (no jersey number)
 *
 * Usage: node patch-robust-parser.mjs
 */

import fs from 'fs';

const file = 'ec-polling-service.mjs';
let code = fs.readFileSync(file, 'utf-8');

// Find and replace parseBatting
const startMarker = '// ─── PARSE STATS';
const endMarker = 'function parsePitching';

const startIdx = code.indexOf(startMarker);
const endIdx = code.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
  console.log('⚠️  Could not find parse section markers');
  process.exit(1);
}

// Also find end of parsePitching
const pitchingEnd = code.indexOf('// ─── SAVE TO SUPABASE');
if (pitchingEnd === -1) {
  console.log('⚠️  Could not find SAVE TO SUPABASE marker');
  process.exit(1);
}

const before = code.substring(0, startIdx);
const after = code.substring(pitchingEnd);

const newParsers = `// ─── PARSE STATS ─────────────────────────────────────────

function isStatNumber(str) {
  // Check if a string looks like a stat number (integer or IP like 3.2)
  return /^\\d+(\\.\\d)?$/.test(str);
}

function parseBatting(tableText) {
  const lines = tableText.split('\\n').map(l => l.trim()).filter(l => l);
  const players = [];
  
  // Skip header row — LINEUP, AB, R, H, RBI, BB, SO
  let i = 0;
  const headers = new Set(['LINEUP', 'AB', 'R', 'H', 'RBI', 'BB', 'SO']);
  while (i < lines.length && headers.has(lines[i])) i++;
  
  while (i < lines.length) {
    if (lines[i] === 'TEAM') break;
    
    const name = lines[i];
    i++;
    if (i >= lines.length) break;
    
    let jersey = '';
    let pos = '';
    
    // Figure out what the next line is:
    // Option A: "#24 (LF)" or "#99 (3B, P)" — jersey + position
    // Option B: "#26" — jersey only, no position
    // Option C: "(1B)" or "(LF)" — position only, no jersey
    // Option D: "3" — it's already a stat number (no jersey/position at all)
    
    const nextLine = lines[i];
    
    if (nextLine.startsWith('#')) {
      // Has jersey number: "#24 (LF)" or "#26"
      const jMatch = nextLine.match(/^#(\\d+)\\s*(?:\\(([^)]+)\\))?/);
      if (jMatch) {
        jersey = jMatch[1];
        pos = jMatch[2] || '';
      }
      i++;
    } else if (nextLine.startsWith('(')) {
      // Position only, no jersey: "(1B)" or "(LF)"
      const pMatch = nextLine.match(/^\\(([^)]+)\\)/);
      if (pMatch) {
        pos = pMatch[1];
      }
      i++;
    } else if (isStatNumber(nextLine)) {
      // No jersey or position at all — this IS the first stat
      // Don't advance i — we'll read stats starting here
    } else {
      // Unknown format — try to skip it
      i++;
    }
    
    // Read 6 stat values: AB, R, H, RBI, BB, SO
    if (i + 5 < lines.length && isStatNumber(lines[i])) {
      const ab = parseInt(lines[i]) || 0;
      const r = parseInt(lines[i + 1]) || 0;
      const h = parseInt(lines[i + 2]) || 0;
      const rbi = parseInt(lines[i + 3]) || 0;
      const bb = parseInt(lines[i + 4]) || 0;
      const so = parseInt(lines[i + 5]) || 0;
      
      players.push({ name, jersey, pos, ab, r, h, rbi, bb, so });
      i += 6;
    } else {
      // Can't find stats — skip this entry
      continue;
    }
  }
  
  return players;
}

function parsePitching(tableText) {
  const lines = tableText.split('\\n').map(l => l.trim()).filter(l => l);
  const pitchers = [];
  
  // Skip headers: PITCHING, IP, H, R, ER, BB, SO
  let i = 0;
  const headers = new Set(['PITCHING', 'IP', 'H', 'R', 'ER', 'BB', 'SO']);
  while (i < lines.length && headers.has(lines[i])) i++;
  
  while (i < lines.length) {
    if (lines[i] === 'TEAM') break;
    
    const name = lines[i];
    i++;
    if (i >= lines.length) break;
    
    let jersey = '';
    const nextLine = lines[i];
    
    if (nextLine.startsWith('#')) {
      const jMatch = nextLine.match(/^#(\\d+)/);
      if (jMatch) jersey = jMatch[1];
      i++;
    } else if (nextLine.startsWith('(')) {
      // Position only
      i++;
    } else if (isStatNumber(nextLine)) {
      // No jersey — stats start here
    } else {
      i++;
    }
    
    // Read 6 stat values: IP, H, R, ER, BB, SO
    if (i + 5 < lines.length && isStatNumber(lines[i])) {
      const ip = parseFloat(lines[i]) || 0;
      const h = parseInt(lines[i + 1]) || 0;
      const r = parseInt(lines[i + 2]) || 0;
      const er = parseInt(lines[i + 3]) || 0;
      const bb = parseInt(lines[i + 4]) || 0;
      const so = parseInt(lines[i + 5]) || 0;
      
      pitchers.push({ name, jersey, ip, h, r, er, bb, so });
      i += 6;
    } else {
      continue;
    }
  }
  
  return pitchers;
}

`;

code = before + newParsers + after;
fs.writeFileSync(file, code);
console.log('✅ Both parsers replaced with bulletproof versions!');
console.log('   Handles: jersey+pos, jersey only, pos only, and NO jersey/pos');
console.log('\\nClear DB and re-run:');
console.log('  1. Clear DB in Supabase SQL Editor');
console.log("  2. GC_PASSWORD='Tournaments1234!' node ec-polling-service.mjs");
