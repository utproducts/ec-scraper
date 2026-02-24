/**
 * Fetch-Based GC Scraper — ec-scraper-fetch.mjs
 *
 * Replaces Puppeteer DOM scraping with direct HTTP calls to GameChanger's REST API.
 * Puppeteer is used ONCE to capture the gc-token JWT, then all data is fetched via HTTP.
 *
 * GC API base: https://api.team-manager.gc.com
 *
 * Public endpoints (no auth):
 *   GET /public/teams/{teamId}
 *   GET /public/teams/{teamId}/games
 *   GET /public/game-stream-processing/{gameId}/details?include=line_scores
 *
 * Authenticated endpoint (gc-token required):
 *   GET /game-stream-processing/{gameId}/boxscore
 */

import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import fs, { cpSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { findOrCreateTeam, findOrCreatePlayer, calculatePOTG, normalizeTeamName } from './ec-polling-v2.mjs';

try { const d = await import('dotenv'); d.default.config(); } catch(e) {}

// ─── CONFIG ──────────────────────────────────────────────────
const GC_API = 'https://api.team-manager.gc.com';
const TOKEN_REFRESH_MARGIN = 10 * 60 * 1000; // 10 min before expiry
const REQUEST_DELAY = 150; // ms between API calls
const MAX_RETRIES = 2;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Set SUPABASE_URL and SUPABASE_ANON_KEY in .env');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── TOKEN MANAGEMENT ────────────────────────────────────────
let gcToken = null;
let gcTokenExpiry = 0; // Unix timestamp ms

async function obtainGcToken() {
  console.log('🔑 Obtaining GC token via Puppeteer...');

  // Create temp browser with copied profile (same pattern as createSessionBrowser)
  const profileDir = path.join(tmpdir(), 'ec-scraper-token-' + Date.now());
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });

  const baseProfile = './gc-browser-data';
  if (existsSync(baseProfile)) {
    cpSync(baseProfile, profileDir, { recursive: true });
    for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { rmSync(path.join(profileDir, lockFile), { force: true }); } catch(e) {}
    }
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      userDataDir: profileDir,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Intercept requests to capture gc-token from boxscore call
    let capturedToken = null;
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('boxscore') || url.includes('game-stream-processing')) {
        const headers = req.headers();
        if (headers['gc-token']) {
          capturedToken = headers['gc-token'];
        }
      }
    });

    // Navigate to a known team schedule to find a game
    const teamUrl = 'https://web.gc.com/teams/QP9Pju4Y50N4/schedule';
    console.log('  📄 Navigating to schedule page...');
    await page.goto(teamUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(2000);

    // Find a game link
    const gameLinks = await page.$$eval(
      'a[href*="/schedule/"]',
      els => els.map(e => e.href).filter(h => /schedule\/[a-f0-9-]+/.test(h))
    );

    if (gameLinks.length === 0) {
      throw new Error('No game links found on schedule page');
    }

    // Navigate to box score page — this triggers the gc-token request
    // Game links are like /teams/X/schedule/GAMEID — append /box-score
    let gameLink = gameLinks[0];
    if (gameLink.endsWith('/')) gameLink = gameLink.slice(0, -1);
    const boxScoreUrl = gameLink + '/box-score';
    console.log('  📄 Navigating to box score: ' + boxScoreUrl);
    await page.goto(boxScoreUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(3000);

    if (!capturedToken) {
      throw new Error('Failed to capture gc-token from browser requests');
    }

    // Decode JWT payload to get expiry
    const payload = JSON.parse(Buffer.from(capturedToken.split('.')[1], 'base64').toString());
    gcToken = capturedToken;
    gcTokenExpiry = payload.exp * 1000; // convert seconds to ms

    const expiresIn = Math.round((gcTokenExpiry - Date.now()) / 60000);
    console.log('  ✅ GC token obtained, expires in ' + expiresIn + ' min');

  } finally {
    if (browser) try { await browser.close(); } catch(e) {}
    try { rmSync(profileDir, { recursive: true }); } catch(e) {}
  }
}

async function getGcToken() {
  if (gcToken && Date.now() < gcTokenExpiry - TOKEN_REFRESH_MARGIN) {
    return gcToken;
  }
  await obtainGcToken();
  return gcToken;
}

// ─── HTTP HELPERS ────────────────────────────────────────────

async function gcFetch(urlPath, needsAuth = false) {
  const url = GC_API + urlPath;
  const headers = { 'gc-app-name': 'web' };

  if (needsAuth) {
    headers['gc-token'] = await getGcToken();
    headers['accept'] = 'application/vnd.gc.com.event_box_score+json; version=0.0.0';
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers });

      // On 401, refresh token and retry once
      if (res.status === 401 && needsAuth && attempt === 0) {
        console.log('  ⚠️  401 on boxscore — refreshing token...');
        gcToken = null;
        headers['gc-token'] = await getGcToken();
        continue;
      }

      if (!res.ok) {
        throw new Error('GC API ' + res.status + ' ' + res.statusText + ' — ' + urlPath);
      }

      return await res.json();
    } catch (err) {
      if (attempt < MAX_RETRIES && (err.message.includes('fetch failed') || err.message.includes('5'))) {
        console.log('  ⚠️  Retry ' + (attempt + 1) + '/' + MAX_RETRIES + ': ' + err.message);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

// ─── API FUNCTIONS ───────────────────────────────────────────

async function fetchTeamInfo(teamId) {
  return gcFetch('/public/teams/' + teamId);
}

async function fetchTeamGames(teamId) {
  return gcFetch('/public/teams/' + teamId + '/games');
}

async function fetchGameDetails(gameId) {
  return gcFetch('/public/game-stream-processing/' + gameId + '/details?include=line_scores');
}

async function fetchBoxScore(gameId) {
  return gcFetch('/game-stream-processing/' + gameId + '/boxscore', true);
}

// ─── DATA MAPPING ────────────────────────────────────────────

/**
 * Map boxscore JSON for a single team into batting and pitching arrays
 * matching the format that saveGame/parseBatting/parsePitching produce.
 *
 * Boxscore team structure:
 *   { players: [...], groups: [{ category, team_stats, stats|extra, ... }] }
 *
 * We need to discover the per-player stat layout on first run since the
 * exact JSON shape wasn't fully captured. This function handles multiple
 * possible layouts.
 */
function mapBoxScoreToStats(teamData) {
  const players = teamData.players || [];
  const groups = teamData.groups || [];
  const playerMap = {};
  for (const p of players) {
    playerMap[p.id] = {
      firstName: p.first_name || '',
      lastName: p.last_name || '',
      number: p.number || '',
    };
  }

  let batting = [];
  let pitching = [];

  for (const group of groups) {
    const category = group.category;

    if (category === 'lineup') {
      batting = extractPlayerStats(group, playerMap, 'batting');
    } else if (category === 'pitching') {
      pitching = extractPlayerStats(group, playerMap, 'pitching');
    }
  }

  return { batting, pitching };
}

/**
 * Extract per-player stats from a boxscore group.
 *
 * Actual GC boxscore layout:
 *   group.stats = [{
 *     player_id: "xxx",
 *     player_text: "(P, CF)",      // position info
 *     stats: { AB: 2, R: 1, ... }  // nested stat object
 *   }]
 *   group.extra = [{ stat_name: "TB", stats: [{ player_id, value }] }]
 */
function extractPlayerStats(group, playerMap, type) {
  const statsByPlayer = {}; // player_id → { stat_name: value, _pos: position }

  // Primary stats: group.stats array with nested stats objects
  if (Array.isArray(group.stats)) {
    for (const entry of group.stats) {
      const pid = entry.player_id;
      if (!pid) continue;
      if (!statsByPlayer[pid]) statsByPlayer[pid] = {};

      // Nested stats object: { AB: 2, R: 1, H: 1, ... }
      if (entry.stats && typeof entry.stats === 'object' && !Array.isArray(entry.stats)) {
        for (const [key, val] of Object.entries(entry.stats)) {
          statsByPlayer[pid][key] = val;
        }
      }

      // Position from player_text: "(P, CF)" → "P, CF"
      if (entry.player_text) {
        const posMatch = entry.player_text.match(/\(([^)]+)\)/);
        if (posMatch) statsByPlayer[pid]._pos = posMatch[1];
      }
    }
  }

  // Log discovered structure
  const playerIds = Object.keys(statsByPlayer);
  if (playerIds.length > 0) {
    const sampleStats = Object.keys(statsByPlayer[playerIds[0]]).filter(k => !k.startsWith('_'));
    console.log('  📊 ' + type + ' stats found for ' + playerIds.length + ' players: ' + sampleStats.join(', '));
  } else {
    console.log('  ⚠️  No per-player ' + type + ' stats found. Group keys: ' + Object.keys(group).join(', '));
  }

  // Build result arrays matching parseBatting/parsePitching format
  const result = [];
  for (const [pid, stats] of Object.entries(statsByPlayer)) {
    const player = playerMap[pid] || {};
    const name = ((player.firstName || '') + ' ' + (player.lastName || '')).trim() || 'Unknown';
    const jersey = player.number || '';

    if (type === 'batting') {
      result.push({
        name,
        jersey,
        pos: stats._pos || '',
        ab: stats.AB ?? 0,
        r: stats.R ?? 0,
        h: stats.H ?? 0,
        rbi: stats.RBI ?? 0,
        bb: stats.BB ?? 0,
        so: stats.SO ?? stats.K ?? 0,
      });
    } else if (type === 'pitching') {
      // Convert decimal IP to baseball notation (1.6667 → 1.2, 1.3333 → 1.1)
      const rawIp = stats.IP ?? 0;
      const whole = Math.floor(rawIp);
      const thirds = Math.round((rawIp - whole) * 3);
      const baseballIp = whole + thirds * 0.1;

      result.push({
        name,
        jersey,
        ip: Math.round(baseballIp * 10) / 10,
        h: stats.H ?? 0,
        r: stats.R ?? 0,
        er: stats.ER ?? 0,
        bb: stats.BB ?? 0,
        so: stats.SO ?? stats.K ?? 0,
      });
    }
  }

  return result;
}

// ─── SAVE FUNCTIONS ──────────────────────────────────────────

/**
 * Save a game from API data to Supabase.
 *
 * @param {string} gcGameId - GC game UUID (from games API)
 * @param {string} ourTeamId - GC team ID we're scraping for
 * @param {object} game - Game object from fetchTeamGames
 * @param {object} boxScore - Full boxscore JSON (keyed by team IDs)
 * @param {string} ageGroup - Age group (e.g. "9U")
 * @param {string} eventName - Event name
 * @param {string} eventId - Event UUID (for registered team lookup)
 * @param {function} logFn - Logging function
 */
async function saveGameFromApi(gcGameId, ourTeamId, game, boxScore, ageGroup, eventName, eventId, logFn) {
  const log = logFn || console.log;

  // Determine team names and home/away
  const isHome = game.home_away === 'home';
  const opponentName = game.opponent_team?.name || 'Unknown';

  // Get our team name from the boxscore players or team info
  let ourTeamName = null;
  if (boxScore[ourTeamId]?.team_name) {
    ourTeamName = boxScore[ourTeamId].team_name;
  } else {
    // Fetch team info as fallback
    try {
      const info = await fetchTeamInfo(ourTeamId);
      ourTeamName = info.name || 'Unknown';
    } catch(e) {
      ourTeamName = 'Unknown';
    }
  }

  // Find opponent's team ID in boxscore (the other key)
  const boxScoreTeamIds = Object.keys(boxScore);
  const opponentTeamId = boxScoreTeamIds.find(id => id !== ourTeamId) || null;

  // Fetch opponent's actual age group from GC API (not from the game/event)
  let opponentAgeGroup = null;
  if (opponentTeamId) {
    try {
      const oppInfo = await fetchTeamInfo(opponentTeamId);
      // GC API returns age_group or age_division in team info
      const rawAge = oppInfo.age_group || oppInfo.age_division || oppInfo.age || '';
      // Extract "9U", "10U", etc. from whatever format they return
      const ageMatch = rawAge.match(/(\d{1,2}U)/i);
      opponentAgeGroup = ageMatch ? ageMatch[1].toUpperCase() : (rawAge || null);
      await sleep(REQUEST_DELAY);
    } catch (e) {
      log('  ⚠️  Could not fetch opponent team info: ' + e.message);
    }
  }

  // Normalize names
  ourTeamName = normalizeTeamName(ourTeamName);
  const normalizedOpponent = normalizeTeamName(opponentName);

  // Assign home/away
  const awayTeamName = isHome ? normalizedOpponent : ourTeamName;
  const homeTeamName = isHome ? ourTeamName : normalizedOpponent;
  const awayGcId = isHome ? opponentTeamId : ourTeamId;
  const homeGcId = isHome ? ourTeamId : opponentTeamId;
  // Use caller's ageGroup for our team (from ec_event_teams), opponent's from GC API
  const awayAgeGroup = isHome ? opponentAgeGroup : ageGroup;
  const homeAgeGroup = isHome ? ageGroup : opponentAgeGroup;

  // Scores
  const ourScore = game.score?.team ?? null;
  const oppScore = game.score?.opponent_team ?? null;
  const awayScore = isHome ? oppScore : ourScore;
  const homeScore = isHome ? ourScore : oppScore;

  // Game status
  let status = 'live';
  const gs = (game.game_status || '').toLowerCase();
  if (gs === 'completed' || gs === 'final') status = 'final';
  else if (gs === 'in_progress' || gs === 'active') status = 'live';
  else if (gs === 'scheduled' || gs === 'upcoming') status = 'upcoming';

  // Game date
  let gameDate = new Date().toISOString().split('T')[0];
  if (game.start_ts) {
    const parsed = new Date(game.start_ts);
    if (!isNaN(parsed)) gameDate = parsed.toISOString().split('T')[0];
  }

  log('  📝 ' + awayTeamName + ' ' + (awayScore ?? '?') + ' @ ' + homeTeamName + ' ' + (homeScore ?? '?') + ' [' + status + ']');

  // Extract player names from boxscore for roster matching
  const awayBsTeamId = isHome ? opponentTeamId : ourTeamId;
  const homeBsTeamId = isHome ? ourTeamId : opponentTeamId;
  const awayPlayers = (boxScore[awayBsTeamId]?.players || []).map(p =>
    ((p.first_name || '') + ' ' + (p.last_name || '')).trim()
  ).filter(Boolean);
  const homePlayers = (boxScore[homeBsTeamId]?.players || []).map(p =>
    ((p.first_name || '') + ' ' + (p.last_name || '')).trim()
  ).filter(Boolean);

  // Check if opponent is registered for this event — skip non-event games
  let opponentRegisteredDbId = null;
  let opponentInEvent = false;
  if (eventId) {
    const { data: regTeams } = await supabase
      .from('ec_event_teams')
      .select('team_id, team:ec_teams!team_id(id, team_name, gc_team_id)')
      .eq('event_id', eventId);

    if (regTeams) {
      // 1. Match by gc_team_id
      if (opponentTeamId) {
        const gcMatch = regTeams.find(rt => rt.team?.gc_team_id === opponentTeamId);
        if (gcMatch) {
          opponentRegisteredDbId = gcMatch.team.id;
          opponentInEvent = true;
          log('  ✅ Opponent "' + opponentName + '" matched to registered team "' + gcMatch.team.team_name + '" (GC ID)');
        }
      }

      // 2. Fuzzy name match against registered teams
      if (!opponentInEvent) {
        const oppLower = normalizedOpponent.toLowerCase().replace(/\b\d{1,2}u\b/gi, '').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
        for (const rt of regTeams) {
          if (!rt.team?.team_name) continue;
          const regLower = rt.team.team_name.toLowerCase().replace(/\b\d{1,2}u\b/gi, '').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
          // Exact core match, or one contains the other (with reasonable length ratio)
          if (regLower === oppLower ||
              (oppLower.length >= 4 && regLower.includes(oppLower)) ||
              (regLower.length >= 4 && oppLower.includes(regLower) && Math.min(oppLower.length, regLower.length) / Math.max(oppLower.length, regLower.length) > 0.5)) {
            opponentRegisteredDbId = rt.team.id;
            opponentInEvent = true;
            log('  ✅ Opponent "' + opponentName + '" matched to registered team "' + rt.team.team_name + '" (name)');
            break;
          }
        }
      }
    }

    // Skip game if opponent is not in the event
    if (!opponentInEvent) {
      log('  ⏭️ Skipping non-event game: ' + ourTeamName + ' vs ' + normalizedOpponent + ' (opponent not in event)');
      return null;
    }
  }

  // Find/create teams in DB — each team gets its own age group source + roster
  // Use registered team ID for opponent if found, skip findOrCreateTeam
  const awayTeamDbId = isHome && opponentRegisteredDbId
    ? opponentRegisteredDbId
    : await findOrCreateTeam(awayTeamName, awayGcId, awayAgeGroup, eventName, awayPlayers);
  const homeTeamDbId = !isHome && opponentRegisteredDbId
    ? opponentRegisteredDbId
    : await findOrCreateTeam(homeTeamName, homeGcId, homeAgeGroup, eventName, homePlayers);
  if (!awayTeamDbId || !homeTeamDbId) {
    log('  ❌ Could not create teams');
    return null;
  }

  // Upsert game by gc_game_id
  const { data: existingGame } = await supabase
    .from('ec_games')
    .select('id')
    .eq('gc_game_id', gcGameId)
    .single();

  let gameDbId;
  if (existingGame) {
    await supabase.from('ec_games').update({
      away_team_id: awayTeamDbId,
      home_team_id: homeTeamDbId,
      away_score: awayScore,
      home_score: homeScore,
      status,
      game_date: gameDate,
      age_group: ageGroup,
      event_name: eventName,
    }).eq('id', existingGame.id);
    gameDbId = existingGame.id;
  } else {
    const { data: newGame, error } = await supabase
      .from('ec_games')
      .insert({
        gc_game_id: gcGameId,
        away_team_id: awayTeamDbId,
        home_team_id: homeTeamDbId,
        away_score: awayScore,
        home_score: homeScore,
        status,
        game_date: gameDate,
        age_group: ageGroup,
        event_name: eventName,
      })
      .select('id')
      .single();

    if (error) {
      log('  ❌ Game create error: ' + error.message);
      return null;
    }
    gameDbId = newGame.id;
  }

  // Map boxscore to batting/pitching arrays
  const awayBoxTeamId = isHome ? opponentTeamId : ourTeamId;
  const homeBoxTeamId = isHome ? ourTeamId : opponentTeamId;

  const awayStats = boxScore[awayBoxTeamId] ? mapBoxScoreToStats(boxScore[awayBoxTeamId]) : { batting: [], pitching: [] };
  const homeStats = boxScore[homeBoxTeamId] ? mapBoxScoreToStats(boxScore[homeBoxTeamId]) : { batting: [], pitching: [] };

  // Clear old stats and re-save
  await supabase.from('ec_game_stats').delete().eq('game_id', gameDbId);
  await supabase.from('ec_player_of_game').delete().eq('game_id', gameDbId);

  for (const team of [
    { batting: awayStats.batting, pitching: awayStats.pitching, teamId: awayTeamDbId },
    { batting: homeStats.batting, pitching: homeStats.pitching, teamId: homeTeamDbId },
  ]) {
    for (const p of team.batting) {
      const playerId = await findOrCreatePlayer(p.name, p.jersey, team.teamId);
      if (!playerId) continue;
      await supabase.from('ec_game_stats').insert({
        game_id: gameDbId, player_id: playerId, team_id: team.teamId,
        stat_type: 'batting', ab: p.ab, r: p.r, h: p.h, rbi: p.rbi, bb: p.bb, so: p.so,
        position_played: p.pos || null,
      });
    }
    for (const p of team.pitching) {
      const playerId = await findOrCreatePlayer(p.name, p.jersey, team.teamId);
      if (!playerId) continue;
      await supabase.from('ec_game_stats').insert({
        game_id: gameDbId, player_id: playerId, team_id: team.teamId,
        stat_type: 'pitching', ip: p.ip, p_h: p.h, p_r: p.r, p_er: p.er, p_bb: p.bb, p_so: p.so,
      });
    }
  }

  await calculatePOTG(gameDbId);
  log('  ✅ Saved game ' + gcGameId);
  return gameDbId;
}

// ─── POLL CYCLE ──────────────────────────────────────────────

/**
 * Poll all teams for games and save to DB.
 *
 * @param {Array} teams - [{ url, ageGroup, eventName, eventId, startDate, endDate }]
 * @param {function} logFn - Logging function
 * @returns {{ totalGames, newGames, liveOrUpcoming }}
 */
async function pollTeams(teams, logFn) {
  const log = logFn || console.log;
  let totalGames = 0;
  let newGames = 0;
  let liveOrUpcoming = 0;

  for (const team of teams) {
    // Extract teamId from URL
    const teamMatch = team.url.match(/teams\/([A-Za-z0-9]+)/);
    if (!teamMatch) {
      log('⚠️  Could not extract team ID from: ' + team.url);
      continue;
    }
    const teamId = teamMatch[1];

    try {
      log('📋 Fetching games for team ' + teamId + ' (' + team.ageGroup + ')...');
      const games = await fetchTeamGames(teamId);
      await sleep(REQUEST_DELAY);

      if (!Array.isArray(games)) {
        log('⚠️  Unexpected games response for ' + teamId);
        continue;
      }

      // Filter by date range if provided
      const filtered = games.filter(g => {
        if (!g.start_ts) return true;
        const gameDate = g.start_ts.split('T')[0];
        if (team.startDate && gameDate < team.startDate) return false;
        if (team.endDate && gameDate > team.endDate) return false;
        return true;
      });

      log('  Found ' + filtered.length + ' games (of ' + games.length + ' total)');
      totalGames += filtered.length;

      for (const game of filtered) {
        const gs = (game.game_status || '').toLowerCase();
        const isCompleted = gs === 'completed' || gs === 'final';
        const isLive = gs === 'in_progress' || gs === 'active';
        const isUpcoming = gs === 'scheduled' || gs === 'upcoming' || gs === '';

        if (isUpcoming) {
          liveOrUpcoming++;
          continue;
        }
        if (isLive) liveOrUpcoming++;

        // Skip if already final in DB (no need to re-scrape)
        const gcGameId = game.id;
        if (isCompleted) {
          const { data: existing } = await supabase
            .from('ec_games')
            .select('id, status')
            .eq('gc_game_id', gcGameId)
            .single();

          if (existing && existing.status === 'final') {
            continue; // Already saved as final
          }
        }

        // Fetch boxscore
        try {
          log('  🔄 Fetching boxscore for game ' + gcGameId + '...');
          const boxScore = await fetchBoxScore(gcGameId);
          await sleep(REQUEST_DELAY);

          await saveGameFromApi(gcGameId, teamId, game, boxScore, team.ageGroup, team.eventName, team.eventId, log);
          newGames++;
          await sleep(REQUEST_DELAY);
        } catch (err) {
          log('  ❌ Error on game ' + gcGameId + ': ' + err.message);
        }
      }

    } catch (err) {
      log('❌ Error fetching team ' + teamId + ': ' + err.message);
    }
  }

  log('📊 Poll complete: ' + totalGames + ' total, ' + newGames + ' new/updated, ' + liveOrUpcoming + ' live/upcoming');
  return { totalGames, newGames, liveOrUpcoming };
}

// ─── EXPORTS ─────────────────────────────────────────────────

export {
  getGcToken, obtainGcToken,
  fetchTeamInfo, fetchTeamGames, fetchGameDetails, fetchBoxScore,
  mapBoxScoreToStats, saveGameFromApi, pollTeams,
};
