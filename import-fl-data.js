// ═══════════════════════════════════════════════════════════════
// FL PLAYERS + FL COACHES IMPORTER
// Run: node import-fl-data.js
// From: ~/Desktop/unrivaled-connect/backend/
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://fpeogwnjvvwpeihnlbws.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwZW9nd25qdnZ3cGVpaG5sYndzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA1MDQ2MDMsImV4cCI6MjA4NjA4MDYwM30._dgDoiN5lo4Jlsq2mMDkNXBOOPYR5ZQfJ-liSNFZq6k';

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h.trim()] = (vals[idx] || '').trim(); });
    rows.push(obj);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; }
    else if (c === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += c; }
  }
  result.push(current);
  return result;
}

async function supabaseInsert(table, rows) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=ignore-duplicates'
    },
    body: JSON.stringify(rows)
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${err.substring(0, 200)}`);
  }
  return resp.status;
}

async function importPlayers(filePath) {
  console.log('\n📥 IMPORTING FLORIDA PLAYERS');
  console.log('═'.repeat(50));
  
  const text = fs.readFileSync(filePath, 'utf-8');
  const raw = parseCSV(text);
  console.log(`  Parsed ${raw.length} rows from CSV`);

  const players = raw.filter(r => r.FirstName || r.LastName).map(r => ({
    dc_player_id: r.PlayerID || null,
    dc_team_id: r.TeamID || null,
    dc_division_id: r.DivisionID || null,
    first_name: r.FirstName || null,
    last_name: r.LastName || null,
    age: r.Age ? parseInt(r.Age) : null,
    birthdate: r.Birthdate || null,
    city: r.City || null,
    state: r.State || null,
    phone: r.Phone || null,
    email: (r.Email || '').toLowerCase() || null,
    position1: r.Position1 || null,
    position2: r.Position2 || null,
    bats: r.Bats || null,
    throws: r.Throws || null,
    graduation_year: r.GradYear || null,
    height_inches: r.Height ? parseInt(r.Height) : null,
    weight: r.Weight ? parseInt(r.Weight) : null,
    uniform_number: r.UniformNum || null,
    team_name: r.TeamName || null,
    team_class: r.ClassName || null,
    state_scraped: 'FL',
    season: '2026',
    source: 'dc_scraper'
  }));

  console.log(`  ${players.length} valid players to insert`);

  const batchSize = 200;
  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < players.length; i += batchSize) {
    const batch = players.slice(i, i + batchSize);
    try {
      await supabaseInsert('crm_players', batch);
      inserted += batch.length;
      process.stdout.write(`\r  Progress: ${inserted}/${players.length} (${Math.round(inserted/players.length*100)}%)`);
    } catch (err) {
      errors += batch.length;
      console.error(`\n  ❌ Batch error at ${i}: ${err.message}`);
    }
  }

  console.log(`\n  ✅ Done! Inserted: ${inserted}, Errors: ${errors}`);
}

async function importCoaches(filePath) {
  console.log('\n📥 IMPORTING FLORIDA COACHES');
  console.log('═'.repeat(50));
  
  const text = fs.readFileSync(filePath, 'utf-8');
  const raw = parseCSV(text);
  console.log(`  Parsed ${raw.length} rows from CSV`);

  // Deduplicate by email
  const seen = new Set();
  const coaches = [];
  
  for (const r of raw) {
    const email = (r.Email || '').trim().toLowerCase();
    if (email && seen.has(email)) continue;
    if (email) seen.add(email);
    if (!email && !r.Phone && !r.CoachFirst) continue;

    coaches.push({
      first_name: r.CoachFirst || null,
      last_name: r.CoachLast || null,
      email: email || null,
      phone: r.Phone || null,
      phone2: r.Phone2 || null,
      team_name: r.TeamName || null,
      team_city: r.TeamCity || null,
      team_state: r.TeamState || 'FL',
      age_group: (r.AgeGroup || '').trim() || null,
      team_class: (r.DivClass || '').trim() || null,
      states_active: ['FL'],
      source: 'dc_scraper',
      season: '2026',
      gc_status: 'unknown',
      is_active: true,
      contact_type: 'coach'
    });
  }

  console.log(`  ${coaches.length} unique coaches to insert`);

  const batchSize = 200;
  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < coaches.length; i += batchSize) {
    const batch = coaches.slice(i, i + batchSize);
    try {
      await supabaseInsert('crm_contacts', batch);
      inserted += batch.length;
      process.stdout.write(`\r  Progress: ${inserted}/${coaches.length} (${Math.round(inserted/coaches.length*100)}%)`);
    } catch (err) {
      errors += batch.length;
      console.error(`\n  ❌ Batch error at ${i}: ${err.message}`);
    }
  }

  console.log(`\n  ✅ Done! Inserted: ${inserted}, Errors: ${errors}`);
}

async function main() {
  // Look for CSV files in common locations
  const dataDir = path.join(process.env.HOME, 'Desktop', 'Data');
  const downloadsDir = path.join(process.env.HOME, 'Downloads');
  
  // Find coaches file
  let coachFile = null;
  const coachPaths = [
    path.join(dataDir, 'dc_florida_teams.csv'),
    path.join(downloadsDir, 'dc_florida_teams.csv'),
    path.join(dataDir, 'coaches.csv'),
  ];
  for (const p of coachPaths) {
    if (fs.existsSync(p)) { coachFile = p; break; }
  }

  // Find players file
  let playerFile = null;
  const playerPaths = [
    path.join(dataDir, 'dc_florida_players.csv'),
    path.join(downloadsDir, 'dc_florida_players.csv'),
    path.join(dataDir, 'coaches.csv'), // This is actually players based on headers
  ];
  for (const p of playerPaths) {
    if (fs.existsSync(p)) { 
      // Check if it has PlayerID header (it's players, not coaches)
      const firstLine = fs.readFileSync(p, 'utf-8').split('\n')[0];
      if (firstLine.includes('PlayerID')) { playerFile = p; break; }
    }
  }

  console.log('🏟️  USSSA Florida Data Importer');
  console.log('═'.repeat(50));
  console.log(`  Coaches: ${coachFile || 'NOT FOUND'}`);
  console.log(`  Players: ${playerFile || 'NOT FOUND'}`);

  if (coachFile) await importCoaches(coachFile);
  if (playerFile) await importPlayers(playerFile);

  if (!coachFile && !playerFile) {
    console.log('\n❌ No CSV files found. Place them in ~/Desktop/Data/ or ~/Downloads/');
  }

  console.log('\n🏁 Import complete!');
}

main().catch(console.error);
