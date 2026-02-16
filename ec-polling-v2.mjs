/**
 * USSSA Event Central — Schedule Scraper + Polling Service v2
 * 
 * Takes TEAM URLs (not individual game URLs) and auto-discovers all games.
 * 
 * Usage:
 *   node ec-polling-v2.mjs
 * 
 * It reads team URLs from ec-teams.txt (one per line):
 *   https://web.gc.com/teams/fXEnuJhCgzAL | 8U | Space Coast Presidents Day
 *   https://web.gc.com/teams/D4CK5E1BGDsq | 11U | Space Coast Presidents Day
 * 
 * Format: URL | Age Group | Event Name
 * 
 * For each team:
 *   1. Goes to their schedule page
 *   2. Finds all games (past, live, upcoming)
 *   3. Scrapes each game's box score
 *   4. Saves everything to Supabase tagged with event + age group
 *   5. Repeats every POLL_INTERVAL minutes
 */

import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

// ─── CONFIG ──────────────────────────────────────────────────
const POLL_INTERVAL = 10; // minutes between scrape cycles
const GC_EMAIL = process.env.GC_EMAIL || 'steve.hassett@usssa.org';
const GC_PASSWORD = process.env.GC_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Set SUPABASE_URL and SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  const deduped = name.replace(/(\d+U)\s+\1/i, '$1');
  if (deduped !== name) return deduped;
  return name;
}


// ─── TEAM NAME NORMALIZATION ─────────────────────────────────

// ─── BROWSER ─────────────────────────────────────────────────
let browser = null;
let page = null;

async function launchBrowser() {
  if (browser) return;
  console.log('🌐 Launching Chrome with saved session...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1920,1080'],
    userDataDir: './gc-browser-data'
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
}

async function checkLogin() {
  console.log('🔑 Checking saved session...');
  await page.goto('https://web.gc.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);
  
  const loggedIn = await page.evaluate(() => {
    const signInBtn = document.querySelector('[data-testid="desktop-sign-in-button"]');
    return !signInBtn || signInBtn.offsetParent === null;
  });
  
  if (loggedIn) {
    console.log('✅ Session valid!');
  } else {
    console.log('⚠️  Session expired! Run gc-save-session.mjs to log in again.');
    process.exit(1);
  }
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
}

// ─── HELPERS ─────────────────────────────────────────────────

function isStatNumber(str) {
  return /^\d+(\.\d)?$/.test(str);
}

function parseBatting(tableText) {
  const lines = tableText.split('\n').map(l => l.trim()).filter(l => l);
  const players = [];
  let i = 0;
  const headers = new Set(['LINEUP', 'AB', 'R', 'H', 'RBI', 'BB', 'SO']);
  while (i < lines.length && headers.has(lines[i])) i++;
  
  while (i < lines.length) {
    if (lines[i] === 'TEAM') break;
    const name = lines[i];
    i++;
    if (i >= lines.length) break;
    
    let jersey = '', pos = '';
    const nextLine = lines[i];
    
    if (nextLine.startsWith('#')) {
      const jMatch = nextLine.match(/^#(\d+)\s*(?:\(([^)]+)\))?/);
      if (jMatch) { jersey = jMatch[1]; pos = jMatch[2] || ''; }
      i++;
    } else if (nextLine.startsWith('(')) {
      const pMatch = nextLine.match(/^\(([^)]+)\)/);
      if (pMatch) pos = pMatch[1];
      i++;
    } else if (isStatNumber(nextLine)) {
      // no jersey/position
    } else {
      i++;
    }
    
    if (i + 5 < lines.length && isStatNumber(lines[i])) {
      players.push({
        name, jersey, pos,
        ab: parseInt(lines[i]) || 0,
        r: parseInt(lines[i+1]) || 0,
        h: parseInt(lines[i+2]) || 0,
        rbi: parseInt(lines[i+3]) || 0,
        bb: parseInt(lines[i+4]) || 0,
        so: parseInt(lines[i+5]) || 0,
      });
      i += 6;
    } else {
      continue;
    }
  }
  return players;
}

function parsePitching(tableText) {
  const lines = tableText.split('\n').map(l => l.trim()).filter(l => l);
  const pitchers = [];
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
      const jMatch = nextLine.match(/^#(\d+)/);
      if (jMatch) jersey = jMatch[1];
      i++;
    } else if (nextLine.startsWith('(')) {
      i++;
    } else if (isStatNumber(nextLine)) {
      // stats start here
    } else {
      i++;
    }
    
    if (i + 5 < lines.length && isStatNumber(lines[i])) {
      pitchers.push({
        name, jersey,
        ip: parseFloat(lines[i]) || 0,
        h: parseInt(lines[i+1]) || 0,
        r: parseInt(lines[i+2]) || 0,
        er: parseInt(lines[i+3]) || 0,
        bb: parseInt(lines[i+4]) || 0,
        so: parseInt(lines[i+5]) || 0,
      });
      i += 6;
    } else {
      continue;
    }
  }
  return pitchers;
}

// ─── DISCOVER GAMES FROM TEAM SCHEDULE ───────────────────────

async function discoverGames(teamUrl, startDate, endDate) {
  try {
    // Navigate to team page
    await page.goto(teamUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);
    
    // Click the SCHEDULE tab
    const scheduleLink = await page.$('a[href*="/schedule"]');
    if (scheduleLink) {
      await scheduleLink.click();
      await sleep(3000);
    }
    
    // Scroll down to load all games (GC may lazy-load)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1000);
    
    // Find all game links — they are <a class="ScheduleListByMonth__event">
    const games = await page.evaluate(() => {
      const links = [];
      
      // Primary selector: GC schedule game links
      const gameLinks = document.querySelectorAll('a[class*="ScheduleListByMonth__event"]');
      
      for (const link of gameLinks) {
        const href = link.href || link.getAttribute('href') || '';
        if (!href) continue;
        
        // Get the game info text (opponent, score, date)
        const text = link.innerText.replace(/\n/g, ' | ').substring(0, 150);
        
        // Build full box score URL
        let fullUrl = href;
        if (!fullUrl.startsWith('http')) {
          fullUrl = window.location.origin + href;
        }
        if (!fullUrl.includes('/box-score')) {
          fullUrl = fullUrl.replace(/\/?$/, '/box-score');
        }
        
        links.push({ url: fullUrl, text });
      }
      
      // Fallback: try any link with /schedule/ and a UUID
      if (links.length === 0) {
        const allLinks = document.querySelectorAll('a[href*="/schedule/"]');
        for (const link of allLinks) {
          const href = link.href || link.getAttribute('href') || '';
          if (href.match(/\/schedule\/[a-f0-9-]{20,}/)) {
            let fullUrl = href.startsWith('http') ? href : window.location.origin + href;
            if (!fullUrl.includes('/box-score')) fullUrl += '/box-score';
            const text = link.innerText.replace(/\n/g, ' | ').substring(0, 150);
            links.push({ url: fullUrl, text });
          }
        }
      }
      
      // Deduplicate
      const seen = new Set();
      return links.filter(l => {
        const key = l.url.split('/box-score')[0];
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
    
    return games;
  } catch (err) {
    console.error(`  ❌ Schedule discovery error: ${err.message}`);
    return [];
  }
}

// ─── SCRAPE A SINGLE GAME ────────────────────────────────────

async function scrapeGame(url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(6000);

    const rawData = await page.evaluate(() => {
      const away = document.querySelector('[data-testid="away-team-name"]')?.innerText?.trim() || '';
      const home = document.querySelector('[data-testid="home-team-name"]')?.innerText?.trim() || '';
      const tables = [...document.querySelectorAll('[data-testid="data-table"]')].map(t => t.innerText);
      
      // Real score from header
      let awayScore = null, homeScore = null, headerStatus = null;
      
      const awayScoreEl = document.querySelector('[data-testid="EventHeaderOngoing-awayScore"]');
      const homeScoreEl = document.querySelector('[data-testid="EventHeaderOngoing-homeScore"]');
      if (awayScoreEl) awayScore = parseInt(awayScoreEl.innerText.trim()) || null;
      if (homeScoreEl) homeScore = parseInt(homeScoreEl.innerText.trim()) || null;
      
      const finalHeader = document.querySelector('[data-testid="Event-Header-LineScoreFinal"]');
      if (finalHeader && finalHeader.innerText.includes('FINAL')) headerStatus = 'final';
      if (!headerStatus) {
        const liveHeader = document.querySelector('[data-testid="Event-Header-LineScoreLive"]');
        if (liveHeader) headerStatus = 'live';
      }
      
      // Line score
      let lineScore = null;
      const awayInnings = document.querySelector('[data-testid="away-row-innings"]');
      const homeInnings = document.querySelector('[data-testid="home-row-innings"]');
      const inningHeaders = document.querySelector('[data-testid="inning-header"]');
      if (awayInnings && homeInnings) {
        lineScore = {
          innings: inningHeaders ? inningHeaders.innerText.split('\t').map(s => s.trim()).filter(s => s) : [],
          away: awayInnings.innerText.split('\t').map(s => s.trim()).filter(s => s),
          home: homeInnings.innerText.split('\t').map(s => s.trim()).filter(s => s),
        };
      }
      
      // Game date/time from header
      const timeEl = document.querySelector('[data-testid="event-time"]');
      const gameTime = timeEl ? timeEl.innerText.trim() : '';
      
      return { away, home, tables, awayScore, homeScore, headerStatus, lineScore, gameTime };
    });

    if (!rawData.away && !rawData.home) return null;
    // Normalize team names
    rawData.away = normalizeTeamName(rawData.away);
    rawData.home = normalizeTeamName(rawData.home);
    return rawData;
  } catch (err) {
    console.error(`  ❌ Scrape error: ${err.message}`);
    return null;
  }
}

// ─── SAVE TO SUPABASE ────────────────────────────────────────

async function findOrCreateTeam(teamName, gcTeamId, ageGroup, eventName) {
  const { data: existing } = await supabase
    .from('ec_teams')
    .select('id')
    .eq('team_name', teamName)
    .single();

  if (existing) return existing.id;

  const { data: newTeam, error } = await supabase
    .from('ec_teams')
    .insert({ 
      team_name: teamName, 
      gc_team_id: gcTeamId || null,
      age_group: ageGroup || null,
    })
    .select('id')
    .single();

  if (error) {
    console.error(`  ⚠️  Team create error: ${error.message}`);
    return null;
  }
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
    .insert({ player_name: playerName, jersey_number: jersey, team_id: teamId })
    .select('id')
    .single();

  if (error) return null;
  return newPlayer.id;
}

async function saveGame(url, data, ageGroup, eventName) {
  const { away, home, tables, awayScore, homeScore, headerStatus, gameTime } = data;
  
  // ─── DEDUP CHECK: Skip if game already exists (by gc_game_id) ───
  const gcGameMatchDedup = url.match(/schedule\/([a-f0-9-]+)\//);
  const gcGameIdDedup = gcGameMatchDedup ? gcGameMatchDedup[1] : null;
  
  // Also check all known gc_game_ids for this game (same teams, same date could be different games)
  const { data: awayTeamCheck } = await supabase.from("ec_teams").select("id").eq("team_name", away).maybeSingle();
  const { data: homeTeamCheck } = await supabase.from("ec_teams").select("id").eq("team_name", home).maybeSingle();
  
  // Check by gc_game_id first — each team has a different gc_game_id for the same game
  // So we check by team IDs + score to detect true duplicates
  let dup1 = null, dup2 = null;
  if (awayTeamCheck && homeTeamCheck) {
    const { data: dups1 } = await supabase.from("ec_games").select("id, away_score, home_score").eq("away_team_id", awayTeamCheck.id).eq("home_team_id", homeTeamCheck.id);
    const { data: dups2raw } = await supabase.from("ec_games").select("id, away_score, home_score").eq("away_team_id", homeTeamCheck.id).eq("home_team_id", awayTeamCheck.id);
    // Only consider it a duplicate if the score matches (or score is null/0)
    if (dups1 && dups1.length > 0) {
      const scoreMatch = dups1.find(d => d.away_score === awayScore && d.home_score === homeScore);
      if (scoreMatch) dup1 = scoreMatch;
    }
    if (!dup1 && dups2raw && dups2raw.length > 0) {
      const scoreMatch = dups2raw.find(d => d.away_score === homeScore && d.home_score === awayScore);
      if (scoreMatch) dup2 = scoreMatch;
    }
    if (dup1 || dup2) {
      const dupId = dup1 ? dup1.id : dup2.id;
      if (awayScore !== null && homeScore !== null) {
        const upd = dup1
          ? { away_score: awayScore, home_score: homeScore }
          : { away_score: homeScore, home_score: awayScore };
        await supabase.from("ec_games").update(upd).eq("id", dupId);
        console.log("  SKIP dup (score updated): " + away + " " + awayScore + " vs " + home + " " + homeScore);
      } else {
        console.log("  SKIP duplicate: " + away + " vs " + home);
      }
      // Re-save stats for BOTH teams with current scrape data (more accurate)
      if (tables.length >= 4) {
        const awayBat = parseBatting(tables[0]);
        const awayPit = parsePitching(tables[1]);
        const homeBat = parseBatting(tables[2]);
        const homePit = parsePitching(tables[3]);
        const aTeamId = awayTeamCheck.id;
        const hTeamId = homeTeamCheck.id;
        // Flip if teams were stored in opposite order
        const [t1Id, t1Bat, t1Pit, t2Id, t2Bat, t2Pit] = dup1
          ? [aTeamId, awayBat, awayPit, hTeamId, homeBat, homePit]
          : [hTeamId, homeBat, homePit, aTeamId, awayBat, awayPit];
        // Clear old stats
        await supabase.from("ec_game_stats").delete().eq("game_id", dupId);
        await supabase.from("ec_player_of_game").delete().eq("game_id", dupId);
        // Re-save
        for (const team of [{b:t1Bat,p:t1Pit,tid:t1Id},{b:t2Bat,p:t2Pit,tid:t2Id}]) {
          for (const pl of team.b) {
            const pid = await findOrCreatePlayer(pl.name, pl.jersey, team.tid);
            if (!pid) continue;
            await supabase.from("ec_game_stats").insert({
              game_id: dupId, player_id: pid, team_id: team.tid,
              stat_type: "batting", ab: pl.ab, r: pl.r, h: pl.h, rbi: pl.rbi, bb: pl.bb, so: pl.so,
              position_played: pl.pos,
            });
          }
          for (const pl of team.p) {
            const pid = await findOrCreatePlayer(pl.name, pl.jersey, team.tid);
            if (!pid) continue;
            await supabase.from("ec_game_stats").insert({
              game_id: dupId, player_id: pid, team_id: team.tid,
              stat_type: "pitching", ip: pl.ip, p_h: pl.h, p_r: pl.r, p_er: pl.er, p_bb: pl.bb, p_so: pl.so,
            });
          }
        }
        await calculatePOTG(dupId);
        console.log("  🔄 Re-saved stats from current scrape");
      }
      return dupId;
    }
  }
  // ─── END DEDUP CHECK ───
  
  const gcGameMatch = url.match(/schedule\/([a-f0-9-]+)\//);
  const gcGameId = gcGameMatch ? gcGameMatch[1] : url;
  
  const gcTeamMatch = url.match(/teams\/([A-Za-z0-9]+)\//);
  const gcTeamId = gcTeamMatch ? gcTeamMatch[1] : null;

  if (tables.length < 4) {
    console.log(`  ⚠️  ${away} vs ${home} — less than 4 tables, skipping`);
    return null;
  }

  const awayBatting = parseBatting(tables[0]);
  const awayPitching = parsePitching(tables[1]);
  const homeBatting = parseBatting(tables[2]);
  const homePitching = parsePitching(tables[3]);

  const finalAwayScore = awayScore !== null ? awayScore : awayBatting.reduce((s, p) => s + p.r, 0);
  const finalHomeScore = homeScore !== null ? homeScore : homeBatting.reduce((s, p) => s + p.r, 0);
  
  let status = headerStatus || null;
  if (!status) {
    const aIP = awayPitching.reduce((s, p) => s + p.ip, 0);
    const hIP = homePitching.reduce((s, p) => s + p.ip, 0);
    status = (aIP >= 3 && hIP >= 3) ? 'final' : 'live';
  }

  // Parse game date from gameTime string like "Sun Feb 15, 12:00 PM - 1:00 PM ET"
  let gameDate = new Date().toISOString().split('T')[0];
  if (gameTime) {
    const dateMatch = gameTime.match(/(\w+ \w+ \d+)/);
    if (dateMatch) {
      const parsed = new Date(dateMatch[1] + ', 2026');
      if (!isNaN(parsed)) gameDate = parsed.toISOString().split('T')[0];
    }
  }

  const awayTeamId = await findOrCreateTeam(away, null, ageGroup, eventName);
  const homeTeamId = await findOrCreateTeam(home, null, ageGroup, eventName);
  if (!awayTeamId || !homeTeamId) return null;

  // Upsert game
  const { data: existingGame } = await supabase
    .from('ec_games')
    .select('id')
    .eq('gc_game_id', gcGameId)
    .single();

  let gameId;
  if (existingGame) {
    await supabase.from('ec_games').update({
      away_score: finalAwayScore,
      home_score: finalHomeScore,
      status,
      away_team_id: awayTeamId,
      home_team_id: homeTeamId,
      age_group: ageGroup,
      event_name: eventName,
      game_date: gameDate,
    }).eq('id', existingGame.id);
    gameId = existingGame.id;
  } else {
    const { data: newGame, error } = await supabase
      .from('ec_games')
      .insert({
        gc_game_id: gcGameId,
        away_team_id: awayTeamId,
        home_team_id: homeTeamId,
        away_score: finalAwayScore,
        home_score: finalHomeScore,
        status,
        game_date: gameDate,
        age_group: ageGroup,
        event_name: eventName,
      })
      .select('id')
      .single();

    if (error) {
      console.error(`  ❌ Game create error: ${error.message}`);
      return null;
    }
    gameId = newGame.id;
  }

  // Clear and re-save stats

    await supabase.from('ec_game_stats').delete().eq('game_id', gameId);
    await supabase.from('ec_player_of_game').delete().eq('game_id', gameId);
    console.log('  🔄 Cleared old stats for re-save with accurate data');

  for (const team of [
    { batting: awayBatting, pitching: awayPitching, teamId: awayTeamId },
    { batting: homeBatting, pitching: homePitching, teamId: homeTeamId }
  ]) {
    for (const p of team.batting) {
      const playerId = await findOrCreatePlayer(p.name, p.jersey, team.teamId);
      if (!playerId) continue;
      if (p.name === 'Beckham J') console.log('  STATS DEBUG Beckham J: AB=' + p.ab + ' R=' + p.r + ' H=' + p.h + ' RBI=' + p.rbi);
      await supabase.from('ec_game_stats').insert({
        game_id: gameId, player_id: playerId, team_id: team.teamId,
        stat_type: 'batting', ab: p.ab, r: p.r, h: p.h, rbi: p.rbi, bb: p.bb, so: p.so,
        position_played: p.pos,
      });
    }
    for (const p of team.pitching) {
      const playerId = await findOrCreatePlayer(p.name, p.jersey, team.teamId);
      if (!playerId) continue;
      await supabase.from('ec_game_stats').insert({
        game_id: gameId, player_id: playerId, team_id: team.teamId,
        stat_type: 'pitching', ip: p.ip, p_h: p.h, p_r: p.r, p_er: p.er, p_bb: p.bb, p_so: p.so,
      });
    }
  }

  // POTG
  await calculatePOTG(gameId);
  return gameId;
}

// ─── POTG ────────────────────────────────────────────────────

async function calculatePOTG(gameId) {
  const { data: stats } = await supabase
    .from('ec_game_stats')
    .select('*, player:ec_players!player_id(player_name, jersey_number), team:ec_teams!team_id(team_name)')
    .eq('game_id', gameId);

  if (!stats || stats.length === 0) return;

  const scores = {};
  for (const s of stats) {
    const pid = s.player_id;
    if (!scores[pid]) {
      scores[pid] = { playerId: pid, name: s.player?.player_name, team: s.team?.team_name, teamId: s.team_id, score: 0, highlights: [] };
    }

    if (s.stat_type === 'batting') {
      const singles = (s.h || 0) - (s.doubles || 0) - (s.triples || 0) - (s.hr || 0);
      scores[pid].score += (singles * 2) + ((s.hr || 0) * 5) + ((s.rbi || 0) * 2) + ((s.r || 0) * 1.5) + ((s.bb || 0) * 1) + ((s.so || 0) * -0.5);
      const parts = [];
      if (s.h > 0) parts.push(`${s.h}-for-${s.ab}`);
      if (s.rbi > 0) parts.push(`${s.rbi} RBI`);
      if (s.r > 0) parts.push(`${s.r} R`);
      if (parts.length > 0) scores[pid].highlights.push(parts.join(', '));
    }
    if (s.stat_type === 'pitching') {
      scores[pid].score += ((s.ip || 0) * 3) + ((s.p_so || 0) * 2) + ((s.p_er || 0) * -2) + ((s.p_bb || 0) * -1) + ((s.p_h || 0) * -0.5);
      const parts = [];
      if (s.ip > 0) parts.push(`${s.ip} IP`);
      if (s.p_so > 0) parts.push(`${s.p_so} K`);
      if (s.p_er === 0 && s.ip > 0) parts.push('0 ER');
      if (parts.length > 0) scores[pid].highlights.push(parts.join(', '));
    }
  }

  const sorted = Object.values(scores).sort((a, b) => b.score - a.score);
  if (sorted.length === 0) return;
  const winner = sorted[0];

  const potgData = {
    game_id: gameId, player_id: winner.playerId, team_id: winner.teamId,
    potg_score: Math.round(winner.score * 10) / 10,
    highlights: winner.highlights.join(' | '),
    auto_selected: true,
  };

  const { data: existing } = await supabase.from('ec_player_of_game').select('id').eq('game_id', gameId).single();
  if (existing) {
    await supabase.from('ec_player_of_game').update(potgData).eq('id', existing.id);
  } else {
    await supabase.from('ec_player_of_game').insert(potgData);
  }
  console.log(`  ⭐ POTG: ${winner.name} (${winner.team}) — ${winner.score.toFixed(1)}`);
}

// ─── READ TEAM CONFIG ────────────────────────────────────────

function readTeamConfig() {
  try {
    const raw = fs.readFileSync('ec-teams.txt', 'utf-8');
    const teams = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      // Format: URL | Age Group | Event Name
      const parts = trimmed.split('|').map(p => p.trim());
      const url = parts[0];
      const ageGroup = parts[1] || 'Unknown';
      const eventName = parts[2] || 'Unknown Event';
      const startDate = parts[3] || null;
      const endDate = parts[4] || null;
      
      if (url.includes('gc.com/teams/')) {
        teams.push({ url, ageGroup, eventName, startDate, endDate });
      }
    }
    return teams;
  } catch {
    console.log('📋 No ec-teams.txt found!');
    console.log('   Create it with team URLs, one per line:');
    console.log('   https://web.gc.com/teams/XXXXX | 8U | Space Coast Presidents Day');
    process.exit(1);
  }
}

// ─── MAIN POLLING LOOP ──────────────────────────────────────

async function pollOnce(teams) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔄 SCRAPE CYCLE — ${new Date().toLocaleTimeString()}`);
  console.log(`   ${teams.length} teams to check`);
  console.log('='.repeat(60));

  let totalGames = 0;
  let newGames = 0;

  for (const team of teams) {
    console.log(`\n📋 ${team.ageGroup} | ${team.eventName}`);
    console.log(`   ${team.url}`);
    
    // Discover games from schedule
    const games = await discoverGames(team.url, team.startDate, team.endDate);
    console.log(`   📅 Found ${games.length} total games on schedule`);
    
    for (const game of games) {
      totalGames++;
      console.log(`\n  📊 Scraping: ${game.text.substring(0, 80)}...`);
      
      const data = await scrapeGame(game.url);
      if (!data || data.tables.length < 4) {
        console.log(`  ⏭️  Skipping — no box score data yet`);
        continue;
      }
      
      // Check if game date falls within event dates
      if (team.startDate && team.endDate && data.gameTime) {
        const eventStart = new Date(team.startDate + 'T00:00:00');
        const eventEnd = new Date(team.endDate + 'T23:59:59');
        
        // Parse date from gameTime like "Sun Feb 15, 12:00 PM - 1:00 PM ET"
        const dateMatch = data.gameTime.match(/(\w+)\s+(\w+)\s+(\d+)/);
        if (dateMatch) {
          const monthNames = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
          const month = monthNames[dateMatch[2].toLowerCase().substring(0, 3)];
          const day = parseInt(dateMatch[3]);
          if (month !== undefined && day) {
            const gameDate = new Date(2026, month, day);
            if (gameDate < eventStart || gameDate > eventEnd) {
              console.log(`  ⏭️  Skipping — ${data.gameTime} outside event dates (${team.startDate} to ${team.endDate})`);
              await sleep(1000);
              continue;
            }
          }
        }
      }
      
      const score = `${data.away} ${data.awayScore ?? '?'}, ${data.home} ${data.homeScore ?? '?'}`;
      const statusIcon = data.headerStatus === 'live' ? '🔴' : data.headerStatus === 'final' ? '✅' : '⏳';
      console.log(`  ${statusIcon} ${score} (${data.headerStatus || 'unknown'})`);
      
      await saveGame(game.url, data, team.ageGroup, team.eventName);
      newGames++;
      
      await sleep(2000); // Be nice to GC
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`✅ Cycle complete: ${totalGames} games found, ${newGames} scraped`);
  console.log(`   Next scrape in ${POLL_INTERVAL} minutes.\n`);
}

async function run() {
  const teams = readTeamConfig();
  console.log(`\n📋 Loaded ${teams.length} teams from ec-teams.txt\n`);
  teams.forEach(t => console.log(`   ${t.ageGroup} | ${t.eventName} | ${t.startDate || 'no date'}-${t.endDate || 'no date'} | ${t.url}`));

  await launchBrowser();
  await checkLogin();
  
  // First cycle
  await pollOnce(teams);

  // Loop
  console.log(`⏰ Polling every ${POLL_INTERVAL} minutes. Press Ctrl+C to stop.\n`);

  const interval = setInterval(async () => {
    try {
      const freshTeams = readTeamConfig(); // Re-read in case file changed
      await pollOnce(freshTeams);
    } catch (err) {
      console.error('❌ Poll cycle error:', err.message);
    }
  }, POLL_INTERVAL * 60 * 1000);

  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down...');
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
