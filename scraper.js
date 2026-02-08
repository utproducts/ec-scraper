// scraper.js
// Crawls a director's website and saves content to the knowledge_base table
// Usage: node scraper.js <website_url> [director_id]

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const WEBSITE_URL = process.argv[2];
const DIRECTOR_ID = process.argv[3] || null;

if (!WEBSITE_URL) {
  console.error('Usage: node scraper.js <website_url> [director_id]');
  process.exit(1);
}

// Parse the base domain from URL
function getBaseDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return url;
  }
}

// Clean HTML to plain text
function htmlToText(html) {
  return html
    // Remove script and style tags and their content
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    // Remove HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    // Clean up whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract title from HTML
function extractTitle(html) {
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  if (titleMatch) return htmlToText(titleMatch[1]).substring(0, 200);
  
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
  if (h1Match) return htmlToText(h1Match[1]).substring(0, 200);
  
  return 'Untitled Page';
}

// Extract main content from HTML (skip nav, footer, etc.)
function extractContent(html) {
  // Try to find main content area
  let content = html;
  
  // Try common main content selectors
  const mainMatch = html.match(/<main[\s\S]*?<\/main>/i) ||
                    html.match(/<article[\s\S]*?<\/article>/i) ||
                    html.match(/<div[^>]*class="[^"]*content[^"]*"[\s\S]*?<\/div>/i) ||
                    html.match(/<div[^>]*id="[^"]*content[^"]*"[\s\S]*?<\/div>/i);
  
  if (mainMatch) {
    content = mainMatch[0];
  }
  
  return htmlToText(content);
}

// Categorize content based on keywords
function categorizeContent(title, content) {
  const combined = (title + ' ' + content).toLowerCase();
  
  if (combined.includes('rule') || combined.includes('regulation') || combined.includes('ejection') || combined.includes('illegal')) {
    return 'rules';
  }
  if (combined.includes('faq') || combined.includes('frequently asked') || combined.includes('question')) {
    return 'faq';
  }
  if (combined.includes('policy') || combined.includes('refund') || combined.includes('cancel') || combined.includes('rain') || combined.includes('weather')) {
    return 'policy';
  }
  if (combined.includes('register') || combined.includes('signup') || combined.includes('sign up') || combined.includes('how to')) {
    return 'registration';
  }
  if (combined.includes('tournament') || combined.includes('event') || combined.includes('schedule') || combined.includes('bracket')) {
    return 'tournament';
  }
  if (combined.includes('contact') || combined.includes('phone') || combined.includes('email') || combined.includes('address')) {
    return 'contact';
  }
  if (combined.includes('about') || combined.includes('mission') || combined.includes('history') || combined.includes('who we are')) {
    return 'about';
  }
  if (combined.includes('price') || combined.includes('cost') || combined.includes('fee') || combined.includes('pay')) {
    return 'pricing';
  }
  return 'info';
}

// Find all internal links on a page
function findLinks(html, baseDomain) {
  const links = new Set();
  const linkRegex = /href=["'](.*?)["']/gi;
  let match;
  
  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1];
    
    // Skip anchors, mailto, tel, javascript, external links
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || 
        href.startsWith('javascript:') || href.startsWith('data:')) continue;
    
    // Skip file downloads
    if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|doc|docx|xls|xlsx|mp4|mp3)$/i.test(href)) continue;
    
    // Convert relative URLs to absolute
    if (href.startsWith('/')) {
      href = baseDomain + href;
    } else if (!href.startsWith('http')) {
      href = baseDomain + '/' + href;
    }
    
    // Only include links from the same domain
    try {
      const linkDomain = new URL(href).origin;
      if (linkDomain === baseDomain) {
        // Clean up the URL (remove fragments, trailing slashes)
        const cleanUrl = href.split('#')[0].replace(/\/$/, '');
        links.add(cleanUrl);
      }
    } catch {
      // Invalid URL, skip
    }
  }
  
  return [...links];
}

// Fetch a page with retry
async function fetchPage(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000)
      });
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) return null;
      
      return await response.text();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// Main scraper
async function scrapeWebsite(startUrl) {
  const baseDomain = getBaseDomain(startUrl);
  console.log(`\n🌐 Scraping website: ${startUrl}`);
  console.log(`📍 Base domain: ${baseDomain}\n`);
  
  const visited = new Set();
  const toVisit = [startUrl.replace(/\/$/, '')];
  const pages = [];
  const MAX_PAGES = 50; // Safety limit
  
  while (toVisit.length > 0 && visited.size < MAX_PAGES) {
    const url = toVisit.shift();
    
    // Skip if already visited
    const cleanUrl = url.split('#')[0].replace(/\/$/, '');
    if (visited.has(cleanUrl)) continue;
    visited.add(cleanUrl);
    
    try {
      process.stdout.write(`  [${visited.size}/${MAX_PAGES}] ${cleanUrl.substring(0, 70).padEnd(70)} `);
      
      const html = await fetchPage(cleanUrl);
      if (!html) {
        console.log('⏭️  Not HTML');
        continue;
      }
      
      const title = extractTitle(html);
      const content = extractContent(html);
      
      // Skip pages with very little content
      if (content.length < 100) {
        console.log('⏭️  Too short');
        continue;
      }
      
      const category = categorizeContent(title, content);
      
      pages.push({
        url: cleanUrl,
        title: title,
        content: content.substring(0, 5000), // Cap at 5000 chars per page
        category: category
      });
      
      console.log(`✅ ${category} (${content.length} chars)`);
      
      // Find and queue new links
      const links = findLinks(html, baseDomain);
      for (const link of links) {
        const cleanLink = link.split('#')[0].replace(/\/$/, '');
        if (!visited.has(cleanLink) && !toVisit.includes(cleanLink)) {
          toVisit.push(cleanLink);
        }
      }
      
      // Be polite - 500ms between requests
      await new Promise(r => setTimeout(r, 500));
      
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
  }
  
  console.log(`\n📊 Scraping complete!`);
  console.log(`  ✅ Pages scraped: ${pages.length}`);
  console.log(`  📄 Total visited: ${visited.size}`);
  console.log(`  📋 Queue remaining: ${toVisit.length}\n`);
  
  return pages;
}

// Save scraped content to Supabase knowledge_base
async function saveToKnowledgeBase(pages, directorId) {
  console.log('💾 Saving to knowledge_base...\n');
  
  // If director_id provided, clear their existing scraped content first
  if (directorId) {
    const { error: deleteError } = await supabase
      .from('knowledge_base')
      .delete()
      .eq('director_id', directorId)
      .eq('source', 'scraper');
    
    if (deleteError) console.log('  ⚠️  Could not clear old content:', deleteError.message);
    else console.log('  🗑️  Cleared old scraped content');
  }
  
  let saved = 0;
  let failed = 0;
  
  for (const page of pages) {
    const record = {
      title: page.title,
      content: page.content,
      category: page.category,
      source_url: page.url,
      source: 'scraper'
    };
    
    if (directorId) record.director_id = directorId;
    
    const { error } = await supabase
      .from('knowledge_base')
      .insert(record);
    
    if (error) {
      console.log(`  ❌ Failed: ${page.title.substring(0, 50)} - ${error.message}`);
      failed++;
    } else {
      console.log(`  ✅ Saved: [${page.category}] ${page.title.substring(0, 60)}`);
      saved++;
    }
  }
  
  console.log(`\n🎉 Done!`);
  console.log(`  ✅ Saved: ${saved} pages`);
  console.log(`  ❌ Failed: ${failed} pages\n`);
  
  return { saved, failed };
}

// Run it
async function main() {
  try {
    const pages = await scrapeWebsite(WEBSITE_URL);
    
    if (pages.length === 0) {
      console.log('❌ No pages scraped. Check the URL and try again.');
      return;
    }
    
    // Show summary by category
    const categories = {};
    for (const p of pages) {
      categories[p.category] = (categories[p.category] || 0) + 1;
    }
    console.log('📁 Content by category:');
    for (const [cat, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat}: ${count} pages`);
    }
    console.log('');
    
    await saveToKnowledgeBase(pages, DIRECTOR_ID);
    
  } catch (err) {
    console.error('❌ Scraper error:', err.message);
  }
}

main();