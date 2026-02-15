/**
 * USSSA Event Central — Polling Service
 * 
 * Automatically scrapes GameChanger box scores on a schedule.
 * Run this on your Mac during tournament weekends.
 * 
 * Usage:
 *   node ec-polling-service.mjs
 * 
 * It will:
 *   1. Read active event config from Supabase (ec_events table)
 *   2. Get all GC game URLs for those events
 *   3. Scrape each game every POLL_INTERVAL minutes
 *   4. Save/update stats in Supabase
 *   5. Recalculate POTG for each game
 *   6. Loop forever until you stop it (Ctrl+C)
 * 
 * You can also run it in "manual mode" by passing URLs directly:
 *   node ec-polling-service.mjs --urls "url1,url2,url3"
 */

import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// ─── CONFIG ──────────────────────────────────────────────────
const POLL_INTERVAL = 10; // minutes between scrape cycles
const GC_EMAIL = process.env.GC_EMAIL || 'steve.hassett@usssa.org';
const GC_PASSWORD = process.env.GC_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

if (!GC_PASSWORD) {
  console.error('ERROR: Set GC_PASSWORD environment variable');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── SLEEP HELPER ────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── BROWSER MANAGEMENT ─────────────────────────────────────
let browser = null;
let page = null;
let isLoggedIn = false;

async function launchBrowser() {
  if (browser) return;
  console.log('🌐 Launching Chrome...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1920,1080'],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
}

async function loginToGC() {
  if (isLoggedIn) return;
  console.log(`🔑 Logging in as ${GC_EMAIL}...`);

  await page.goto('https://web.gc.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);

  const emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
  if (emailInput) await emailInput.type(GC_EMAIL, { delay: 50 });

  const passwordInput = await page.$('input[type="password"]');
  if (passwordInput) await passwordInput.type(GC_PASSWORD, { delay: 50 });

  const submitBtn = await page.$('button[type="submit"]');
  if (submitBtn) await submitBtn.click();

  await sleep(5000);
  isLoggedIn = true;
  console.log('✅ Logged in!');
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
    isLoggedIn = false;
  }
}

// ─── SCRAPE A SINGLE GAME ────────────────────────────────────
async function scrapeGame(url) {
  try {
    console.log(`  📊 Scraping: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    const data = await page.evaluate(() => {
      const away = document.querySelector('[data-testid="away-team-name"]')?.innerText?.trim() || '';
      const home = document.querySelector('[data-testid="home-team-name"]')?.innerText?.trim() || '';
      const tables = [...document.querySelectorAll('[data-testid="data-table"]')].map(t => t.innerText);
      const legends = [...document.querySelectorAll('[data-testid="box-score-legend"] dt, [data-testid="box-score-legend"] dd')].map(el => el.innerText);
      return { away, home, tables, legends };
    });

    if (!data.away && !data.home) {
      console.log('  ⚠️  No team names found — page may not have loaded');
      return null;
    }

    console.log(`  ✅ ${data.away} vs ${data.home} | ${data.tables.length} tables`);
    return data;
  } catch (err) {
    console.error(`  ❌ Scrape error: ${err.message}`);
    return null;
  }
}

// ─── PARSE STATS ─────────────────────────────────────────────
function parseBatting(tableText) {
  const lines = tableText.split('\n').map(l => l.trim()).filter(l => l);
  const players = [];
  let i = 0;

  // Skip header row (LINEUP, AB, R, H, RBI, BB, SO)
  while (i < lines.length && !lines[i].match(/^[A-Z]\s/)) i++;

  while (i < lines.length) {
    const nameLine = lines[i];
    if (nameLine === 'TEAM') break;

    // Next line is jersey/position
    const jerseyLine = lines[i + 1] || '';
    const jerseyMatch = jerseyLine.match(/#(\d+)\s*\(?([\w/]*)\)?/);

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
}

function parsePitching(tableText) {
  const lines = tableText.split('\n').map(l => l.trim()).filter(l => l);
  const pitchers = [];
  let i = 0;

  // Skip header
  while (i < lines.length && !lines[i].match(/^[A-Z]\s/)) i++;

  while (i < lines.length) {
    const nameLine = lines[i];
    if (nameLine === 'TEAM') break;

    const jerseyLine = lines[i + 1] || '';
    const jerseyMatch = jerseyLine.match(/#(\d+)/);
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
}

// ─── SAVE TO SUPABASE ────────────────────────────────────────
async function findOrCreateTeam(teamName, gcTeamId) {
  // Try to find by name first
  const { data: existing } = await supabase
    .from('ec_teams')
    .select('id, team_name')
    .eq('team_name', teamName)
    .single();

  if (existing) return existing.id;

  // Create new
  const { data: newTeam, error } = await supabase
    .from('ec_teams')
    .insert({ team_name: teamName, gc_team_id: gcTeamId || null })
    .select('id')
    .single();

  if (error) {
    console.error(`  ⚠️  Team create error: ${error.message}`);
    return null;
  }
  console.log(`  🆕 New team: ${teamName}`);
  return newTeam.id;
}

async function findOrCreatePlayer(playerName, jersey, teamId) {
  const { data: existing } = await supabase
    .from('ec_players')
    .select('id')
    .eq('player_name', playerName)
    .eq('team_id', teamId)
    .single();

  if (existing) return existing.id;

  const { data: newPlayer, error } = await supabase
    .from('ec_players')
    .insert({
      player_name: playerName,
      jersey_number: jersey,
      team_id: teamId,
    })
    .select('id')
    .single();

  if (error) return null;
  return newPlayer.id;
}

async function saveGameToSupabase(url, scrapedData) {
  const { away, home, tables } = scrapedData;

  // Extract GC game ID from URL
  const gcGameMatch = url.match(/schedule\/([a-f0-9-]+)\//);
  const gcGameId = gcGameMatch ? gcGameMatch[1] : url;

  // Extract GC team ID from URL
  const gcTeamMatch = url.match(/teams\/([A-Za-z0-9]+)\//);
  const gcTeamId = gcTeamMatch ? gcTeamMatch[1] : null;

  // Parse the 4 tables: away batting, away pitching, home batting, home pitching
  if (tables.length < 4) {
    console.log('  ⚠️  Less than 4 tables — game may not have started yet');
    return null;
  }

  const awayBatting = parseBatting(tables[0]);
  const awayPitching = parsePitching(tables[1]);
  const homeBatting = parseBatting(tables[2]);
  const homePitching = parsePitching(tables[3]);

  // Calculate scores from batting
  const awayScore = awayBatting.reduce((s, p) => s + p.r, 0);
  const homeScore = homeBatting.reduce((s, p) => s + p.r, 0);

  // Determine status — if pitching IP adds up to a complete game, it's final
  const awayIP = awayPitching.reduce((s, p) => s + p.ip, 0);
  const homeIP = homePitching.reduce((s, p) => s + p.ip, 0);
  const status = (awayIP >= 4 && homeIP >= 4) ? 'final' : 'live';

  // Find or create teams
  const awayTeamId = await findOrCreateTeam(away);
  const homeTeamId = await findOrCreateTeam(home);

  if (!awayTeamId || !homeTeamId) {
    console.error('  ❌ Failed to create teams');
    return null;
  }

  // Upsert game
  const { data: existingGame } = await supabase
    .from('ec_games')
    .select('id')
    .eq('gc_game_id', gcGameId)
    .single();

  let gameId;
  if (existingGame) {
    // Update existing game
    await supabase.from('ec_games').update({
      away_score: awayScore,
      home_score: homeScore,
      status: status,
      away_team_id: awayTeamId,
      home_team_id: homeTeamId,
    }).eq('id', existingGame.id);
    gameId = existingGame.id;
    console.log(`  📝 Updated game: ${away} ${awayScore}, ${home} ${homeScore} (${status})`);
  } else {
    // Create new game
    const { data: newGame, error } = await supabase
      .from('ec_games')
      .insert({
        gc_game_id: gcGameId,
        away_team_id: awayTeamId,
        home_team_id: homeTeamId,
        away_score: awayScore,
        home_score: homeScore,
        status: status,
        game_date: new Date().toISOString().split('T')[0],
      })
      .select('id')
      .single();

    if (error) {
      console.error(`  ❌ Game create error: ${error.message}`);
      return null;
    }
    gameId = newGame.id;
    console.log(`  🆕 New game: ${away} ${awayScore}, ${home} ${homeScore} (${status})`);
  }

  // Clear old stats for this game (we replace them each scrape)
  await supabase.from('ec_game_stats').delete().eq('game_id', gameId);

  // Save batting stats
  for (const team of [{ batting: awayBatting, pitching: awayPitching, teamId: awayTeamId },
                       { batting: homeBatting, pitching: homePitching, teamId: homeTeamId }]) {
    for (const p of team.batting) {
      const playerId = await findOrCreatePlayer(p.name, p.jersey, team.teamId);
      if (!playerId) continue;

      await supabase.from('ec_game_stats').insert({
        game_id: gameId,
        player_id: playerId,
        team_id: team.teamId,
        stat_type: 'batting',
        ab: p.ab, r: p.r, h: p.h, rbi: p.rbi, bb: p.bb, so: p.so,
        position_played: p.pos,
      });
    }

    for (const p of team.pitching) {
      const playerId = await findOrCreatePlayer(p.name, p.jersey, team.teamId);
      if (!playerId) continue;

      await supabase.from('ec_game_stats').insert({
        game_id: gameId,
        player_id: playerId,
        team_id: team.teamId,
        stat_type: 'pitching',
        ip: p.ip, p_h: p.h, p_r: p.r, p_er: p.er, p_bb: p.bb, p_so: p.so,
      });
    }
  }

  // Calculate POTG
  await calculatePOTG(gameId);

  return gameId;
}

// ─── POTG CALCULATION ────────────────────────────────────────
async function calculatePOTG(gameId) {
  const { data: stats } = await supabase
    .from('ec_game_stats')
    .select('*, player:ec_players!player_id(player_name, jersey_number), team:ec_teams!team_id(team_name)')
    .eq('game_id', gameId);

  if (!stats || stats.length === 0) return;

  // Score each player
  const scores = {};
  for (const s of stats) {
    const pid = s.player_id;
    if (!scores[pid]) {
      scores[pid] = {
        playerId: pid,
        name: s.player?.player_name,
        team: s.team?.team_name,
        teamId: s.team_id,
        score: 0,
        highlights: [],
      };
    }

    if (s.stat_type === 'batting') {
      const singles = (s.h || 0) - (s.doubles || 0) - (s.triples || 0) - (s.hr || 0);
      const batScore = (singles * 2) + ((s.hr || 0) * 5) + ((s.rbi || 0) * 2) +
                       ((s.r || 0) * 1.5) + ((s.bb || 0) * 1) + ((s.so || 0) * -0.5);
      scores[pid].score += batScore;

      // Build highlights
      const parts = [];
      if (s.h > 0) parts.push(`${s.h}-for-${s.ab}`);
      if (s.hr > 0) parts.push(`${s.hr} HR`);
      if (s.rbi > 0) parts.push(`${s.rbi} RBI`);
      if (s.r > 0) parts.push(`${s.r} R`);
      if (parts.length > 0) scores[pid].highlights.push(parts.join(', '));
    }

    if (s.stat_type === 'pitching') {
      const pitchScore = ((s.ip || 0) * 3) + ((s.p_so || 0) * 2) +
                         ((s.p_er || 0) * -2) + ((s.p_bb || 0) * -1) + ((s.p_h || 0) * -0.5);
      scores[pid].score += pitchScore;

      const parts = [];
      if (s.ip > 0) parts.push(`${s.ip} IP`);
      if (s.p_so > 0) parts.push(`${s.p_so} K`);
      if (s.p_er === 0) parts.push('0 ER');
      if (parts.length > 0) scores[pid].highlights.push(parts.join(', '));
    }
  }

  // Find top scorer
  const sorted = Object.values(scores).sort((a, b) => b.score - a.score);
  if (sorted.length === 0) return;

  const winner = sorted[0];

  // Upsert POTG
  const { data: existingPOTG } = await supabase
    .from('ec_player_of_game')
    .select('id')
    .eq('game_id', gameId)
    .single();

  const potgData = {
    game_id: gameId,
    player_id: winner.playerId,
    team_id: winner.teamId,
    potg_score: Math.round(winner.score * 10) / 10,
    highlights: winner.highlights.join(' | '),
    auto_selected: true,
  };

  if (existingPOTG) {
    await supabase.from('ec_player_of_game').update(potgData).eq('id', existingPOTG.id);
  } else {
    await supabase.from('ec_player_of_game').insert(potgData);
  }

  console.log(`  ⭐ POTG: ${winner.name} (${winner.team}) — Score: ${winner.score.toFixed(1)}`);
}

// ─── MAIN POLLING LOOP ──────────────────────────────────────
async function pollOnce(gameUrls) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔄 SCRAPE CYCLE — ${new Date().toLocaleTimeString()}`);
  console.log(`   ${gameUrls.length} games to check`);
  console.log('='.repeat(60));

  for (const url of gameUrls) {
    const data = await scrapeGame(url);
    if (data && data.tables.length >= 4) {
      await saveGameToSupabase(url, data);
    }
    await sleep(2000); // 2 sec between games to be nice to GC
  }

  console.log(`\n✅ Cycle complete. Next scrape in ${POLL_INTERVAL} minutes.\n`);
}

async function run() {
  // Check for manual URL mode
  const urlArg = process.argv.find(a => a.startsWith('--urls='));
  let gameUrls = [];

  if (urlArg) {
    // Manual mode: pass URLs on command line
    gameUrls = urlArg.replace('--urls=', '').split(',').map(u => u.trim());
    console.log(`\n📋 Manual mode: ${gameUrls.length} URLs provided\n`);
  } else {
    // Auto mode: look for a urls.txt file
    try {
      const fs = await import('fs');
      const urlsFile = fs.readFileSync('ec-game-urls.txt', 'utf-8');
      gameUrls = urlsFile.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      console.log(`\n📋 Loaded ${gameUrls.length} URLs from ec-game-urls.txt\n`);
    } catch {
      console.log('\n📋 No ec-game-urls.txt found. Create one with GameChanger box score URLs (one per line).');
      console.log('   Or use: node ec-polling-service.mjs --urls="url1,url2"\n');
      process.exit(1);
    }
  }

  if (gameUrls.length === 0) {
    console.log('No game URLs to scrape!');
    process.exit(1);
  }

  // Launch and login
  await launchBrowser();
  await loginToGC();

  // Run first cycle immediately
  await pollOnce(gameUrls);

  // Then loop
  console.log(`⏰ Polling every ${POLL_INTERVAL} minutes. Press Ctrl+C to stop.\n`);

  const interval = setInterval(async () => {
    try {
      // Re-read URLs file in case it changed
      try {
        const fs = await import('fs');
        const urlsFile = fs.readFileSync('ec-game-urls.txt', 'utf-8');
        gameUrls = urlsFile.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      } catch {}

      await pollOnce(gameUrls);
    } catch (err) {
      console.error('❌ Poll cycle error:', err.message);
      // Try to re-login on next cycle
      isLoggedIn = false;
      try {
        await loginToGC();
      } catch {}
    }
  }, POLL_INTERVAL * 60 * 1000);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down polling service...');
    clearInterval(interval);
    await closeBrowser();
    process.exit(0);
  });
}

run().catch(err => {
  console.error('Fatal error:', err);
  closeBrowser();
  process.exit(1);
});
