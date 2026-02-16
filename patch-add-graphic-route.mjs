/**
 * Add /ec/all-tournament route to serve the graphic page
 * Usage: node patch-add-graphic-route.mjs
 */
import fs from 'fs';

// 1. Copy the graphic HTML to the frontend folder
fs.copyFileSync('all-tournament-graphic.html', 'frontend/all-tournament.html');
console.log('✅ Copied all-tournament-graphic.html to frontend/all-tournament.html');

// 2. Add route to server.js
const file = 'server.js';
let code = fs.readFileSync(file, 'utf-8');

// Find where the /ec route is served and add the graphic route
const ecRoute = "app.get('/ec'";
const ecIdx = code.indexOf(ecRoute);

if (ecIdx !== -1) {
  const graphicRoute = `
// All-Tournament Team shareable graphic
app.get('/ec/all-tournament', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'all-tournament.html'));
});

`;
  code = code.substring(0, ecIdx) + graphicRoute + code.substring(ecIdx);
  fs.writeFileSync(file, code);
  console.log('✅ Added /ec/all-tournament route');
} else {
  console.log('⚠️  Could not find /ec route, adding at end...');
  // Try to add before the last app.listen or similar
  const listenIdx = code.lastIndexOf('app.listen');
  if (listenIdx !== -1) {
    const graphicRoute = `
// All-Tournament Team shareable graphic
app.get('/ec/all-tournament', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'all-tournament.html'));
});

`;
    code = code.substring(0, listenIdx) + graphicRoute + code.substring(listenIdx);
    fs.writeFileSync(file, code);
    console.log('✅ Added /ec/all-tournament route before app.listen');
  }
}

console.log('\nDone! The graphic page will be at:');
console.log('  https://unrivaled-connect-backend.onrender.com/ec/all-tournament');
console.log('  https://unrivaled-connect-backend.onrender.com/ec/all-tournament?age=11U');
