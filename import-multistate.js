// import-multistate.js
// Run: node import-multistate.js
// Place dc_players.csv and dc_teams.csv in ~/Desktop/Data/

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const SUPABASE_URL = 'https://fpeogwnjvvwpeihnlbws.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwZW9nd25qdnZ3cGVpaG5sYndzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA1MDQ2MDMsImV4cCI6MjA4NjA4MDYwM30._dgDoiN5lo4Jlsq2mMDkNXBOOPYR5ZQfJ-liSNFZq6k';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
});

const BATCH = 500; // upsert in batches of 500
const DATA_DIR = path.join(process.env.HOME, 'Desktop', 'Data');

async function importPlayers() {
    console.log('\n📂 Reading dc_players.csv...');
    const raw = fs.readFileSync(path.join(DATA_DIR, 'dc_players.csv'), 'utf8');
    const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
    console.log(`✅ ${rows.length} player rows found`);

    let inserted = 0, skipped = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH).map(r => ({
    dc_player_id:    r.playerID || null,
    dc_team_id:      r._teamID || null,
    dc_division_id:  r._divisionID || null,
    dc_event_id:     r._eventID || null,
    first_name:      r.firstName || null,
    last_name:       r.lastName || null,
    age:             r.age || null,
    birthdate:       r.birthdate || null,
    city:            r.city || null,
    state:           r.stateABR || r.state || null,
    phone:           r.homePhone || r.workPhone || null,
    email:           r.email1 || r.email2 || null,
    position1:       r.position1 || null,
    position2:       r.position2 || null,
    bats:            r.bats || null,
    throws:          r.throws || null,
    graduation_year: r.graduationYear || null,
    height_inches:   r.height_inches || null,
    weight:          r.weight || null,
    uniform_number:  r.uniformNumber || null,
    team_name:       r._teamName || r.teamName || null,
    team_class:      r._className || null,
    registration:    r._registration || null,
    state_scraped:   r.stateABR || r.state || null,
    season:          '2026',
    source:          'dc_scrape_multistate',
})).filter(r => r.dc_player_id);

        const { error } = await sb.from('crm_players').insert(batch);

        if (error) {
            console.error(`❌ Batch ${i}-${i+BATCH} error:`, error.message);
            skipped += batch.length;
        } else {
            inserted += batch.length;
        }

        if ((i / BATCH) % 10 === 0) {
            console.log(`   Players: ${inserted} inserted, ${skipped} skipped (${Math.round((i/rows.length)*100)}%)`);
        }
    }
    console.log(`✅ Players done: ${inserted} inserted, ${skipped} skipped`);
}

async function importCoaches() {
    console.log('\n📂 Reading dc_teams.csv...');
    const raw = fs.readFileSync(path.join(DATA_DIR, 'dc_teams.csv'), 'utf8');
    const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
    console.log(`✅ ${rows.length} team/coach rows found`);

    let inserted = 0, skipped = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH).map(r => ({
            dc_team_id:     r.dc_team_id || r.teamId || r.team_id || null,
            dc_registration: r.dc_registration || r.registration || r.dc_team_id || null,
            first_name:     r.first_name || r.firstName || r.coach_first || null,
            last_name:      r.last_name || r.lastName || r.coach_last || null,
            email:          r.email || null,
            phone:          r.phone || r.coach_phone || null,
            phone2:         r.phone2 || null,
            team_name:      r.team_name || r.teamName || null,
            team_city:      r.team_city || r.city || null,
            team_state:     r.team_state || r.state || null,
            age_group:      r.age_group || r.ageGroup || null,
            team_class:     r.team_class || r.class || null,
            season:         r.season || '2026',
            source:         'dc_scrape_multistate',
            is_active:      true,
        })).filter(r => r.dc_team_id);

        const { error } = await sb.from('crm_contacts').upsert(batch, {
            onConflict: 'dc_registration,season',
            ignoreDuplicates: false
        });

        if (error) {
            console.error(`❌ Batch ${i}-${i+BATCH} error:`, error.message);
            skipped += batch.length;
        } else {
            inserted += batch.length;
        }

        if ((i / BATCH) % 10 === 0) {
            console.log(`   Coaches: ${inserted} inserted, ${skipped} skipped (${Math.round((i/rows.length)*100)}%)`);
        }
    }
    console.log(`✅ Coaches done: ${inserted} inserted, ${skipped} skipped`);
}

async function main() {
    console.log('🚀 Starting multistate CRM import...');
    if (!SUPABASE_KEY) { console.error('❌ Set SUPABASE_KEY env var first:\nexport SUPABASE_KEY=your_service_role_key'); process.exit(1); }
    await importPlayers();
    console.log('\n🎉 Import complete!');
}

main().catch(console.error);