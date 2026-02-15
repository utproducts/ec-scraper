/**
 * Add age group filtering + minimum requirements + all-tournament team
 * to server.js API endpoints
 * 
 * Usage: node patch-age-filter.mjs
 */
import fs from 'fs';

const file = 'server.js';
let code = fs.readFileSync(file, 'utf-8');

// ─── 1. Replace /api/ec/games to support ?age_group filter ───
const oldGames = `app.get('/api/ec/games', async (req, res) => {
  try {
    let query = supabase
      .from('ec_games')
      .select('*, away_team:ec_teams!away_team_id(team_name), home_team:ec_teams!home_team_id(team_name)')
      .order('game_date', { ascending: false });`;

const newGames = `app.get('/api/ec/games', async (req, res) => {
  try {
    let query = supabase
      .from('ec_games')
      .select('*, away_team:ec_teams!away_team_id(team_name), home_team:ec_teams!home_team_id(team_name)')
      .order('game_date', { ascending: false });
    
    if (req.query.age_group) query = query.eq('age_group', req.query.age_group);
    if (req.query.event_name) query = query.eq('event_name', req.query.event_name);`;

if (code.includes(oldGames)) {
  code = code.replace(oldGames, newGames);
  console.log('✅ Games endpoint: added age_group + event_name filters');
}

// ─── 2. Replace leaderboards with min AB/IP requirements ───
// Find the leaderboards endpoint and replace it entirely
const leaderboardStart = "app.get('/api/ec/leaderboards'";
const leaderboardIdx = code.indexOf(leaderboardStart);

if (leaderboardIdx !== -1) {
  // Find the end of this route handler
  let braceCount = 0;
  let endIdx = leaderboardIdx;
  let foundFirstBrace = false;
  for (let i = leaderboardIdx; i < code.length; i++) {
    if (code[i] === '{') { braceCount++; foundFirstBrace = true; }
    if (code[i] === '}') braceCount--;
    if (foundFirstBrace && braceCount === 0) { endIdx = i + 1; break; }
  }
  // Find the closing ");
  while (endIdx < code.length && code[endIdx] !== ';') endIdx++;
  endIdx++;

  const newLeaderboard = `app.get('/api/ec/leaderboards', async (req, res) => {
  try {
    const ageGroup = req.query.age_group || null;
    const eventName = req.query.event_name || null;
    const minAB = parseInt(req.query.min_ab) || 5;
    const minIP = parseInt(req.query.min_ip) || 5;

    // Get games for this age group/event
    let gamesQuery = supabase.from('ec_games').select('id');
    if (ageGroup) gamesQuery = gamesQuery.eq('age_group', ageGroup);
    if (eventName) gamesQuery = gamesQuery.eq('event_name', eventName);
    const { data: games } = await gamesQuery;
    const gameIds = (games || []).map(g => g.id);
    
    if (gameIds.length === 0) return res.json({ batting: [], pitching: [] });

    // Get all stats for these games
    const { data: stats } = await supabase
      .from('ec_game_stats')
      .select('*, player:ec_players!player_id(player_name, jersey_number), team:ec_teams!team_id(team_name)')
      .in('game_id', gameIds);

    // Aggregate batting stats by player
    const batters = {};
    const pitchers = {};

    for (const s of (stats || [])) {
      const pid = s.player_id;
      const name = s.player?.player_name || 'Unknown';
      const team = s.team?.team_name || 'Unknown';
      const jersey = s.player?.jersey_number || '';

      if (s.stat_type === 'batting') {
        if (!batters[pid]) batters[pid] = { name, team, jersey, ab: 0, r: 0, h: 0, rbi: 0, bb: 0, so: 0, games: 0 };
        batters[pid].ab += s.ab || 0;
        batters[pid].r += s.r || 0;
        batters[pid].h += s.h || 0;
        batters[pid].rbi += s.rbi || 0;
        batters[pid].bb += s.bb || 0;
        batters[pid].so += s.so || 0;
        batters[pid].games++;
      }

      if (s.stat_type === 'pitching') {
        if (!pitchers[pid]) pitchers[pid] = { name, team, jersey, ip: 0, h: 0, r: 0, er: 0, bb: 0, so: 0, games: 0 };
        pitchers[pid].ip += s.ip || 0;
        pitchers[pid].h += s.p_h || 0;
        pitchers[pid].r += s.p_r || 0;
        pitchers[pid].er += s.p_er || 0;
        pitchers[pid].bb += s.p_bb || 0;
        pitchers[pid].so += s.p_so || 0;
        pitchers[pid].games++;
      }
    }

    // Calculate batting averages — filter by minimum AB
    const battingLeaders = Object.values(batters)
      .filter(b => b.ab >= minAB)
      .map(b => ({
        ...b,
        avg: b.ab > 0 ? (b.h / b.ab).toFixed(3) : '.000',
        obp: (b.ab + b.bb) > 0 ? ((b.h + b.bb) / (b.ab + b.bb)).toFixed(3) : '.000',
        slg: b.ab > 0 ? ((b.h * 1.0 + (b.doubles || 0) * 1.0 + (b.triples || 0) * 2.0 + (b.hr || 0) * 3.0) / b.ab).toFixed(3) : '.000',
      }))
      .sort((a, b) => parseFloat(b.avg) - parseFloat(a.avg))
      .slice(0, 15);

    // Calculate pitching leaders — filter by minimum IP
    const pitchingLeaders = Object.values(pitchers)
      .filter(p => p.ip >= minIP)
      .map(p => ({
        ...p,
        era: p.ip > 0 ? ((p.er / p.ip) * 7).toFixed(2) : '0.00',
        whip: p.ip > 0 ? ((p.bb + p.h) / p.ip).toFixed(2) : '0.00',
        kPerGame: p.ip > 0 ? ((p.so / p.ip) * 7).toFixed(1) : '0.0',
      }))
      .sort((a, b) => parseFloat(a.era) - parseFloat(b.era))
      .slice(0, 15);

    res.json({ batting: battingLeaders, pitching: pitchingLeaders, minAB, minIP });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});`;

  code = code.substring(0, leaderboardIdx) + newLeaderboard + code.substring(endIdx);
  console.log('✅ Leaderboards: added age_group filter + min AB/IP requirements');
}

// ─── 3. Add All-Tournament Team endpoint ───
const allTourneyEndpoint = `
// GET /api/ec/all-tournament — Top 15 performers by weighted score
app.get('/api/ec/all-tournament', async (req, res) => {
  try {
    const ageGroup = req.query.age_group || null;
    const eventName = req.query.event_name || null;
    const minAB = parseInt(req.query.min_ab) || 5;
    const minIP = parseInt(req.query.min_ip) || 5;

    // Get games
    let gamesQuery = supabase.from('ec_games').select('id');
    if (ageGroup) gamesQuery = gamesQuery.eq('age_group', ageGroup);
    if (eventName) gamesQuery = gamesQuery.eq('event_name', eventName);
    const { data: games } = await gamesQuery;
    const gameIds = (games || []).map(g => g.id);
    
    if (gameIds.length === 0) return res.json({ team: [] });

    const { data: stats } = await supabase
      .from('ec_game_stats')
      .select('*, player:ec_players!player_id(player_name, jersey_number), team:ec_teams!team_id(team_name)')
      .in('game_id', gameIds);

    // Aggregate + score each player
    const players = {};
    for (const s of (stats || [])) {
      const pid = s.player_id;
      if (!players[pid]) {
        players[pid] = {
          name: s.player?.player_name || 'Unknown',
          team: s.team?.team_name || 'Unknown',
          jersey: s.player?.jersey_number || '',
          score: 0, ab: 0, h: 0, r: 0, rbi: 0, bb: 0, so: 0,
          ip: 0, p_so: 0, p_er: 0, games: new Set(),
          highlights: [],
        };
      }
      players[pid].games.add(s.game_id);

      if (s.stat_type === 'batting') {
        const ab = s.ab || 0, h = s.h || 0, r = s.r || 0, rbi = s.rbi || 0, bb = s.bb || 0, so = s.so || 0;
        players[pid].ab += ab;
        players[pid].h += h;
        players[pid].r += r;
        players[pid].rbi += rbi;
        players[pid].bb += bb;
        players[pid].so += so;
        // Batting score
        const singles = h - (s.doubles || 0) - (s.triples || 0) - (s.hr || 0);
        players[pid].score += (singles * 2) + ((s.hr || 0) * 5) + (rbi * 2) + (r * 1.5) + (bb * 1) + (so * -0.5);
      }

      if (s.stat_type === 'pitching') {
        const ip = s.ip || 0, pso = s.p_so || 0, per = s.p_er || 0, pbb = s.p_bb || 0, ph = s.p_h || 0;
        players[pid].ip += ip;
        players[pid].p_so += pso;
        players[pid].p_er += per;
        // Pitching score
        players[pid].score += (ip * 3) + (pso * 2) + (per * -2) + (pbb * -1) + (ph * -0.5);
      }
    }

    // Filter: must meet minimum AB OR minimum IP
    const eligible = Object.values(players)
      .filter(p => p.ab >= minAB || p.ip >= minIP)
      .map(p => {
        const avg = p.ab > 0 ? (p.h / p.ab).toFixed(3) : null;
        const era = p.ip > 0 ? ((p.p_er / p.ip) * 7).toFixed(2) : null;
        const gamesPlayed = p.games.size;
        
        // Build highlight string
        const parts = [];
        if (p.ab > 0) parts.push(p.h + '-for-' + p.ab + ' (' + avg + ')');
        if (p.rbi > 0) parts.push(p.rbi + ' RBI');
        if (p.r > 0) parts.push(p.r + ' R');
        if (p.ip > 0) parts.push(p.ip + ' IP');
        if (p.p_so > 0) parts.push(p.p_so + ' K');
        
        return {
          name: p.name,
          team: p.team,
          jersey: p.jersey,
          score: Math.round(p.score * 10) / 10,
          avg, era,
          ab: p.ab, h: p.h, r: p.r, rbi: p.rbi, bb: p.bb, so: p.so,
          ip: p.ip, p_so: p.p_so, p_er: p.p_er,
          games: gamesPlayed,
          highlights: parts.join(', '),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);

    res.json({ 
      team: eligible, 
      ageGroup: ageGroup || 'All',
      eventName: eventName || 'All Events',
      minAB, minIP 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
`;

// Insert the all-tournament endpoint before the POTG endpoint
const potgMarker = "app.get('/api/ec/potg'";
const potgIdx = code.indexOf(potgMarker);
if (potgIdx !== -1) {
  code = code.substring(0, potgIdx) + allTourneyEndpoint + '\n' + code.substring(potgIdx);
  console.log('✅ Added /api/ec/all-tournament endpoint (Top 15 weighted performers)');
}

// ─── 4. Update POTG endpoint to support age_group filter ───
const oldPotg = "app.get('/api/ec/potg', async (req, res) => {\n  try {\n    const { data, error } = await supabase\n      .from('ec_player_of_game')\n      .select('potg_score, highlights, player:ec_players!player_id(player_name, jersey_number, primary_position), team:ec_teams!team_id(team_name), game:ec_games!game_id(id, home_score, away_score, status, home_team_id, away_team_id)')";

const newPotg = "app.get('/api/ec/potg', async (req, res) => {\n  try {\n    let potgQuery = supabase\n      .from('ec_player_of_game')\n      .select('potg_score, highlights, player:ec_players!player_id(player_name, jersey_number, primary_position), team:ec_teams!team_id(team_name), game:ec_games!game_id(id, home_score, away_score, status, home_team_id, away_team_id, age_group, event_name)')";

if (code.includes(oldPotg)) {
  code = code.replace(oldPotg, newPotg);
  
  // Also need to add filtering after the query
  const oldOrder = ".order('potg_score', { ascending: false });";
  const newOrder = ".order('potg_score', { ascending: false });\n    const { data, error } = await potgQuery;";
  
  // Replace the old pattern where data comes directly from the select
  code = code.replace(
    ".order('potg_score', { ascending: false });\n\n    if (error) throw error;",
    ".order('potg_score', { ascending: false });\n    const { data, error } = await potgQuery;\n\n    if (error) throw error;"
  );
  
  console.log('✅ POTG endpoint: added age_group to game select');
}

// ─── 5. Add /api/ec/age-groups endpoint ───
const ageGroupsEndpoint = `
// GET /api/ec/age-groups — List available age groups and events
app.get('/api/ec/age-groups', async (req, res) => {
  try {
    const { data } = await supabase
      .from('ec_games')
      .select('age_group, event_name')
      .not('age_group', 'is', null);
    
    const groups = {};
    for (const g of (data || [])) {
      const key = g.age_group || 'Unknown';
      if (!groups[key]) groups[key] = new Set();
      if (g.event_name) groups[key].add(g.event_name);
    }
    
    const result = Object.entries(groups).map(([age, events]) => ({
      age_group: age,
      events: [...events],
    })).sort((a, b) => {
      const numA = parseInt(a.age_group) || 99;
      const numB = parseInt(b.age_group) || 99;
      return numA - numB;
    });
    
    res.json({ age_groups: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
`;

// Insert before the games endpoint
const gamesMarker = "app.get('/api/ec/games'";
const gamesIdx = code.indexOf(gamesMarker);
if (gamesIdx !== -1) {
  code = code.substring(0, gamesIdx) + ageGroupsEndpoint + '\n' + code.substring(gamesIdx);
  console.log('✅ Added /api/ec/age-groups endpoint');
}

fs.writeFileSync(file, code);
console.log('\nDone! New endpoints:');
console.log('  GET /api/ec/age-groups — list available age groups');
console.log('  GET /api/ec/games?age_group=11U — filter games by age');
console.log('  GET /api/ec/leaderboards?age_group=11U&min_ab=5&min_ip=5 — with minimums');
console.log('  GET /api/ec/all-tournament?age_group=11U — Top 15 performers');
console.log('  GET /api/ec/potg?age_group=11U — POTG by age group');
