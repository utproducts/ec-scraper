// geocode-tournaments.js
// Adds lat/lng coordinates to tournaments using free OpenStreetMap Nominatim API
// Rate limit: 1 request per second (Nominatim policy)

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Cache so we don't re-geocode the same location
const geocodeCache = {};

async function geocode(location) {
  // Check cache first
  if (geocodeCache[location]) {
    return geocodeCache[location];
  }

  // Clean up location string for better results
  let searchQuery = location.trim();
  
  // Add "Florida" if not already there for better results
  if (!searchQuery.toLowerCase().includes('florida') && searchQuery.toLowerCase().includes(', fl')) {
    searchQuery = searchQuery.replace(/, fl$/i, ', Florida, USA');
  } else if (!searchQuery.toLowerCase().includes('florida') && !searchQuery.toLowerCase().includes(', fl')) {
    searchQuery += ', Florida, USA';
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery)}&format=json&limit=1&countrycodes=us`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'USSSA-Tournament-Geocoder/1.0 (tournament lookup tool)'
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const results = await response.json();
    
    if (results.length > 0) {
      const coords = {
        lat: parseFloat(results[0].lat),
        lng: parseFloat(results[0].lon)
      };
      geocodeCache[location] = coords;
      return coords;
    }
    
    return null;
  } catch (err) {
    console.error(`    Geocode error: ${err.message}`);
    return null;
  }
}

async function geocodeTournaments() {
  console.log('📍 Starting tournament geocoding...\n');

  // Get all unique locations
  const { data: tournaments, error } = await supabase
    .from('tournaments')
    .select('id, name, location')
    .is('latitude', null)
    .not('location', 'is', null)
    .order('location');

  if (error) {
    console.error('❌ Error fetching tournaments:', error);
    return;
  }

  console.log(`📋 Found ${tournaments.length} tournaments needing coordinates\n`);

  // Group by location to minimize API calls
  const locationGroups = {};
  for (const t of tournaments) {
    const loc = t.location.trim();
    if (!locationGroups[loc]) locationGroups[loc] = [];
    locationGroups[loc].push(t);
  }

  const uniqueLocations = Object.keys(locationGroups);
  console.log(`🗺️  ${uniqueLocations.length} unique locations to geocode\n`);

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < uniqueLocations.length; i++) {
    const location = uniqueLocations[i];
    const tournamentsAtLocation = locationGroups[location];

    process.stdout.write(`  [${i + 1}/${uniqueLocations.length}] ${location.padEnd(45)} `);

    const coords = await geocode(location);

    if (coords) {
      // Update all tournaments at this location
      const ids = tournamentsAtLocation.map(t => t.id);
      
      const { error: updateError } = await supabase
        .from('tournaments')
        .update({ latitude: coords.lat, longitude: coords.lng })
        .in('id', ids);

      if (updateError) {
        console.log(`❌ DB error`);
        failed += tournamentsAtLocation.length;
      } else {
        console.log(`✅ ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)} (${tournamentsAtLocation.length} tournaments)`);
        updated += tournamentsAtLocation.length;
      }
    } else {
      console.log(`⚠️  Not found`);
      failed += tournamentsAtLocation.length;
    }

    // Nominatim requires 1 second between requests
    await new Promise(r => setTimeout(r, 1100));
  }

  console.log(`\n📊 Results:`);
  console.log(`  ✅ Updated: ${updated} tournaments`);
  console.log(`  ⚠️  Failed: ${failed} tournaments`);
  console.log(`\n🎉 Done!`);
}

geocodeTournaments();