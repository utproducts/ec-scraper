/**
 * Run this once to add the POTG API route to server.js
 * Usage: node patch-potg.mjs
 */

import fs from 'fs';

const serverFile = 'server.js';
let code = fs.readFileSync(serverFile, 'utf-8');

// Check if already patched
if (code.includes('/api/ec/potg')) {
  console.log('✅ POTG route already exists in server.js — no changes needed.');
  process.exit(0);
}

const POTG_ROUTE = `
// GET /api/ec/potg — player of the game list
app.get('/api/ec/potg', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ec_player_of_game')
      .select('potg_score, highlights, player:ec_players!player_id(player_name, jersey_number, primary_position), team:ec_teams!team_id(team_name), game:ec_games!game_id(id, home_score, away_score, status, home_team_id, away_team_id)')
      .order('potg_score', { ascending: false });

    if (error) throw error;

    const teamIds = [...new Set((data || []).flatMap(p => [p.game?.home_team_id, p.game?.away_team_id]).filter(Boolean))];
    let teamMap = {};
    if (teamIds.length > 0) {
      const { data: teams } = await supabase.from('ec_teams').select('id, team_name').in('id', teamIds);
      (teams || []).forEach(t => teamMap[t.id] = t.team_name);
    }

    const potg = (data || []).map(p => ({
      name: p.player?.player_name,
      jersey: p.player?.jersey_number,
      position: p.player?.primary_position || '',
      team: p.team?.team_name,
      score: p.potg_score,
      highlights: p.highlights,
      isLive: p.game?.status === 'live',
      game: (teamMap[p.game?.away_team_id] || 'Away') + ' ' + (p.game?.away_score || 0) + ', ' + (teamMap[p.game?.home_team_id] || 'Home') + ' ' + (p.game?.home_score || 0),
    }));

    res.json({ potg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

`;

// Insert before the "Event Central API routes loaded" line
const marker = "console.log('✅ Event Central API routes loaded');";
if (code.includes(marker)) {
  code = code.replace(marker, POTG_ROUTE + marker);
  fs.writeFileSync(serverFile, code);
  console.log('✅ POTG route added to server.js!');
} else {
  // Fallback: insert before "// Start server"
  const fallback = '// Start server';
  code = code.replace(fallback, POTG_ROUTE + fallback);
  fs.writeFileSync(serverFile, code);
  console.log('✅ POTG route added to server.js (before Start server)!');
}
