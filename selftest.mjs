/* Node harness. Extracts the core from the HTML between sentinels and
   evaluates it in a bare context, so one file stays one file and still gets
   headless testing. */
import { readFileSync } from 'node:fs';
const file = process.argv[2] || 'edge-board.html';
const html = readFileSync(file, 'utf8');

const core = html.split('/*==VB-CORE-BEGIN==*/')[1].split('/*==VB-CORE-END==*/')[0];
const tail = html.split('/*==VB-CORE-END==*/')[1].split('</script>')[0];
// Keep only VB.selftest from the app layer; view modules are DOM-bound.
const stStart = tail.indexOf('VB.selftest = (function');
const stEnd = tail.indexOf('/* ------------------------------------------------------------- router */');
const stSrc = tail.slice(stStart, stEnd);

const VB = new Function(`var VB = {};\n${core}\n${stSrc}\nreturn VB;`)();
const res = VB.selftest.run();
const pass = res.filter(r => r.pass).length;

console.log('=== Edge Board self-test (node, same V8 as Chrome) ===\n');
for (const r of res) {
  console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '\n          → ' + r.detail : ''));
}
console.log(`\n  ${pass}/${res.length} passing`);

// Static lints
const lints = [];
const mathSrc = {};
for (const name of ['VB.odds','VB.devig','VB.consensus','VB.stake','VB.arb','VB.multiplicity','VB.score']) {
  const i = core.indexOf(name + ' = (function');
  if (i < 0) continue;
  const j = core.indexOf('\n})();', i);
  mathSrc[name] = core.slice(i, j);
}
for (const banned of ['document','window','VB.store','VB.dom','VB.charts','VB.views','VB.router']) {
  const hits = Object.keys(mathSrc).filter(m => mathSrc[m].includes(banned));
  if (hits.length) lints.push(`math module references ${banned}: ${hits.join(', ')}`);
}
if (html.includes('type="module"')) lints.push('type="module" present — imports fail from file://');
if (/(?:src|href)="https?:/.test(html)) lints.push('external resource — breaks the offline guarantee');
if (html.includes('new Worker')) lints.push('new Worker — blocked from an opaque file:// origin in Chrome');
if (/Math\.random\s*\(/.test(core)) lints.push('Math.random in core — breaks determinism');
if (html.includes('debugger')) lints.push('debugger statement');
// Every module under src/ that defines a VB.* namespace MUST be present in the
// built file. This lint exists because 91-adapters and 92-live were written,
// unit-tested in isolation, and silently left out of the build list -- so the
// live-data buttons threw on click while every test passed.
{
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync('src').filter(x => x.endsWith('.js'))) {
    const src = readFileSync('src/' + f, 'utf8');
    const m = src.match(/^VB\.([A-Za-z0-9_]+)\s*=/m);
    if (!m) continue;
    const ns = 'VB.' + m[1] + ' =';
    if (!html.includes(ns)) lints.push(`src/${f} defines ${ns.trim()} but is NOT in the built file`);
  }
}
const bytes = Buffer.byteLength(html);
if (bytes > 400 * 1024) lints.push(`file is ${(bytes/1024).toFixed(0)}KB, over the 400KB budget`);

// The suite above only exercises the CORE. A syntax error or an early throw
// anywhere in the VIEW layer breaks the entire app and used to pass 29/29 with
// a blank white page. So: parse every shipped script region, and require a
// real browser boot to reach data-vb-boot="ok" when one is available.
{
  const tail = html.split('/*==VB-CORE-END==*/')[1].split('</script>')[0];
  try { new Function(tail); } catch (e) { lints.push('VIEW LAYER does not parse: ' + e.message); }
  try { new Function(core); } catch (e) { lints.push('CORE does not parse: ' + e.message); }
}
{
  const { execFileSync, existsSync } = await import('node:child_process').then(async m => ({
    execFileSync: m.execFileSync, existsSync: (await import('node:fs')).existsSync }));
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(chrome)) {
    try {
      const dom = execFileSync(chrome, ['--headless=new','--disable-gpu','--no-sandbox',
        '--virtual-time-budget=15000','--dump-dom',
        'file://' + process.cwd() + '/' + file + '#/board/all?preset=1'],
        { encoding:'utf8', stdio:['ignore','pipe','ignore'], timeout:60000 });
      const m = dom.match(/data-vb-boot="([a-z]+)"/);
      const state = m ? m[1] : 'missing';
      if (state !== 'ok') {
        const be = dom.match(/<div id="boot">([\s\S]*?)<\/div>/);
        lints.push('BROWSER BOOT = "' + state + '"' + (be ? ': ' + be[1].trim().slice(0,180) : ''));
      } else {
        console.log('\n  browser boot: ok (headless Chrome reached data-vb-boot="ok")');
      }
    } catch (e) { console.log('\n  browser boot: skipped (' + String(e.message).slice(0,60) + ')'); }
  } else { console.log('\n  browser boot: skipped (no Chrome binary)'); }
}

console.log('\n=== Static lints ===');
if (!lints.length) console.log('  all lints clean');
else for (const l of lints) console.log('  FAIL  ' + l);
console.log(`  file size ${(bytes/1024).toFixed(1)}KB (budget 400KB, warn 300KB)`);

process.exit(pass === res.length && !lints.length ? 0 : 1);
