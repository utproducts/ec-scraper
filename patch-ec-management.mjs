/**
 * Event Central Management — Patch for Director Assistant Dashboard
 * 
 * Adds "Event Central" nav item and page section to the DA dashboard.
 * Run: node patch-ec-management.mjs
 * 
 * Features:
 * - Create/manage events (name, dates, venue, age groups)
 * - Add GC team URLs per event
 * - Start/stop scraper per event  
 * - View game count and billing
 * - Invoice generation ($5/game)
 * - Link to public event page
 */
import fs from 'fs';

const file = '/Users/ChadMary/Desktop/Director Assistant/index.html';
let html = fs.readFileSync(file, 'utf-8');

// ─── 1. Add nav item after "Billing" ───
const billingNav = `<div class="nav-item" onclick="switchPage('billing', this)">`;
const ecNav = `<div class="nav-item" onclick="switchPage('event-central', this)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          Event Central
          <span class="nav-badge" id="ecEventCount" style="background:linear-gradient(135deg,#f59e0b,#ef4444)">0</span>
        </div>
        <div class="nav-item" onclick="switchPage('billing', this)">`;

if (html.includes(billingNav)) {
  html = html.replace(billingNav, ecNav);
  console.log('✅ Added Event Central nav item');
} else {
  console.log('⚠️  Could not find Billing nav item');
}

// ─── 2. Add page section before billing page ───
const billingPage = `<div class="page-section" id="page-billing">`;
const ecPage = `
      <!-- ═══ EVENT CENTRAL ═══ -->
      <div class="page-section" id="page-event-central">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px; flex-wrap:wrap; gap:12px;">
          <div>
            <h2 style="font-size:24px; font-weight:700;">Event Central</h2>
            <p style="color:var(--text-secondary); font-size:14px; margin-top:4px;">Manage live stats & leaderboards for your tournaments</p>
          </div>
          <button class="btn btn-primary" onclick="showCreateEventModal()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New Event
          </button>
        </div>

        <!-- Stats Summary -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:16px; margin-bottom:24px;">
          <div class="card" style="padding:20px;">
            <div style="font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">Total Events</div>
            <div id="ecTotalEvents" style="font-size:28px; font-weight:700;">0</div>
          </div>
          <div class="card" style="padding:20px;">
            <div style="font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">Total Games</div>
            <div id="ecTotalGames" style="font-size:28px; font-weight:700;">0</div>
          </div>
          <div class="card" style="padding:20px;">
            <div style="font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">Revenue</div>
            <div id="ecTotalRevenue" style="font-size:28px; font-weight:700; color:var(--success);">$0</div>
          </div>
          <div class="card" style="padding:20px;">
            <div style="font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">Outstanding</div>
            <div id="ecOutstanding" style="font-size:28px; font-weight:700; color:var(--warning);">$0</div>
          </div>
        </div>

        <!-- Events List -->
        <div class="card" style="padding:0; overflow:hidden;">
          <div style="padding:16px 20px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;">
            <h3 style="font-size:16px; font-weight:600;">Events</h3>
            <div style="display:flex; gap:8px;">
              <select id="ecStatusFilter" onchange="loadECEvents()" style="padding:6px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--navy-light); font-size:13px; color:var(--text-primary);">
                <option value="all">All Status</option>
                <option value="active">Active</option>
                <option value="complete">Complete</option>
                <option value="setup">Setup</option>
              </select>
            </div>
          </div>
          <div id="ecEventsList" style="min-height:100px;"></div>
        </div>
      </div>

      <!-- Create Event Modal -->
      <div id="createEventModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:1000; display:none; align-items:center; justify-content:center; padding:20px;">
        <div style="background:var(--white); border-radius:var(--radius-lg); width:100%; max-width:600px; max-height:90vh; overflow-y:auto; box-shadow:var(--shadow-lg);">
          <div style="padding:24px 24px 0; display:flex; justify-content:space-between; align-items:center;">
            <h3 style="font-size:20px; font-weight:700;" id="eventModalTitle">Create New Event</h3>
            <button onclick="closeCreateEventModal()" style="background:none; border:none; cursor:pointer; font-size:24px; color:var(--text-muted);">&times;</button>
          </div>
          <div style="padding:24px;">
            <input type="hidden" id="editEventId" value="">
            
            <div style="margin-bottom:16px;">
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">Event Name</label>
              <input id="ecEventName" type="text" placeholder="e.g. Space Coast Presidents Day" style="width:100%; padding:10px 14px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:14px;">
            </div>
            
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px;">
              <div>
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">Start Date</label>
                <input id="ecStartDate" type="date" style="width:100%; padding:10px 14px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:14px;">
              </div>
              <div>
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">End Date</label>
                <input id="ecEndDate" type="date" style="width:100%; padding:10px 14px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:14px;">
              </div>
            </div>
            
            <div style="margin-bottom:16px;">
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">Venue</label>
              <input id="ecVenue" type="text" placeholder="e.g. Space Coast Complex" style="width:100%; padding:10px 14px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:14px;">
            </div>
            
            <div style="margin-bottom:16px;">
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">Age Groups (comma separated)</label>
              <input id="ecAgeGroups" type="text" placeholder="e.g. 11U, 12U, 14U" style="width:100%; padding:10px 14px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:14px;">
            </div>

            <div style="margin-bottom:16px;">
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">Director Name</label>
              <input id="ecDirectorName" type="text" placeholder="e.g. Scott Rutherford" style="width:100%; padding:10px 14px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:14px;">
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px;">
              <div>
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">Director Email</label>
                <input id="ecDirectorEmail" type="email" placeholder="director@email.com" style="width:100%; padding:10px 14px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:14px;">
              </div>
              <div>
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">Director Phone</label>
                <input id="ecDirectorPhone" type="tel" placeholder="555-555-5555" style="width:100%; padding:10px 14px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:14px;">
              </div>
            </div>

            <div style="margin-bottom:16px;">
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">GameChanger Team URLs</label>
              <p style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">One per line. Format: URL | Age Group (e.g. https://web.gc.com/teams/abc123 | 11U)</p>
              <textarea id="ecTeamUrls" rows="8" placeholder="https://web.gc.com/teams/fXEnuJhCgzAL | 11U
https://web.gc.com/teams/4dj1c8ViBjU3 | 11U
https://web.gc.com/teams/yAo2y8yv1DvH | 12U" style="width:100%; padding:10px 14px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:13px; font-family:'Space Mono',monospace; line-height:1.6; resize:vertical;"></textarea>
            </div>

            <div style="margin-bottom:16px;">
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">Notes</label>
              <textarea id="ecNotes" rows="2" placeholder="Any notes about this event..." style="width:100%; padding:10px 14px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:14px; resize:vertical;"></textarea>
            </div>
            
            <div style="display:flex; gap:12px; justify-content:flex-end;">
              <button class="btn btn-secondary" onclick="closeCreateEventModal()">Cancel</button>
              <button class="btn btn-primary" onclick="saveEvent()">Save Event</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Event Detail Modal -->
      <div id="eventDetailModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:1000; align-items:center; justify-content:center; padding:20px;">
        <div style="background:var(--white); border-radius:var(--radius-lg); width:100%; max-width:700px; max-height:90vh; overflow-y:auto; box-shadow:var(--shadow-lg);">
          <div style="padding:24px 24px 0; display:flex; justify-content:space-between; align-items:center;">
            <h3 style="font-size:20px; font-weight:700;" id="detailEventName">Event Details</h3>
            <button onclick="closeEventDetail()" style="background:none; border:none; cursor:pointer; font-size:24px; color:var(--text-muted);">&times;</button>
          </div>
          <div id="eventDetailContent" style="padding:24px;"></div>
        </div>
      </div>

      <div class="page-section" id="page-billing">`;

if (html.includes(billingPage)) {
  html = html.replace(billingPage, ecPage);
  console.log('✅ Added Event Central page section');
} else {
  console.log('⚠️  Could not find billing page section');
}

// ─── 3. Add Event Central JavaScript before the closing </script> ───
const closingScript = `</script>
</body>`;

const ecScript = `
    // ═══ EVENT CENTRAL ═══════════════════════════════════════════
    
    const EC_PRICE_PER_GAME = 5;
    
    async function loadECEvents() {
      const filter = document.getElementById('ecStatusFilter')?.value || 'all';
      let query = supabase.from('ec_events').select('*').order('start_date', { ascending: false });
      if (filter !== 'all') query = query.eq('status', filter);
      
      const { data: events, error } = await query;
      if (error) { console.error('EC load error:', error); return; }
      
      // Update counts
      document.getElementById('ecTotalEvents').textContent = events?.length || 0;
      document.getElementById('ecEventCount').textContent = events?.length || 0;
      
      let totalGames = 0, totalRevenue = 0, outstanding = 0;
      events?.forEach(e => {
        totalGames += e.game_count || 0;
        const amount = (e.game_count || 0) * EC_PRICE_PER_GAME;
        if (e.invoice_status === 'paid') totalRevenue += amount;
        else outstanding += amount;
      });
      
      document.getElementById('ecTotalGames').textContent = totalGames;
      document.getElementById('ecTotalRevenue').textContent = '$' + totalRevenue;
      document.getElementById('ecOutstanding').textContent = '$' + outstanding;
      
      const container = document.getElementById('ecEventsList');
      if (!events || events.length === 0) {
        container.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-muted);">No events yet. Click "New Event" to get started!</div>';
        return;
      }
      
      container.innerHTML = events.map(e => {
        const games = e.game_count || 0;
        const amount = games * EC_PRICE_PER_GAME;
        const statusColors = {
          setup: 'var(--warning)',
          active: 'var(--success)', 
          scraping: '#3b82f6',
          complete: 'var(--text-muted)',
          archived: '#6b7280'
        };
        const invoiceColors = {
          pending: 'var(--warning)',
          sent: '#3b82f6',
          paid: 'var(--success)'
        };
        const statusColor = statusColors[e.status] || 'var(--text-muted)';
        const invoiceColor = invoiceColors[e.invoice_status] || 'var(--warning)';
        const slug = e.slug || e.event_code || '';
        const publicUrl = slug ? 'https://unrivaled-connect-backend.onrender.com/ec/' + slug : '#';
        
        return '<div style="padding:16px 20px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; cursor:pointer;" onclick="showEventDetail(\\'' + e.id + '\\')">' +
          '<div style="flex:1; min-width:200px;">' +
            '<div style="font-size:15px; font-weight:600;">' + (e.name || e.event_name || 'Untitled') + '</div>' +
            '<div style="font-size:12px; color:var(--text-muted); margin-top:2px;">' + 
              (e.start_date || '') + ' to ' + (e.end_date || '') + 
              (e.venue ? ' • ' + e.venue : '') +
              (e.age_groups?.length ? ' • ' + e.age_groups.join(', ') : '') +
            '</div>' +
            (e.director_name ? '<div style="font-size:12px; color:var(--text-muted);">Director: ' + e.director_name + '</div>' : '') +
          '</div>' +
          '<div style="display:flex; gap:16px; align-items:center; flex-wrap:wrap;">' +
            '<div style="text-align:center; min-width:60px;">' +
              '<div style="font-size:18px; font-weight:700;">' + games + '</div>' +
              '<div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Games</div>' +
            '</div>' +
            '<div style="text-align:center; min-width:60px;">' +
              '<div style="font-size:18px; font-weight:700;">$' + amount + '</div>' +
              '<div style="font-size:10px; color:' + invoiceColor + '; text-transform:uppercase; letter-spacing:0.5px;">' + (e.invoice_status || 'pending') + '</div>' +
            '</div>' +
            '<span style="padding:4px 10px; border-radius:12px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; color:' + statusColor + '; background:' + statusColor + '15;">' + (e.status || 'setup') + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }
    
    function showCreateEventModal(editId) {
      document.getElementById('editEventId').value = editId || '';
      document.getElementById('eventModalTitle').textContent = editId ? 'Edit Event' : 'Create New Event';
      
      if (editId) {
        // Load existing event data
        supabase.from('ec_events').select('*').eq('id', editId).single().then(({ data }) => {
          if (data) {
            document.getElementById('ecEventName').value = data.name || data.event_name || '';
            document.getElementById('ecStartDate').value = data.start_date || '';
            document.getElementById('ecEndDate').value = data.end_date || '';
            document.getElementById('ecVenue').value = data.venue || data.location || '';
            document.getElementById('ecAgeGroups').value = data.age_groups?.join(', ') || '';
            document.getElementById('ecDirectorName').value = data.director_name || '';
            document.getElementById('ecDirectorEmail').value = data.director_email || '';
            document.getElementById('ecDirectorPhone').value = data.director_phone || '';
            document.getElementById('ecNotes').value = data.notes || '';
            
            // Load team URLs
            supabase.from('ec_event_teams').select('*').eq('event_id', editId).then(({ data: teams }) => {
              if (teams) {
                document.getElementById('ecTeamUrls').value = teams.map(t => t.gc_team_url + ' | ' + t.age_group).join('\\n');
              }
            });
          }
        });
      } else {
        document.getElementById('ecEventName').value = '';
        document.getElementById('ecStartDate').value = '';
        document.getElementById('ecEndDate').value = '';
        document.getElementById('ecVenue').value = '';
        document.getElementById('ecAgeGroups').value = '';
        document.getElementById('ecDirectorName').value = '';
        document.getElementById('ecDirectorEmail').value = '';
        document.getElementById('ecDirectorPhone').value = '';
        document.getElementById('ecTeamUrls').value = '';
        document.getElementById('ecNotes').value = '';
      }
      
      const modal = document.getElementById('createEventModal');
      modal.style.display = 'flex';
    }
    
    function closeCreateEventModal() {
      document.getElementById('createEventModal').style.display = 'none';
    }
    
    async function saveEvent() {
      const editId = document.getElementById('editEventId').value;
      const name = document.getElementById('ecEventName').value.trim();
      const startDate = document.getElementById('ecStartDate').value;
      const endDate = document.getElementById('ecEndDate').value;
      const venue = document.getElementById('ecVenue').value.trim();
      const ageGroups = document.getElementById('ecAgeGroups').value.split(',').map(s => s.trim()).filter(s => s);
      const directorName = document.getElementById('ecDirectorName').value.trim();
      const directorEmail = document.getElementById('ecDirectorEmail').value.trim();
      const directorPhone = document.getElementById('ecDirectorPhone').value.trim();
      const teamUrlsRaw = document.getElementById('ecTeamUrls').value.trim();
      const notes = document.getElementById('ecNotes').value.trim();
      
      if (!name || !startDate || !endDate) {
        alert('Please fill in event name, start date, and end date.');
        return;
      }
      
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + startDate.substring(0, 4);
      
      const eventData = {
        name, event_name: name, slug, start_date: startDate, end_date: endDate,
        venue, age_groups: ageGroups, director_name: directorName,
        director_email: directorEmail, director_phone: directorPhone,
        notes, status: 'setup', updated_at: new Date().toISOString()
      };
      
      let eventId = editId;
      
      if (editId) {
        const { error } = await supabase.from('ec_events').update(eventData).eq('id', editId);
        if (error) { alert('Error updating event: ' + error.message); return; }
      } else {
        const { data, error } = await supabase.from('ec_events').insert(eventData).select('id').single();
        if (error) { alert('Error creating event: ' + error.message); return; }
        eventId = data.id;
      }
      
      // Save team URLs
      if (teamUrlsRaw) {
        // Delete existing team URLs for this event
        await supabase.from('ec_event_teams').delete().eq('event_id', eventId);
        
        const teamLines = teamUrlsRaw.split('\\n').filter(l => l.trim());
        const teamInserts = teamLines.map(line => {
          const parts = line.split('|').map(s => s.trim());
          const url = parts[0] || '';
          const ageGroup = parts[1] || ageGroups[0] || '11U';
          const gcTeamMatch = url.match(/teams\\/([A-Za-z0-9]+)/);
          return {
            event_id: eventId,
            gc_team_url: url,
            age_group: ageGroup,
            gc_team_id: gcTeamMatch ? gcTeamMatch[1] : null,
            status: 'pending'
          };
        }).filter(t => t.gc_team_url);
        
        if (teamInserts.length > 0) {
          const { error: teamError } = await supabase.from('ec_event_teams').insert(teamInserts);
          if (teamError) console.error('Team URL save error:', teamError);
        }
      }
      
      closeCreateEventModal();
      loadECEvents();
      alert(editId ? 'Event updated!' : 'Event created! Add it to the scraper to start tracking.');
    }
    
    async function showEventDetail(eventId) {
      const { data: event } = await supabase.from('ec_events').select('*').eq('id', eventId).single();
      if (!event) return;
      
      const { data: teams } = await supabase.from('ec_event_teams').select('*').eq('event_id', eventId);
      const { count: gameCount } = await supabase.from('ec_games').select('id', { count: 'exact' }).eq('event_id', eventId);
      
      const games = gameCount || event.game_count || 0;
      const amount = games * EC_PRICE_PER_GAME;
      const slug = event.slug || event.event_code || '';
      const publicUrl = slug ? 'https://unrivaled-connect-backend.onrender.com/ec/' + slug : '#';
      
      document.getElementById('detailEventName').textContent = event.name || event.event_name || 'Event';
      
      const content = document.getElementById('eventDetailContent');
      content.innerHTML = '' +
        '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:12px; margin-bottom:20px;">' +
          '<div style="background:var(--navy-light); padding:16px; border-radius:var(--radius-sm); text-align:center;">' +
            '<div style="font-size:24px; font-weight:700;">' + games + '</div>' +
            '<div style="font-size:11px; color:var(--text-muted); text-transform:uppercase;">Games</div>' +
          '</div>' +
          '<div style="background:var(--navy-light); padding:16px; border-radius:var(--radius-sm); text-align:center;">' +
            '<div style="font-size:24px; font-weight:700;">' + (teams?.length || 0) + '</div>' +
            '<div style="font-size:11px; color:var(--text-muted); text-transform:uppercase;">Teams</div>' +
          '</div>' +
          '<div style="background:var(--navy-light); padding:16px; border-radius:var(--radius-sm); text-align:center;">' +
            '<div style="font-size:24px; font-weight:700; color:var(--success);">$' + amount + '</div>' +
            '<div style="font-size:11px; color:var(--text-muted); text-transform:uppercase;">Invoice</div>' +
          '</div>' +
          '<div style="background:var(--navy-light); padding:16px; border-radius:var(--radius-sm); text-align:center;">' +
            '<div style="font-size:13px; font-weight:600; color:' + (event.invoice_status === 'paid' ? 'var(--success)' : 'var(--warning)') + '; text-transform:uppercase;">' + (event.invoice_status || 'pending') + '</div>' +
            '<div style="font-size:11px; color:var(--text-muted); text-transform:uppercase;">Status</div>' +
          '</div>' +
        '</div>' +
        
        '<div style="margin-bottom:20px;">' +
          '<div style="font-size:13px; color:var(--text-muted); margin-bottom:4px;">Dates: ' + (event.start_date || '') + ' to ' + (event.end_date || '') + '</div>' +
          '<div style="font-size:13px; color:var(--text-muted); margin-bottom:4px;">Venue: ' + (event.venue || event.location || 'N/A') + '</div>' +
          '<div style="font-size:13px; color:var(--text-muted); margin-bottom:4px;">Age Groups: ' + (event.age_groups?.join(', ') || 'N/A') + '</div>' +
          (event.director_name ? '<div style="font-size:13px; color:var(--text-muted); margin-bottom:4px;">Director: ' + event.director_name + (event.director_email ? ' (' + event.director_email + ')' : '') + '</div>' : '') +
        '</div>' +
        
        '<div style="margin-bottom:20px;">' +
          '<h4 style="font-size:14px; font-weight:600; margin-bottom:8px;">Teams (' + (teams?.length || 0) + ')</h4>' +
          (teams && teams.length > 0 ? 
            '<div style="background:var(--navy-light); border-radius:var(--radius-sm); padding:12px; font-family:\\'Space Mono\\',monospace; font-size:12px; max-height:200px; overflow-y:auto;">' +
              teams.map(t => '<div style="margin-bottom:4px;">' + (t.team_name || 'Pending...') + ' <span style="color:var(--text-muted);">(' + t.age_group + ')</span> <a href="' + t.gc_team_url + '" target="_blank" style="color:var(--blue-bright); text-decoration:none; font-size:11px;">GC →</a></div>').join('') +
            '</div>'
          : '<div style="color:var(--text-muted); font-size:13px;">No teams added yet.</div>') +
        '</div>' +
        
        '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
          '<button class="btn btn-primary btn-sm" onclick="closeEventDetail(); showCreateEventModal(\\'' + eventId + '\\')">Edit Event</button>' +
          '<a href="' + publicUrl + '" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration:none;">View Public Page →</a>' +
          (event.invoice_status !== 'paid' ? '<button class="btn btn-sm" style="background:var(--success); color:white; border:none; padding:6px 14px; border-radius:var(--radius-sm); cursor:pointer; font-size:13px;" onclick="markEventPaid(\\'' + eventId + '\\')">Mark as Paid</button>' : '') +
          '<button class="btn btn-sm" style="background:var(--danger); color:white; border:none; padding:6px 14px; border-radius:var(--radius-sm); cursor:pointer; font-size:13px;" onclick="if(confirm(\\'Delete this event?\\')) deleteEvent(\\'' + eventId + '\\')">Delete</button>' +
        '</div>';
      
      document.getElementById('eventDetailModal').style.display = 'flex';
    }
    
    function closeEventDetail() {
      document.getElementById('eventDetailModal').style.display = 'none';
    }
    
    async function markEventPaid(eventId) {
      await supabase.from('ec_events').update({ invoice_status: 'paid' }).eq('id', eventId);
      closeEventDetail();
      loadECEvents();
    }
    
    async function updateGameCount(eventId) {
      const { count } = await supabase.from('ec_games').select('id', { count: 'exact' }).eq('event_id', eventId);
      await supabase.from('ec_events').update({ game_count: count || 0, invoice_amount: (count || 0) * EC_PRICE_PER_GAME }).eq('id', eventId);
    }
    
    async function deleteEvent(eventId) {
      // Delete related data
      await supabase.from('ec_event_teams').delete().eq('event_id', eventId);
      await supabase.from('ec_events').delete().eq('id', eventId);
      closeEventDetail();
      loadECEvents();
    }
    
    // Load EC events when page switches
    const origSwitchPage = switchPage;
    switchPage = function(page, navEl) {
      origSwitchPage(page, navEl);
      if (page === 'event-central') loadECEvents();
    };
    
    // Initial load
    loadECEvents();

</script>
</body>`;

if (html.includes(closingScript)) {
  html = html.replace(closingScript, ecScript);
  console.log('✅ Added Event Central JavaScript');
} else {
  console.log('⚠️  Could not find closing script tag');
}

fs.writeFileSync(file, html);
console.log('\n✅ Done! Event Central management added to Director Assistant dashboard.');
console.log('   Refresh the DA page to see the new "Event Central" nav item.');
