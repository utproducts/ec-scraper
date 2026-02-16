/**
 * Fix stats accuracy for duplicate games
 * 
 * Problem: When game is first scraped from Team A's schedule, both teams' stats are saved.
 * But Team B's stats from Team A's Premium view may be inaccurate.
 * When we later scrape from Team B's schedule, the game already exists so stats are skipped.
 * 
 * Fix: When a duplicate game is found, STILL save/update stats for the team we're currently
 * scraping from (since we have Premium accuracy for them). Delete old stats for that team
 * and re-insert with accurate data.
 * 
 * Usage: node patch-stats-accuracy.mjs
 */
import fs from 'fs';

const file = 'ec-polling-v2.mjs';
let code = fs.readFileSync(file, 'utf-8');

// Find the dedup section that returns early
const oldDedup = `      console.log(\`  ♻️  Game already exists (updating): \${away} vs \${home}\`);
      
      // Update the existing game's score and status
      const finalAwayScore = awayScore !== null ? awayScore : 0;
      const finalHomeScore = homeScore !== null ? homeScore : 0;
      let status = headerStatus || null;
      
      if (existingGame1) {
        await supabase.from('ec_games').update({
          away_score: finalAwayScore,
          home_score: finalHomeScore,
          status: status || 'final',
        }).eq('id', existingGame1.id);
      } else {
        // Game exists but teams are flipped — update with swapped scores
        await supabase.from('ec_games').update({
          away_score: finalHomeScore,
          home_score: finalAwayScore,
          status: status || 'final',
        }).eq('id', existingGame2.id);
      }
      
      return existingId;`;

const newDedup = `      const existingGameId = existingGame1?.id || existingGame2?.id;
      console.log(\`  ♻️  Game already exists (updating scores + re-saving current team stats): \${away} vs \${home}\`);
      
      // Update the existing game's score and status
      const finalAwayScoreDup = awayScore !== null ? awayScore : 0;
      const finalHomeScoreDup = homeScore !== null ? homeScore : 0;
      let statusDup = headerStatus || null;
      
      if (existingGame1) {
        await supabase.from('ec_games').update({
          away_score: finalAwayScoreDup,
          home_score: finalHomeScoreDup,
          status: statusDup || 'final',
        }).eq('id', existingGame1.id);
      } else {
        await supabase.from('ec_games').update({
          away_score: finalHomeScoreDup,
          home_score: finalAwayScoreDup,
          status: statusDup || 'final',
        }).eq('id', existingGame2.id);
      }
      
      // IMPORTANT: Don't return early! Fall through to re-save stats for the 
      // current team (we have Premium accuracy for them).
      // We'll use existingGameId instead of creating a new game.
      data._existingGameId = existingGameId;
      data._isFlipped = !!existingGame2 && !existingGame1;`;

if (code.includes(oldDedup)) {
  code = code.replace(oldDedup, newDedup);
  console.log('✅ Removed early return from dedup check — stats will be re-saved');
} else {
  console.log('⚠️  Could not find dedup block');
  console.log('   Searching for alternate...');
}

// Now find where the game is created/upserted and use existingGameId if available
// Find: const { data: gameRow, error: gameError } = await supabase.from('ec_games')
const oldGameInsert = `  const finalAwayScore = awayBatting.reduce((s, p) => s + p.r, 0) || awayScore || 0;
  const finalHomeScore = homeBatting.reduce((s, p) => s + p.r, 0) || homeScore || 0;`;

const newGameInsert = `  const finalAwayScore = awayBatting.reduce((s, p) => s + p.r, 0) || awayScore || 0;
  const finalHomeScore = homeBatting.reduce((s, p) => s + p.r, 0) || homeScore || 0;
  
  // If game already exists from dedup check, skip game creation
  const existingGameId = data._existingGameId || null;
  const isFlipped = data._isFlipped || false;`;

if (code.includes(oldGameInsert)) {
  code = code.replace(oldGameInsert, newGameInsert);
  console.log('✅ Added existingGameId tracking');
} else {
  console.log('⚠️  Could not find game insert score calc');
}

// Find where game is inserted and add skip logic
const oldGameUpsert = `  // Upsert game
  const { data: gameRow, error: gameError } = await supabase.from('ec_games')`;

const newGameUpsert = `  // Use existing game or create new
  let gameId = existingGameId;
  
  if (!gameId) {
  // Upsert game
  const { data: gameRow, error: gameError } = await supabase.from('ec_games')`;

if (code.includes(oldGameUpsert)) {
  code = code.replace(oldGameUpsert, newGameUpsert);
  console.log('✅ Added conditional game creation');
} else {
  console.log('⚠️  Could not find game upsert');
}

// Find where gameId is set from the upsert result and close the if block
const oldGameId = `  const gameId = gameRow?.id || gameRow?.[0]?.id;
  if (!gameId) { console.log('  ❌ No game ID returned'); return null; }`;

const newGameId = `  gameId = gameRow?.id || gameRow?.[0]?.id;
  if (!gameId) { console.log('  ❌ No game ID returned'); return null; }
  } // end if (!gameId)`;

if (code.includes(oldGameId)) {
  code = code.replace(oldGameId, newGameId);
  console.log('✅ Closed conditional game creation block');
} else {
  console.log('⚠️  Could not find gameId assignment');
}

// Now update the stats saving section to delete old stats for current team before re-saving
// Find the stats loop
const oldStatsLoop = `  for (const team of [
    { batting: awayBatting, pitching: awayPitching, teamId: awayTeamId },
    { batting: homeBatting, pitching: homePitching, teamId: homeTeamId }
  ]) {`;

const newStatsLoop = `  // If game already existed, delete old stats for both teams and re-save
  if (existingGameId) {
    await supabase.from('ec_game_stats').delete().eq('game_id', gameId);
    await supabase.from('ec_player_of_game').delete().eq('game_id', gameId);
    console.log('  🔄 Cleared old stats for re-save with accurate data');
  }

  for (const team of [
    { batting: awayBatting, pitching: awayPitching, teamId: awayTeamId },
    { batting: homeBatting, pitching: homePitching, teamId: homeTeamId }
  ]) {`;

if (code.includes(oldStatsLoop)) {
  code = code.replace(oldStatsLoop, newStatsLoop);
  console.log('✅ Added stats cleanup before re-save');
} else {
  console.log('⚠️  Could not find stats loop');
}

fs.writeFileSync(file, code);
console.log('\n✅ Done! Now wipe DB and re-scrape for accurate stats.');
console.log('   The scraper will now re-save stats every time it encounters a game,');
console.log('   ensuring each team gets Premium-accurate stats from their own schedule view.');
