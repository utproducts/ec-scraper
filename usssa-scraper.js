require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function scrapeUSSSATournaments() {
  console.log('🕷️  Starting USSSA tournament scrape...');
  
  try {
    // Scrape the main search page for Florida baseball tournaments
    const searchUrl = 'https://www.usssa.com/baseball/eventSearch/?sportID=11&seasonID=30&region=1573&period=b';
    
    console.log('📡 Fetching tournament data from USSSA...');
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    const tournaments = [];
    
    // Log the page title to confirm we got the right page
    console.log('📄 Page title:', $('title').text());
    
    // Try multiple selector patterns to find the events
    console.log('🔍 Searching for tournament listings...');
    
    // Pattern 1: Look for table rows with event data
    let rowCount = 0;
    $('table tbody tr, .event-row, .tournament-item').each((index, element) => {
      rowCount++;
      
      // Try to extract event name from various possible locations
      let eventName = $(element).find('a[href*="eventDetails"]').first().text().trim();
      if (!eventName) eventName = $(element).find('.event-name, .tournament-name').text().trim();
      if (!eventName) eventName = $(element).find('td').first().find('a').text().trim();
      
      // Skip header rows and empty rows
      if (!eventName || eventName.toLowerCase().includes('event name') || eventName.length < 3) {
        return;
      }
      
      // Extract details link
      let detailsLink = $(element).find('a[href*="eventDetails"]').attr('href');
      if (!detailsLink) detailsLink = $(element).find('a').first().attr('href');
      
      // Extract other fields
      const allText = $(element).text();
      
      // Try to find date pattern (MM/DD/YYYY)
      const dateMatch = allText.match(/(\d{2}\/\d{2}\/\d{4})/);
      const startDate = dateMatch ? dateMatch[1] : '';
      
      // Extract location (look for state abbreviations)
      const locationMatch = allText.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),?\s+FL/i);
      const location = locationMatch ? locationMatch[0] : '';
      
      // Extract director name (usually appears before location)
      const directorMatch = allText.match(/([A-Z][a-z]+\s+[A-Z][a-z]+)(?=.*FL)/);
      const director = directorMatch ? directorMatch[1].trim() : '';
      
      // Extract team count
      const teamsMatch = allText.match(/(\d+)\s*(?:teams?)?/i);
      const teamsCount = teamsMatch ? parseInt(teamsMatch[1]) : 0;
      
      tournaments.push({
        name: eventName,
        start_date: startDate,
        location: location,
        director: director,
        teams_count: teamsCount,
        details_url: detailsLink ? (detailsLink.startsWith('http') ? detailsLink : `https://www.usssa.com${detailsLink}`) : null,
        source: 'usssa.com',
        scraped_at: new Date().toISOString()
      });
    });
    
    console.log(`📊 Processed ${rowCount} rows`);
    console.log(`✅ Found ${tournaments.length} tournaments`);
    
    // Show first tournament as sample
    if (tournaments.length > 0) {
      console.log('📝 Sample tournament:', JSON.stringify(tournaments[0], null, 2));
    }
    
    // Save to Supabase
    if (tournaments.length > 0) {
      console.log('💾 Saving to database...');
      const { data, error } = await supabase
        .from('tournaments')
        .upsert(tournaments, { onConflict: 'name,start_date' });
      
      if (error) {
        console.error('❌ Error saving to database:', error);
      } else {
        console.log(`✅ Saved ${tournaments.length} tournaments to database`);
      }
    } else {
      console.log('⚠️  No tournaments found. The page structure may have changed.');
      console.log('💡 Saving raw HTML to debug.html for inspection...');
      const fs = require('fs');
      fs.writeFileSync('debug.html', response.data);
      console.log('✅ Saved debug.html - open it to see the page structure');
    }
    
    return tournaments;
    
  } catch (error) {
    console.error('❌ Scraping error:', error.message);
    throw error;
  }
}

// Run the scraper
if (require.main === module) {
  scrapeUSSSATournaments()
    .then(() => {
      console.log('✅ Scraping complete!');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Scraping failed:', error);
      process.exit(1);
    });
}

module.exports = { scrapeUSSSATournaments };