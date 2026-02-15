/**
 * Fix POTG duplicates — deduplicate by player name + game score combo
 * Usage: node patch-potg-dedup.mjs
 */
import fs from 'fs';

const file = 'server.js';
let code = fs.readFileSync(file, 'utf-8');

// Find the POTG formatting/response section and add dedup
// Look for where potg results are mapped and sent
const oldPotgMap = `res.json({ potg: results });`;

const newPotgMap = `// Deduplicate — same player + same game = keep highest score only
      const seen = new Set();
      const deduped = results.filter(r => {
        const key = (r.name || '') + '|' + (r.game || '') + '|' + (r.team || '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      
      res.json({ potg: deduped });`;

if (code.includes(oldPotgMap)) {
  code = code.replace(oldPotgMap, newPotgMap);
  fs.writeFileSync(file, code);
  console.log('✅ POTG deduplication added!');
} else {
  console.log('⚠️  Could not find POTG response line. Searching...');
  
  // Try alternate pattern
  const alt = `res.json({ potg: results })`;
  if (code.includes(alt)) {
    code = code.replace(alt, `// Deduplicate
      const seen = new Set();
      const deduped = results.filter(r => {
        const key = (r.name || '') + '|' + (r.game || '') + '|' + (r.team || '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      res.json({ potg: deduped })`);
    fs.writeFileSync(file, code);
    console.log('✅ POTG deduplication added (alt match)!');
  } else {
    console.log('❌ Could not find POTG response. Manual fix needed.');
  }
}
