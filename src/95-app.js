/* ===================== L3/L4  store, router, view layer ================= */
VB.store = (function () {
  const KEY = { schema:'vb.schemaVersion', settings:'vb.settings', venues:'vb.venues',
                ui:'vb.ui', betlog:'vb.betlog', dataset:'vb.dataset', offspec:'vb.offspec',
                keys:'vb.keys' };
  const CURRENT = 1;

  /* RATIFIED DEFAULTS. Every one of these is a decision with a reason
     recorded in the build spec; loosening any of them is tracked. */
  const DEFAULTS = {
    bankroll: null, unitUsd: null,      /* null until the first-run modal */
    lambda: 0.25, R: 0.35,
    minEVPct: 0.020, minEdgePP: 0.010, minT: 2.0,
    minClusters: 3, requireTier1: true,
    /* 60, not 15. The Odds API is cached 15 minutes to protect a 500-credit
       month, so a 20-35 minute quote age is the NORMAL operating state on
       the free plan, not a fault. A 15-minute budget marked healthy prices
       as defective and buried real rows under an alarm. */
    maxAgeMin: 60,
    multiplicityAdjust: true,           /* no toggle. ever. */
    accessibleOnly: true, noColour: false,
    /* 'eu' buys the sharp reference (Pinnacle, Betfair, Matchbook) for 3
       credits; 'us,eu' adds retail books for 6 but DraftKings is already
       free via ESPN. */
    oddsRegions: 'eu',
    caps: { maxStakeUnits:2.0, maxStakePctBankroll:0.02, maxPerEventUnits:3.0,
            maxPerPlayerUnits:2.0, maxOpenUnits:10.0, maxDailyUnits:10.0 }
  };
  const RATIFIED = JSON.parse(JSON.stringify(DEFAULTS));

  let S = {
    schemaVersion: CURRENT,
    settings: JSON.parse(JSON.stringify(DEFAULTS)),
    venues: {}, ui: { route:'#/board/all', tab:'signal', sort:'t', dir:-1,
                      mode:'value', cat:'all', q:'', src:'all', layout:'games', expanded:null, firstRunSeen:false },
    betlog: [], offspec: [], dataset: { mode:'live', seed:VB.seed.MASTER },
    /* API key. Held in this browser's localStorage and sent in the query
       string, because a custom header would trigger a CORS preflight these
       endpoints do not answer from a file:// origin.
       IMPORTANT: seeding it here means the HTML file itself now contains a
       credential. Do not share or screen-share this file. Rotate at
       the-odds-api.com/account/ if it is ever exposed; clearing the field in
       Settings removes it from storage but NOT from this file. */
    /* Deliberately EMPTY in source. The key is a live credential and this
       repo is public-capable, so it is never committed. Paste it once in
       Settings -> Live data; it persists in this browser's localStorage
       under vb.keys and survives reloads. Rotate at
       the-odds-api.com/account/ if it is ever exposed. */
    keys: {},
    runtime: { storage:{local:false}, bootErrors:[], tests:null }
  };

  /* Persist only tiny identity state. Quotes are NEVER persisted: 80k rows
     serialize to ~2.7M chars and localStorage bills UTF-16, so that is
     ~5.4MB against a ~5MB ceiling -- confirmed overflow, not a tuning
     problem. The seed descriptor is 81 bytes and regenerates in ~13ms,
     which is faster than parsing the JSON would have been. */
  function probe() {
    try { localStorage.setItem('vb.__t','1'); localStorage.removeItem('vb.__t');
          S.runtime.storage.local = true; } catch (e) { S.runtime.storage.local = false; }
    return S.runtime.storage.local;
  }
  function safeSet(k, v) {
    if (!S.runtime.storage.local) return false;
    try { localStorage.setItem(k, v); return true; }
    catch (e) { S.runtime.storage.local = false; return false; }
  }
  function save() {
    safeSet(KEY.schema, String(CURRENT));
    safeSet(KEY.settings, JSON.stringify(S.settings));
    safeSet(KEY.ui, JSON.stringify({ mode:S.ui.mode, sort:S.ui.sort, dir:S.ui.dir,
                                     tab:S.ui.tab, src:S.ui.src, layout:S.ui.layout, firstRunSeen:S.ui.firstRunSeen }));
    safeSet(KEY.betlog, JSON.stringify(S.betlog));
    safeSet(KEY.offspec, JSON.stringify(S.offspec));
    safeSet(KEY.keys, JSON.stringify(S.keys || {}));
    safeSet(KEY.dataset, JSON.stringify(S.dataset));
    const acc = {}; for (const id in S.venues) acc[id] = !!S.venues[id].accessible;
    safeSet(KEY.venues, JSON.stringify(acc));
  }
  function load() {
    if (!probe()) return;
    const sv = Number(localStorage.getItem(KEY.schema) || 0);
    if (!sv) return;
    if (sv > CURRENT) { S.runtime.bootErrors.push('newer schema v' + sv + ' refused'); return; }
    try {
      const st = JSON.parse(localStorage.getItem(KEY.settings) || 'null');
      if (st) S.settings = Object.assign(S.settings, st);
      const ui = JSON.parse(localStorage.getItem(KEY.ui) || 'null');
      if (ui) Object.assign(S.ui, ui);
      S.betlog = JSON.parse(localStorage.getItem(KEY.betlog) || '[]');
      S.offspec = JSON.parse(localStorage.getItem(KEY.offspec) || '[]');
      const kk = JSON.parse(localStorage.getItem(KEY.keys) || 'null');
      if (kk && kk.oddsapi) S.keys = kk;
      const acc = JSON.parse(localStorage.getItem(KEY.venues) || '{}');
      S.__acc = acc;
    } catch (e) { S.runtime.bootErrors.push('settings unreadable, booted clean'); }
  }

  /* Loosening a ratified default is RECORDED. Nothing constrains the user
     from turning the gates down until rows appear, and that is the actual
     documented path from an honest app to a lost bankroll. */
  function loosenedGates() {
    const out = [];
    const cmp = [['minEVPct','min EV%',-1],['minEdgePP','min edge pp',-1],
                 ['minT','min t',-1],['minClusters','min clusters',-1],
                 ['maxAgeMin','max quote age',1],['lambda','risk level',1]];
    for (const [k, label, dir] of cmp) {
      const cur = S.settings[k], rat = RATIFIED[k];
      if (dir < 0 ? cur < rat : cur > rat) out.push({ key:k, label, from:rat, to:cur });
    }
    if (S.settings.requireTier1 === false) out.push({ key:'requireTier1', label:'sharp-venue requirement', from:true, to:false });
    if (S.settings.accessibleOnly === false) out.push({ key:'accessibleOnly', label:'accessible-only filter', from:true, to:false });
    return out;
  }
  const get = () => S;
  return { get, load, save, DEFAULTS, RATIFIED, CURRENT, KEY, loosenedGates, probe };
})();

/* ------------------------------------------------------------------- dom */
VB.dom = (function () {
  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k.slice(0, 5) === 'data-') el.setAttribute(k, v);
      else el.setAttribute(k, v);
    }
    if (kids) for (const c of [].concat(kids)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const t = (s) => document.createTextNode(String(s));
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  /* Signed numbers ALWAYS lead with an explicit +/- glyph, so sign never
     depends on hue. Required, not stylistic: the positive/negative colour
     pair fails colourblind separation. */
  function sgn(x, dp, suffix) {
    if (!isFinite(x)) return '--';
    const s = x >= 0 ? '+' : '−';
    return s + Math.abs(x).toFixed(dp === undefined ? 2 : dp) + (suffix || '');
  }
  const cls = (x) => (!isFinite(x) ? 'muted' : x > 0 ? 'pos' : x < 0 ? 'neg' : 'muted');
  const money = (x, dp) => '$' + (x === null || x === undefined || !isFinite(x)
    ? '--' : Number(x).toFixed(dp === undefined ? 0 : dp).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  function ago(sec) {
    if (!isFinite(sec)) return '--';
    if (sec < 60) return Math.round(sec) + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) return (sec / 3600).toFixed(1) + 'h';
    return Math.round(sec / 86400) + 'd';
  }
  function until(sec) {
    if (!isFinite(sec)) return 'OPEN';
    if (sec <= 0) return 'OFF';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h' + String(Math.floor(sec % 3600 / 60)).padStart(2, '0');
    return Math.floor(sec / 86400) + 'd ' + Math.floor(sec % 86400 / 3600) + 'h';
  }
  /* Four-state density glyph. Survives greyscale, print and CVD, which is
     why quality is encoded here and not in a row fill. */
  function glyph(r) {
    if (r.verdict === 'STALE') return '!░';
    if (r.verdict === 'SUSPECT') return '!!';
    if (r.verdict === 'BET') return (r.ep >= 0.04 && r.t >= 4) ? '██' : '▓▓';
    if (r.verdict === 'THIN' || r.verdict === 'LIMITED') return '░░';
    return '··';
  }
  /* VENUE CHIPS.
     Drawn INLINE from a brand table rather than referencing a sprite, for two
     reasons: a live book discovered from the feed will never be in a shipped
     sprite and must still get a chip, and the app must not render empty boxes
     if an asset is missing. Unknown venues get a deterministic hue from a hash
     of their id, so every book is visually distinguishable whether or not we
     have ever heard of it.
     These are brand COLOURS with a monogram, not logo artwork: reproducing a
     company's actual mark would need an external asset (which the offline
     guarantee forbids) and would be reproducing a trademark. */
  const BRAND = {
    pinnacle:['#0a2540','PIN','#fff'],      circa:['#b8102e','CIR','#fff'],
    betfair:['#ffb80c','BF','#111'],        kalshi:['#00d09c','KAL','#04231a'],
    polymarket:['#1652f0','POLY','#fff'],   smarkets:['#00b8d4','SMK','#04252b'],
    bet365:['#027b5b','365','#fff'],        draftkings:['#53d337','DK','#0b2408'],
    fanduel:['#1493ff','FD','#fff'],        betmgm:['#c5a572','MGM','#20180a'],
    caesars:['#0b6b3a','CZR','#fff'],       espnbet:['#d50a0a','ESPN','#fff'],
    betrivers:['#0a4d8c','BR','#fff'],      fanatics:['#1a1a1a','FAN','#fff'],
    novig:['#6c4df6','NOV','#fff'],         sporttrade:['#00a6a6','SPT','#04252b'],
    prophetx:['#7b2ff7','PX','#fff'],       betonline:['#c8102e','BOL','#fff'],
    bovada:['#e11b22','BOV','#fff']
  };
  function brandFor(venueId) {
    if (BRAND[venueId]) return BRAND[venueId];
    /* Deterministic fallback so an unrecognised live book is still legible
       and still distinct from its neighbours. */
    const hue = VB.util.cyrb53(String(venueId), 7) % 360;
    const mono = String(venueId).replace(/^live_/, '').replace(/[^a-zA-Z0-9]/g, '')
                   .slice(0, 3).toUpperCase() || '?';
    return ['hsl(' + hue + ' 42% 32%)', mono, '#fff'];
  }
  const NS = 'http://www.w3.org/2000/svg';
  /* Real logo when we have one, generated monogram when we do not. The
     fallback matters: books discovered live from a feed will never be in the
     shipped logo table, and a blank cell in a venue column is worse than a
     coloured initial. */
  function venueChip(venueId, px) {
    if (VB.logos && VB.logos.has(venueId)) {
      const img = document.createElement('img');
      img.className = 'vchip' + (px >= 24 ? ' vchip-lg' : '');
      img.src = VB.logos.DATA[venueId];
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.setAttribute('loading', 'eager');
      img.setAttribute('decoding', 'sync');
      return img;
    }
    const [bg, mono, fg] = brandFor(venueId);
    const el = document.createElementNS(NS, 'svg');
    el.setAttribute('class', 'vchip' + (px >= 24 ? ' vchip-lg' : ''));
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', mono);
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', 0); r.setAttribute('y', 0);
    r.setAttribute('width', 24); r.setAttribute('height', 24);
    r.setAttribute('rx', 5); r.setAttribute('fill', bg);
    el.appendChild(r);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', 12); t.setAttribute('y', 12.5);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'central');
    t.setAttribute('fill', fg);
    t.setAttribute('font-size', mono.length >= 4 ? 7.5 : mono.length === 3 ? 9 : 11);
    t.setAttribute('font-weight', '700');
    t.setAttribute('font-family', 'system-ui,-apple-system,sans-serif');
    t.textContent = mono;
    el.appendChild(t);
    return el;
  }
  const SPRITE = { sports:{} };
  function registerSprite() {}
  function sportIcon(catKey) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('class', 'sicon');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', '#s-' + catKey);
    el.appendChild(u);
    return el;
  }
  /* REAL TOOLTIPS.
     The native `title` attribute is not a tooltip: it waits 1-2 seconds, it
     renders in OS chrome you cannot style or wrap, it never fires on touch,
     and it is trivially missed. For a board whose column names are q_o and
     p_c and t, the definition has to appear the moment you point at it or it
     may as well not exist.
     One shared element, positioned on demand, clamped to the viewport, and
     driven by delegated listeners so it costs nothing per row. */
  let TIP = null;
  function ensureTip() {
    if (TIP) return TIP;
    TIP = document.createElement('div');
    TIP.id = 'vbtip';
    TIP.setAttribute('role', 'tooltip');
    document.body.appendChild(TIP);
    return TIP;
  }
  function showTip(el) {
    const txt = el.getAttribute('data-tip');
    if (!txt) return;
    const tip = ensureTip();
    tip.textContent = txt;
    tip.classList.add('on');
    const r = el.getBoundingClientRect();
    /* Measure after the text is in, or the width is stale on the first show. */
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = r.bottom + 8;
    /* Flip above if it would fall off the bottom. */
    if (top + th > window.innerHeight - 8) top = Math.max(8, r.top - th - 8);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function hideTip() { if (TIP) TIP.classList.remove('on'); }
  function initTips() {
    if (initTips.done) return;
    initTips.done = true;
    /* Delegated, so rows re-rendering never leaves a stale listener. */
    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (el) showTip(el);
    });
    document.addEventListener('mouseout', (e) => {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (el) hideTip();
    });
    /* Keyboard parity: a definition reachable only by mouse is not reachable. */
    document.addEventListener('focusin', (e) => {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (el) showTip(el);
    });
    document.addEventListener('focusout', hideTip);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
    window.addEventListener('scroll', hideTip, true);
  }
  return { h, t, clear, sgn, cls, money, ago, until, glyph,
           venueChip, sportIcon, registerSprite, SPRITE,
           initTips, showTip, hideTip };
})();

/* ---------------------------------------------------------------- charts */
VB.charts = (function () {
  const NS = 'http://www.w3.org/2000/svg';
  function svg(tag, a) {
    const e = document.createElementNS(NS, tag);
    for (const k in a) if (a[k] !== null && a[k] !== undefined) e.setAttribute(k, a[k]);
    return e;
  }
  /* 1. Line-movement sparkline. Two series, direct-labelled endpoints, no
        axes. Earns its place because line movement is the best available
        check that an edge is real rather than a stale quote. */
  function movement(series, w, hgt) {
    const W = w || 260, H = hgt || 54, pad = 3;
    const all = series.reduce((a, s) => a.concat(s.pts), []);
    if (!all.length) return svg('svg', { width:W, height:H });
    let lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (hi - lo < 1e-9) { hi += 0.01; lo -= 0.01; }
    const g = svg('svg', { width:W, height:H, class:'spark', role:'img' });
    const X = (i, n) => pad + (W - pad * 2 - 34) * (n < 2 ? 0 : i / (n - 1));
    const Y = (v) => H - pad - (H - pad * 2) * (v - lo) / (hi - lo);
    series.forEach((s, si) => {
      let d = '';
      s.pts.forEach((v, i) => { d += (i ? ' L' : 'M') + X(i, s.pts.length).toFixed(1) + ' ' + Y(v).toFixed(1); });
      g.appendChild(svg('path', { d, fill:'none', stroke:s.colour, 'stroke-width':2,
                                  'stroke-linecap':'round' }));
      const last = s.pts[s.pts.length - 1];
      g.appendChild(svg('circle', { cx:X(s.pts.length - 1, s.pts.length), cy:Y(last), r:3,
                                    fill:s.colour, stroke:'#ffffff', 'stroke-width':2 }));
      const lab = svg('text', { x:W - 32, y:Y(last) + 3, fill:'#3f4652' });
      lab.textContent = s.label;
      g.appendChild(lab);
    });
    return g;
  }
  /* 2. Venue-score trend small multiples. SHARED y-axis in every panel is
        the entire point: per-panel autoscaling would make a stable venue
        look as volatile as one that collapsed. */
  function smallMultiple(pts, w, hgt, lo, hi, median) {
    const W = w || 118, H = hgt || 30, pad = 2;
    const g = svg('svg', { width:W, height:H, class:'spark', role:'img' });
    const Y = (v) => H - pad - (H - pad * 2) * (v - lo) / Math.max(1e-9, hi - lo);
    if (isFinite(median)) g.appendChild(svg('line', { x1:0, x2:W, y1:Y(median), y2:Y(median),
      stroke:'#dfe3ea', 'stroke-width':1, 'stroke-dasharray':'2 2' }));
    let d = '';
    pts.forEach((v, i) => { d += (i ? ' L' : 'M') +
      (pad + (W - pad * 2) * (pts.length < 2 ? 0 : i / (pts.length - 1))).toFixed(1) + ' ' + Y(v).toFixed(1); });
    g.appendChild(svg('path', { d, fill:'none', stroke:'#3f4652', 'stroke-width':1.5 }));
    const lx = pad + (W - pad * 2), lv = pts[pts.length - 1];
    g.appendChild(svg('circle', { cx:lx, cy:Y(lv), r:2.5, fill:'#1c5cab' }));
    return g;
  }
  /* 3. Calibration curve, bin markers SIZED BY n. Earns its place because it
        is the only honest visual answer to "is this venue's price a
        probability I can trust", and sizing by n puts the sample size in the
        same view as the claim. */
  function calibration(bins, w, hgt) {
    const W = w || 240, H = hgt || 200, pad = 26;
    const g = svg('svg', { width:W, height:H, role:'img' });
    const X = (p) => pad + (W - pad - 8) * p;
    const Y = (p) => H - pad - (H - pad - 8) * p;
    for (let i = 0; i <= 4; i++) {
      const v = i / 4;
      g.appendChild(svg('line', { x1:X(0), x2:X(1), y1:Y(v), y2:Y(v), stroke:'#e7eaf0', 'stroke-width':1 }));
      const tx = svg('text', { x:4, y:Y(v) + 3 }); tx.textContent = v.toFixed(2); g.appendChild(tx);
      const ty = svg('text', { x:X(v) - 8, y:H - 10 }); ty.textContent = v.toFixed(2); g.appendChild(ty);
    }
    g.appendChild(svg('line', { x1:X(0), y1:Y(0), x2:X(1), y2:Y(1),
      stroke:'#b9c0cc', 'stroke-width':1, 'stroke-dasharray':'3 3' }));
    const maxN = Math.max.apply(null, bins.map(b => b.n).concat([1]));
    for (const b of bins) {
      const r = 2.5 + 5.5 * Math.sqrt(b.n / maxN);
      g.appendChild(svg('circle', { cx:X(b.pMean), cy:Y(b.oMean), r,
        fill:'#1c5cab', stroke:'#ffffff', 'stroke-width':2, 'fill-opacity':0.9 }));
    }
    const xl = svg('text', { x:X(0.5) - 22, y:H - 1 }); xl.textContent = 'implied prob';
    g.appendChild(xl);
    return g;
  }
  return { svg, movement, smallMultiple, calibration };
})();
