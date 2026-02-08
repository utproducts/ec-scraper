require('dotenv').config();
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function scrapeFlBaseballEvents() {
  console.log('🕷️  Starting Florida Baseball USSSA scrape...');
  
  let browser;
  try {
    console.log('🌐 Launching browser...');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    const allTournaments = [];
    let currentPage = 1;
    const maxPages = 13; // We saw 13 pages
    
    while (currentPage <= maxPages) {
      const url = currentPage === 1 
        ? 'https://flbaseball.usssa.com/events/'
        : `https://flbaseball.usssa.com/events/page/${currentPage}/`;
      
      console.log(`📡 Scraping page ${currentPage}/${maxPages}: ${url}`);
      
      await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 60000 
      });
      
      // Wait for events to load
// Just wait for the page to settle instead of specific selector
await new Promise(resolve => setTimeout(resolve, 3000));
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Extract tournament data from this page
      const tournaments = await page.evaluate(() => {
        const results = [];
        
        // Find all event cards
        const eventCards = document.querySelectorAll('.event-card, .event-item, [class*="event-"]');
        
        eventCards.forEach(card => {
          try {
            // Extract event name
            const nameElement = card.querySelector('h3, h2, .event-name, [class*="title"]');
            const name = nameElement?.textContent?.trim();
            
            if (!name || name.length < 3) return;
            
            // Extract dates
            const dateText = card.textContent;
            const dateMatch = dateText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}-?\d*\s*-?\s*\d*/i);
            const dates = dateMatch ? dateMatch[0] : '';
            
            // Extract pricing
            const priceMatch = dateText.match(/\$(\d+)\s*-?\s*\$?(\d+)?/);
            const pricing = priceMatch ? priceMatch[0] : '';
            
            // Extract age groups
            const ageMatch = dateText.match(/(\d+U)\s*-\s*(\d+U)/);
            const ageGroups = ageMatch ? ageMatch[0] : '';
            
            // Extract location
            const locationMatch = dateText.match(/([A-Z][a-z\s]+),\s*FL/);
            const location = locationMatch ? locationMatch[0] : '';
            
            // Extract director
            const lines = card.textContent.split('\n').map(l => l.trim()).filter(l => l);
            const director = lines.find(l => 
              l.match(/^[A-Z][a-z]+\s+[A-Z][a-z]+$/) && 
              !l.includes('Event Details')
            ) || '';
            
            // Extract teams count
            const teamsMatch = dateText.match(/👥\s*(\d+)|(\d+)\s*teams?/i);
            const teamsCount = teamsMatch ? parseInt(teamsMatch[1] || teamsMatch[2]) : 0;
            
            // Extract event details link
            const detailsLink = card.querySelector('a[href*="event"]')?.getAttribute('href');
            
            results.push({
              name: name,
              dates: dates,
              pricing: pricing,
              age_groups: ageGroups,
              location: location,
              director: director,
              teams_count: teamsCount,
              details_url: detailsLink ? (detailsLink.startsWith('http') ? detailsLink : `https://flbaseball.usssa.com${detailsLink}`) : null,
              source: 'flbaseball.usssa.com',
              scraped_at: new Date().toISOString()
            });
          } catch (err) {
            console.error('Error parsing event card:', err);
          }
        });
        
        return results;
      });
      
      console.log(`✅ Found ${tournaments.length} events on page ${currentPage}`);
      allTournaments.push(...tournaments);
      
      currentPage++;
      
      // Be nice to the server
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log(`\n🎉 Total tournaments scraped: ${allTournaments.length}`);
    
    // Show sample
    if (allTournaments.length > 0) {
      console.log('\n📝 Sample tournament:');
      console.log(JSON.stringify(allTournaments[0], null, 2));
    }
    
    // Save to Supabase
    if (allTournaments.length > 0) {
      console.log('\n💾 Saving to database...');
      
      // Delete old tournaments from this source
      await supabase.from('tournaments').delete().eq('source', 'flbaseball.usssa.com');
      
      // Insert new tournaments in batches of 100
      const batchSize = 100;
      for (let i = 0; i < allTournaments.length; i += batchSize) {
        const batch = allTournaments.slice(i, i + batchSize);
        const { error } = await supabase.from('tournaments').insert(batch);
        
        if (error) {
          console.error(`❌ Error saving batch ${i / batchSize + 1}:`, error);
        } else {
          console.log(`✅ Saved batch ${i / batchSize + 1} (${batch.length} tournaments)`);
        }
      }
      
      console.log(`\n✅ Successfully saved ${allTournaments.length} tournaments to database!`);
    }
    
    await browser.close();
    return allTournaments;
    
  } catch (error) {
    console.error('❌ Scraping error:', error.message);
    if (browser) await browser.close();
    throw error;
  }
}

if (require.main === module) {
  scrapeFlBaseballEvents()
    .then(() => {
      console.log('\n🎉 Scraping complete!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Scraping failed:', error);
      process.exit(1);
    });
}

module.exports = { scrapeFlBaseballEvents };