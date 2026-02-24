import http from 'http';
import { createClient } from '@supabase/supabase-js';
import { launchBrowser, checkLogin, closeBrowser, pollOnce, readTeamConfig,
         createSessionBrowser, closeSessionBrowser, checkLoginWithPage,
         discoverGcApiEndpoints } from './ec-polling-v2.mjs';
import { pollTeams, getGcToken } from './ec-scraper-fetch.mjs';

// Prevent Chrome crashes from killing the service
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err?.message || err);
});

const PORT = process.env.PORT || 3001;
const API_SECRET = process.env.API_SECRET || 'ec-scraper-secret-2026';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── SCRAPER STATE ───────────────────────────────────────────
let scraperStatus = 'idle'; // idle | running | stopped | error
let currentEvent = null;
let scrapeLog = [];
let pollInterval = null;
let allGamesFinalSince = null;
const AUTO_STOP_DELAY = 60; // minutes after all games final
const POLL_INTERVAL = 10; // minutes between cycles

// ─── MULTI-EVENT SESSION STATE (v1 — Puppeteer) ─────────────
const activeSessions = new Map(); // eventId → session object
const MAX_SESSIONS = 6;

// ─── FETCH-BASED SESSION STATE (v2 — no browser) ────────────
const fetchSessions = new Map(); // eventId → v2 session object
const MAX_FETCH_SESSIONS = 50;
const FETCH_POLL_INTERVAL = 5; // minutes between v2 cycles

const log = (msg) => {
  const entry = '[' + new Date().toISOString() + '] ' + msg;
  console.log(entry);
  scrapeLog.push(entry);
  if (scrapeLog.length > 500) scrapeLog.shift();
};

// ─── AUTH CHECK ──────────────────────────────────────────────
function checkAuth(req) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const token = url.searchParams.get('token') || req.headers['authorization']?.replace('Bearer ', '');
  return token === API_SECRET;
}

// ─── START SCRAPING ──────────────────────────────────────────
async function startScraping() {
  if (scraperStatus === 'running') {
    log('⚠️  Scraper already running');
    return { error: 'Already running' };
  }

  scraperStatus = 'running';
  allGamesFinalSince = null;
  log('🚀 Starting scraper...');

  try {
    log('🌐 About to launch browser...');
    await launchBrowser();
    log('🌐 Browser launched OK');
    await checkLogin();
    log('✅ Login check passed');
    
    const teams = readTeamConfig();
    currentEvent = teams.length > 0 ? teams[0].eventName : 'Unknown';
    log('📋 Loaded ' + teams.length + ' teams for ' + currentEvent);

    // First cycle
    try {
      await runCycle(teams);
    } catch (cycleErr) {
      log('❌ First cycle error (continuing): ' + cycleErr.message);
    }

    // Start polling interval
    pollInterval = setInterval(async () => {
      try {
        // Check auto-stop
        if (allGamesFinalSince && (Date.now() - allGamesFinalSince) >= AUTO_STOP_DELAY * 60000) {
          log('🛑 AUTO-STOP: All games final for ' + AUTO_STOP_DELAY + '+ min. Stopping.');
          await stopScraping();
          return;
        }
        const freshTeams = readTeamConfig();
        await runCycle(freshTeams);
      } catch (err) {
        log('❌ Poll cycle error: ' + err.message);
      }
    }, POLL_INTERVAL * 60 * 1000);

    return { status: 'started', teams: teams.length, event: currentEvent };
  } catch (err) {
    scraperStatus = 'error';
    log('❌ Start error: ' + err.message);
    log('❌ Stack: ' + (err.stack || 'none'));
    try { await closeBrowser(); } catch(e) {}
    return { error: err.message };
  }
}

async function runCycle(teams) {
  const result = await pollOnce(teams);
  
  // Track auto-stop
  if (result.totalGames > 0 && result.liveOrUpcoming === 0) {
    if (!allGamesFinalSince) {
      allGamesFinalSince = Date.now();
      log('🏁 All games FINAL — auto-stop in ' + AUTO_STOP_DELAY + ' min');
    } else {
      const mins = Math.round((Date.now() - allGamesFinalSince) / 60000);
      log('🏁 All games still final: ' + mins + '/' + AUTO_STOP_DELAY + ' min until auto-stop');
    }
  } else {
    allGamesFinalSince = null;
  }

  return result;
}

async function stopScraping() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  await closeBrowser();
  scraperStatus = 'stopped';
  currentEvent = null;
  allGamesFinalSince = null;
  log('🛑 Scraper stopped');
}

// ─── MULTI-EVENT SESSION MANAGEMENT ─────────────────────────

async function startSession(eventId, teams, eventName) {
  if (activeSessions.has(eventId)) {
    return { error: 'Event ' + eventId + ' already scraping' };
  }
  if (activeSessions.size >= MAX_SESSIONS) {
    return { error: 'Max ' + MAX_SESSIONS + ' concurrent sessions. Stop one first.' };
  }

  const session = {
    eventId, eventName, teams,
    browser: null, page: null, profileDir: null,
    status: 'running',
    pollInterval: null,
    allGamesFinalSince: null,
    log: [],
    startedAt: Date.now(),
  };

  const slog = (msg) => {
    const entry = '[' + new Date().toISOString() + '] [' + eventName + '] ' + msg;
    console.log(entry);
    session.log.push(entry);
    if (session.log.length > 200) session.log.shift();
    log(entry);
  };
  session.slog = slog;

  activeSessions.set(eventId, session);

  try {
    slog('🚀 Starting session...');
    const sb = await createSessionBrowser(eventId);
    session.browser = sb.browser;
    session.page = sb.page;
    session.profileDir = sb.profileDir;

    await checkLoginWithPage(session.page);
    slog('✅ Login check passed');
    slog('📋 ' + teams.length + ' teams for ' + eventName);

    const ctx = {
      page: session.page,
      get allGamesFinalSince() { return session.allGamesFinalSince; },
      setAllGamesFinalSince(v) { session.allGamesFinalSince = v; },
    };

    // First cycle
    try { await runSessionCycle(session, ctx); }
    catch(e) { slog('❌ First cycle error: ' + e.message); }

    // Start polling
    session.pollInterval = setInterval(async () => {
      try {
        if (session.allGamesFinalSince && (Date.now() - session.allGamesFinalSince) >= AUTO_STOP_DELAY * 60000) {
          slog('🛑 AUTO-STOP: All games final for ' + AUTO_STOP_DELAY + '+ min');
          await stopSession(eventId);
          return;
        }
        await runSessionCycle(session, ctx);
      } catch(e) { slog('❌ Cycle error: ' + e.message); }
    }, POLL_INTERVAL * 60 * 1000);

    return { status: 'started', teamsLoaded: teams.length, event: eventName };
  } catch(e) {
    session.status = 'error';
    slog('❌ Start error: ' + e.message);
    await closeSessionBrowser(session);
    activeSessions.delete(eventId);
    return { error: e.message };
  }
}

async function runSessionCycle(session, ctx) {
  const result = await pollOnce(session.teams, ctx);

  if (result.totalGames > 0 && result.liveOrUpcoming === 0) {
    if (!session.allGamesFinalSince) {
      session.allGamesFinalSince = Date.now();
      session.slog('🏁 All games FINAL — auto-stop in ' + AUTO_STOP_DELAY + ' min');
    }
  } else {
    session.allGamesFinalSince = null;
  }
  return result;
}

async function stopSession(eventId) {
  const session = activeSessions.get(eventId);
  if (!session) return;
  if (session.pollInterval) clearInterval(session.pollInterval);
  await closeSessionBrowser(session);
  session.status = 'stopped';
  if (session.slog) session.slog('🛑 Session stopped');
  activeSessions.delete(eventId);
}

// ─── FETCH-BASED SESSION MANAGEMENT (v2) ────────────────────

async function startFetchSession(eventId, teams, eventName) {
  if (fetchSessions.has(eventId)) {
    return { error: 'Event ' + eventId + ' already scraping (v2)' };
  }
  if (fetchSessions.size >= MAX_FETCH_SESSIONS) {
    return { error: 'Max ' + MAX_FETCH_SESSIONS + ' concurrent fetch sessions reached' };
  }

  const session = {
    eventId, eventName, teams,
    type: 'v2',
    status: 'running',
    pollInterval: null,
    allGamesFinalSince: null,
    log: [],
    startedAt: Date.now(),
    lastCycleAt: null,
    totalGames: 0,
    newGames: 0,
  };

  const slog = (msg) => {
    const entry = '[' + new Date().toISOString() + '] [v2:' + eventName + '] ' + msg;
    console.log(entry);
    session.log.push(entry);
    if (session.log.length > 200) session.log.shift();
    log(entry);
  };
  session.slog = slog;

  fetchSessions.set(eventId, session);

  try {
    slog('🚀 Starting fetch session...');

    // Ensure gc-token is available (obtains once, then cached)
    await getGcToken();
    slog('✅ GC token ready');
    slog('📋 ' + teams.length + ' teams for ' + eventName);

    // First cycle
    try { await runFetchCycle(session); }
    catch(e) { slog('❌ First cycle error: ' + e.message); }

    // Start polling
    session.pollInterval = setInterval(async () => {
      try {
        if (session.allGamesFinalSince && (Date.now() - session.allGamesFinalSince) >= AUTO_STOP_DELAY * 60000) {
          slog('🛑 AUTO-STOP: All games final for ' + AUTO_STOP_DELAY + '+ min');
          await stopFetchSession(eventId);
          return;
        }
        await runFetchCycle(session);
      } catch(e) { slog('❌ Cycle error: ' + e.message); }
    }, FETCH_POLL_INTERVAL * 60 * 1000);

    return { status: 'started', teamsLoaded: teams.length, event: eventName };
  } catch(e) {
    session.status = 'error';
    slog('❌ Start error: ' + e.message);
    fetchSessions.delete(eventId);
    return { error: e.message };
  }
}

async function runFetchCycle(session) {
  const result = await pollTeams(session.teams, session.slog);
  session.lastCycleAt = Date.now();
  session.totalGames = result.totalGames;
  session.newGames += result.newGames;

  if (result.totalGames > 0 && result.liveOrUpcoming === 0) {
    if (!session.allGamesFinalSince) {
      session.allGamesFinalSince = Date.now();
      session.slog('🏁 All games FINAL — auto-stop in ' + AUTO_STOP_DELAY + ' min');
    }
  } else {
    session.allGamesFinalSince = null;
  }
  return result;
}

async function stopFetchSession(eventId) {
  const session = fetchSessions.get(eventId);
  if (!session) return;
  if (session.pollInterval) clearInterval(session.pollInterval);
  session.status = 'stopped';
  if (session.slog) session.slog('🛑 Fetch session stopped');
  fetchSessions.delete(eventId);
}

// ─── HTTP SERVER ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost:' + PORT);
  const path = url.pathname;
  const json = (data, status) => { res.writeHead(status || 200, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };

  // ─── PUBLIC ENDPOINTS ────────────────────────────────────
  if (path === '/health') {
    const sessions = [];
    for (const [eid, s] of activeSessions) {
      sessions.push({ eventId: eid, eventName: s.eventName, type: 'v1', status: s.status, teams: s.teams.length, startedAt: new Date(s.startedAt).toISOString() });
    }
    for (const [eid, s] of fetchSessions) {
      sessions.push({ eventId: eid, eventName: s.eventName, type: 'v2', status: s.status, teams: s.teams.length, startedAt: new Date(s.startedAt).toISOString() });
    }
    const autoStopInfo = allGamesFinalSince
      ? { allFinalSince: new Date(allGamesFinalSince).toISOString(), minutesUntilStop: Math.max(0, AUTO_STOP_DELAY - Math.round((Date.now() - allGamesFinalSince) / 60000)) }
      : null;
    json({ status: 'ok', scraper: scraperStatus, event: currentEvent, sessions, v1Sessions: activeSessions.size, v2Sessions: fetchSessions.size, maxV1: MAX_SESSIONS, maxV2: MAX_FETCH_SESSIONS, uptime: process.uptime(), autoStop: autoStopInfo });

  } else if (path === '/status') {
    const sessions = [];
    for (const [eid, s] of activeSessions) {
      sessions.push({
        eventId: eid, eventName: s.eventName, type: 'v1', status: s.status,
        teams: s.teams.length,
        autoStop: s.allGamesFinalSince ? { since: new Date(s.allGamesFinalSince).toISOString(), minutesRemaining: Math.max(0, AUTO_STOP_DELAY - Math.round((Date.now() - s.allGamesFinalSince) / 60000)) } : null,
        logLines: s.log.slice(-30),
      });
    }
    for (const [eid, s] of fetchSessions) {
      sessions.push({
        eventId: eid, eventName: s.eventName, type: 'v2', status: s.status,
        teams: s.teams.length, pollInterval: FETCH_POLL_INTERVAL + 'min',
        totalGames: s.totalGames, newGames: s.newGames,
        lastCycleAt: s.lastCycleAt ? new Date(s.lastCycleAt).toISOString() : null,
        autoStop: s.allGamesFinalSince ? { since: new Date(s.allGamesFinalSince).toISOString(), minutesRemaining: Math.max(0, AUTO_STOP_DELAY - Math.round((Date.now() - s.allGamesFinalSince) / 60000)) } : null,
        logLines: s.log.slice(-30),
      });
    }
    json({
      legacyScraper: scraperStatus,
      currentEvent,
      sessions,
      autoStop: allGamesFinalSince
        ? { since: new Date(allGamesFinalSince).toISOString(), minutesRemaining: Math.max(0, AUTO_STOP_DELAY - Math.round((Date.now() - allGamesFinalSince) / 60000)) }
        : null,
      logLines: scrapeLog.slice(-50)
    });

  } else if (path === '/events') {
    const { data } = await supabase.from('ec_events').select('*').order('start_date', { ascending: false });
    json({ events: data });

  // ─── PROTECTED ENDPOINTS (require API_SECRET) ────────────
  } else if (path === '/scrape' && req.method === 'POST') {
    if (!checkAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    json({ status: 'starting' });
    startScraping().catch(err => log('❌ Scrape error: ' + err.message));

  } else if (path === '/scrape-event' && req.method === 'POST') {
    if (!checkAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }

    let body = '';
    for await (const chunk of req) body += chunk;
    let params;
    try { params = JSON.parse(body); } catch(e) { json({ error: 'Invalid JSON' }, 400); return; }

    const eventId = params.eventId;
    if (!eventId) { json({ error: 'eventId required' }, 400); return; }

    // Reject if already scraping this event
    if (activeSessions.has(eventId)) {
      json({ error: 'Event already being scraped', eventId }, 409); return;
    }
    if (activeSessions.size >= MAX_SESSIONS) {
      json({ error: 'Max ' + MAX_SESSIONS + ' concurrent sessions reached' }, 429); return;
    }

    const { data: event } = await supabase.from('ec_events').select('*').eq('id', eventId).single();
    if (!event) { json({ error: 'Event not found' }, 404); return; }

    const { data: eventTeams } = await supabase
      .from('ec_event_teams')
      .select('*, team:ec_teams!team_id(*)')
      .eq('event_id', eventId);

    const teamsWithGC = (eventTeams || []).filter(et => et.team && (et.team.gc_team_id || et.team.gc_team_link));
    if (teamsWithGC.length === 0) {
      json({ error: 'No teams with GC links found for this event' }, 400); return;
    }

    const eventName = event.name || event.event_name || 'Unknown Event';
    const startDate = event.start_date || '';
    const endDate = event.end_date || '';

    // Build teams array in memory (same shape as readTeamConfig)
    const teams = teamsWithGC.map(et => {
      const team = et.team;
      const url = team.gc_team_link || ('https://web.gc.com/teams/' + team.gc_team_id);
      const age = et.age_group || team.age_group || 'Unknown';
      return { url, ageGroup: age, eventName, startDate, endDate };
    });

    json({ status: 'starting', teamsLoaded: teams.length, event: eventName, activeSessions: activeSessions.size + 1 });
    startSession(eventId, teams, eventName).catch(err => log('❌ Session error: ' + err.message));

  } else if (path === '/scrape-event-v2' && req.method === 'POST') {
    if (!checkAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }

    let body = '';
    for await (const chunk of req) body += chunk;
    let params;
    try { params = JSON.parse(body); } catch(e) { json({ error: 'Invalid JSON' }, 400); return; }

    const eventId = params.eventId;
    if (!eventId) { json({ error: 'eventId required' }, 400); return; }

    // Reject if already scraping this event (check both v1 and v2)
    if (fetchSessions.has(eventId)) {
      json({ error: 'Event already being scraped (v2)', eventId }, 409); return;
    }
    if (activeSessions.has(eventId)) {
      json({ error: 'Event already being scraped (v1)', eventId }, 409); return;
    }
    if (fetchSessions.size >= MAX_FETCH_SESSIONS) {
      json({ error: 'Max ' + MAX_FETCH_SESSIONS + ' concurrent v2 sessions reached' }, 429); return;
    }

    const { data: event } = await supabase.from('ec_events').select('*').eq('id', eventId).single();
    if (!event) { json({ error: 'Event not found' }, 404); return; }

    const { data: eventTeams } = await supabase
      .from('ec_event_teams')
      .select('*, team:ec_teams!team_id(*)')
      .eq('event_id', eventId);

    const teamsWithGC = (eventTeams || []).filter(et => et.team && (et.team.gc_team_id || et.team.gc_team_link));
    if (teamsWithGC.length === 0) {
      json({ error: 'No teams with GC links found for this event' }, 400); return;
    }

    const eventName = event.name || event.event_name || 'Unknown Event';
    const startDate = event.start_date || '';
    const endDate = event.end_date || '';

    const teams = teamsWithGC.map(et => {
      const team = et.team;
      const url = team.gc_team_link || ('https://web.gc.com/teams/' + team.gc_team_id);
      const age = et.age_group || team.age_group || 'Unknown';
      return { url, ageGroup: age, eventName, eventId, startDate, endDate };
    });

    json({ status: 'starting', type: 'v2', teamsLoaded: teams.length, event: eventName, fetchSessions: fetchSessions.size + 1 });
    startFetchSession(eventId, teams, eventName).catch(err => log('❌ v2 session error: ' + err.message));

  // ─── TEMPORARY: GC API discovery (remove after use) ────────
  } else if (path === '/discover-gc-api' && req.method === 'POST') {
    if (!checkAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }

    let body = '';
    for await (const chunk of req) body += chunk;
    let params;
    try { params = JSON.parse(body); } catch(e) { json({ error: 'Invalid JSON' }, 400); return; }

    const teamUrl = params.teamUrl;
    if (!teamUrl || !teamUrl.includes('gc.com/teams/')) {
      json({ error: 'teamUrl required (e.g. https://web.gc.com/teams/XXXXX)' }, 400); return;
    }

    log('🔍 Starting GC API discovery for: ' + teamUrl);

    let sessionBrowser = null;
    try {
      // Use a separate session browser to avoid profile lock conflicts
      sessionBrowser = await createSessionBrowser('api-discovery');
      await checkLoginWithPage(sessionBrowser.page);

      const result = await discoverGcApiEndpoints(teamUrl, sessionBrowser.page);
      json({
        status: 'complete',
        totalEndpoints: result.discovered.length,
        uniquePatterns: result.patterns.length,
        patterns: result.patterns,
        logFile: result.logFile,
        capturedRequests: (result.capturedRequests || []).map(r => ({
          url: r.url,
          method: r.method,
          authorization: r.headers?.['authorization'] || null,
          headers: r.headers,
        })),
        endpoints: result.discovered.map(d => ({
          url: d.url,
          status: d.status,
          size: d.bodySize,
          preview: d.bodyPreview.substring(0, 150),
        })),
      });
    } catch(e) {
      log('❌ Discovery error: ' + e.message);
      json({ error: e.message }, 500);
    } finally {
      if (sessionBrowser) await closeSessionBrowser(sessionBrowser);
    }

  } else if (path === '/stop' && req.method === 'POST') {
    if (!checkAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    let params = {};
    try { params = JSON.parse(body); } catch(e) {}

    if (params.eventId) {
      // Stop from whichever Map has it
      if (fetchSessions.has(params.eventId)) {
        await stopFetchSession(params.eventId);
        json({ status: 'stopped', type: 'v2', eventId: params.eventId });
      } else if (activeSessions.has(params.eventId)) {
        await stopSession(params.eventId);
        json({ status: 'stopped', type: 'v1', eventId: params.eventId });
      } else {
        json({ error: 'No active session for event ' + params.eventId }, 404);
      }
    } else {
      // Stop all sessions (v1 + v2) + legacy
      const v1Count = activeSessions.size;
      const v2Count = fetchSessions.size;
      for (const [eid] of activeSessions) await stopSession(eid);
      for (const [eid] of fetchSessions) await stopFetchSession(eid);
      await stopScraping();
      json({ status: 'all_stopped', v1Stopped: v1Count, v2Stopped: v2Count });
    }

  } else {
    json({ error: 'Not found', endpoints: ['/health', '/status', '/events', 'POST /scrape', 'POST /scrape-event', 'POST /scrape-event-v2', 'POST /stop'] }, 404);
  }
});

server.listen(PORT, () => {
  log('EC Scraper Service running on port ' + PORT);
  log('Endpoints: /health, /status, /events, POST /scrape (auth), POST /scrape-event (auth), POST /scrape-event-v2 (auth), POST /stop (auth)');
});
