import fs from 'fs';
let code = fs.readFileSync('ec-polling-v2.mjs', 'utf-8');
code = code.replace('}\\n\\n// ─── SCRAPE A SINGLE GAME', '}\n\n// ─── SCRAPE A SINGLE GAME');
fs.writeFileSync('ec-polling-v2.mjs', code);
console.log('Fixed!');
