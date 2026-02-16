import puppeteer from 'puppeteer';

function parseBatting(tableText) {
  const lines = tableText.split('\n').map(l => l.trim()).filter(l => l);
  const players = [];
  let i = 0;
  const headers = new Set(['LINEUP', 'AB', 'R', 'H', 'RBI', 'BB', 'SO']);
  while (i < lines.length && headers.has(lines[i])) i++;
  while (i < lines.length) {
    if (lines[i] === 'TEAM') break;
    const name = lines[i]; i++;
    if (i >= lines.length) break;
    let jersey = '', pos = '';
    const nextLine = lines[i];
    if (nextLine.startsWith('#')) {
      const jMatch = nextLine.match(/^#(\d+)\s*(?:\(([^)]+)\))?/);
      if (jMatch) { jersey = jMatch[1]; pos = jMatch[2] || ''; }
      i++;
    } else if (nextLine.startsWith('(')) {
      const pMatch = nextLine.match(/^\(([^)]+)\)/);
      if (pMatch) pos = pMatch[1];
      i++;
    } else if (!isNaN(parseInt(nextLine))) {
    } else { i++; }
    if (i + 5 < lines.length && !isNaN(parseInt(lines[i]))) {
      players.push({ name, jersey, pos,
        ab: parseInt(lines[i]) || 0, r: parseInt(lines[i+1]) || 0,
        h: parseInt(lines[i+2]) || 0, rbi: parseInt(lines[i+3]) || 0,
        bb: parseInt(lines[i+4]) || 0, so: parseInt(lines[i+5]) || 0,
      });
      i += 6;
    } else { continue; }
  }
  return players;
}

const b = await puppeteer.launch({headless:'new',args:['--no-sandbox'],userDataDir:'./gc-browser-data'});
const p = await b.newPage();

// Find PB PRIME's schedule and get their version of this game
await p.goto('https://web.gc.com/teams/RNZWvqcbYACe/schedule',{waitUntil:'networkidle2',timeout:30000});
await new Promise(r=>setTimeout(r,3000));

// Get all game links
const links = await p.evaluate(() => {
  return [...document.querySelectorAll('a')].filter(a => a.href.includes('/box-score')).map(a => a.href);
});
console.log('PB PRIME game links:', links.length);
links.forEach(l => console.log('  ', l));

// Find the Ballplex game
const bpGame = links.find(l => true);  // just get first game for now
if (bpGame) {
  await p.goto(bpGame, {waitUntil:'networkidle2',timeout:30000});
  await new Promise(r=>setTimeout(r,5000));
  const tables = await p.evaluate(()=>[...document.querySelectorAll('[data-testid="data-table"]')].map(t=>t.innerText));
  const teamNames = await p.evaluate(()=>[...document.querySelectorAll('[data-testid="data-table"]')].map(t=>{
    const prev = t.previousElementSibling;
    return prev ? prev.innerText : 'unknown';
  }));
  console.log('\nTeam labels:', teamNames);
  console.log('\n=== TABLE 0 (first team batting) ===');
  const t0 = parseBatting(tables[0]);
  t0.forEach(p => console.log(p.name, '#'+p.jersey, 'AB:'+p.ab, 'R:'+p.r, 'H:'+p.h, 'RBI:'+p.rbi));
  console.log('\n=== TABLE 2 (second team batting) ===');
  const t2 = parseBatting(tables[2]);
  t2.forEach(p => console.log(p.name, '#'+p.jersey, 'AB:'+p.ab, 'R:'+p.r, 'H:'+p.h, 'RBI:'+p.rbi));
}

await b.close();
