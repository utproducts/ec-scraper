import http from 'http';
import { createClient } from '@supabase/supabase-js';

const PORT = process.env.PORT || 3001;
const API_SECRET = process.env.API_SECRET || 'ec-scraper-secret-2026';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

let scraperStatus = 'idle';
let currentEvent = null;
let scrapeLog = [];

const log = (msg) => {
  const entry = '[' + new Date().toISOString() + '] ' + msg;
  console.log(entry);
  scrapeLog.push(entry);
  if (scrapeLog.length > 500) scrapeLog.shift();
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost:' + PORT);
  const path = url.pathname;
  const json = (data, status) => { res.writeHead(status || 200, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };

  if (path === '/health') {
    json({ status: 'ok', scraper: scraperStatus, uptime: process.uptime() });
  } else if (path === '/status') {
    json({ status: scraperStatus, currentEvent, logLines: scrapeLog.slice(-50) });
  } else if (path === '/events') {
    const { data } = await supabase.from('ec_events').select('*').order('start_date', { ascending: false });
    json({ events: data });
  } else {
    json({ error: 'Not found' }, 404);
  }
});

server.listen(PORT, () => {
  log('EC Scraper Service running on port ' + PORT);
});
