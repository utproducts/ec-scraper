/**
 * Test: Scrape a game and save it to Supabase
 * 
 * Run: node test-gc-to-supabase.mjs
 */

import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const GC_EMAIL = process.env.GC_EMAIL || 'steve.hassett@usssa.org';
const GC_PASSWORD = process.env.GC_PASSWORD || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TEST_URL = 'https://web.gc.com/teams/D4CK5E1BGDsq/schedule/b60bffc5-0679-41fd-942f-49e782f9ad85/box-score';

async function main() {
  console.log('Starting scrape + save test...\n');

  if (!GC_PASSWORD) {
    console.log('ERROR: Run like this:');
    console.log("GC_PASSWORD='Tournaments1234!' node test-gc-to-supabase.mjs");
    process.exit(1);
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('ERROR: SUPABASE_URL or SUPABASE_KEY not found in .env file');
    process.exit(1);
  }

  console.log('Supabase URL:', SUPABASE_URL);
  console.log('');

  // ─── STEP 1: SCRAPE THE GAME ────────────────────────────
  console.log('=== STEP 1: SCRAPE THE GAME ===\n');

  const browser = await puppeteer.launch({
    headless: 'new', // Run in background this time
    args: ['--no-sandbox', '--window-size=1920,1080'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // Login
  console.log('Logging in to GameChanger...');
  await page.goto('https://web.gc.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  const emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
  await emailInput.type(GC_EMAIL, { delay: 50 });
  const passwordInput = await page.$('input[type="password"]');
  if (passwordInput) await passwordInput.type(GC_PASSWORD, { delay: 50 });
  const submitBtn = await page.$('button[type="submit"]');
  if (submitBtn) await submitBtn.click();
  await sleep(5000);

  if (page.url().includes('/login')) {
    console.log('ERROR: Login failed');
    await browser.close();
    return;
  }
  console.log('Logged in!\n');

  // Navigate to box score
  console.log('Loading box score...');
  await page.goto(TEST_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(5000);

  // Extract data
  const data = await page.evaluate(() => {
    const result = { tables: [], legend: [], homeTeam: '', awayTeam: '' };
    const home = document.querySelector('[data-testid="home-team-name"]');
    const away = document.querySelector('[data-testid="away-team-name"]');
    if (home) result.homeTeam = home.innerText.trim();
    if (away) result.awayTeam = away.innerText.trim();
    const dataTables = document.querySelectorAll('[data-testid="data-table"]');
    for (let i = 0; i < dataTables.length; i++) {
      result.tables.push({ index: i, text: dataTables[i].innerText });
    }
    const legends = document.querySelectorAll('[data-testid="box-score-legend"]');
    for (const l of legends) result.legend.push(l.innerText);
    return result;
  });

  await browser.close();
  console.log('Scraped! Away:', data.awayTeam, '| Home:', data.homeTeam);
  console.log('Tables found:', data.tables.length, '\n');

  // ─── STEP 2: PARSE THE DATA ─────────────────────────────
  console.log('=== STEP 2: PARSE THE DATA ===\n');

  const teams = [];
  for (const table of data.tables) {
    const lines = table.text.split('\n').map(l => l.trim()).filter(Boolean);
    
    if (lines[0] === 'LINEUP') {
      const players = parseBatting(lines);
      teams.push({ type: 'batting', tableIndex: table.index, players });
      console.log('Parsed batting: ' + players.length + ' players');
    }
    if (lines[0] === 'PITCHING') {
      const pitchers = parsePitching(lines);
      teams.push({ type: 'pitching', tableIndex: table.index, pitchers });
      console.log('Parsed pitching: ' + pitchers.length + ' pitchers');
    }
  }
  console.log('');

  // ─── STEP 3: SAVE TO SUPABASE ───────────────────────────
  console.log('=== STEP 3: SAVE TO SUPABASE ===\n');

  // 3a. Create or find the two teams
  const awayTeamRecord = await findOrCreateTeam(data.awayTeam, 'UWz8I5X3ypcu');
  const homeTeamRecord = await findOrCreateTeam(data.homeTeam, null);
  console.log('Away team:', awayTeamRecord.team_name, '(id:', awayTeamRecord.id, ')');
  console.log('Home team:', homeTeamRecord.team_name, '(id:', homeTeamRecord.id, ')');

  // 3b. Create the game record
  const gameRecord = await findOrCreateGame(
    '1b0de349-3adf-47da-b5e6-ade2a1f02391',
    awayTeamRecord.id,
    homeTeamRecord.id,
    15, // away score (11u Scorps)
    5,  // home score (Central Florida Suns)
    '2026-01-25'
  );
  console.log('Game:', gameRecord.id, '| Status:', gameRecord.status);

  // 3c. Save player stats
  // Tables 0,1 = away team (11u Scorps), Tables 2,3 = home team
  const awayBatting = teams.find(t => t.type === 'batting' && t.tableIndex === 0);
  const awayPitching = teams.find(t => t.type === 'pitching' && t.tableIndex === 1);
  const homeBatting = teams.find(t => t.type === 'batting' && t.tableIndex === 2);
  const homePitching = teams.find(t => t.type === 'pitching' && t.tableIndex === 3);

  let statsSaved = 0;

  if (awayBatting) {
    for (const p of awayBatting.players) {
      await savePlayerBattingStats(p, awayTeamRecord.id, gameRecord.id);
      statsSaved++;
    }
  }
  if (awayPitching) {
    for (const p of awayPitching.pitchers) {
      await savePlayerPitchingStats(p, awayTeamRecord.id, gameRecord.id);
      statsSaved++;
    }
  }
  if (homeBatting) {
    for (const p of homeBatting.players) {
      await savePlayerBattingStats(p, homeTeamRecord.id, gameRecord.id);
      statsSaved++;
    }
  }
  if (homePitching) {
    for (const p of homePitching.pitchers) {
      await savePlayerPitchingStats(p, homeTeamRecord.id, gameRecord.id);
      statsSaved++;
    }
  }

  console.log('\nSaved ' + statsSaved + ' player stat records to Supabase!');

  // ─── STEP 4: CALCULATE PLAYER OF THE GAME ───────────────
  console.log('\n=== STEP 4: PLAYER OF THE GAME ===\n');

  const allBatters = [
    ...(awayBatting?.players || []).map(p => ({ ...p, side: 'away', teamName: data.awayTeam })),
    ...(homeBatting?.players || []).map(p => ({ ...p, side: 'home', teamName: data.homeTeam })),
  ];

  const allPitchers = [
    ...(awayPitching?.pitchers || []).map(p => ({ ...p, side: 'away', teamName: data.awayTeam })),
    ...(homePitching?.pitchers || []).map(p => ({ ...p, side: 'home', teamName: data.homeTeam })),
  ];

  const potgScores = [];

  for (const p of allBatters) {
    const singles = p.h - (p.hr || 0); // simplified, no doubles/triples from batting line
    const score =
      (singles * 2) +
      ((p.hr || 0) * 5) +
      (p.rbi * 2) +
      (p.r * 1.5) +
      (p.bb * 1) +
      (p.so * -0.5);
    potgScores.push({ name: p.name, team: p.teamName, score: Math.round(score * 100) / 100, type: 'bat' });
  }

  for (const p of allPitchers) {
    const score =
      (p.ip * 3) +
      (p.so * 2) +
      (p.er * -2) +
      (p.bb * -1) +
      (p.h * -0.5);
    // Add to existing score if player also batted
    const existing = potgScores.find(s => s.name === p.name);
    if (existing) {
      existing.score += Math.round(score * 100) / 100;
      existing.type = 'both';
    } else {
      potgScores.push({ name: p.name, team: p.teamName, score: Math.round(score * 100) / 100, type: 'pitch' });
    }
  }

  potgScores.sort((a, b) => b.score - a.score);

  console.log('Top 5 Player of the Game candidates:');
  for (let i = 0; i < Math.min(5, potgScores.length); i++) {
    const p = potgScores[i];
    console.log('  ' + (i + 1) + '. ' + p.name + ' (' + p.team + ') — Score: ' + p.score);
  }

  const winner = potgScores[0];
  console.log('\n⭐ PLAYER OF THE GAME: ' + winner.name + ' (' + winner.team + ') — Score: ' + winner.score);

  console.log('\n✅ ALL DONE! Check your Supabase tables:');
  console.log('   - ec_teams: should have 2 teams');
  console.log('   - ec_players: should have all players');
  console.log('   - ec_games: should have 1 game');
  console.log('   - ec_game_stats: should have all batting + pitching stats');
}

// ─── PARSERS ──────────────────────────────────────────────

function parseBatting(lines) {
  const players = [];
  let i = 7; // Skip LINEUP + 6 header labels
  while (i < lines.length) {
    if (lines[i] === 'TEAM') break;
    const name = lines[i];
    const info = lines[i + 1] || '';
    const numberMatch = info.match(/#(\d+)/);
    const posMatch = info.match(/\(([A-Z]+)\)/);
    const stats = lines.slice(i + 2, i + 8).map(Number);
    players.push({
      name,
      jerseyNumber: numberMatch ? numberMatch[1] : '',
      position: posMatch ? posMatch[1] : '',
      ab: stats[0] || 0,
      r: stats[1] || 0,
      h: stats[2] || 0,
      rbi: stats[3] || 0,
      bb: stats[4] || 0,
      so: stats[5] || 0,
    });
    i += 8;
  }
  return players;
}

function parsePitching(lines) {
  const pitchers = [];
  let i = 7;
  while (i < lines.length) {
    if (lines[i] === 'TEAM') break;
    const name = lines[i];
    const info = lines[i + 1] || '';
    const numberMatch = info.match(/#(\d+)/);
    const stats = lines.slice(i + 2, i + 8).map(Number);
    pitchers.push({
      name,
      jerseyNumber: numberMatch ? numberMatch[1] : '',
      position: 'P',
      ip: stats[0] || 0,
      h: stats[1] || 0,
      r: stats[2] || 0,
      er: stats[3] || 0,
      bb: stats[4] || 0,
      so: stats[5] || 0,
    });
    i += 8;
  }
  return pitchers;
}

// ─── SUPABASE HELPERS ─────────────────────────────────────

async function findOrCreateTeam(teamName, gcTeamId) {
  // Try to find existing team
  let query = supabase.from('ec_teams').select('*');
  if (gcTeamId) {
    query = query.eq('gc_team_id', gcTeamId);
  } else {
    query = query.eq('team_name', teamName);
  }
  const { data: existing } = await query.single();
  if (existing) return existing;

  // Create new team
  const { data: newTeam, error } = await supabase
    .from('ec_teams')
    .insert({ team_name: teamName, gc_team_id: gcTeamId })
    .select()
    .single();
  if (error) {
    console.log('Error creating team:', error.message);
    // Try again without gc_team_id constraint
    const { data: retry } = await supabase
      .from('ec_teams')
      .insert({ team_name: teamName })
      .select()
      .single();
    return retry;
  }
  return newTeam;
}

async function findOrCreatePlayer(name, jerseyNumber, position, teamId) {
  const { data: existing } = await supabase
    .from('ec_players')
    .select('*')
    .eq('player_name', name)
    .eq('team_id', teamId)
    .single();
  if (existing) return existing;

  const { data: newPlayer, error } = await supabase
    .from('ec_players')
    .insert({
      player_name: name,
      jersey_number: jerseyNumber,
      primary_position: position,
      team_id: teamId,
    })
    .select()
    .single();
  if (error) console.log('Error creating player:', name, error.message);
  return newPlayer;
}

async function findOrCreateGame(gcGameId, awayTeamId, homeTeamId, awayScore, homeScore, gameDate) {
  const { data: existing } = await supabase
    .from('ec_games')
    .select('*')
    .eq('gc_game_id', gcGameId)
    .single();
  if (existing) return existing;

  const { data: newGame, error } = await supabase
    .from('ec_games')
    .insert({
      gc_game_id: gcGameId,
      away_team_id: awayTeamId,
      home_team_id: homeTeamId,
      home_score: homeScore,
      away_score: awayScore,
      game_date: gameDate,
      status: 'final',
    })
    .select()
    .single();
  if (error) console.log('Error creating game:', error.message);
  return newGame;
}

async function savePlayerBattingStats(player, teamId, gameId) {
  const playerRecord = await findOrCreatePlayer(player.name, player.jerseyNumber, player.position, teamId);
  if (!playerRecord) return;

  const { error } = await supabase.from('ec_game_stats').upsert({
    game_id: gameId,
    player_id: playerRecord.id,
    team_id: teamId,
    stat_type: 'batting',
    ab: player.ab,
    r: player.r,
    h: player.h,
    rbi: player.rbi,
    bb: player.bb,
    so: player.so,
  }, { onConflict: 'game_id,player_id,stat_type' });

  if (error) console.log('Error saving batting stats for', player.name, ':', error.message);
}

async function savePlayerPitchingStats(player, teamId, gameId) {
  const playerRecord = await findOrCreatePlayer(player.name, player.jerseyNumber, 'P', teamId);
  if (!playerRecord) return;

  const { error } = await supabase.from('ec_game_stats').upsert({
    game_id: gameId,
    player_id: playerRecord.id,
    team_id: teamId,
    stat_type: 'pitching',
    ip: player.ip,
    p_h: player.h,
    p_r: player.r,
    p_er: player.er,
    p_bb: player.bb,
    p_so: player.so,
  }, { onConflict: 'game_id,player_id,stat_type' });

  if (error) console.log('Error saving pitching stats for', player.name, ':', error.message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main();