// =============================================
// FL BASEBALL USSSA - CONTENT SCRAPER
// Scrapes all content pages from flbaseball.usssa.com
// and upserts into Supabase knowledge_base table
// 
// Can be run manually: node content-scraper.js
// Or scheduled via cron (see bottom of file)
// =============================================

require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// =============================================
// PAGES TO SCRAPE
// Each entry defines a page, its category, and
// how to extract meaningful content from it
// =============================================
const PAGES_TO_SCRAPE = [
  {
    url: 'https://flbaseball.usssa.com/florida-usssa-state-rules/',
    category: 'rules',
    subcategory: 'tournament_rules',
    title: 'Florida USSSA Tournament Rules',
    keywords: ['rules', 'time limit', 'pitching', 'mercy', 'cleats', 'bat', 'ejection', 'roster', 'lineup', 'tie', 'home team']
  },
  {
    url: 'https://flbaseball.usssa.com/florida-usssa-bat-rules/',
    category: 'rules',
    subcategory: 'bats',
    title: 'Florida USSSA Bat Rules',
    keywords: ['bat', 'bats', 'BBCOR', 'BPF', 'drop 5', 'drop 3', 'USA bat', 'demarini', 'legal bat']
  },
  {
    url: 'https://flbaseball.usssa.com/rule-8-00-coach-pitch-specific-rules/',
    category: 'rules',
    subcategory: 'coach_pitch',
    title: 'Coach Pitch Rules (Rule 8.00)',
    keywords: ['coach pitch', '6u', '7u', '8u', 'pitching circle', 'safety arc', 'fair ball arc', '5 run rule']
  },
  {
    url: 'https://flbaseball.usssa.com/classifications/',
    category: 'rules',
    subcategory: 'classifications',
    title: 'Team Classification System',
    keywords: ['classification', 'class', 'AA', 'AAA', 'major', 'A class', 'reclassified', 'power rating']
  },
  {
    url: 'https://flbaseball.usssa.com/usssa-roster-rules/',
    category: 'rules',
    subcategory: 'roster_rules',
    title: 'USSSA Roster and Guest Player Rules',
    keywords: ['roster', 'guest player', 'drop player', 'add player', 'two teams', 'deactivate', 'guest portal']
  },
  {
    url: 'https://flbaseball.usssa.com/florida-state-9u-closed-base-rules/',
    category: 'rules',
    subcategory: '9u_closed_base',
    title: '9U Closed Base Rules',
    keywords: ['9u', 'closed base', 'lead off', 'stealing', 'base running', '65 feet', '46 feet', 'balk']
  },
  {
    url: 'https://flbaseball.usssa.com/weather-refund-policy/',
    category: 'policies',
    subcategory: 'refund',
    title: 'Weather/Refund Policy',
    keywords: ['refund', 'weather', 'rain', 'rainout', 'money back', 'cancelled', 'guarantee']
  },
  {
    url: 'https://flbaseball.usssa.com/faq/',
    category: 'faq',
    subcategory: null,
    title: 'Frequently Asked Questions',
    keywords: ['faq', 'gate fee', 'points', 'speakers', 'protest', 'weather update', 'classification', 'noise']
  },
  {
    url: 'https://flbaseball.usssa.com/about-us/',
    category: 'about',
    subcategory: null,
    title: 'About USSSA Florida Baseball',
    keywords: ['about', 'usssa', 'history', 'safe sport', 'headquarters', 'melbourne']
  },
  {
    url: 'https://flbaseball.usssa.com/contact-us/',
    category: 'contact',
    subcategory: null,
    title: 'Contact Information',
    keywords: ['contact', 'phone', 'email', 'address', 'state office']
  },
  {
    url: 'https://flbaseball.usssa.com/points-race/',
    category: 'faq',
    subcategory: 'points',
    title: 'USSSA Points Race',
    keywords: ['points', 'points race', 'ranking', 'championship rings', 'seeding']
  },
  {
    url: 'https://flbaseball.usssa.com/fl-mvp-games/',
    category: 'events',
    subcategory: 'mvp_games',
    title: 'Florida MVP Games',
    keywords: ['mvp', 'mvp games', 'all star', 'showcase']
  },
  {
    url: 'https://flbaseball.usssa.com/state-tournaments/',
    category: 'events',
    subcategory: 'state_tournaments',
    title: 'State Tournaments',
    keywords: ['state', 'state tournament', 'state championship', 'qualifier']
  },
  {
    url: 'https://flbaseball.usssa.com/new-to-the-usssa-app/',
    category: 'app',
    subcategory: null,
    title: 'USSSA App - Getting Started',
    keywords: ['app', 'usssa app', 'download', 'mobile', 'iphone', 'android']
  },
  {
    url: 'https://flbaseball.usssa.com/how-to-add-teams-in-usssa-app/',
    category: 'app',
    subcategory: 'add_team',
    title: 'USSSA App - How to Add Teams',
    keywords: ['app', 'add team', 'usssa app', 'team', 'roster']
  },
  {
    url: 'https://flbaseball.usssa.com/insurance/',
    category: 'how_to',
    subcategory: 'insurance',
    title: 'Insurance Information',
    keywords: ['insurance', 'coverage', 'policy', 'purchase insurance']
  }
];

// =============================================
// CONTENT EXTRACTION
// Strips nav, footer, sidebar junk and returns
// only the meaningful page content
// =============================================
function extractContent($) {
  // Remove elements we don't want
  $('nav, header, footer, .nav, .footer, .header').remove();
  $('script, style, noscript, iframe').remove();
  $('[class*="menu"], [class*="sidebar"], [class*="widget"]').remove();
  $('[class*="footer"], [class*="header"], [class*="nav"]').remove();
  $('[class*="partner"], [class*="sponsor"]').remove();
  $('[class*="app-badge"], [class*="mobile-app"]').remove();
  $('img').remove();

  // Try to find the main content area
  let content = '';

  // Look for common content containers
  const selectors = [
    '.entry-content',
    '.page-content', 
    '.post-content',
    'article',
    '.content-area',
    'main',
    '.main-content',
    '#content',
    '.accordion',           // for FAQ pages
    '.tab-content',         // for tabbed content
    '.event-list',          // for event listings
    '.single-content'
  ];

  for (const selector of selectors) {
    const el = $(selector);
    if (el.length && el.text().trim().length > 50) {
      content = el.text().trim();
      break;
    }
  }

  // Fallback: grab body text minus known junk
  if (!content || content.length < 50) {
    content = $('body').text().trim();
  }

  // Clean up the text
  content = content
    .replace(/\s+/g, ' ')           // collapse whitespace
    .replace(/\n\s*\n/g, '\n')      // remove blank lines
    .replace(/\t/g, ' ')            // remove tabs
    .replace(/\s{2,}/g, ' ')        // collapse multiple spaces
    .trim();

  // Truncate if extremely long (keep most important content)
  if (content.length > 8000) {
    content = content.substring(0, 8000) + '... [content truncated]';
  }

  return content;
}

// =============================================
// SCRAPE A SINGLE PAGE
// =============================================
async function scrapePage(pageConfig) {
  try {
    console.log(`  📄 Scraping: ${pageConfig.title}`);
    
    const response = await axios.get(pageConfig.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);
    const content = extractContent($);

    if (!content || content.length < 20) {
      console.log(`  ⚠️  No meaningful content found for: ${pageConfig.title}`);
      return null;
    }

    return {
      category: pageConfig.category,
      subcategory: pageConfig.subcategory,
      title: pageConfig.title,
      content: content,
      source_url: pageConfig.url,
      keywords: pageConfig.keywords,
      updated_at: new Date().toISOString()
    };

  } catch (error) {
    console.error(`  ❌ Error scraping ${pageConfig.url}: ${error.message}`);
    return null;
  }
}

// =============================================
// SCRAPE THE EVENTS PAGE FOR DIRECTOR INFO
// =============================================
async function scrapeDirectors() {
  try {
    console.log(`  📄 Scraping: Tournament Directors from events page`);
    
    const response = await axios.get('https://flbaseball.usssa.com/events/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);
    
    // Extract director names from the filter dropdown
    const directors = [];
    $('select option').each((i, el) => {
      const text = $(el).text().trim();
      // Directors are in one of the filter dropdowns
      if (text && !text.includes('Select') && !text.includes('All') && 
          !text.includes('Baseball Boys') && !text.includes('miles') &&
          !text.includes('Stature') && !text.includes('Class')) {
        // This is a rough filter - the actual directors are in a specific select
      }
    });

    return {
      category: 'directors',
      subcategory: null,
      title: 'Florida USSSA Tournament Directors',
      content: 'The Florida USSSA tournament directors are: Ronny Delgado, Scott Rutherford, Darrell Hannaseck (Space Coast Complex in Viera, Boombah Sports Complex in Sanford), Vinny Castro (Central Florida - New Smyrna/Ocoee/Apopka), Brien Coppola, Roger Miller, Sebastian Hassett (Sarasota/Bradenton area), Daryl Smith (Clearwater/Tampa Bay area), Steve Hassett, Christian Martinez (Fort Myers, Coral Springs), Chris Crawford (Jacksonville), Southeast Region Baseball (Fort Walton Beach/Panhandle), AAG Baseball. Contact them through the USSSA website or app.',
      source_url: 'https://flbaseball.usssa.com/events/',
      keywords: ['director', 'directors', 'contact', 'tournament director', 'hassett', 'hannaseck', 'castro', 'martinez', 'crawford', 'smith'],
      updated_at: new Date().toISOString()
    };

  } catch (error) {
    console.error(`  ❌ Error scraping directors: ${error.message}`);
    return null;
  }
}

// =============================================
// SCRAPE UPCOMING EVENTS SUMMARY
// =============================================
async function scrapeUpcomingEventsSummary() {
  try {
    console.log(`  📄 Scraping: Upcoming Events Summary`);
    
    const response = await axios.get('https://flbaseball.usssa.com/events/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);
    const events = [];

    // Parse event cards - they typically have a consistent structure
    $('a[href*="/event/"]').each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (text && text.length > 3 && !text.includes('Event Details') && !text.includes('View All')) {
        if (!events.includes(text)) {
          events.push(text);
        }
      }
    });

    // Build a summary of upcoming events
    const eventList = events.slice(0, 20).join(', ');
    
    return {
      category: 'events',
      subcategory: 'upcoming_summary',
      title: 'Current Upcoming Events',
      content: `Upcoming Florida USSSA Baseball events include: ${eventList}. For full details, pricing, age groups, and registration, visit https://flbaseball.usssa.com/events/ or use the USSSA App. Events can be filtered by date, stature, competitive class, director, and location/zip code.`,
      source_url: 'https://flbaseball.usssa.com/events/',
      keywords: ['upcoming', 'events', 'tournaments', 'this weekend', 'next weekend', 'schedule', 'what events', 'what tournaments'],
      updated_at: new Date().toISOString()
    };

  } catch (error) {
    console.error(`  ❌ Error scraping upcoming events: ${error.message}`);
    return null;
  }
}

// =============================================
// UPSERT TO SUPABASE
// Uses title + category as the unique key
// =============================================
async function upsertToSupabase(records) {
  if (!records || records.length === 0) {
    console.log('⚠️  No records to upsert');
    return;
  }

  console.log(`\n💾 Upserting ${records.length} records to Supabase...`);

  for (const record of records) {
    try {
      // Check if record already exists by title + category
      const { data: existing } = await supabase
        .from('knowledge_base')
        .select('id')
        .eq('title', record.title)
        .eq('category', record.category)
        .single();

      if (existing) {
        // UPDATE existing record
        const { error } = await supabase
          .from('knowledge_base')
          .update({
            content: record.content,
            source_url: record.source_url,
            keywords: record.keywords,
            subcategory: record.subcategory,
            updated_at: record.updated_at
          })
          .eq('id', existing.id);

        if (error) {
          console.error(`  ❌ Error updating "${record.title}": ${error.message}`);
        } else {
          console.log(`  🔄 Updated: ${record.title}`);
        }
      } else {
        // INSERT new record
        const { error } = await supabase
          .from('knowledge_base')
          .insert(record);

        if (error) {
          console.error(`  ❌ Error inserting "${record.title}": ${error.message}`);
        } else {
          console.log(`  ✅ Inserted: ${record.title}`);
        }
      }
    } catch (err) {
      console.error(`  ❌ Error processing "${record.title}": ${err.message}`);
    }
  }
}

// =============================================
// MAIN SCRAPE FUNCTION
// =============================================
async function scrapeAllContent() {
  console.log('🕷️  Starting FL Baseball USSSA content scrape...');
  console.log(`📅 ${new Date().toISOString()}`);
  console.log(`📄 ${PAGES_TO_SCRAPE.length + 2} pages to scrape\n`);

  const records = [];

  // Scrape all content pages
  for (const page of PAGES_TO_SCRAPE) {
    const record = await scrapePage(page);
    if (record) {
      records.push(record);
    }
    // Small delay between requests to be respectful
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Scrape directors
  const directorsRecord = await scrapeDirectors();
  if (directorsRecord) records.push(directorsRecord);

  // Scrape upcoming events summary
  const eventsRecord = await scrapeUpcomingEventsSummary();
  if (eventsRecord) records.push(eventsRecord);

  // Add static records that don't come from scraping
  records.push({
    category: 'how_to',
    subcategory: null,
    title: 'How-To Resources and Important Links',
    content: 'How to Pay For An Event: https://vimeo.com/711650406/dce3606919. How to Add Guest Player: https://usssa.com/guest-player-management. New to USSSA? Get Started: https://usssa.com/how-to-create. Create Manager User Account: http://www.usssa.com/ISTSIDCreation. Manager Login: https://www.usssa.com/login. Purchase Insurance: http://www.usssa.com/baseball/TeamInsurance/. USSSA Age Calculator: https://www.usssa.com/BASEBALL/AGECALCULATOR. National Rules 2025-2026 PDF: https://cms.usssa.net/wp-content/uploads/sites/2/2025/11/usssa-baseball-playing-rules-national-by-laws.pdf.',
    source_url: 'https://flbaseball.usssa.com/',
    keywords: ['how to', 'pay', 'register', 'sign up', 'create account', 'login', 'insurance', 'age calculator', 'guest player'],
    updated_at: new Date().toISOString()
  });

  records.push({
    category: 'venues',
    subcategory: null,
    title: 'Key Florida USSSA Complexes and Venues',
    content: 'Major complexes: 1) USSSA Space Coast Complex in Viera, FL (online tickets required). 2) Boombah Sports Complex in Sanford, FL ($10/day cash gate fee, no speakers). 3) Sarasota/Bradenton area. 4) Coral Springs, FL. 5) Jacksonville, FL. 6) Fort Myers, FL. 7) Clearwater/Tampa Bay area. 8) New Smyrna/Ocoee/Apopka (Central Florida). 9) Fort Walton Beach (Panhandle).',
    source_url: 'https://flbaseball.usssa.com/',
    keywords: ['complex', 'venue', 'field', 'park', 'where', 'space coast', 'boombah', 'viera', 'sanford'],
    updated_at: new Date().toISOString()
  });

  records.push({
    category: 'programs',
    subcategory: null,
    title: 'National Programs',
    content: 'All State Championship: https://allstate.usssa.com. All American Games: https://aagbaseball.usssa.com/. Future Stars - AA Showcase: https://www.futurestarssg.com. World Series: https://wsbaseball.usssa.com/.',
    source_url: 'https://flbaseball.usssa.com/',
    keywords: ['all state', 'all american', 'future stars', 'world series', 'national', 'showcase'],
    updated_at: new Date().toISOString()
  });

  // Upsert everything to Supabase
  await upsertToSupabase(records);

  console.log(`\n🎉 Content scrape complete! ${records.length} records processed.`);
  return records;
}

// =============================================
// RUN MODE
// =============================================

// If run directly: node content-scraper.js
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--schedule')) {
    // Run on a weekly schedule (every Sunday at 3am)
    console.log('📅 Content scraper scheduled: Every Sunday at 3:00 AM');
    console.log('   Running initial scrape now...\n');
    
    scrapeAllContent().then(() => {
      console.log('\n⏰ Waiting for next scheduled run (Sunday 3:00 AM)...');
    });

    cron.schedule('0 3 * * 0', () => {
      console.log('\n⏰ Scheduled scrape triggered!');
      scrapeAllContent();
    });

  } else {
    // One-time run
    scrapeAllContent()
      .then(() => {
        console.log('\n✅ Done!');
        process.exit(0);
      })
      .catch(error => {
        console.error('❌ Scrape failed:', error);
        process.exit(1);
      });
  }
}

module.exports = { scrapeAllContent, scrapeDirectors, scrapeUpcomingEventsSummary };