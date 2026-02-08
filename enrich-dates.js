// enrich-dates.js
// Visits each tournament's detail page and extracts the actual dates
// Then updates the tournaments table in Supabase

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

function extractDate(html) {
  // Look for "Tournament Date" followed by the date text
  // Pattern on detail pages: "Tournament Date\n  Feb 15 - Feb 16 2025"
  
  // Try multiple patterns
  const patterns = [
    // Pattern 1: "Tournament Date" ... date text
    /Tournament Date\s*(?:<[^>]*>\s*)*([A-Z][a-z]{2}\s+\d{1,2}\s*-\s*[A-Z][a-z]{2}\s+\d{1,2}\s*,?\s*\d{4})/i,
    // Pattern 2: "Tournament Date" ... single month range with year
    /Tournament Date\s*(?:<[^>]*>\s*)*([A-Z][a-z]{2}\s+\d{1,2}\s*-\s*\d{1,2}\s*,?\s*\d{4})/i,
    // Pattern 3: Full date format like "02/15/2025 to 02/16/2025"
    /held from\s+(\d{2}\/\d{2}\/\d{4})\s+to\s+(\d{2}\/\d{2}\/\d{4})/i,
    // Pattern 4: "will be held from MM/DD/YYYY to MM/DD/YYYY" in meta/description
    /(\d{2}\/\d{2}\/\d{4})\s+to\s+(\d{2}\/\d{2}\/\d{4})/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      if (match[2]) {
        // Pattern with start and end dates (MM/DD/YYYY format)
        return formatMMDDYYYY(match[1], match[2]);
      }
      return match[1].trim();
    }
  }

  // Try the meta description approach: "will be held from 02/15/2025 to 02/16/2025"
  const metaMatch = html.match(/will be held from (\d{2})\/(\d{2})\/(\d{4}) to (\d{2})\/(\d{2})\/(\d{4})/);
  if (metaMatch) {
    const startMonth = getMonthName(parseInt(metaMatch[1]));
    const startDay = parseInt(metaMatch[2]);
    const endMonth = getMonthName(parseInt(metaMatch[4]));
    const endDay = parseInt(metaMatch[5]);
    const year = metaMatch[3];
    
    if (startMonth === endMonth) {
      return `${startMonth} ${startDay}-${endDay}, ${year}`;
    }
    return `${startMonth} ${startDay} - ${endMonth} ${endDay}, ${year}`;
  }

  return null;
}

function getMonthName(num) {
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[num] || '';
}

function formatMMDDYYYY(start, end) {
  const [sm, sd, sy] = start.split('/');
  const [em, ed, ey] = end.split('/');
  const startMonth = getMonthName(parseInt(sm));
  const endMonth = getMonthName(parseInt(em));
  
  if (startMonth === endMonth) {
    return `${startMonth} ${parseInt(sd)}-${parseInt(ed)}, ${sy}`;
  }
  return `${startMonth} ${parseInt(sd)} - ${endMonth} ${parseInt(ed)}, ${sy}`;
}

async function enrichDates() {
  console.log('🗓️  Starting tournament date enrichment...\n');

  // Get all tournaments with detail URLs
  const { data: tournaments, error } = await supabase
    .from('tournaments')
    .select('id, name, dates, details_url')
    .not('details_url', 'is', null)
    .order('name');

  if (error) {
    console.error('❌ Error fetching tournaments:', error);
    return;
  }

  console.log(`📋 Found ${tournaments.length} tournaments with detail URLs\n`);

  let updated = 0;
  let failed = 0;
  let skipped = 0;
  let alreadyHasDates = 0;

  for (let i = 0; i < tournaments.length; i++) {
    const t = tournaments[i];
    
    // Skip if already has a good date (contains a year)
    if (t.dates && /\d{4}/.test(t.dates)) {
      alreadyHasDates++;
      continue;
    }

    if (!t.details_url) {
      skipped++;
      continue;
    }

    try {
      process.stdout.write(`  [${i + 1}/${tournaments.length}] ${t.name.substring(0, 50).padEnd(50)} `);
      
      const html = await fetchWithRetry(t.details_url);
      const dateStr = extractDate(html);

      if (dateStr) {
        const { error: updateError } = await supabase
          .from('tournaments')
          .update({ dates: dateStr })
          .eq('id', t.id);

        if (updateError) {
          console.log(`❌ DB error`);
          failed++;
        } else {
          console.log(`✅ ${dateStr}`);
          updated++;
        }
      } else {
        console.log(`⚠️  No date found`);
        failed++;
      }

      // Rate limit - be nice to the server
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      console.log(`❌ ${err.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Results:`);
  console.log(`  ✅ Updated: ${updated}`);
  console.log(`  ⏭️  Already had dates: ${alreadyHasDates}`);
  console.log(`  ⚠️  Failed/no date: ${failed}`);
  console.log(`  ⏩ Skipped (no URL): ${skipped}`);
  console.log(`\n🎉 Done!`);
}

enrichDates();