/**
 * Add team name normalization to ec-polling-v2.mjs
 * Maps duplicate/variant team names to their canonical names
 * 
 * Also cleans up existing bad data in Supabase
 * 
 * Usage: node patch-team-aliases.mjs
 */
import fs from 'fs';

const file = 'ec-polling-v2.mjs';
let code = fs.readFileSync(file, 'utf-8');

// Add the alias map and normalizer function after the sleep helper
const aliasCode = `
// ─── TEAM NAME NORMALIZATION ─────────────────────────────────
const TEAM_ALIASES = {
  'Ballplex Bolts 11U': 'Ballplex Academy 11U',
  'Warriors 11U': 'Warriors Baseball Club Orange 11U',
  'tc elite 11u': 'TC ELITE 11U',
  'TC ELITE 11U 11U': 'TC ELITE 11U',
  'Tc Elite 11u': 'TC ELITE 11U',
  'TC Elite 11U': 'TC ELITE 11U',
  'TC ELITE 11U 11u': 'TC ELITE 11U',
};

function normalizeTeamName(name) {
  if (!name) return name;
  // Check exact alias match
  if (TEAM_ALIASES[name]) return TEAM_ALIASES[name];
  // Check case-insensitive
  const lower = name.toLowerCase();
  for (const [alias, canonical] of Object.entries(TEAM_ALIASES)) {
    if (alias.toLowerCase() === lower) return canonical;
  }
  // Strip "TBD-" placeholder names — return as-is but flagged
  // Remove trailing duplicate age groups like "11U 11U" -> "11U"
  const deduped = name.replace(/(\\d+U)\\s+\\1/i, '$1');
  if (deduped !== name) return deduped;
  return name;
}
`;

const sleepLine = `const sleep = (ms) => new Promise(r => setTimeout(r, ms));`;
if (code.includes(sleepLine)) {
  code = code.replace(sleepLine, sleepLine + '\n' + aliasCode);
  console.log('✅ Added team alias map and normalizeTeamName()');
}

// Now wrap the team names in scrapeGame results through normalizer
// Find where away/home are extracted and normalize them
const oldAwayHome = `const data = await page.evaluate(() => {
      const away = document.querySelector('[data-testid="away-team-name"]')?.innerText?.trim() || '';
      const home = document.querySelector('[data-testid="home-team-name"]')?.innerText?.trim() || '';`;

const newAwayHome = `const rawData = await page.evaluate(() => {
      const away = document.querySelector('[data-testid="away-team-name"]')?.innerText?.trim() || '';
      const home = document.querySelector('[data-testid="home-team-name"]')?.innerText?.trim() || '';`;

if (code.includes(oldAwayHome)) {
  code = code.replace(oldAwayHome, newAwayHome);
  console.log('✅ Changed data to rawData in scrapeGame');
}

// Find where data is returned and add normalization
const oldReturnData = `    if (!data.away && !data.home) return null;
    return data;`;

const newReturnData = `    if (!rawData.away && !rawData.home) return null;
    // Normalize team names
    rawData.away = normalizeTeamName(rawData.away);
    rawData.home = normalizeTeamName(rawData.home);
    return rawData;`;

if (code.includes(oldReturnData)) {
  code = code.replace(oldReturnData, newReturnData);
  console.log('✅ Added team name normalization to scrapeGame output');
} else {
  console.log('⚠️  Could not find return data block, trying alternate...');
  // The variable might still be called 'data' in the return
  const alt = `return { away, home, tables, awayScore, homeScore, headerStatus, lineScore, gameTime };`;
  if (code.includes(alt)) {
    // This is inside page.evaluate so we can't call normalizeTeamName there
    // Instead normalize after the evaluate
    const afterEval = `    if (!data.away && !data.home) return null;`;
    const afterEvalNew = `    if (!rawData.away && !rawData.home) return null;
    rawData.away = normalizeTeamName(rawData.away);
    rawData.home = normalizeTeamName(rawData.home);`;
    if (code.includes(afterEval)) {
      code = code.replace(afterEval, afterEvalNew);
      console.log('✅ Added normalization after evaluate (alt)');
    }
  }
}

// Fix remaining references to 'data' that should be 'rawData'
// The return statement after evaluate
code = code.replace(
  /return { away, home, tables, awayScore, homeScore, headerStatus, lineScore, gameTime };\n\s*}\);\n\n\s*if \(!rawData/,
  'return { away, home, tables, awayScore, homeScore, headerStatus, lineScore, gameTime };\n    });\n\n    if (!rawData'
);

fs.writeFileSync(file, code);

// Also create a SQL cleanup script
const sql = `-- Clean up duplicate teams in Supabase
-- Run this in the Supabase SQL Editor

-- Step 1: See all teams
SELECT id, team_name FROM ec_teams ORDER BY team_name;

-- Step 2: Merge "Ballplex Bolts 11U" into "Ballplex Academy 11U"
UPDATE ec_game_stats SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Academy 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Bolts 11U');

UPDATE ec_games SET away_team_id = (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Academy 11U' LIMIT 1)
WHERE away_team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Bolts 11U');

UPDATE ec_games SET home_team_id = (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Academy 11U' LIMIT 1)
WHERE home_team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Bolts 11U');

UPDATE ec_players SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Academy 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Bolts 11U');

UPDATE ec_player_of_game SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Academy 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Bolts 11U');

DELETE FROM ec_teams WHERE team_name = 'Ballplex Bolts 11U';

-- Step 3: Merge "Warriors 11U" into "Warriors Baseball Club Orange 11U"
UPDATE ec_game_stats SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'Warriors Baseball Club Orange 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Warriors 11U');

UPDATE ec_games SET away_team_id = (SELECT id FROM ec_teams WHERE team_name = 'Warriors Baseball Club Orange 11U' LIMIT 1)
WHERE away_team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Warriors 11U');

UPDATE ec_games SET home_team_id = (SELECT id FROM ec_teams WHERE team_name = 'Warriors Baseball Club Orange 11U' LIMIT 1)
WHERE home_team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Warriors 11U');

UPDATE ec_players SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'Warriors Baseball Club Orange 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Warriors 11U');

UPDATE ec_player_of_game SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'Warriors Baseball Club Orange 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Warriors 11U');

DELETE FROM ec_teams WHERE team_name = 'Warriors 11U';

-- Step 4: Merge TC ELITE variants into "TC ELITE 11U"
UPDATE ec_game_stats SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'TC ELITE 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name IN ('tc elite 11u', 'TC ELITE 11U 11U'));

UPDATE ec_games SET away_team_id = (SELECT id FROM ec_teams WHERE team_name = 'TC ELITE 11U' LIMIT 1)
WHERE away_team_id IN (SELECT id FROM ec_teams WHERE team_name IN ('tc elite 11u', 'TC ELITE 11U 11U'));

UPDATE ec_games SET home_team_id = (SELECT id FROM ec_teams WHERE team_name = 'TC ELITE 11U' LIMIT 1)
WHERE home_team_id IN (SELECT id FROM ec_teams WHERE team_name IN ('tc elite 11u', 'TC ELITE 11U 11U'));

UPDATE ec_players SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'TC ELITE 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name IN ('tc elite 11u', 'TC ELITE 11U 11U'));

UPDATE ec_player_of_game SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'TC ELITE 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name IN ('tc elite 11u', 'TC ELITE 11U 11U'));

DELETE FROM ec_teams WHERE team_name IN ('tc elite 11u', 'TC ELITE 11U 11U');

-- Step 5: Check what's left
SELECT id, team_name FROM ec_teams ORDER BY team_name;
`;

fs.writeFileSync('cleanup-teams.sql', sql);
console.log('✅ Created cleanup-teams.sql — run in Supabase SQL Editor');
console.log('\nDo both:');
console.log('  1. Run cleanup-teams.sql in Supabase to fix existing data');
console.log('  2. Restart scraper to use normalized names going forward');
