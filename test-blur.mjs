import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new',args:['--no-sandbox'],userDataDir:'./gc-browser-data'});
const p = await b.newPage();
await p.goto('https://web.gc.com/teams/D4CK5E1BGDsq/2026-spring-ballplex-academy-11u/schedule/31ade338-9c1f-47ad-861f-96974879da69/box-score',{waitUntil:'networkidle2',timeout:30000});
await new Promise(r=>setTimeout(r,5000));
const blurred = await p.evaluate(()=>document.querySelector('[class*=blur]') ? true : false);
console.log('Blurred stats:', blurred);
await b.close();
