require('dotenv').config();
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function scrapeUSSSATournaments() {
  console.log('🕷️  Starting USSSA tournament scrape with Puppeteer...');
  
  let browser;
  try {
    console.log('🌐 Launching browser...');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    const searchUrl = 'https://www.usssa.com/baseball/eventSearch/?sportID=11&seasonID=30&region=1573&period=b';
    console.log('📡 Loading page:', searchUrl);
    
    await page.goto(searchUrl, { 
      waitUntil: 'networkidle0',
      timeout: 60000 
    });

    console.log('⏳ Waiting for page to settle...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('📸 Taking screenshot...');
    await page.screenshot({ path: 'usssa-final.png', fullPage: true });
    
    // Extract ALL text to see what's on the page
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('📄 Page contains:', pageText.substring(0, 500));
    
    // Try multiple selectors
    console.log('🔍 Looking for tournament data...');
    const tournaments = await page.evaluate(() => {
      const results = [];
      
      // Try different selectors
      const selectors = [
        'table tbody tr',
        '.event-row',
        '[class*="tournament"]',
        'tr[data-event]',
        '.table tr'
      ];
      
      let rows = [];
      for (const selector of selectors) {
        rows = document.querySelectorAll(selector);
        if (rows.length > 0) {
          console.log(`Found ${rows.length} rows with selector: ${selector}`);
          break;
        }
      }
      
      rows.forEach(row => {
        const allText = row.textContent || '';
        
        // Look for event links
        const links = row.querySelectorAll('a');
        links.forEach(link => {
          const text = link.textContent?.trim();
          if (text && text.length > 5 && !text.toLowerCase().includes('detail')) {
            results.push({
              name: text,
              raw_text: allText.substring(0, 200),
              source: 'usssa.com',
              scraped_at: new Date().toISOString()
            });
          }
        });
      });
      
      return results;
    });
    
    console.log(`✅ Found ${tournaments.length} potential tournaments`);
    
    if (tournaments.length > 0) {
      console.log('📝 Sample:', JSON.stringify(tournaments[0], null, 2));
    }
    
    await browser.close();
    return tournaments;
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (browser) await browser.close();
    throw error;
  }
}

if (require.main === module) {
  scrapeUSSSATournaments()
    .then(() => {
      console.log('✅ Done!');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Failed:', error);
      process.exit(1);
    });
}

module.exports = { scrapeUSSSATournaments };