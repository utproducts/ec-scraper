import http from 'http';
import { createClient } from '@supabase/supabase-js';
import { launchBrowser, checkLogin, closeBrowser, pollOnce, readTeamConfig } from './ec-polling-v2.mjs';

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
    await launchBrowser();
    await checkLogin();
    
    const teams = readTeamConfig();
    currentEvent = teams.length > 0 ? teams[0].eventName : 'Unknown';
    log('📋 Loaded ' + teams.length + ' teams for ' + currentEvent);

    // First cycle
    await runCycle(teams);

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
    const autoStopInfo = allGamesFinalSince 
      ? { allFinalSince: new Date(allGamesFinalSince).toISOString(), minutesUntilStop: Math.max(0, AUTO_STOP_DELAY - Math.round((Date.now() - allGamesFinalSince) / 60000)) }
      : null;
    json({ status: 'ok', scraper: scraperStatus, event: currentEvent, uptime: process.uptime(), autoStop: autoStopInfo });

  } else if (path === '/status') {
    json({ 
      status: scraperStatus, 
      currentEvent, 
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
    const result = await startScraping();
    json(result);

  } else if (path === '/scrape-event' && req.method === 'POST') {
    if (!checkAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    
    // Read POST body
    let body = '';
    for await (const chunk of req) body += chunk;
    let params;
    try { params = JSON.parse(body); } catch(e) { json({ error: 'Invalid JSON' }, 400); return; }
    
    const eventId = params.eventId;
    if (!eventId) { json({ error: 'eventId required' }, 400); return; }
    
    // Load event details
    const { data: event } = await supabase.from('ec_events').select('*').eq('id', eventId).single();
    if (!event) { json({ error: 'Event not found' }, 404); return; }
    
    // Load teams with GC links for this event
    const { data: eventTeams } = await supabase
      .from('ec_event_teams')
      .select('*, team:ec_teams!team_id(*)')
      .eq('event_id', eventId);
    
    const teamsWithGC = (eventTeams || []).filter(et => et.team && (et.team.gc_team_id || et.team.gc_team_link));
    
    if (teamsWithGC.length === 0) {
      json({ error: 'No teams with GC links found for this event' }, 400);
      return;
    }
    
    // Build ec-teams.txt dynamically
    const eventName = event.name || event.event_name || 'Unknown Event';
    const startDate = event.start_date || '';
    const endDate = event.end_date || '';
    
    let teamsConfig = '# Auto-generated from Event Central\n';
    teamsWithGC.forEach(et => {
      const team = et.team;
      const gcId = team.gc_team_id;
      const url = team.gc_team_link || ('https://web.gc.com/teams/' + gcId);
      const age = et.age_group || team.age_group || 'Unknown';
      teamsConfig += url + ' | ' + age + ' | ' + eventName + ' | ' + startDate + ' | ' + endDate + '\n';
    });
    
    // Write to ec-teams.txt
    const fs = await import('fs');
    fs.default.writeFileSync('ec-teams.txt', teamsConfig);
    log('📝 Wrote ' + teamsWithGC.length + ' teams to ec-teams.txt for event: ' + eventName);
    
    // Start scraping
    const result = await startScraping();
    json({ ...result, teamsLoaded: teamsWithGC.length, event: eventName });

  } else if (path === '/stop' && req.method === 'POST') {
    if (!checkAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    await stopScraping();
    json({ status: 'stopped' });

  } else {
    json({ error: 'Not found', endpoints: ['/health', '/status', '/events', 'POST /scrape', 'POST /stop'] }, 404);
  }
});

server.listen(PORT, () => {
  log('EC Scraper Service running on port ' + PORT);
  log('Endpoints: /health, /status, /events, POST /scrape (auth), POST /stop (auth)');
});
