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
await p.goto('https://web.gc.com/teams/D4CK5E1BGDsq/2026-spring-ballplex-academy-11u/schedule/31ade338-9c1f-47ad-861f-96974879da69/box-score',{waitUntil:'networkidle2',timeout:30000});
await new Promise(r=>setTimeout(r,5000));
const tables = await p.evaluate(()=>[...document.querySelectorAll('[data-testid="data-table"]')].map(t=>t.innerText));
console.log('=== PARSED AWAY BATTING ===');
const away = parseBatting(tables[0]);
away.forEach(p => console.log(p.name, '#'+p.jersey, 'AB:'+p.ab, 'R:'+p.r, 'H:'+p.h, 'RBI:'+p.rbi));
console.log('\n=== PARSED HOME BATTING ===');
const home = parseBatting(tables[2]);
home.forEach(p => console.log(p.name, '#'+p.jersey, 'AB:'+p.ab, 'R:'+p.r, 'H:'+p.h, 'RBI:'+p.rbi));
await b.close();
