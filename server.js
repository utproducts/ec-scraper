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

// Initialize services
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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

      // Save to gamechanger_links table
      const { error: gcError } = await supabase.from('gamechanger_links').insert({
        phone_from: From,
        team_id: gcTeamId,
        full_url: gcUrl,
        raw_message: Body,
        status: 'pending'
      });

      if (gcError) console.error('GC link save error:', gcError.message);
      else console.log('✅ GameChanger link saved!');

      // Send confirmation to coach
      const gcResponse = `Thanks Coach! Got your GameChanger link. We'll get those stats posted to the state site. Great weekend! 🏟️ If you have any other questions, feel free to reach out!`;

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

    // Search knowledge base for relevant info
    let knowledgeContext = '';

    console.log('🔍 Searching knowledge base for:', Body);
    const { data: kbResults, error: kbError } = await supabase
      .rpc('search_knowledge_base', { search_query: Body });

    console.log('📚 KB Results:', kbResults?.length || 0, 'Error:', kbError?.message || 'none');

    if (!kbError && kbResults && kbResults.length > 0) {
      knowledgeContext = '\n\nRelevant Florida USSSA information:\n' +
        kbResults.map(kb =>
          `[${kb.category.toUpperCase()}] ${kb.title}:\n${kb.content}`
        ).join('\n\n');
    }

    // Generate AI response using Claude
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `You are a 50-65 year old Florida USSSA baseball tournament director responding to a coach's text message.

Coach's message: "${Body}"

${tournamentContext}

${knowledgeContext}

Instructions:
- If tournaments are listed above, use that specific information in your response
- If distance info is included, mention how far each tournament is
- If USSSA rules, policies, or FAQ info is provided above, use that to answer accurately
- Give actual dates, locations, pricing, and directors when available
- Keep it VERY brief (1-2 short sentences max, under 160 characters total)
- If there are more than 3 tournaments, list the closest/soonest 3 and say how many more are available
- Sound natural and friendly, like you're texting back personally
- ALWAYS end with: "If you have any other questions, feel free to reach out!"
- If you don't have specific info about their question, say: "Let me have someone from the office get back to you on that. They'll reach out shortly!"

Respond as if you're texting back personally.`
      }]
    });

    const aiResponse = message.content[0].text;
    console.log('🤖 Claude response:', aiResponse);

    // Determine status
    const isForwarded = aiResponse.toLowerCase().includes('office get back to you') ||
                        aiResponse.toLowerCase().includes('reach out shortly');

    // Log to sms_log table
    const { error: logError } = await supabase
      .from('sms_log')
      .insert({
        phone_from: From,
        phone_to: To,
        question: Body,
        response: aiResponse,
        status: isForwarded ? 'forwarded' : 'answered'
      });
    if (logError) console.error('📝 SMS log error:', logError.message);
    else console.log('📝 SMS logged to database');

    // Forward unanswered questions to office
    if (isForwarded) {
      await twilioClient.messages.create({
        body: `🚨 UNANSWERED QUESTION 🚨\n\nFrom: ${From}\nQuestion: ${Body}\n\nClaude's response: ${aiResponse}`,
        from: To,
        to: '+16308647869' // YOUR PHONE NUMBER
      });

      console.log('📬 Forwarded unanswered question to office');
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

// Start server
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
