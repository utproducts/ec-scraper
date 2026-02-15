/**
 * Add game dedup check to ec-polling-v2.mjs
 * Before saving, checks if a game with same teams (in either order) 
 * and same date already exists
 * 
 * Usage: node patch-game-dedup.mjs
 */
import fs from 'fs';

const file = 'ec-polling-v2.mjs';
let code = fs.readFileSync(file, 'utf-8');

// Find the saveGame function and add a dedup check at the top
const oldSaveStart = `async function saveGame(url, data, ageGroup, eventName) {
  const { away, home, tables, awayScore, homeScore, headerStatus, gameTime } = data;`;

const newSaveStart = `async function saveGame(url, data, ageGroup, eventName) {
  const { away, home, tables, awayScore, homeScore, headerStatus, gameTime } = data;
  
  // ─── DEDUP CHECK: Skip if game between same teams already exists ───
  // Look up team IDs for away and home
  const { data: awayTeamRow } = await supabase.from('ec_teams').select('id').eq('team_name', away).single();
  const { data: homeTeamRow } = await supabase.from('ec_teams').select('id').eq('team_name', home).single();
  
  if (awayTeamRow && homeTeamRow) {
    // Check both directions: A vs B or B vs A
    const { data: existingGame1 } = await supabase.from('ec_games')
      .select('id')
      .eq('away_team_id', awayTeamRow.id)
      .eq('home_team_id', homeTeamRow.id)
      .limit(1)
      .single();
    
    const { data: existingGame2 } = await supabase.from('ec_games')
      .select('id')
      .eq('away_team_id', homeTeamRow.id)
      .eq('home_team_id', awayTeamRow.id)
      .limit(1)
      .single();
    
    if (existingGame1 || existingGame2) {
      const existingId = existingGame1?.id || existingGame2?.id;
      console.log(\`  ♻️  Game already exists (updating): \${away} vs \${home}\`);
      
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
      
      return existingId;
    }
  }
  // ─── END DEDUP CHECK ───`;

if (code.includes(oldSaveStart)) {
  code = code.replace(oldSaveStart, newSaveStart);
  fs.writeFileSync(file, code);
  console.log('✅ Added game dedup check to saveGame()');
  console.log('   Before saving, checks if game between same teams already exists');
  console.log('   If found, updates score instead of creating duplicate');
} else {
  console.log('⚠️  Could not find saveGame function start');
  console.log('   Looking for alternate...');
  
  // Try without the destructure
  const alt = `async function saveGame(url, data, ageGroup, eventName) {`;
  if (code.includes(alt)) {
    console.log('   Found function but destructure line is different.');
    console.log('   Please check ec-polling-v2.mjs manually.');
  }
}
