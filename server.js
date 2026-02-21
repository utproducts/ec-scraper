const path = require("path");
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve Event Central frontend
app.use('/ec', express.static('frontend'));

// Initialize services
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─── AUTO CONTACT COLLECTION ─────────────────────────────
async function lookupContact(phone) {
  const cleanPhone = phone.replace(/\D/g, '').slice(-10);
  try {
    const { data } = await supabase.from('crm_contacts')
      .select('id, first_name, last_name, team_name, age_group, email')
      .or('phone.like.%' + cleanPhone + ',phone2.like.%' + cleanPhone)
      .limit(1);
    return (data && data.length > 0) ? data[0] : null;
  } catch (err) {
    console.error('Contact lookup error:', err.message);
    return null;
  }
}

async function checkPendingInfoRequest(phone) {
  const cleanPhone = phone.replace(/\D/g, '').slice(-10);
  try {
    const { data } = await supabase.from('sms_log')
      .select('created_at')
      .eq('phone_from', phone)
      .like('question', '%[System] Requested contact info%')
      .order('created_at', { ascending: false })
      .limit(1);
    if (!data || data.length === 0) return false;
    // Check if request was within last 24 hours
    const requestTime = new Date(data[0].created_at);
    const now = new Date();
    return (now - requestTime) < 24 * 60 * 60 * 1000;
  } catch (err) { return false; }
}

function parseContactInfo(text) {
  // Try to parse name, team, and age group from a reply
  const lines = text.split(/[\n,;]+/).map(l => l.trim()).filter(l => l);
  let firstName = null, lastName = null, teamName = null, ageGroup = null;
  
  // Look for age group pattern anywhere in text
  const ageMatch = text.match(/\b(\d{1,2})[uU]\b/);
  if (ageMatch) ageGroup = ageMatch[1] + 'U';
  
  // Try parsing structured replies (numbered lines)
  for (const line of lines) {
    const cleaned = line.replace(/^[1-3][.)\s-]+/, '').trim();
    if (!cleaned) continue;
    
    // Check if this line looks like a name (2-3 words, no numbers except jersey)
    const nameCheck = cleaned.replace(/^(coach|Coach|COACH)\s+/i, '');
    const words = nameCheck.split(/\s+/);
    if (!firstName && words.length >= 1 && words.length <= 4 && !/\d{2,}/.test(nameCheck) && !/[uU]$/.test(nameCheck)) {
      firstName = words[0];
      lastName = words.slice(1).join(' ') || null;
      continue;
    }
    
    // Check if this looks like a team name (longer, may have location words)
    if (!teamName && cleaned.length > 2 && cleaned !== ageGroup) {
      // Skip if it's just the age group
      if (!cleaned.match(/^\d{1,2}[uU]$/)) {
        teamName = cleaned;
      }
    }
  }
  
  return { firstName, lastName, teamName, ageGroup };
}

async function saveContactFromReply(phone, info) {
  const cleanPhone = phone.replace(/\D/g, '').slice(-10);
  const fullPhone = '+1' + cleanPhone;
  
  try {
    // Check if already exists
    const { data: existing } = await supabase.from('crm_contacts')
      .select('id')
      .or('phone.like.%' + cleanPhone + ',phone2.like.%' + cleanPhone)
      .limit(1);
    
    if (existing && existing.length > 0) {
      const updates = {};
      if (info.firstName) updates.first_name = info.firstName;
      if (info.lastName) updates.last_name = info.lastName;
      if (info.teamName) updates.team_name = info.teamName;
      if (info.ageGroup) updates.age_group = info.ageGroup;
      await supabase.from('crm_contacts').update(updates).eq('id', existing[0].id);
      console.log('Updated contact:', info.firstName, info.lastName, phone);
    } else {
      await supabase.from('crm_contacts').insert({
        first_name: info.firstName || null,
        last_name: info.lastName || null,
        phone: fullPhone,
        team_name: info.teamName || null,
        age_group: info.ageGroup || null,
        is_active: true,
        source: 'sms_auto_collected'
      });
      console.log('Created contact:', info.firstName, info.lastName, phone);
    }
    return true;
  } catch (err) {
    console.error('Save contact error:', err.message);
    return false;
  }
}


const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Florida cities list (used in multiple places)
const floridaCities = [
  'jacksonville', 'orlando', 'tampa', 'miami', 'fort lauderdale', 'naples',
  'sarasota', 'bradenton', 'lakeland', 'daytona', 'gainesville', 'tallahassee',
  'ocala', 'pensacola', 'fort myers', 'ft myers', 'ft. myers', 'port st lucie',
  'coral springs', 'viera', 'space coast', 'sanford', 'ocoee', 'kissimmee',
  'lake city', 'st augustine', 'palm beach', 'jupiter', 'stuart', 'melbourne',
  'cocoa', 'titusville', 'deland', 'deltona', 'spring hill', 'brooksville',
  'new smyrna', 'fort walton', 'panama city', 'destin', 'cape coral',
  'apopka', 'clearwater', 'inverness', 'newberry', 'ormond', 'umatilla',
  'wellington', 'bay area', 'lucie', 'pines', 'springs', 'park'
];

// Geocode a zip code using free Nominatim API
async function geocodeZip(zip) {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=US&format=json&limit=1`,
      { headers: { 'User-Agent': 'USSSA-Tournament-Bot/1.0' } }
    );
    const results = await response.json();
    if (results.length > 0) {
      return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
    }
    return null;
  } catch (err) {
    console.error('Geocode error:', err.message);
    return null;
  }
}

// Geocode a city name using free Nominatim API
async function geocodeCity(city) {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city + ', Florida, USA')}&format=json&limit=1`,
      { headers: { 'User-Agent': 'USSSA-Tournament-Bot/1.0' } }
    );
    const results = await response.json();
    if (results.length > 0) {
      return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
    }
    return null;
  } catch (err) {
    console.error('Geocode city error:', err.message);
    return null;
  }
}

// Check if a tournament date has already passed
function isFutureEvent(dateStr) {
  if (!dateStr) return true; // include if no date
  try {
    const match = dateStr.match(/([A-Z][a-z]{2})\s+(\d{1,2})\s*-\s*(?:[A-Z][a-z]{2}\s+)?(\d{1,2})\s+(\d{4})/);
    if (!match) return true;
    const [, month, day, , year] = match;
    const startDate = new Date(`${month} ${day}, ${year}`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return startDate >= today;
  } catch {
    return true;
  }
}

// Save conversation context for a phone number
async function saveContext(phone, message, context) {
  const { error } = await supabase
    .from('sms_conversations')
    .upsert({
      phone_number: phone,
      last_message: message,
      last_context: JSON.stringify(context),
      updated_at: new Date().toISOString()
    }, { onConflict: 'phone_number' });
  if (error) console.error('Save context error:', error.message);
}

// Load conversation context for a phone number
async function loadContext(phone) {
  const { data, error } = await supabase
    .from('sms_conversations')
    .select('last_message, last_context, updated_at')
    .eq('phone_number', phone)
    .single();

  if (error || !data) return null;

  // Only use context if it's less than 30 minutes old
  const age = Date.now() - new Date(data.updated_at).getTime();
  if (age > 30 * 60 * 1000) return null;

  try {
    return {
      lastMessage: data.last_message,
      ...JSON.parse(data.last_context)
    };
  } catch {
    return null;
  }
}

// Import routes
const smsRoutes = require('./routes/sms');
app.use('/api/sms', smsRoutes);

// Test route
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Unrivaled Connect API is running',
    timestamp: new Date().toISOString()
  });
});

// ===== WEBSITE SCRAPER =====

function getBaseDomain(url) {
  try { return new URL(url).origin; } catch { return url; }
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>(.*?)<\/title>/i) || html.match(/<h1[^>]*>(.*?)<\/h1>/i);
  return m ? htmlToText(m[1]).substring(0, 200) : 'Untitled Page';
}

function extractContent(html) {
  const m = html.match(/<main[\s\S]*?<\/main>/i) || html.match(/<article[\s\S]*?<\/article>/i) ||
            html.match(/<div[^>]*class="[^"]*content[^"]*"[\s\S]*?<\/div>/i);
  return htmlToText(m ? m[0] : html);
}

function categorizeContent(title, content) {
  const c = (title + ' ' + content).toLowerCase();
  if (c.includes('rule') || c.includes('regulation') || c.includes('ejection')) return 'rules';
  if (c.includes('faq') || c.includes('frequently asked')) return 'faq';
  if (c.includes('policy') || c.includes('refund') || c.includes('weather')) return 'policy';
  if (c.includes('register') || c.includes('signup') || c.includes('how to')) return 'registration';
  if (c.includes('tournament') || c.includes('event') || c.includes('schedule')) return 'tournament';
  if (c.includes('contact') || c.includes('phone') || c.includes('email')) return 'contact';
  if (c.includes('about') || c.includes('mission') || c.includes('history')) return 'about';
  if (c.includes('price') || c.includes('cost') || c.includes('fee')) return 'pricing';
  return 'info';
}

function findLinks(html, baseDomain) {
  const links = new Set();
  const re = /href=["'](.*?)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1];
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|doc|docx|xls|xlsx|mp4|mp3)$/i.test(href)) continue;
    if (href.startsWith('/')) href = baseDomain + href;
    else if (!href.startsWith('http')) href = baseDomain + '/' + href;
    try {
      if (new URL(href).origin === baseDomain) links.add(href.split('#')[0].replace(/\/$/, ''));
    } catch {}
  }
  return [...links];
}

async function fetchPage(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    redirect: 'follow', signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!(r.headers.get('content-type') || '').includes('text/html')) return null;
  return await r.text();
}

async function scrapeWebsite(startUrl, maxPages = 50) {
  const baseDomain = getBaseDomain(startUrl);
  const visited = new Set();
  const toVisit = [startUrl.replace(/\/$/, '')];
  const pages = [];

  while (toVisit.length > 0 && visited.size < maxPages) {
    const url = toVisit.shift();
    const clean = url.split('#')[0].replace(/\/$/, '');
    if (visited.has(clean)) continue;
    visited.add(clean);

    try {
      const html = await fetchPage(clean);
      if (!html) continue;
      const title = extractTitle(html);
      const content = extractContent(html);
      if (content.length < 100) continue;

      pages.push({ url: clean, title, content: content.substring(0, 5000), category: categorizeContent(title, content) });
      console.log(`  ✅ [${visited.size}] ${title.substring(0, 50)}`);

      for (const link of findLinks(html, baseDomain)) {
        const cl = link.split('#')[0].replace(/\/$/, '');
        if (!visited.has(cl)) toVisit.push(cl);
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`  ❌ [${visited.size}] ${clean.substring(0, 50)} - ${err.message}`);
    }
  }
  return pages;
}

// Campaign endpoint - send batch SMS to coaches
app.post('/api/campaign', async (req, res) => {
  const { message, phones, director_id } = req.body;
  
  if (!message || !phones || phones.length === 0) {
    return res.status(400).json({ error: 'message and phones are required' });
  }

  console.log(`\n📢 Campaign requested: "${message.substring(0, 50)}..." to ${phones.length} recipients`);

  let sent = 0;
  let failed = 0;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER || '+19414046484';

  for (const phone of phones) {
    try {
      await twilioClient.messages.create({
        body: message,
        from: fromNumber,
        to: phone
      });
      sent++;
      console.log(`  ✅ Sent to ${phone}`);
      
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      failed++;
      console.log(`  ❌ Failed ${phone}: ${err.message}`);
    }
  }

  // Log the campaign
  if (director_id) {
    await supabase.from('sms_log').insert({
      director_id: director_id,
      phone_from: fromNumber,
      phone_to: `campaign:${phones.length}`,
      question: `[CAMPAIGN] Sent to ${sent} coaches`,
      response: message,
      status: 'campaign'
    });
  }

  console.log(`📢 Campaign complete: ${sent} sent, ${failed} failed`);
  res.json({ sent, failed, total: phones.length });
});

// Scrape endpoint - called by dashboard during onboarding
app.post('/api/scrape', async (req, res) => {
  const { website_url, director_id } = req.body;
  
  if (!website_url) {
    return res.status(400).json({ error: 'website_url is required' });
  }

  console.log(`\n🕷️  Scrape requested: ${website_url} (director: ${director_id || 'none'})`);
  
  // Return immediately, scrape in background
  res.json({ status: 'scraping', message: 'Scraping started in background' });

  try {
    const pages = await scrapeWebsite(website_url);
    console.log(`🕷️  Scraped ${pages.length} pages from ${website_url}`);

    // Clear old scraped content for this director
    if (director_id) {
      await supabase.from('knowledge_base').delete().eq('director_id', director_id).eq('source', 'scraper');
    }

    // Save to knowledge_base
    let saved = 0;
    for (const page of pages) {
      const record = {
        title: page.title,
        content: page.content,
        category: page.category,
        source_url: page.url,
        source: 'scraper'
      };
      if (director_id) record.director_id = director_id;

      const { error } = await supabase.from('knowledge_base').insert(record);
      if (!error) saved++;
    }

    console.log(`🕷️  Saved ${saved}/${pages.length} pages to knowledge_base`);
    
    // Update director's scrape status
    if (director_id) {
      await supabase.from('directors').update({ 
        scrape_status: 'complete', 
        scrape_pages: saved,
        scraped_at: new Date().toISOString()
      }).eq('id', director_id);
    }
  } catch (err) {
    console.error('🕷️  Scrape error:', err.message);
    if (director_id) {
      await supabase.from('directors').update({ scrape_status: 'error' }).eq('id', director_id);
    }
  }
});

// Batch SMS endpoint — send the same message to multiple phones
app.post('/api/sms/batch', async (req, res) => {
  const { phones, message } = req.body;
  
  if (!phones || !message) {
    return res.status(400).json({ error: 'phones and message required' });
  }

  console.log(`\n📩 Batch SMS: Sending to ${phones.length} recipients`);
  
  let sent = 0;
  let failed = 0;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  for (const phone of phones) {
    try {
      await twilioClient.messages.create({
        body: message,
        from: fromNumber,
        to: phone
      });
      sent++;
      
      // Log each message
      await supabase.from('sms_log').insert({
        phone_from: fromNumber,
        phone_to: phone,
        question: '[BATCH CAMPAIGN]',
        response: message,
        status: 'campaign'
      });

      // Small delay to avoid Twilio rate limits
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.log(`  ❌ Failed: ${phone} - ${err.message}`);
      failed++;
    }
  }

  console.log(`📩 Batch complete: ${sent} sent, ${failed} failed`);
  res.json({ sent, failed, total: phones.length });
});

// ===== NEW: Director manual SMS reply endpoint =====
app.post('/api/sms/send', async (req, res) => {
  const { to, message, director_id, sent_by } = req.body;
  
  console.log(`📤 Director sending SMS to ${to}: ${message}`);
  
  if (!to || !message) {
    return res.status(400).json({ error: 'Missing "to" or "message"' });
  }
  
  try {
    // Send via Twilio
    const smsResult = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to
    });
    
    console.log('✅ Director SMS sent:', smsResult.sid);
    
    res.json({ 
      success: true, 
      sid: smsResult.sid,
      message: 'SMS sent successfully' 
    });
  } catch (error) {
    console.error('❌ Failed to send SMS:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Twilio webhook for incoming SMS
app.post('/api/sms/webhook', async (req, res) => {
  const { From, To, Body } = req.body;
  console.log(`Incoming SMS from ${From} to ${To}: ${Body}`);

  try {
    // ===== CHECK IF AI IS PAUSED FOR THIS NUMBER =====
    const { data: pauseData } = await supabase
      .from('ai_pauses')
      .select('*')
      .eq('phone', From)
      .gte('expires_at', new Date().toISOString())
      .limit(1);
    
    if (pauseData && pauseData.length > 0) {
      console.log(`⏸️ AI paused for ${From} until ${pauseData[0].expires_at} — skipping auto-reply`);
      
      // Still log the message but don't respond
      await supabase.from('sms_log').insert({
        phone_from: From,
        phone_to: To,
        question: Body,
        response: null,
        status: 'paused'
      });
      
      return res.status(200).send('<Response></Response>');
    }

    let tournamentContext = '';
    const bodyLower = Body.toLowerCase().trim();

    // ===== GAMECHANGER LINK DETECTION =====
    const gcLinkMatch = Body.match(/(?:https?:\/\/)?(?:web\.)?gc\.com\/teams\/([A-Za-z0-9]+)/i) ||
                        Body.match(/(?:https?:\/\/)?(?:www\.)?gamechanger\.io\/teams\/([A-Za-z0-9]+)/i);
    
    if (gcLinkMatch) {
      const gcTeamId = gcLinkMatch[1];
      const gcUrl = `https://web.gc.com/teams/${gcTeamId}`;
      console.log(`🎮 GameChanger link detected! Team ID: ${gcTeamId}`);

      let matchedEventId = null;
      let matchedTeamId = null;
      let matchedTeamName = null;
      let matchedAgeGroup = null;
      let gcStatus = 'pending';

      // STEP 1: Try to match by phone number to a known coach
      const cleanPhone = From.replace(/\D/g, '').slice(-10);
      
      // Search ec_teams FIRST (where CSV-uploaded teams live)
      const { data: ecTeamsMatch } = await supabase
        .from('ec_teams')
        .select('id, team_name, coach_phone, age_group');
      const { data: ecEventTeams } = await supabase
        .from('ec_event_teams')
        .select('team_id, event_id, age_group');
      
      // Also search legacy teams table as fallback
      const { data: legacyTeams } = await supabase
        .from('teams')
        .select('id, name, age_group, event_id, coach_phone')
        .order('created_at', { ascending: false });
      
      // Build combined search list
      const allSearchTeams = [];
      (ecTeamsMatch || []).forEach(t => {
        const etLink = (ecEventTeams || []).find(et => et.team_id === t.id);
        allSearchTeams.push({
          id: t.id, name: t.team_name, coach_phone: t.coach_phone,
          age_group: etLink?.age_group || t.age_group || '',
          event_id: etLink?.event_id || '', source: 'ec_teams'
        });
      });
      (legacyTeams || []).forEach(t => {
        allSearchTeams.push({
          id: t.id, name: t.name, coach_phone: t.coach_phone,
          age_group: t.age_group || '', event_id: t.event_id || '', source: 'teams'
        });
      });
      
      const matchedTeams = allSearchTeams;
      
      if (matchedTeams) {
        const phoneMatch = matchedTeams.find(t => {
          const tp = (t.coach_phone || '').replace(/\D/g, '').slice(-10);
          return tp && tp === cleanPhone;
        });
        
        if (phoneMatch) {
          matchedTeamId = phoneMatch.id;
          matchedTeamName = phoneMatch.name;
          matchedAgeGroup = phoneMatch.age_group;
          matchedEventId = phoneMatch.event_id;
          gcStatus = 'matched';
          console.log(`🔗 Auto-matched GC link by phone to team: ${phoneMatch.name} (${phoneMatch.age_group})`);
          
          // ALSO update ec_teams.gc_team_id so the scraper can use this link
          if (phoneMatch.source === 'ec_teams') {
            const { error: ecUpdateErr } = await supabase.from('ec_teams').update({
              gc_team_id: gcTeamId,
              gc_team_link: gcUrl
            }).eq('id', phoneMatch.id);
            if (ecUpdateErr) console.error('ec_teams GC update error:', ecUpdateErr.message);
            else console.log(`✅ Updated ec_teams.gc_team_id for ${phoneMatch.name}`);
          }
          // Also update crm_contacts GC status
const { error: crmGcErr } = await supabase.from('crm_contacts').update({
  gc_team_id: gcTeamId,
  gc_team_url: gcUrl,
  gc_status: 'submitted',
  gc_submitted_at: new Date().toISOString()
}).or('phone.like.%' + cleanPhone + ',phone2.like.%' + cleanPhone);
if (crmGcErr) console.error('crm_contacts GC update error:', crmGcErr.message);
else console.log(`✅ Updated crm_contacts GC status for ${cleanPhone}`);
        }
      }

      // STEP 2: If no phone match, check conversation history for event context
      if (!matchedEventId) {
        console.log('📜 No phone match — checking conversation history for event context...');
        
        // Look at the last outbound message we sent to this phone
        const { data: lastOutbound } = await supabase
          .from('sms_log')
          .select('response, question')
          .eq('phone_from', From)
          .order('created_at', { ascending: false })
          .limit(5);
        
        if (lastOutbound && lastOutbound.length > 0) {
          // Check both our responses and campaign messages for event names
          const recentMessages = lastOutbound.map(m => `${m.question || ''} ${m.response || ''}`).join(' ');
          
          // Try to match event name from conversation — check ec_events first, then legacy events
          const { data: ecEvents } = await supabase.from('ec_events').select('id, name, event_name');
          const { data: allEvents } = await supabase.from('events').select('id, name');
          const combinedEvents = [
            ...(ecEvents || []).map(e => ({ id: e.id, name: e.name || e.event_name, source: 'ec_events' })),
            ...(allEvents || []).map(e => ({ id: e.id, name: e.name, source: 'events' }))
          ];
          
          if (combinedEvents.length > 0) {
            for (const event of combinedEvents) {
              if (event.name && recentMessages.toLowerCase().includes(event.name.toLowerCase())) {
                matchedEventId = event.id;
                console.log(`📌 Matched to event "${event.name}" from conversation context`);
                
                // Now try to find the team within this event by phone
                if (matchedTeams) {
                  const eventTeamMatch = matchedTeams.find(t => 
                    t.event_id === event.id && 
                    (t.coach_phone || '').replace(/\D/g, '').slice(-10) === cleanPhone
                  );
                  if (eventTeamMatch) {
                    matchedTeamId = eventTeamMatch.id;
                    matchedTeamName = eventTeamMatch.name;
                    matchedAgeGroup = eventTeamMatch.age_group;
                    gcStatus = 'matched';
                  }
                }
                break;
              }
            }
          }
        }
      }

      // Save to gamechanger_links table
      const { error: gcError } = await supabase.from('gamechanger_links').insert({
        phone_from: From,
        team_id: gcTeamId,
        full_url: gcUrl,
        raw_message: Body,
        status: gcStatus,
        event_id: matchedEventId,
        matched_team_id: matchedTeamId,
        matched_team_name: matchedTeamName,
        matched_age_group: matchedAgeGroup
      });

      if (gcError) console.error('GC link save error:', gcError.message);
      else console.log(`✅ GameChanger link saved! Status: ${gcStatus}, Event: ${matchedEventId || 'unmatched'}`);

      // Build appropriate response
      let gcResponse;
      if (gcStatus === 'matched') {
        gcResponse = `Thanks Coach! Got your GameChanger link for ${matchedTeamName}. We'll get those stats posted to the state site! 🏟️`;
      } else if (matchedEventId) {
        gcResponse = `Thanks! Got your GameChanger link. Which team is this for? Just reply with the team name and we'll get it matched up! 🏟️`;
      } else {
        gcResponse = `Thanks for the GameChanger link! Which team and event is this for? Just reply with the team name and we'll get those stats posted to the state site! 🏟️`;
      }

      await twilioClient.messages.create({
        body: gcResponse,
        from: To,
        to: From
      });

      // Log it
      await supabase.from('sms_log').insert({
        phone_from: From, phone_to: To,
        question: Body, response: gcResponse,
        status: 'answered'
      });

      console.log('✅ GC confirmation sent to coach');
      res.status(200).send('<Response></Response>');
      return; // Don't process through normal AI flow
    }

    // Detect month keywords early
    const months = {
      'january': 'Jan', 'february': 'Feb', 'march': 'Mar', 'april': 'Apr',
      'may': 'May', 'june': 'Jun', 'july': 'Jul', 'august': 'Aug',
      'september': 'Sep', 'october': 'Oct', 'november': 'Nov', 'december': 'Dec',
      'jan': 'Jan', 'feb': 'Feb', 'mar': 'Mar', 'apr': 'Apr',
      'jun': 'Jun', 'jul': 'Jul', 'aug': 'Aug', 'sep': 'Sep',
      'oct': 'Oct', 'nov': 'Nov', 'dec': 'Dec'
    };

    let matchedMonth = null;
    for (const [keyword, abbrev] of Object.entries(months)) {
      if (bodyLower.includes(keyword)) {
        matchedMonth = abbrev;
        break;
      }
    }

    // Check for zip code and distance keywords
    const zipMatch = Body.match(/\b(\d{5})\b/);
    const distanceMatch = Body.match(/within\s+(\d+)\s+(?:miles|minutes)/i);
    const minutesMatch = Body.match(/(\d+)\s+minutes/i);
    const milesMatch = Body.match(/(\d+)\s+miles/i);
    const radius = milesMatch ? parseInt(milesMatch[1]) : (minutesMatch ? parseInt(minutesMatch[1]) : 50);

    // Detect if they want location-based search
    const wantsDistance = distanceMatch || minutesMatch || milesMatch ||
                          bodyLower.includes('near me') || bodyLower.includes('near my') ||
                          bodyLower.includes('close to') || bodyLower.includes('my area') ||
                          bodyLower.includes('my zip') || bodyLower.includes('my house') ||
                          bodyLower.includes('around me') || bodyLower.includes('from me') ||
                          bodyLower.includes('of me') || bodyLower.includes('by me');

    // Check if message is just a zip code (short reply)
    const isJustZip = zipMatch && bodyLower.replace(/[^\d\w\s]/g, '').trim().match(/^\d{5}$/);
    
    // Check if message is just a city name (short reply)
    const isJustCity = floridaCities.find(city => bodyLower === city || bodyLower === city + ' fl' || bodyLower === city + ', fl');

    // Check if this is a short follow-up reply (zip or city) to a previous question
    let savedContext = null;
    if (isJustZip || isJustCity) {
      savedContext = await loadContext(From);
      console.log(`📍 Short reply detected ("${Body}"). Saved context:`, savedContext ? 'found' : 'none');

      if (savedContext && savedContext.needsZip) {
        // Restore their original search parameters
        if (savedContext.month && !matchedMonth) matchedMonth = savedContext.month;
      }
    }

    const effectiveRadius = (savedContext && savedContext.radius) ? savedContext.radius : radius;

    // --- PATH 1: They want distance-based search but gave no location → ask for zip ---
    if (wantsDistance && !zipMatch && !isJustCity) {
      // Check if the message also contains a city name
      const cityInMessage = floridaCities.find(city => bodyLower.includes(city));
      
      if (cityInMessage) {
        // They said something like "events within 30 minutes of me in miami" — use the city
        console.log(`📍 Distance request with city: ${cityInMessage}`);
        const coords = await geocodeCity(cityInMessage);
        
        if (coords) {
          const { data: nearbyTournaments, error: geoError } = await supabase
            .rpc('search_tournaments_by_distance', {
              user_lat: coords.lat,
              user_lng: coords.lng,
              radius_miles: effectiveRadius
            });

          console.log(`📍 Geo results: ${nearbyTournaments?.length || 0} within ${effectiveRadius} miles of ${cityInMessage}`);

          if (!geoError && nearbyTournaments && nearbyTournaments.length > 0) {
            let filtered = nearbyTournaments.filter(t => isFutureEvent(t.dates));
            if (matchedMonth) {
              filtered = filtered.filter(t => t.dates && t.dates.includes(matchedMonth));
            }

            tournamentContext = `\nUpcoming tournaments within ${effectiveRadius} miles of ${cityInMessage}:\n` +
              filtered.slice(0, 15).map(t =>
                `- ${t.name} | ${t.dates || 'TBD'} | ${t.location} | ${Math.round(t.distance_miles)} miles away | ${t.pricing || 'Contact for pricing'} | Ages: ${t.age_groups || 'Various'} | Director: ${t.director}`
              ).join('\n');
          }
        }
      } else {
        // No city or zip — ask for location
        console.log('📍 Distance request without location — asking for zip code');

        await saveContext(From, Body, {
          needsZip: true,
          month: matchedMonth,
          radius: effectiveRadius,
          originalQuestion: Body
        });

        const askZipResponse = `Hey Coach! I'd love to help find tournaments near you. What's your zip code or city? Just text it back and I'll find events in your area!`;

        console.log('📤 Sending SMS via Twilio...');
        const smsResult = await twilioClient.messages.create({
          body: askZipResponse,
          from: To,
          to: From
        });
        console.log('✅ SMS sent! SID:', smsResult.sid);
        res.status(200).send('<Response></Response>');
        return;
      }
    }

    // --- PATH 2: They replied with just a city name (follow-up) ---
    if (!tournamentContext && isJustCity) {
      console.log(`📍 City follow-up detected: ${isJustCity}`);
      const coords = await geocodeCity(isJustCity);

      if (coords) {
        const { data: nearbyTournaments, error: geoError } = await supabase
          .rpc('search_tournaments_by_distance', {
            user_lat: coords.lat,
            user_lng: coords.lng,
            radius_miles: effectiveRadius
          });

        console.log(`📍 Geo results: ${nearbyTournaments?.length || 0} within ${effectiveRadius} miles of ${isJustCity}`);

        if (!geoError && nearbyTournaments && nearbyTournaments.length > 0) {
          let filtered = nearbyTournaments.filter(t => isFutureEvent(t.dates));
          if (matchedMonth) {
            filtered = filtered.filter(t => t.dates && t.dates.includes(matchedMonth));
          }

          const contextLabel = savedContext && savedContext.originalQuestion
            ? `(Based on your earlier question: "${savedContext.originalQuestion}")\n`
            : '';

          tournamentContext = `${contextLabel}\nUpcoming tournaments within ${effectiveRadius} miles of ${isJustCity}:\n` +
            filtered.slice(0, 15).map(t =>
              `- ${t.name} | ${t.dates || 'TBD'} | ${t.location} | ${Math.round(t.distance_miles)} miles away | ${t.pricing || 'Contact for pricing'} | Ages: ${t.age_groups || 'Various'} | Director: ${t.director}`
            ).join('\n');

          if (filtered.length === 0 && matchedMonth) {
            const totalFuture = nearbyTournaments.filter(t => isFutureEvent(t.dates)).length;
            tournamentContext = `\nNo upcoming ${matchedMonth} tournaments found within ${effectiveRadius} miles of ${isJustCity}. There are ${totalFuture} upcoming tournaments in that area across all months.`;
          }
        }
      }

      // Clear saved context
      await saveContext(From, Body, { needsZip: false });
    }

    // --- PATH 3: They provided a zip code (directly or as follow-up) ---
    if (!tournamentContext && zipMatch) {
      console.log(`📍 Zip code detected: ${zipMatch[1]}, radius: ${effectiveRadius} miles`);
      const coords = await geocodeZip(zipMatch[1]);

      if (coords) {
        console.log(`📍 Coordinates: ${coords.lat}, ${coords.lng}`);
        const { data: nearbyTournaments, error: geoError } = await supabase
          .rpc('search_tournaments_by_distance', {
            user_lat: coords.lat,
            user_lng: coords.lng,
            radius_miles: effectiveRadius
          });

        console.log(`📍 Geo results: ${nearbyTournaments?.length || 0} within ${effectiveRadius} miles`);

        if (!geoError && nearbyTournaments && nearbyTournaments.length > 0) {
          let filtered = nearbyTournaments.filter(t => isFutureEvent(t.dates));
          if (matchedMonth) {
            filtered = filtered.filter(t => t.dates && t.dates.includes(matchedMonth));
          }

          const contextLabel = savedContext && savedContext.originalQuestion
            ? `(Based on your earlier question: "${savedContext.originalQuestion}")\n`
            : '';

          tournamentContext = `${contextLabel}\nUpcoming tournaments within ${effectiveRadius} miles of zip ${zipMatch[1]}:\n` +
            filtered.slice(0, 15).map(t =>
              `- ${t.name} | ${t.dates || 'TBD'} | ${t.location} | ${Math.round(t.distance_miles)} miles away | ${t.pricing || 'Contact for pricing'} | Ages: ${t.age_groups || 'Various'} | Director: ${t.director}`
            ).join('\n');

          if (filtered.length === 0 && matchedMonth) {
            const totalFuture = nearbyTournaments.filter(t => isFutureEvent(t.dates)).length;
            tournamentContext = `\nNo upcoming ${matchedMonth} tournaments found within ${effectiveRadius} miles of zip ${zipMatch[1]}. There are ${totalFuture} upcoming tournaments in that area across all months.`;
          }
        }
      }

      // Clear saved context
      await saveContext(From, Body, { needsZip: false });
    }

    // --- PATH 4: Regular keyword-based tournament search ---
    if (!tournamentContext) {
      let query = supabase.from('tournaments').select('*');
      let hasFilter = false;

      // Check for location keywords
      const matchedCity = floridaCities.find(city => bodyLower.includes(city));
      if (matchedCity) {
        query = query.ilike('location', `%${matchedCity}%`);
        hasFilter = true;
      }

      // Check for director names
      const directorNames = ['crawford', 'hannaseck', 'castro', 'rutherford', 'hassett'];
      const foundDirector = directorNames.find(d => bodyLower.includes(d));
      if (foundDirector) {
        query = query.ilike('director', `%${foundDirector}%`);
        hasFilter = true;
      }

      // Apply month filter
      if (matchedMonth) {
        query = query.ilike('dates', `%${matchedMonth}%`);
        hasFilter = true;
      }

      // Check for age group mentions
      const ageMatch = bodyLower.match(/(\d{1,2})\s*u\b/);
      if (ageMatch) {
        query = query.ilike('age_groups', `%${ageMatch[1]}U%`);
        hasFilter = true;
      }

      // Check for tournament name keywords
      const nameKeywords = ['classic', 'championship', 'showdown', 'slugfest', 'nit',
        'celebration', 'memorial', 'nationals', 'regional', 'war', 'battle', 'slam',
        'kickoff', 'valentine', 'rings'];
      const matchedName = nameKeywords.find(kw => bodyLower.includes(kw));
      if (matchedName) {
        query = query.ilike('name', `%${matchedName}%`);
        hasFilter = true;
      }

      // Only run query if we have at least one filter
      if (hasFilter) {
        const { data: tournaments, error } = await query.limit(20);
        const futureTournaments = tournaments ? tournaments.filter(t => isFutureEvent(t.dates)) : [];

        if (!error && futureTournaments.length > 0) {
          tournamentContext = '\nUpcoming tournaments in our database:\n' +
            futureTournaments.map(t =>
              `- ${t.name} | ${t.dates || 'TBD'} | ${t.location} | ${t.pricing || 'Contact for pricing'} | Ages: ${t.age_groups || 'Various'} | Director: ${t.director}`
            ).join('\n');
        }
      }
    }

    // ==========================================
    // CRM LOOKUP — Know who's texting
    // ==========================================
    const cleanPhone = From.replace(/\D/g, '').slice(-10);
    let callerInfo = null;
    try {
      const { data: crmHits } = await supabase.from('crm_contacts')
        .select('id, first_name, last_name, team_name, age_group, city, state, email')
        .or('phone.like.%' + cleanPhone + ',phone2.like.%' + cleanPhone)
        .eq('is_active', true)
        .limit(1);
      if (crmHits && crmHits.length > 0) callerInfo = crmHits[0];
    } catch (err) { console.error('CRM lookup error:', err.message); }

    console.log(callerInfo 
      ? `👤 Known caller: ${callerInfo.first_name} ${callerInfo.last_name} (${callerInfo.team_name || 'no team'}, ${callerInfo.age_group || 'no age'})`
      : `❓ Unknown caller: ${From}`);

    // If caller has an age group and no age filter was detected in message, auto-apply it
    if (callerInfo && callerInfo.age_group && !bodyLower.match(/(\d{1,2})\s*u\b/)) {
      console.log(`🎯 Auto-applying age group ${callerInfo.age_group} from CRM`);
    }

    // ==========================================
    // CONVERSATION HISTORY — last 10 messages for context
    // ==========================================
    let conversationHistory = '';
    try {
      const { data: history } = await supabase.from('sms_log')
        .select('question, response, created_at')
        .eq('phone_from', From)
        .order('created_at', { ascending: false })
        .limit(10);
      
      if (history && history.length > 0) {
        conversationHistory = history.reverse().map(m => {
          const parts = [];
          if (m.question && !m.question.startsWith('[')) parts.push('Coach: ' + m.question);
          if (m.response) parts.push('You: ' + m.response);
          return parts.join('\n');
        }).filter(Boolean).join('\n');
      }
    } catch (err) { console.error('History load error:', err.message); }

    // ==========================================
    // KNOWLEDGE BASE SEARCH
    // ==========================================
    let knowledgeContext = '';
    console.log('🔍 Searching knowledge base for:', Body);
    const { data: kbResults, error: kbError } = await supabase
      .rpc('search_knowledge_base', { search_query: Body });
    console.log('📚 KB Results:', kbResults?.length || 0, 'Error:', kbError?.message || 'none');

    if (!kbError && kbResults && kbResults.length > 0) {
      knowledgeContext = '\n\nRelevant USSSA information:\n' +
        kbResults.map(kb =>
          `[${kb.category.toUpperCase()}] ${kb.title}:\n${kb.content}`
        ).join('\n\n');
    }

    // ==========================================
    // CHECK FOR UNKNOWN CALLER INFO COLLECTION
    // ==========================================
    let collectingInfo = false;
    if (!callerInfo) {
      const pendingRequest = await checkPendingInfoRequest(From);
      
      if (pendingRequest) {
        // They're replying to our info request — try to parse their response
        const parsed = parseContactInfo(Body);
        if (parsed.firstName) {
          await saveContactFromReply(From, parsed);
          console.log(`✅ Collected contact info: ${parsed.firstName} ${parsed.lastName || ''} - ${parsed.teamName || 'no team'}`);
          // Re-lookup so the AI knows them now
          const { data: newHits } = await supabase.from('crm_contacts')
            .select('id, first_name, last_name, team_name, age_group, city, state, email')
            .or('phone.like.%' + cleanPhone + ',phone2.like.%' + cleanPhone)
            .limit(1);
          if (newHits && newHits.length > 0) callerInfo = newHits[0];
        }
      } else if (!tournamentContext) {
        // First message from unknown number — ask for info
        collectingInfo = true;
        const askInfoResponse = "Hey there! I'd be happy to help. Quick question — what's your name and what team are you with? That way I can make sure you get the best info for your age group. 🏟️";

        // Log the info request
        await supabase.from('sms_log').insert({
          phone_from: From, phone_to: To,
          question: '[System] Requested contact info',
          response: askInfoResponse,
          status: 'collecting_info'
        });

        // Also log their actual message
        await supabase.from('sms_log').insert({
          phone_from: From, phone_to: To,
          question: Body, response: null,
          status: 'pending_info'
        });

        await twilioClient.messages.create({ body: askInfoResponse, from: To, to: From });
        console.log('📋 Asked unknown caller for contact info');
        res.status(200).send('<Response></Response>');
        return;
      }
    }

    // ==========================================
    // BUILD SMART AI PROMPT
    // ==========================================
    const callerBlock = callerInfo
      ? `CALLER INFO (from our database):
- Name: ${callerInfo.first_name} ${callerInfo.last_name}
- Team: ${callerInfo.team_name || 'Not on file'}
- Age Group: ${callerInfo.age_group || 'Not on file'}
- Location: ${callerInfo.city || 'Unknown'}${callerInfo.state ? ', ' + callerInfo.state : ''}
USE their first name naturally in your response. If they ask about tournaments and didn't specify an age group, prioritize their age group (${callerInfo.age_group || 'unknown'}).`
      : `UNKNOWN CALLER (phone: ${From}). We just asked for their info or they provided it. Be friendly and helpful.`;

    const systemPrompt = `You are the text messaging assistant for Florida USSSA Baseball. You help coaches and parents with tournament info, registration, schedules, rules, and general questions via text message.

PERSONALITY:
- Friendly, knowledgeable about youth baseball in Florida
- Text like a real person — casual but professional  
- Use their first name when you know it
- Sound like someone who works in the USSSA office, not a corporate chatbot
- One emoji max per message, and only if it feels natural

${callerBlock}

${conversationHistory ? 'RECENT CONVERSATION HISTORY:\n' + conversationHistory + '\n\nUse this history to understand follow-up questions. If they say "how much?" or "what time?" — refer back to what was discussed.' : '(First message from this number)'}

${tournamentContext || ''}

${knowledgeContext || ''}

RESPONSE RULES:
- Keep responses under 300 characters when possible (2 text messages max)
- For tournament lists, keep to the top 3 closest/soonest and mention if there are more
- Be SPECIFIC — give dates, locations, prices, director names when you have the data
- If tournaments are listed above with distance info, mention how far each one is
- If you have the answer from tournament data or knowledge base, GIVE it — don't punt
- If you genuinely cannot answer, say: "Let me check on that and have someone get back to you shortly!"
- NEVER make up tournament dates, prices, or locations
- Do NOT end every message with "feel free to reach out" — only say it occasionally when it feels natural
- Match the energy of their message — short question gets a short answer`;

    // ==========================================
    // CALL CLAUDE
    // ==========================================
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: Body
      }]
    });

    const aiResponse = message.content[0].text;
    console.log('🤖 Claude response:', aiResponse);

    // Determine status
    const isForwarded = aiResponse.toLowerCase().includes('get back to you') ||
                        aiResponse.toLowerCase().includes('reach out shortly');

    // Log to sms_log table
    const { error: logError } = await supabase
      .from('sms_log')
      .insert({
        phone_from: From,
        phone_to: To,
        question: Body,
        response: aiResponse,
        contact_name: callerInfo ? `${callerInfo.first_name} ${callerInfo.last_name}` : null,
        team_name: callerInfo ? callerInfo.team_name : null,
        status: isForwarded ? 'forwarded' : 'answered'
      });
    if (logError) console.error('📝 SMS log error:', logError.message);
    else console.log('📝 SMS logged to database');

    // Forward unanswered questions to office
    if (isForwarded) {
      const callerLabel = callerInfo 
        ? `${callerInfo.first_name} ${callerInfo.last_name} (${callerInfo.team_name || 'no team'})` 
        : 'UNKNOWN';
      await twilioClient.messages.create({
        body: `🚨 NEEDS FOLLOW-UP\nFrom: ${From} (${callerLabel})\nQ: ${Body}\nAI said: ${aiResponse}`,
        from: To,
        to: '+16308647869'
      });
      console.log('📬 Forwarded to office');
    }

    // Send response via Twilio
    console.log('📤 Sending SMS via Twilio...');
    const smsResult = await twilioClient.messages.create({
      body: aiResponse,
      from: To,
      to: From
    });
    console.log('✅ SMS sent! SID:', smsResult.sid);

    res.status(200).send('<Response></Response>');

  } catch (error) {
    console.error('❌ FULL ERROR:', error.message);
    console.error('❌ ERROR STACK:', error.stack);
  }
});

// ===== EVENT CENTRAL API =====

// GET /api/ec/games — all games with team info

// GET /api/ec/age-groups — List available age groups and events
app.get('/api/ec/age-groups', async (req, res) => {
  try {
    let query = supabase
      .from('ec_games')
      .select('age_group, event_name')
      .not('age_group', 'is', null);
    
    if (req.query.event) query = query.eq('event_name', req.query.event);
    
    const { data } = await query;
    
    const groups = {};
    for (const g of (data || [])) {
      const key = g.age_group || 'Unknown';
      if (!groups[key]) groups[key] = new Set();
      if (g.event_name) groups[key].add(g.event_name);
    }
    
    const result = Object.entries(groups).map(([age, events]) => ({
      age_group: age,
      events: [...events],
    })).sort((a, b) => {
      const numA = parseInt(a.age_group) || 99;
      const numB = parseInt(b.age_group) || 99;
      return numA - numB;
    });
    
    res.json({ age_groups: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ec/games', async (req, res) => {
  try {
    let query = supabase
      .from('ec_games')
      .select('id, gc_game_id, home_score, away_score, age_group, status, game_date, field, innings_completed, home_team_id, away_team_id')
      .order('game_date', { ascending: false });

    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.age_group) query = query.eq('age_group', req.query.age_group);
    if (req.query.event) query = query.eq('event_name', req.query.event);

    const { data: games, error } = await query;
    if (error) throw error;

    // Get team names
    const teamIds = [...new Set(games.flatMap(g => [g.home_team_id, g.away_team_id]).filter(Boolean))];
    const { data: teams } = await supabase.from('ec_teams').select('id, team_name').in('id', teamIds);
    const teamMap = {};
    (teams || []).forEach(t => teamMap[t.id] = t.team_name);

    const result = games.map(g => ({
      ...g,
      home_team: teamMap[g.home_team_id] || 'TBD',
      away_team: teamMap[g.away_team_id] || 'TBD',
    }));

    res.json({ games: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ec/games/:id — single game with full box score
app.get('/api/ec/games/:id', async (req, res) => {
  try {
    const { data: game, error: gErr } = await supabase
      .from('ec_games')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (gErr) throw gErr;

    // Get team names
    const { data: homeTeam } = await supabase.from('ec_teams').select('id, team_name').eq('id', game.home_team_id).single();
    const { data: awayTeam } = await supabase.from('ec_teams').select('id, team_name').eq('id', game.away_team_id).single();

    // Get all stats
    const { data: stats } = await supabase
      .from('ec_game_stats')
      .select('*, player:ec_players!player_id(player_name, jersey_number, primary_position)')
      .eq('game_id', req.params.id);

    const boxScore = { away: { batting: [], pitching: [] }, home: { batting: [], pitching: [] } };

    for (const s of (stats || [])) {
      const side = s.team_id === game.home_team_id ? 'home' : 'away';
      const entry = { name: s.player?.player_name || '', jersey: s.player?.jersey_number || '', pos: s.player?.primary_position || '' };

      if (s.stat_type === 'batting') {
        boxScore[side].batting.push({ ...entry, ab: s.ab, r: s.r, h: s.h, rbi: s.rbi, bb: s.bb, so: s.so });
      } else if (s.stat_type === 'pitching') {
        boxScore[side].pitching.push({ ...entry, ip: s.ip, h: s.p_h, r: s.p_r, er: s.p_er, bb: s.p_bb, so: s.p_so });
      }
    }

    res.json({
      game: {
        ...game,
        home_team: homeTeam?.team_name || 'TBD',
        away_team: awayTeam?.team_name || 'TBD',
        boxScore,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ec/leaderboards — batting & pitching leaders
app.get('/api/ec/leaderboards', async (req, res) => {
  try {
    const ageGroup = req.query.age_group || null;
    const eventName = req.query.event || req.query.event_name || null;
    const minAB = parseInt(req.query.min_ab) || 5;
    const minIP = parseInt(req.query.min_ip) || 5;

    // Get games for this age group/event
    let gamesQuery = supabase.from('ec_games').select('id');
    if (ageGroup) gamesQuery = gamesQuery.eq('age_group', ageGroup);
    if (eventName) gamesQuery = gamesQuery.eq('event_name', eventName);
    const { data: games } = await gamesQuery;
    const gameIds = (games || []).map(g => g.id);
    
    if (gameIds.length === 0) return res.json({ batting: [], pitching: [] });

    // Get all stats for these games
    const { data: stats } = await supabase
      .from('ec_game_stats')
      .select('*, player:ec_players!player_id(player_name, jersey_number), team:ec_teams!team_id(team_name)')
      .in('game_id', gameIds);

    // Aggregate batting stats by player
    const batters = {};
    const pitchers = {};

    for (const s of (stats || [])) {
      const pid = s.player_id;
      const name = s.player?.player_name || 'Unknown';
      const team = s.team?.team_name || 'Unknown';
      const jersey = s.player?.jersey_number || '';

      if (s.stat_type === 'batting') {
        if (!batters[pid]) batters[pid] = { name, team, jersey, ab: 0, r: 0, h: 0, rbi: 0, bb: 0, so: 0, games: 0 };
        batters[pid].ab += s.ab || 0;
        batters[pid].r += s.r || 0;
        batters[pid].h += s.h || 0;
        batters[pid].rbi += s.rbi || 0;
        batters[pid].bb += s.bb || 0;
        batters[pid].so += s.so || 0;
        batters[pid].games++;
      }

      if (s.stat_type === 'pitching') {
        if (!pitchers[pid]) pitchers[pid] = { name, team, jersey, ip: 0, h: 0, r: 0, er: 0, bb: 0, so: 0, games: 0 };
        pitchers[pid].ip += s.ip || 0;
        pitchers[pid].h += s.p_h || 0;
        pitchers[pid].r += s.p_r || 0;
        pitchers[pid].er += s.p_er || 0;
        pitchers[pid].bb += s.p_bb || 0;
        pitchers[pid].so += s.p_so || 0;
        pitchers[pid].games++;
      }
    }

    // Calculate batting averages — filter by minimum AB
    const battingLeaders = Object.values(batters)
      .filter(b => b.ab >= minAB)
      .map(b => ({
        ...b,
        avg: b.ab > 0 ? (b.h / b.ab).toFixed(3) : '.000',
        obp: (b.ab + b.bb) > 0 ? ((b.h + b.bb) / (b.ab + b.bb)).toFixed(3) : '.000',
        slg: b.ab > 0 ? ((b.h * 1.0 + (b.doubles || 0) * 1.0 + (b.triples || 0) * 2.0 + (b.hr || 0) * 3.0) / b.ab).toFixed(3) : '.000',
      }))
      .sort((a, b) => parseFloat(b.avg) - parseFloat(a.avg))
      .slice(0, 15);

    // Calculate pitching leaders — filter by minimum IP
    const pitchingLeaders = Object.values(pitchers)
      .filter(p => p.ip >= minIP)
      .map(p => ({
        ...p,
        era: p.ip > 0 ? ((p.er / p.ip) * 7).toFixed(2) : '0.00',
        whip: p.ip > 0 ? ((p.bb + p.h) / p.ip).toFixed(2) : '0.00',
        kPerGame: p.ip > 0 ? ((p.so / p.ip) * 7).toFixed(1) : '0.0',
      }))
      .sort((a, b) => parseFloat(a.era) - parseFloat(b.era))
      .slice(0, 15);

    res.json({ batting: battingLeaders, pitching: pitchingLeaders, minAB, minIP });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ec/standings — W-L records
app.get('/api/ec/standings', async (req, res) => {
  try {
    let query = supabase
      .from('ec_games')
      .select('home_score, away_score, home_team_id, away_team_id, age_group, event_name')
      .eq('status', 'final');

    if (req.query.event) query = query.eq('event_name', req.query.event);
    if (req.query.age_group) query = query.eq('age_group', req.query.age_group);

    const { data: games } = await query;

    const teamIds = [...new Set((games||[]).flatMap(g => [g.home_team_id, g.away_team_id]).filter(Boolean))];
    const { data: teams } = await supabase.from('ec_teams').select('id, team_name').in('id', teamIds.length ? teamIds : ['none']);
    const teamMap = {};
    (teams || []).forEach(t => teamMap[t.id] = t.team_name);

    // Track standings by team NAME to merge duplicates
    const standings = {};
    for (const g of (games || [])) {
      const homeName = teamMap[g.home_team_id] || 'Unknown';
      const awayName = teamMap[g.away_team_id] || 'Unknown';
      
      // Skip TBD placeholder teams
      if (homeName.startsWith('TBD') || awayName.startsWith('TBD')) continue;
      
      if (!standings[homeName]) standings[homeName] = { team: homeName, age_group: g.age_group||'', w:0, l:0, rs:0, ra:0 };
      if (!standings[awayName]) standings[awayName] = { team: awayName, age_group: g.age_group||'', w:0, l:0, rs:0, ra:0 };

      standings[homeName].rs += g.home_score||0;
      standings[homeName].ra += g.away_score||0;
      standings[awayName].rs += g.away_score||0;
      standings[awayName].ra += g.home_score||0;

      if (g.home_score > g.away_score) { standings[homeName].w++; standings[awayName].l++; }
      else if (g.away_score > g.home_score) { standings[awayName].w++; standings[homeName].l++; }
    }

    const result = Object.values(standings)
      .map(t => ({ ...t, diff: (t.rs-t.ra) > 0 ? `+${t.rs-t.ra}` : `${t.rs-t.ra}` }))
      .sort((a,b) => b.w - a.w || a.l - b.l || (b.rs-b.ra) - (a.rs-a.ra));

    res.json({ standings: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET /api/ec/potg — player of the game list

// GET /api/ec/all-tournament — Top 15 performers by weighted score
app.get('/api/ec/all-tournament', async (req, res) => {
  try {
    const ageGroup = req.query.age_group || null;
    const eventName = req.query.event || req.query.event_name || null;
    const minAB = parseInt(req.query.min_ab) || 5;
    const minIP = parseInt(req.query.min_ip) || 5;

    // Get games
    let gamesQuery = supabase.from('ec_games').select('id');
    if (ageGroup) gamesQuery = gamesQuery.eq('age_group', ageGroup);
    if (eventName) gamesQuery = gamesQuery.eq('event_name', eventName);
    const { data: games } = await gamesQuery;
    const gameIds = (games || []).map(g => g.id);
    
    if (gameIds.length === 0) return res.json({ team: [] });

    const { data: stats } = await supabase
      .from('ec_game_stats')
      .select('*, player:ec_players!player_id(player_name, jersey_number), team:ec_teams!team_id(team_name)')
      .in('game_id', gameIds);

    // Aggregate + score each player
    const players = {};
    for (const s of (stats || [])) {
      const pid = s.player_id;
      if (!players[pid]) {
        players[pid] = {
          name: s.player?.player_name || 'Unknown',
          team: s.team?.team_name || 'Unknown',
          jersey: s.player?.jersey_number || '',
          score: 0, ab: 0, h: 0, r: 0, rbi: 0, bb: 0, so: 0,
          ip: 0, p_so: 0, p_er: 0, games: new Set(),
          highlights: [],
        };
      }
      players[pid].games.add(s.game_id);

      if (s.stat_type === 'batting') {
        const ab = s.ab || 0, h = s.h || 0, r = s.r || 0, rbi = s.rbi || 0, bb = s.bb || 0, so = s.so || 0;
        players[pid].ab += ab;
        players[pid].h += h;
        players[pid].r += r;
        players[pid].rbi += rbi;
        players[pid].bb += bb;
        players[pid].so += so;
        // Batting score
        const singles = h - (s.doubles || 0) - (s.triples || 0) - (s.hr || 0);
        players[pid].score += (singles * 2) + ((s.hr || 0) * 5) + (rbi * 2) + (r * 1.5) + (bb * 1) + (so * -0.5);
      }

      if (s.stat_type === 'pitching') {
        const ip = s.ip || 0, pso = s.p_so || 0, per = s.p_er || 0, pbb = s.p_bb || 0, ph = s.p_h || 0;
        players[pid].ip += ip;
        players[pid].p_so += pso;
        players[pid].p_er += per;
        // Pitching score
        players[pid].score += (ip * 3) + (pso * 2) + (per * -2) + (pbb * -1) + (ph * -0.5);
      }
    }

    // Filter: must meet minimum AB OR minimum IP
    const eligible = Object.values(players)
      .filter(p => p.ab >= minAB || p.ip >= minIP)
      .map(p => {
        const avg = p.ab > 0 ? (p.h / p.ab).toFixed(3) : null;
        const era = p.ip > 0 ? ((p.p_er / p.ip) * 7).toFixed(2) : null;
        const gamesPlayed = p.games.size;
        
        // Build highlight string
        const parts = [];
        if (p.ab > 0) parts.push(p.h + '-for-' + p.ab + ' (' + avg + ')');
        if (p.rbi > 0) parts.push(p.rbi + ' RBI');
        if (p.r > 0) parts.push(p.r + ' R');
        if (p.ip > 0) parts.push(p.ip + ' IP');
        if (p.p_so > 0) parts.push(p.p_so + ' K');
        
        return {
          name: p.name,
          team: p.team,
          jersey: p.jersey,
          score: Math.round(p.score * 10) / 10,
          avg, era,
          ab: p.ab, h: p.h, r: p.r, rbi: p.rbi, bb: p.bb, so: p.so,
          ip: p.ip, p_so: p.p_so, p_er: p.p_er,
          games: gamesPlayed,
          highlights: parts.join(', '),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);

    res.json({ 
      team: eligible, 
      ageGroup: ageGroup || 'All',
      eventName: eventName || 'All Events',
      minAB, minIP 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ec/potg', async (req, res) => {
  try {
    let potgQuery = supabase
      .from('ec_player_of_game')
      .select('potg_score, highlights, player:ec_players!player_id(player_name, jersey_number, primary_position), team:ec_teams!team_id(team_name), game:ec_games!game_id(id, home_score, away_score, status, home_team_id, away_team_id, age_group, event_name)')
      .order('potg_score', { ascending: false });
    const { data, error } = await potgQuery;

    if (error) throw error;

    // Filter by event and age_group after join
    const eventFilter = req.query.event || null;
    const ageFilter = req.query.age_group || null;
    const filtered = (data || []).filter(p => {
      if (eventFilter && p.game?.event_name !== eventFilter) return false;
      if (ageFilter && p.game?.age_group !== ageFilter) return false;
      return true;
    });

    const teamIds = [...new Set((filtered || []).flatMap(p => [p.game?.home_team_id, p.game?.away_team_id]).filter(Boolean))];
    let teamMap = {};
    if (teamIds.length > 0) {
      const { data: teams } = await supabase.from('ec_teams').select('id, team_name').in('id', teamIds);
      (teams || []).forEach(t => teamMap[t.id] = t.team_name);
    }

    const potg = (filtered || []).map(p => ({
      name: p.player?.player_name,
      jersey: p.player?.jersey_number,
      position: p.player?.primary_position || '',
      team: p.team?.team_name,
      score: p.potg_score,
      highlights: p.highlights,
      isLive: p.game?.status === 'live',
      game: (teamMap[p.game?.away_team_id] || 'Away') + ' ' + (p.game?.away_score || 0) + ', ' + (teamMap[p.game?.home_team_id] || 'Home') + ' ' + (p.game?.home_score || 0),
    }));

    // Deduplicate
    const seen = new Set();
    const deduped = potg.filter(r => {
      const key = (r.name || "") + "|" + r.score;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    res.json({ potg: deduped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

console.log('✅ Event Central API routes loaded');


// Start server

// All-Tournament Team shareable graphic
app.get('/ec/all-tournament', (req, res) => {
  res.sendFile(__dirname + '/frontend/all-tournament.html');
});


// ═══ CRM + GC COLLECTION ROUTES ═══════════════════════════

// Serve GC submission form
app.get("/gc-submit", (req, res) => {
  res.sendFile(__dirname + "/frontend/gc-submit.html");
});
app.get("/gc-submit/:token", (req, res) => {
  res.sendFile(__dirname + "/frontend/gc-submit.html");
});

// GET submission data by token
app.get("/api/gc-submit/:token", async (req, res) => {
  try {
    const { data, error } = await supabase.from("gc_submissions").select("*").eq("token", req.params.token).single();
    if (error || !data) return res.status(404).json({ error: "Not found" });
    res.json({ team_name: data.team_name, age_group: data.age_group, team_class: data.team_class, coach_name: data.coach_name, submitted_at: data.submitted_at, no_gc: data.no_gc, gc_url: data.gc_url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Track form view
app.post("/api/gc-submit/:token/viewed", async (req, res) => {
  await supabase.from("gc_submissions").update({ form_viewed_at: new Date().toISOString() }).eq("token", req.params.token).is("form_viewed_at", null);
  res.json({ ok: true });
});

// POST submission (coach submits GC link)
app.post("/api/gc-submit/:token", async (req, res) => {
  try {
    const { gc_url, no_gc } = req.body;
    const { data: sub } = await supabase.from("gc_submissions").select("*").eq("token", req.params.token).single();
    if (!sub) return res.status(404).json({ error: "Invalid token" });
    let gcTeamId = null;
    if (gc_url) { const match = gc_url.match(/teams\/([A-Za-z0-9]+)/); gcTeamId = match ? match[1] : null; }
    await supabase.from("gc_submissions").update({ gc_url: gc_url || null, no_gc: !!no_gc, submitted_at: new Date().toISOString() }).eq("token", req.params.token);
    if (sub.contact_id) {
      await supabase.from("crm_contacts").update({ gc_team_url: gc_url || null, gc_team_id: gcTeamId, gc_status: no_gc ? "no_gc" : "submitted", gc_submitted_at: new Date().toISOString() }).eq("id", sub.contact_id);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET CRM contacts with filtering
app.get("/api/crm/contacts", async (req, res) => {
  try {
    const { state, age_group, gc_status, search, limit, offset } = req.query;
    let query = supabase.from("crm_contacts").select("*", { count: "exact" }).eq("is_active", true).order("updated_at", { ascending: false });
    if (state) query = query.contains("states_active", [state]);
    if (age_group) query = query.eq("age_group", age_group);
    if (gc_status) query = query.eq("gc_status", gc_status);
    if (search) query = query.or("team_name.ilike.%" + search + "%,first_name.ilike.%" + search + "%,last_name.ilike.%" + search + "%,email.ilike.%" + search + "%");
    query = query.range(parseInt(offset) || 0, (parseInt(offset) || 0) + (parseInt(limit) || 50) - 1);
    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ contacts: data, total: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET CRM summary
app.get("/api/crm/summary", async (req, res) => {
  try {
    const { data } = await supabase.from("crm_summary").select("*").single();
    res.json(data || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET GC progress by state
app.get("/api/crm/gc-progress", async (req, res) => {
  try {
    const { data } = await supabase.from("gc_progress_by_state").select("*");
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST import coaches into CRM
app.post("/api/crm/import-coaches", async (req, res) => {
  try {
    const { coaches, state } = req.body;
    let imported = 0, skipped = 0;
    for (const c of coaches) {
      const rec = { first_name: c.CoachFirst || c.firstName, last_name: c.CoachLast || c.lastName, email: (c.Email || c.email || "").toLowerCase().trim(), phone: c.Phone || c.phone, team_name: c.TeamName || c.teamName, team_city: c.TeamCity || c.teamCity, team_state: c.TeamState || c.teamState || state, age_group: c.AgeGroup || c.ageGroup, team_class: c.DivClass || c.teamClass, dc_team_id: c.TeamID || c.teamID, dc_registration: c.Registration || c.registration, states_active: [state || "FL"], source: "dc_scraper", season: "2026" };
      if (!rec.email && !rec.phone && !rec.first_name) { skipped++; continue; }
      const { error } = await supabase.from("crm_contacts").upsert(rec, { onConflict: "dc_registration,season", ignoreDuplicates: false });
      if (error) skipped++; else imported++;
    }
    res.json({ imported, skipped, total: coaches.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST generate GC tokens for contacts
app.post("/api/crm/generate-gc-tokens", async (req, res) => {
  try {
    const { filter } = req.body;
    let query = supabase.from("crm_contacts").select("*").eq("is_active", true).eq("gc_status", "unknown").not("email", "is", null);
    if (filter?.state) query = query.contains("states_active", [filter.state]);
    if (filter?.age_group) query = query.eq("age_group", filter.age_group);
    const { data: contacts } = await query;
    const crypto = require("crypto");
    let created = 0;
    for (const contact of (contacts || [])) {
      const token = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
      const { data: existing } = await supabase.from("gc_submissions").select("id").eq("contact_id", contact.id).maybeSingle();
      if (!existing) {
        await supabase.from("gc_submissions").insert({ contact_id: contact.id, token, team_name: contact.team_name, age_group: contact.age_group, team_class: contact.team_class, coach_name: (contact.first_name + " " + contact.last_name).trim() });
        created++;
      }
    }
    res.json({ contacts_matched: (contacts || []).length, tokens_created: created });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET email templates
app.get("/api/email/templates", async (req, res) => {
  try {
    const { data } = await supabase.from("email_templates").select("*").order("created_at");
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Unsubscribe
app.get("/unsubscribe/:contactId", async (req, res) => {
  await supabase.from("crm_contacts").update({ opted_out: true, opted_out_at: new Date().toISOString() }).eq("id", req.params.contactId);
  res.send("<html><body style=\"font-family:Arial;text-align:center;padding:60px;background:#0a0e1a;color:#eee;\"><h2>Unsubscribed</h2><p>You will not receive any more emails from us.</p></body></html>");
});


// ─── SEND SMS ENDPOINT (for dashboard) ─────────────────
app.post('/api/send-sms', async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });
    
    const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to.startsWith('+') ? to : '+1' + to.replace(/\D/g, '').slice(-10)
    });

    console.log('Saving to sms_log, phone_to:', process.env.TWILIO_PHONE_NUMBER);
    const { error: logError } = await supabase.from('sms_log').insert({
      phone_from: to,
      phone_to: process.env.TWILIO_PHONE_NUMBER,
      response: message,
      status: 'manual_reply',
      created_at: new Date().toISOString()
    });
    if (logError) console.error('Failed to log outbound SMS:', logError.message);

    res.json({ success: true });
  } catch (err) {
    console.error('Send SMS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Unrivaled Connect server running on port ${PORT}`);
  console.log(`📱 Twilio configured for: ${process.env.TWILIO_ACCOUNT_SID}`);
  console.log(`🔗 Supabase connected to: ${process.env.SUPABASE_URL}`);
  console.log(`🤖 Claude API ready`);
  console.log(`📚 Knowledge base search enabled`);
  console.log(`📍 Geo-search enabled`);
  console.log(`💬 Conversation memory enabled`);
  console.log(`⏸️  AI pause system enabled`);
});

module.exports = app;
