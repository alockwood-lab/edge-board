/* ==================== L4  model orchestration + views ================== */
VB.model = (function () {
  const P = VB.pipe, SD = VB.seed;
  let M = null;

  function boot() {
    const t0 = performance.now();
    /* LIVE PRODUCT: no synthetic slate, no seeded settled history, nothing
       fabricated on the board. The seed generator remains in the file because
       the self-test suite exercises the math against known inputs, but it no
       longer produces a single row a user can see.
       The cost is real and is disclosed rather than hidden: without observed
       closing lines there is no closing-line accuracy and no Brier, so the
       venue leaderboard falls back to what a live snapshot genuinely
       measures -- hold, coverage and depth. */
    const stats = {};
    const tHist = 0;

    const venues = {}, S = VB.store.get();
    for (const v of SD.VENUES) {
      const c = VB.score.components(stats[v.id]);
      venues[v.id] = Object.assign({}, v, {
        claHist: c ? c.cla : 0,
        /* Consensus weighting uses the SHARPNESS sub-index only. For a
           reference venue you do not care about its limits or breadth, only
           whether its price is right; using the composite here would
           downweight a sharp low-limit book for an irrelevant reason. */
        sharp: 50,
        accessible: S.__acc ? !!S.__acc[v.id] : false
      });
    }
    /* No history means no sharpness score, so consensus weighting falls back
       to liquidity and staleness only -- which the consensus builder already
       handles and flags. Neutral 50 is the honest starting value, not a
       measurement. */
    const lb = { rows: [], ranked: { rated: [], unrated: [] }, cohort: {} };
    const t1 = performance.now();
    const slate = { events: [], markets: [] };
    const manifest = { ev: [], arb: [], fakeArb: null, misMap: null, stale: [],
                       thinMarket: null, attempted: 0, skipped: 0 };
    const tSlate = performance.now() - t1;

    S.venues = venues;
    M = { stats, venues, lb, slate, manifest, live: {},
          timing: { hist:tHist, slate:tSlate }, rows:null, byMarket:null };
    compute();
    return M;
  }

  /* PHASE A + B + C. M for the noise line is the count of markets EVALUATED,
     not displayed: filtering the board does not refund multiplicity already
     paid for. */
  function compute() {
    const t0 = performance.now();
    const S = VB.store.get(), st = S.settings;
    /* accessibleOnly defaults ON and every account defaults OFF, so applying
       the filter literally on first run guarantees an empty board for a
       reason that has nothing to do with value -- which is precisely the
       "user reads an empty board as broken and loosens the gates" failure
       mode. Until at least one account is marked the filter cannot bind, so
       it is suspended and the suspension is stated on the board. This claims
       nothing on the user's behalf: it asserts no accounts, it just stops
       filtering on an empty set. */
    const nAcc = Object.keys(M.venues).filter(id => M.venues[id].accessible).length;
    const accSuspended = st.accessibleOnly && nAcc === 0;
    M.nAccessible = nAcc; M.accSuspended = accSuspended;
    const opts = Object.assign({}, P.DEFAULTS, {
      minEVPct:st.minEVPct, minEdgePP:st.minEdgePP, minT:st.minT,
      minClusters:st.minClusters, requireTier1:st.requireTier1,
      maxAgeMin:st.maxAgeMin, multiplicityAdjust:st.multiplicityAdjust,
      accessibleOnly: st.accessibleOnly && !accSuspended
    });
    let rows = [], byMarket = {};
    for (const m of M.slate.markets) {
      const a = P.phaseA(m, M.venues, opts);
      const arb = P.arbForMarket(m, a.rows);
      if (arb && arb.det.isArb) {
        for (const r of a.rows) {
          const isLeg = arb.best.some(b => b && b.venueId === r.venueId && b.side === r.side);
          r.inArb = isLeg;
          r.arbRoi = arb.det.roi;
          /* Quarantine only the LEGS of a suspect arb, not every offer in the
             market. Flagging the whole market punished 30 rows for a
             two-row pairing problem and buried every legitimate PASS
             underneath a SUSPECT verdict it had nothing to do with. */
          r.arbSuspect = arb.suspect && isLeg;
        }
      }
      byMarket[m.id] = { market:m, rows:a.rows, arb };
      rows = rows.concat(a.rows);
    }
    const nEval = rows.length;
    for (const r of rows) { P.gate(r, opts, nEval); P.sizeRow(r, st); }
    /* Reference comparison runs AFTER the gates, because it is a separate
       claim from the consensus and must never be mistaken for one. */
    if (M.refPool) {
      M.refStats = VB.refcmp.apply(rows, M.refPool, M.venues);
    }
    M.rows = rows; M.byMarket = byMarket; M.nEval = nEval;
    M.timing.compute = performance.now() - t0;
    M.eCritMedian = medianECrit(rows);
    return M;
  }
  function medianECrit(rows) {
    const v = rows.map(r => r.eCrit).filter(isFinite).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  }
  /* Fetch the exchange and keep it as a REFERENCE POOL rather than as board
     rows. Polymarket's own single-venue markets are unpriceable noise on a
     board; its value here is as the sharp yardstick the book's price is
     measured against. */
  async function loadReference() {
    const ad = VB.adapters.polymarket;
    /* Two things are required to surface GAME markets rather than the
       long-dated politics and crypto contracts that dominate by volume:
       an end-date window, and PAGINATION. The API silently caps at 100 rows
       per request no matter what `limit` says -- measured: limit=500 returns
       100. One page found 9 game totals and matched nothing; four pages find
       33 and match 3 of 5 DraftKings MLB totals. */
    const end = new Date(Date.now() + 4 * 86400e3).toISOString().slice(0, 10) + 'T00:00:00Z';
    const pages = [0, 100, 200, 300];
    let quotes = [], pagesOk = 0, err = null;
    for (const off of pages) {
      const url = ad.gamma + '/markets?closed=false&limit=100&offset=' + off +
                  '&end_date_max=' + encodeURIComponent(end) +
                  '&order=volume24hr&ascending=false';
      try {
        const r = await fetch(url, { mode:'cors', credentials:'omit' });
        if (!r.ok) { err = 'HTTP ' + r.status; break; }
        const raw = await r.json();
        if (!Array.isArray(raw) || !raw.length) break;
        quotes = quotes.concat(ad.normalize(raw).quotes);
        pagesOk++;
        if (raw.length < 100) break;          /* last page */
      } catch (e) { err = String(e.message || e); break; }
    }
    if (!quotes.length) return { ok:false, error: err || 'no markets returned',
                                 classify: err ? 'blocked_cors' : 'empty' };
    M.refPool = VB.refcmp.buildPool(quotes);
    M.refMeta = { at: Date.now(), contracts: quotes.length, pages: pagesOk,
                  totals: Object.keys(M.refPool.totals).length };
    compute();
    return { ok:true, contracts: quotes.length, pages: pagesOk,
             totals: M.refMeta.totals };
  }

  /* Live ingest. normalize() is pure and network-free, so the manual-paste
     path below produces byte-identical rows to a live fetch -- the paste
     escape hatch is the same code with a different transport, not a
     degraded second-class mode. */
  async function loadLive(adapterId, opts) {
    const A = VB.adapters, S = VB.store.get();
    const ad = A.byId[adapterId];
    if (!ad) return { ok:false, error:'unknown adapter' };
    const tk = A.take(ad.bucket, 1);
    if (!tk.ok) return { ok:false, error:'rate limited, retry in ' + Math.ceil(tk.waitMs/1000) + 's' };
    let url, cost = 0;
    if (adapterId === 'espn') url = ad.quotesUrl((opts && opts.cat) || 'NFL', opts && opts.dateKey);
    else if (adapterId === 'polymarket') url = ad.quotesUrl(150);
    else {
      const key = (opts && opts.key) || '';
      if (!key) return { ok:false, error:'no API key' };
      url = ad.quotesUrl(key, opts.sportKey || 'americanfootball_nfl',
                         opts.markets || 'h2h,spreads,totals', 'us');
      cost = ad.cost(opts.markets || 'h2h,spreads,totals', 'us');
    }
    let raw, quota = null;
    try {
      const r = await fetch(url, { mode:'cors', credentials:'omit' });
      quota = { remaining: r.headers.get('x-requests-remaining'),
                used: r.headers.get('x-requests-used') };
      if (!r.ok) {
        const body = await r.text();
        return { ok:false, error:'HTTP ' + r.status + ': ' + body.slice(0, 160),
                 classify: r.status === 401 || r.status === 403 ? 'unauthorized' : 'http', quota };
      }
      raw = await r.json();
    } catch (e) {
      /* fetch throwing with no status IS the CORS signature. */
      return { ok:false, error:String(e.message || e), classify:'blocked_cors' };
    }
    return ingest(adapterId, raw, { cost, quota, cat: opts && opts.cat });
  }

  /* Same entry point for a live payload and a pasted one. */
  function ingest(adapterId, raw, meta) {
    const ad = VB.adapters.byId[adapterId];
    const norm = ad.normalize(raw, meta && meta.cat);
    const now = Date.now();
    let built = [], discovered = [];
    if (adapterId === 'oddsapi') {
      const b = VB.live.marketsFromOddsApi(norm, M.venues, now);
      built = b.markets; discovered = b.discovered;
    } else if (adapterId === 'espn') {
      built = VB.live.marketsFromEspn(norm, M.venues, now);
    } else {
      built = VB.live.marketsFromPolymarket(norm, M.venues, now);
    }
    /* Refresh-in-place must be keyed on adapter AND scope, not adapter
       alone. Keying on the adapter meant loading NFL deleted the NCAAF
       markets from the same adapter -- and with the leagues fetched in
       parallel, whichever finished last won and the rest vanished. Measured:
       3 leagues loaded, 75 markets built, 0 rows survived. */
    const scope = (meta && meta.cat) ? String(meta.cat) : '_';
    const tag = adapterId + '/' + scope;
    for (const m of built) m.srcScope = tag;
    M.slate.markets = M.slate.markets
      .filter(m => (m.srcId !== adapterId) || (m.srcScope && m.srcScope !== tag))
      .concat(built);
    M.live = M.live || {};
    const prev = M.live[adapterId] || { markets:0, quotes:0, scopes:{} };
    const scopes = Object.assign({}, prev.scopes);
    scopes[scope] = { markets: built.length, quotes: norm.quotes.length,
                      rejected: norm.rejected, warnings: norm.warnings, at: now };
    /* Totals are recomputed from the per-scope map, so a league that returns
       nothing cannot zero out the ones that did. */
    let tm = 0, tq = 0;
    for (const k in scopes) { tm += scopes[k].markets; tq += scopes[k].quotes; }
    M.live[adapterId] = { at: now, markets: tm, quotes: tq, scopes,
                          rejected: norm.rejected, warnings: norm.warnings,
                          discovered, cost: (meta && meta.cost) || 0,
                          quota: (meta && meta.quota) || null };
    const S = VB.store.get();
    let anyLive = false;
    for (const k in M.live) if (M.live[k].markets > 0) anyLive = true;
    S.dataset.mode = anyLive ? 'mixed' : 'seed';
    compute();
    return { ok:true, markets: built.length, quotes: norm.quotes.length,
             rejected: norm.rejected, warnings: norm.warnings, discovered,
             quota: (meta && meta.quota) || null };
  }
  /* Validate for free before spending credits. Reports the quota headers and
     how many sports the key can see, and classifies the failure so the
     remedy shown is the right one. */
  async function validateKey(key) {
    const ad = VB.adapters.oddsapi;
    try {
      const r = await fetch(ad.validateUrl(key), { mode:'cors', credentials:'omit' });
      const remaining = r.headers.get('x-requests-remaining');
      const used = r.headers.get('x-requests-used');
      if (r.status === 401 || r.status === 403) {
        const b = await r.text();
        return { ok:false, classify:'unauthorized', error:'key rejected: ' + b.slice(0, 140) };
      }
      if (!r.ok) return { ok:false, classify:'http', error:'HTTP ' + r.status };
      const list = await r.json();
      const active = Array.isArray(list) ? list.filter(x => x.active) : [];
      return { ok:true, remaining, used, sports:active.length,
               keys: active.map(x => x.key) };
    } catch (e) {
      return { ok:false, classify:'blocked_cors', error:String(e.message || e) };
    }
  }
  function liveStats() {
    const out = {};
    if (M && M.live) for (const k in M.live) if (M.live[k].markets > 0) out[k] = M.live[k];
    return out;
  }
  function clearLive(adapterId) {
    if (!M) return;
    M.slate.markets = M.slate.markets.filter(m => m.srcId !== adapterId);
    if (M.live) delete M.live[adapterId];
    const S = VB.store.get();
    S.dataset.mode = (M.live && Object.keys(M.live).length) ? 'mixed' : 'seed';
    compute();
  }

  /* AUTO-LOAD REAL LINES ON OPEN.
     Leaving the live fetch behind a button in Settings meant the app opened
     on synthetic data every time and the banner correctly said so -- which
     reads as "this thing is fake" no matter how much plumbing sits behind
     the button. Real lines are now the default and the seed is the fallback.
     Fired AFTER the first paint so a slow or absent network can never delay
     boot, and each league is independent so one failure does not sink the
     rest. */
  const AUTO_LEAGUES = ['NFL', 'NCAAF', 'MLB', 'NBA', 'NHL', 'NCAAB'];
  /* Multi-book leagues are fetched from The Odds API, which is METERED:
     1 credit = 1 sport x 1 market x 1 region, so h2h+spreads+totals on one
     league costs 3. The free tier is 500/month, so a naive fetch-on-every-
     open at 6 leagues would burn 18 credits a visit and exhaust the month in
     27 opens. Hence: a small default league set, and a cache with a TTL so
     reopening the page inside the window costs nothing. */
  const ODDS_LEAGUES = { NFL:'americanfootball_nfl', NCAAF:'americanfootball_ncaaf',
                         MLB:'baseball_mlb', NBA:'basketball_nba',
                         NHL:'icehockey_nhl', NCAAB:'basketball_ncaab' };
  const ODDS_DEFAULT = ['NFL', 'NCAAF'];
  const ODDS_TTL_MS = 15 * 60 * 1000;
  /* A cache is a cost saver, not a fallback of last resort. Serving a
     six-hour-old pull as if it were current would show yesterday's slate
     with today's date on it -- the worst kind of wrong, because it looks
     fine. Past this age the cache is discarded rather than displayed. */
  const ODDS_STALE_MAX_MS = 3 * 60 * 60 * 1000;
  const CACHE_KEY = 'vb.oddscache';

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function writeCache(c) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); return true; }
    catch (e) { return false; }   /* over quota: run uncached rather than fail */
  }

  /* Fetch one league from The Odds API, or serve it from cache. Returns the
     credits actually spent so the UI can report the real number. */
  async function loadOddsLeague(cat, key, opts) {
    const o = opts || {};
    const sportKey = ODDS_LEAGUES[cat];
    if (!sportKey) return { ok:false, error:'unknown league' };
    const cache = readCache();
    const hit = cache[cat];
    const fresh = hit && (Date.now() - hit.at) < ODDS_TTL_MS;
    if (o.cacheOnly) {
      const usable = hit && (Date.now() - hit.at) < ODDS_STALE_MAX_MS;
      if (!usable) return { ok:false, error:'no usable cache', credits:0 };
      const r = ingest('oddsapi', hit.raw, { cost:0, cat, cached:true });
      return Object.assign({ cached:true, credits:0, ageMs: Date.now() - hit.at }, r);
    }
    if (fresh && !o.force) {
      const r = ingest('oddsapi', hit.raw, { cost:0, cat, cached:true });
      return Object.assign({ cached:true, ageMs: Date.now() - hit.at, credits:0 }, r);
    }
    const ad = VB.adapters.oddsapi;
    /* us,eu — NOT us alone. Measured: the US region returns only retail
       books (DraftKings, FanDuel, BetMGM, BetRivers, Bovada, BetOnline), all
       tier 2/3, so the sharp-anchor gate correctly refused all 896 consensus
       rows with "no sharp venue in consensus". The EU region carries
       Pinnacle, Betfair and Matchbook — the three references the gate needs,
       and Pinnacle's hold measured 3.27% against retail's 4.0–6.4%.
       Cost is 2 regions x 3 markets = 6 credits per league. */
    /* REGION STRATEGY. `eu` alone carries Pinnacle, Betfair and Matchbook --
       measured: 21 books, all three sharp anchors -- for 3 credits. Adding
       `us` costs another 3 and mostly duplicates DraftKings/FanDuel/BetMGM,
       and DraftKings already arrives FREE from ESPN. So the default buys the
       REFERENCE and takes the bet target for nothing: same analysis, half
       the credits, 166 league-pulls a month instead of 83. */
    const regions = (VB.store.get().settings.oddsRegions) || 'eu';
    const url = ad.quotesUrl(key, sportKey, 'h2h,spreads,totals', regions);
    try {
      const resp = await fetch(url, { mode:'cors', credentials:'omit' });
      const remaining = resp.headers.get('x-requests-remaining');
      const used = resp.headers.get('x-requests-last');
      if (!resp.ok) {
        const b = await resp.text();
        /* Out of quota or bad key: fall back to a stale cache rather than
           showing nothing. */
        const usable = hit && (Date.now() - hit.at) < ODDS_STALE_MAX_MS;
        if (usable) {
          const r = ingest('oddsapi', hit.raw, { cost:0, cat, cached:true });
          return Object.assign({ cached:true, stale:true, credits:0,
            ageMs: Date.now() - hit.at,
            warn:'HTTP ' + resp.status + ' — showing a cached pull from ' +
                 Math.round((Date.now() - hit.at) / 60000) + 'm ago' }, r);
        }
        if (hit) return { ok:false, error:'HTTP ' + resp.status +
          ', and the cached pull is ' + Math.round((Date.now() - hit.at) / 3600000) +
          'h old — too stale to show', classify:'stale_cache' };
        return { ok:false, error:'HTTP ' + resp.status + ': ' + b.slice(0, 140),
                 classify: resp.status === 401 ? 'unauthorized'
                         : resp.status === 429 ? 'rate_limited' : 'http' };
      }
      const raw = await resp.json();
      VB.budget.record(Number(used) || 3, cat + ' ' + regions);
      cache[cat] = { at: Date.now(), raw };
      writeCache(cache);
      const r = ingest('oddsapi', raw, { cost: Number(used) || 3, cat, quota:{ remaining, used } });
      M.oddsQuota = { remaining, at: Date.now() };
      return Object.assign({ cached:false, credits: Number(used) || 3, remaining }, r);
    } catch (e) {
      const usable2 = hit && (Date.now() - hit.at) < ODDS_STALE_MAX_MS;
      if (usable2) {
        const r = ingest('oddsapi', hit.raw, { cost:0, cat, cached:true });
        return Object.assign({ cached:true, stale:true, credits:0,
          ageMs: Date.now() - hit.at,
          warn:'offline — showing a cached pull from ' +
               Math.round((Date.now() - hit.at) / 60000) + 'm ago' }, r);
      }
      return { ok:false, error:String(e.message || e), classify:'blocked_cors' };
    }
  }
  let autoState = { running:false, done:false, ok:0, failed:0, markets:0, errors:[] };
  function autoStatus() { return autoState; }

  async function autoLoadLive(onProgress) {
    if (autoState.running || autoState.done) return autoState;
    autoState.running = true;
    const refP = loadReference();
    /* Multi-book first: it is the only source that can produce a consensus,
       so it defines the board. ESPN then fills in leagues the key was not
       spent on. */
    const S0 = VB.store.get();
    const key = (S0.keys && S0.keys.oddsapi) || '';
    if (key) {
      autoState.oddsLeagues = [];
      /* SCOUT FREE FIRST. ESPN costs nothing and answers the only question
         that decides whether a paid pull is worth it: are there games, and
         when. Spending credits to discover that there are no games tonight
         is the single easiest way to waste this budget. */
      let gamesSoon = null;
      try {
        await Promise.all(ODDS_DEFAULT.map(c => loadLive('espn', { cat:c }).catch(() => null)));
        const horizon = VB.budget.VALUE_WINDOW_H * 3600;
        const evs = {};
        for (const r of (M.rows || [])) {
          if (ODDS_DEFAULT.indexOf(r.cat) < 0) continue;
          if (isFinite(r.startSec) && r.startSec <= horizon) evs[r.eventId] = 1;
        }
        gamesSoon = Object.keys(evs).length;
      } catch (e) { gamesSoon = null; }
      autoState.scout = { gamesSoon };

      for (const cat of ODDS_DEFAULT) {
        /* Do we already have something worth showing for this league? If
           not, the guards must not block the fetch. */
        const cache0 = readCache();
        const hit0 = cache0[cat];
        const haveUsable = !!(hit0 && (Date.now() - hit0.at) < ODDS_STALE_MAX_MS);
        const dec = VB.budget.decide({ gamesWithinH: gamesSoon, cost: 3,
          haveUsableData: haveUsable,
          remainingHeader: (M.oddsQuota && M.oddsQuota.remaining) });
        autoState.decision = dec;
        if (!dec.spend) {
          /* Serve whatever is cached rather than spending; if nothing is
             cached the free feeds already loaded above are the board. */
          const r = await loadOddsLeague(cat, key, { cacheOnly:true }).catch(() => null);
          autoState.oddsLeagues.push({ cat, ok:!!(r && r.ok), skipped:dec.reason,
            why:dec.why, credits:0, markets:(r && r.markets) || 0, cached:true });
          continue;
        }
        try {
          const r = await loadOddsLeague(cat, key, {});
          autoState.oddsLeagues.push({ cat, ok:!!r.ok, markets:r.markets || 0,
            books:(r.discovered || []).length, credits:r.credits || 0,
            cached:!!r.cached, stale:!!r.stale, ageMs:r.ageMs || 0,
            warn:r.warn, remaining:r.remaining, error:r.error });
          if (r.ok) { autoState.ok++; autoState.markets += (r.markets || 0); }
          else autoState.errors.push(cat + ': ' + (r.error || 'no data'));
        } catch (e) { autoState.errors.push(cat + ': ' + String(e.message || e)); }
      }
    }
    const espnOnly = AUTO_LEAGUES.filter(c => !key || ODDS_DEFAULT.indexOf(c) < 0);
    const results = await Promise.all(espnOnly.map(async (cat) => {
      try {
        const r = await loadLive('espn', { cat });
        return { cat, ok: !!r.ok, markets: r.markets || 0, error: r.error };
      } catch (e) { return { cat, ok:false, markets:0, error:String(e.message || e) }; }
    }));
    for (const r of results) {
      if (r.ok && r.markets) { autoState.ok++; autoState.markets += r.markets; }
      else if (!r.ok) { autoState.failed++; autoState.errors.push(r.cat + ': ' + (r.error || 'no data')); }
    }
    const refR = await refP;
    autoState.ref = refR;
    autoState.running = false; autoState.done = true;
    /* If real lines arrived, show them. Mixing 7,000 synthetic rows into the
       default view is what buried them last time. */
    if (autoState.markets > 0) {
      const S = VB.store.get();
      if (!S.ui.srcTouched) S.ui.src = 'real';
    }
    compute();
    if (onProgress) onProgress(autoState);
    return autoState;
  }

  /* ---------------------------------------------------------- REFRESH
     The two source classes cannot share a refresh policy, because one is
     free and one is metered.
       ESPN + Polymarket : free, so they refresh on a short timer.
       The Odds API      : 6 credits per league per pull. Two leagues is 12,
                           so a 15-minute loop would spend 48/hour and
                           exhaust a 500-credit month in about 10 hours of an
                           open tab. It is therefore MANUAL by default, with
                           an opt-in timer that states its burn rate.
     A hidden tab never refreshes either class -- polling a background tab is
     pure waste, and for the metered source it is waste that costs money. */
  const FREE_REFRESH_MS = 3 * 60 * 1000;
  let timers = { free:null, paid:null };
  let refreshState = { lastFree:0, lastPaid:0, paidAuto:false, running:false };

  async function refreshFree(onDone) {
    if (document.visibilityState === 'hidden') return;
    if (refreshState.running) return;
    refreshState.running = true;
    try {
      const key = (VB.store.get().keys || {}).oddsapi || '';
      const espnCats = AUTO_LEAGUES.filter(c => !key || ODDS_DEFAULT.indexOf(c) < 0);
      await Promise.all(espnCats.map(c => loadLive('espn', { cat:c }).catch(() => null)));
      await loadReference().catch(() => null);
      refreshState.lastFree = Date.now();
    } finally { refreshState.running = false; }
    compute();
    if (onDone) onDone();
  }

  async function refreshPaid(onDone, opts) {
    const o = opts || {};
    if (!o.force && document.visibilityState === 'hidden') return { skipped:'hidden' };
    const key = (VB.store.get().keys || {}).oddsapi || '';
    if (!key) return { skipped:'no key' };
    if (refreshState.running) return { skipped:'busy' };
    refreshState.running = true;
    let spent = 0, remaining = null;
    try {
      for (const cat of ODDS_DEFAULT) {
        const r = await loadOddsLeague(cat, key, { force: !!o.force });
        spent += r.credits || 0;
        if (r.remaining) remaining = r.remaining;
      }
      refreshState.lastPaid = Date.now();
    } finally { refreshState.running = false; }
    compute();
    if (onDone) onDone();
    return { spent, remaining };
  }

  /* Credit burn if the metered timer were left running. Shown BEFORE the
     toggle is flipped, not discovered afterwards. */
  function burnRate(intervalMin) {
    const perPull = ODDS_DEFAULT.length * 6;
    return { perPull, perHour: perPull * (60 / intervalMin),
             perDay: perPull * (1440 / intervalMin),
             hoursToExhaust: 500 / (perPull * (60 / intervalMin)) };
  }

  function startTimers(onTick) {
    if (timers.free) clearInterval(timers.free);
    timers.free = setInterval(() => refreshFree(onTick), FREE_REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      /* Catch up once on return rather than on a schedule while hidden. */
      if (document.visibilityState === 'visible' &&
          Date.now() - refreshState.lastFree > FREE_REFRESH_MS) refreshFree(onTick);
    });
  }
  function setPaidAuto(on, intervalMin, onTick) {
    refreshState.paidAuto = !!on;
    if (timers.paid) { clearInterval(timers.paid); timers.paid = null; }
    if (on) timers.paid = setInterval(() => refreshPaid(onTick), (intervalMin || 15) * 60000);
  }
  const refreshStatus = () => refreshState;

  const get = () => M;
  return { boot, compute, get, loadLive, ingest, liveStats, clearLive, validateKey,
           refreshFree, refreshPaid, startTimers, setPaidAuto, refreshStatus,
           burnRate, FREE_REFRESH_MS,
           autoLoadLive, autoStatus, AUTO_LEAGUES, loadReference,
           loadOddsLeague, ODDS_LEAGUES, ODDS_DEFAULT, ODDS_TTL_MS, readCache };
})();

VB.views = (function () {
  const { h, clear, sgn, cls, money, ago, until, glyph } = VB.dom;
  const O = VB.odds, K = VB.stake, MU = VB.multiplicity;
  const price = (d) => O.fmtAmerican(O.decimalToAmerican(d));

  /* --------------------------------------------------------- filter row */
  function filterBar(shown, census, cat, mode) {
    const S = VB.store.get(), M = VB.model.get();
    const cats = ['all'].concat(VB.seed.CATS.map(c => c.key));
    const chips = cats.map(c => {
      const a = h('a', { class:'chip' + (c === cat ? ' on' : ''),
        href:'#/board/' + c + (mode === 'all' ? '?mode=all' : '') });
      if (c !== 'all') a.appendChild(VB.dom.sportIcon(c));
      a.appendChild(document.createTextNode(c === 'all' ? 'All sports' : c));
      return a;
    });

    /* The source filter existed only to separate real rows from synthetic
       ones. With the seed slate gone there is one source of truth and the
       control is dead weight. */
    const srcBtns = null;

    /* Layout toggle. Games is the book-style default; Rows is the analytical
       per-outcome table where the error budget lives. */
    const layBtns = h('div', { class:'row', style:'gap:6px' }, [
      h('a', { class:'chip' + (S.ui.layout !== 'rows' ? ' on' : ''), href:'javascript:void 0',
        onclick:(e) => { e.preventDefault(); S.ui.layout = 'games'; VB.store.save(); render(); } }, 'Games'),
      h('a', { class:'chip' + (S.ui.layout === 'rows' ? ' on' : ''), href:'javascript:void 0',
        onclick:(e) => { e.preventDefault(); S.ui.layout = 'rows'; VB.store.save(); render(); } }, 'Rows')
    ]);

    const modeBtns = h('div', { class:'row', style:'gap:6px' }, [
      h('a', { class:'chip' + (mode === 'value' ? ' on' : ''), href:'#/board/' + cat }, 'value'),
      h('a', { class:'chip' + (mode === 'all' ? ' on' : ''), href:'#/board/' + cat + '?mode=all' }, 'show everything')
    ]);
    const arith = h('div', { class:'arith' });
    const parts = [];
    for (const k of ['BET','THIN','LIMITED','AGED','SUSPECT','PASS','NO PRICE']) {
      if (census[k]) parts.push(census[k] + ' ' + k);
    }
    arith.appendChild(document.createTextNode(
      M.nEval.toLocaleString() + ' offer rows evaluated → ' + shown.toLocaleString() + ' shown   ·   ' + parts.join(' · ')));
    /* Two rows, not one. Fourteen sport chips plus seven control chips on a
       single nowrap line clipped the controls off the right edge -- the
       layout and mode toggles were literally unreachable. Sports scroll on
       their own line; the controls get a fixed row that always fits. */
    return h('div', { id:'filters' }, [
      h('div', { class:'row catrow' }, chips),
      h('div', { class:'row ctlrow' }, [srcBtns, layBtns, modeBtns, refreshCtl()].filter(Boolean)),
      arith
    ]);
  }

  /* Every column header explains itself on hover. A board full of q_o and
     p_c and t is unusable if you have to remember what they mean, and the
     jargon is not removable -- these ARE the quantities. So the definitions
     ship with the columns. */
  const GLOSS = {
    g:      'Quality glyph. Solid = strong bet, shaded = bet, light = thin, dots = pass, ! = stale. Shape not colour, so it survives greyscale and colourblindness.',
    cat:    'Sport or prediction-market category.',
    start:  'Time until the event starts. OPEN means no scheduled start.',
    event:  'The matchup, or the question for a prediction market.',
    market: 'Bet type and line. A −3.5 and a −3.0 are different markets and are never compared.',
    side:   'Which outcome this row is for.',
    venue:  'The sportsbook, exchange or prediction market offering this price. A ~ prefix means the price is synthetic seed data.',
    dGross: 'The odds this venue is offering, exactly as you would see them there.',
    qo:     'Implied probability of the offered price (1 ÷ decimal odds). This still contains the venue\'s margin, so it is NOT a fair probability.',
    pFair:  'Consensus fair probability, leave-one-cluster-out: built from every OTHER venue cluster, with this venue and its corporate siblings excluded so an offer cannot help judge itself.',
    ep:     'Edge in probability points: consensus fair probability minus the offered implied probability. The raw mispricing, before any correction.',
    eAdj:   'Edge after subtracting the noise line. Scanning thousands of markets produces apparent edge from pure chance; this is what survives that.',
    evNet:  'Expected return per unit staked, net of commission and per-contract fees. Positive means the price beats the consensus.',
    t:      'Edge divided by its own standard error. Below 2 the SIGN of the edge is not reliable, let alone its size. This is the default sort.',
    seTotal:'Standard error of the edge, in probability points: sampling error across venues, plus de-vig model bias, plus a staleness penalty.',
    ageSec: 'How old this quote is. Brackets and a ! mean it is past the staleness budget and excluded from pricing.',
    nClusters:'Independent venue clusters in the consensus. Corporate siblings and shared pricing feeds count once, so five books on one feed count as one opinion.',
    rung:   'Recommended stake in units, after the edge-reliability shrink and your risk level. 0.00u means do not bet.',
    amount: 'Stake in dollars. 1.0u always equals your configured unit exactly.',
    evUsd:  'Expected profit in dollars on the recommended stake. Modelled, not realised.',
    refFair:'Fair probability from the Polymarket order book — an exchange with near-zero vig. Derived exactly when the exchange brackets this line; never interpolated across a gap.',
    refEV:  'Expected value per unit staked against the exchange reference, with the push branch handled separately. This is a TWO-VENUE comparison, a weaker claim than a 3-cluster consensus.',
    verdict:'The decision. BET / THIN / PASS / AGED / SUSPECT / LIMITED / NO PRICE.',
    why:    'The single binding reason for the verdict.'
  };

  /* Refresh control. Free sources are already current; the metered pull
     states its cost on the button so it is never a surprise. */
  function refreshCtl() {
    const M = VB.model.get();
    const st = VB.model.refreshStatus();
    const q = M && M.oddsQuota;
    const age = st.lastPaid ? Math.round((Date.now() - st.lastPaid) / 60000) : null;
    const wrap = h('div', { class:'row', style:'gap:7px' });
    const cost = VB.model.ODDS_DEFAULT.length * 6;
    wrap.appendChild(h('button', {
      'data-tip':'Re-pulls ' + VB.model.ODDS_DEFAULT.join(' + ') + ' from The Odds API. ' +
        'Costs ' + cost + ' credits (6 per league: 3 markets x 2 regions). Free sources ' +
        '(ESPN, Polymarket) already refresh themselves every 3 minutes.',
      onclick: async (e) => {
        const b = e.target; const old = b.textContent;
        b.textContent = 'refreshing…'; b.disabled = true;
        const r = await VB.model.refreshPaid(null, { force:true });
        b.disabled = false; b.textContent = old;
        VB.store.save(); render();
      } }, 'Refresh odds · ' + cost + ' cr'));
    const bits = [];
    if (age !== null) bits.push('books ' + (age === 0 ? 'just now' : age + 'm ago'));
    if (st.lastFree) bits.push('free feeds ' +
      Math.round((Date.now() - st.lastFree) / 60000) + 'm');
    if (q && q.remaining) bits.push(q.remaining + ' credits left');
    if (bits.length) wrap.appendChild(h('span', { class:'small muted' }, bits.join(' · ')));
    return wrap;
  }

  /* ------------------------------------------------------------- board */
  function board(cat, mode) {
    const S = VB.store.get(), M = VB.model.get(), st = S.settings;
    const wrap = h('div');
    const srcSel = 'real';
    let rows = M.rows.filter(r => cat === 'all' || r.cat === cat);
    const census = {};
    for (const r of rows) census[r.verdict] = (census[r.verdict] || 0) + 1;

    /* "Real only" is an explicit request to see real prices, so it is not
       then filtered down to bettable rows -- that combination is what made
       a successful load look like a failed one. */
    if (mode === 'value' && srcSel !== 'real') {
      rows = rows.filter(r => r.verdict === 'BET' || r.verdict === 'THIN');
    }
    let key = S.ui.sort, dir = S.ui.dir;
    /* If the only signal available is the reference EV, sort on it rather
       than on a `t` that does not exist yet. Evaluated against `rows`, not
       `view` -- the slice has not happened at this point. */
    if (key === 't' && !hasConsSort(rows)
        && rows.some(r => r.refEV !== null && r.refEV !== undefined && isFinite(r.refEV))) {
      key = 'refEV';
    }
    rows.sort((a, b) => {
      const av = pick(a, key), bv = pick(b, key);
      if (!isFinite(av) && !isFinite(bv)) return 0;
      if (!isFinite(av)) return 1;
      if (!isFinite(bv)) return -1;
      return (av - bv) * dir;
    });
    /* THE ROW CAP MUST NOT BE APPLIED BEFORE GROUPING.
       In the Games layout one matchup is roughly (books x outcomes) rows --
       measured at ~144 rows for a 24-book NCAAF game -- so a 400-row cap
       silently truncated the board to 2.8 games. Four CFB games were in the
       window and two rendered.
       So: the row cap applies only to the flat Rows layout, which really is
       a per-row list. The Games layout caps GAMES and is handed every
       filtered row so its grouping is complete. */
    /* Which live sources are actually loaded. Used by the caption and the
       mode=all note; its definition was lost when an obsolete banner block
       was removed, leaving the references behind and throwing on every
       render. */
    const liveKeys = Object.keys(VB.model.liveStats());
    const layout = S.ui.layout || 'games';
    const rowCap = mode === 'all' ? 400 : 200;
    const view = (layout === 'games') ? rows : rows.slice(0, rowCap);
    const cap = rowCap;

    wrap.appendChild(filterBar(rows.length, census, cat, mode));

    if (M.accSuspended) {
      wrap.appendChild(h('div', { class:'note w' },
        'No accounts marked, so the accessible-only filter is suspended — otherwise the board would ' +
        'be empty for a reason unrelated to value. Mark the venues you can actually bet at in ' +
        'Settings; the best price is routinely at a venue you cannot use.'));
    }
    if (mode === 'all') {
      wrap.appendChild(h('div', { class:'note w' },
        rows.length.toLocaleString() + ' markets shown with no minimum. ' +
        (census['BET'] || 0) + ' clear your bars. Stake 0.0u means do not bet.'));
    }
    if (!view.length) {
      /* The empty state is load-bearing. The failure mode this product has
         is a user reading an empty board as a broken app and loosening the
         gates until something appears. */
      wrap.appendChild(h('div', { class:'empty' }, [
        h('b', {}, '0 bets clear the noise line.'),
        'That is the expected result on most days. ' + M.nEval.toLocaleString() +
        ' offer rows were evaluated and priced; none had an edge large enough to ' +
        'separate from the noise of scanning that many markets.',
        h('div', { class:'small muted', style:'margin-top:8px' },
          'Noise line: ' + (M.eCritMedian * 100).toFixed(2) + 'pp at M=' + M.nEval.toLocaleString() +
          '. Narrowing the scope to one league lowers it, but only slightly — it grows like √ln M.'),
        h('div', { style:'margin-top:10px' },
          h('a', { href:'#/board/' + cat + '?mode=all' }, 'Show every market with its verdict →'))
      ]));
      return wrap;
    }

    /* Games layout: hand the filtered rows to the grouped renderer and stop. */
    if (layout === 'games') {
      const gv = VB.games.board(cat, view);
      if (gv) { wrap.appendChild(gv); return wrap; }
    }

    /* COLUMNS ADAPT TO WHAT IS COMPUTABLE.
       A column of dashes reads as a broken product, not as an honest
       absence. Consensus columns only appear once a market somewhere in
       view actually has 3 independent clusters; reference columns only once
       the exchange has a matching line. Nothing is hidden -- a column that
       can carry a number is always shown, and one that cannot is not
       pretended into existence. */
    const hasCons = view.some(r => r.nClusters >= 3 && isFinite(r.ep));
    const hasRef = view.some(r => r.refEV !== null && r.refEV !== undefined && isFinite(r.refEV));
    const hasStake = view.some(r => r.rung > 0);
    const C = [['g','',0],['cat','CAT',0],['start','START',1],['event','EVENT',0],
               ['market','MARKET',0],['side','SIDE',0],['venue','VENUE',0],
               ['dGross','PRICE',1],['qo','q_o',1]];
    if (hasRef) C.push(['refFair','REF FAIR',1], ['refEV','REF EV%',1]);
    if (hasCons) {
      C.push(['pFair','p_c',1], ['ep','EDGE pp',1], ['eAdj','ADJ pp',1],
             ['evNet','EV%',1], ['t','t',1], ['seTotal','SE pp',1], ['nClusters','CL',1]);
    }
    C.push(['ageSec','AGE',1]);
    if (hasStake) C.push(['rung','STAKE',1], ['amount','AMT',1], ['evUsd','EV $',1]);
    C.push(['verdict','VERDICT',0], ['why','WHY',0]);
    const cols = C;

    const thead = h('thead', {}, h('tr', {}, cols.map(c => {
      const on = S.ui.sort === c[0];
      const gl = GLOSS[c[0]];
      const th = h('th', { class: (c[2] ? 'r' : '') + (gl ? ' hasgloss' : '') + (c[0] === 'verdict' ? ' vdcell' : ''),
        'data-tip': gl || null, tabindex: gl ? '0' : null,
        'aria-sort': on ? (dir < 0 ? 'descending' : 'ascending') : 'none',
        onclick: () => { if (S.ui.sort === c[0]) S.ui.dir = -S.ui.dir;
                         else { S.ui.sort = c[0]; S.ui.dir = -1; }
                         VB.store.save(); render(); } });
      /* The label is wrapped so the dotted underline marks exactly the text,
         not the whole cell — otherwise a right-aligned numeric header shows a
         rule floating away from its own word. */
      th.appendChild(h('span', { class: gl ? 'gl' : '' }, c[1]));
      if (on) th.appendChild(document.createTextNode(dir < 0 ? ' ▼' : ' ▲'));
      return th;
    })));

    const tb = h('tbody');
    let linePlaced = false;
    for (const r of view) {
      /* The noise line is drawn LITERALLY across the sorted board. */
      /* The line marks where edge stops clearing e_crit -- NOT where the
         first non-BET row happens to fall. A quarantined row can carry a
         large apparent edge and sort above the line; drawing the line above
         it would claim it was noise, when the real reason it is excluded is
         a pairing problem. */
      if (!linePlaced && S.ui.sort === 't' && dir < 0 && isFinite(r.eAdj) && r.eAdj <= 0) {
        tb.appendChild(h('tr', { class:'noiseline' },
          h('td', { colspan: cols.length },
            '── noise line: scanning ' + M.nEval.toLocaleString() + ' markets produces ~' +
            (M.eCritMedian * 100).toFixed(2) + 'pp of apparent edge from pure noise. Below here, stake 0.0u.')));
        linePlaced = true;
      }
      tb.appendChild(boardRow(r, cols, st));
    }
    const table = h('table', {}, [
      h('caption', {}, (function () {
        /* The caption has to describe THIS table, not the app's default
           state: labelling live DraftKings prices "synthetic" is exactly the
           kind of wrong provenance stamp the whole demo-banner design exists
           to prevent. */
        const nReal = view.filter(r => r.srcId !== 'demo').length;
        const scope = (cat === 'all' ? 'all categories' : cat);
        const counts = view.length + ' of ' + rows.length + ' rows';
        let prov;
        if (nReal === view.length && view.length) {
          prov = 'LIVE · real prices from ' + liveKeys.join(' + ') + ', fetched this session';
        } else if (nReal) {
          prov = 'MIXED · ' + nReal + ' live, ' + (view.length - nReal) + ' synthetic seed';
        } else {
          prov = 'DEMO · synthetic prices, as-of app launch';
        }
        return prov + ' · ' + scope + ' · ' + counts;
      })()),
      thead, tb]);
    wrap.appendChild(table);
    if (layout !== 'games' && rows.length > cap) {
      wrap.appendChild(h('div', { class:'small muted', style:'padding:6px 2px' },
        'Showing the top ' + cap + ' of ' + rows.length.toLocaleString() +
        ' rows by current sort. Nothing is hidden — change the sort, switch to the ' +
        'Games layout, or narrow the category to reach the rest.'));
    }
    wrap.appendChild(h('div', { class:'small muted', style:'padding:8px 2px' },
      'Edge and EV are modelled from a de-vigged, leave-one-cluster-out consensus fair price. ' +
      'They are estimates of expected value, not outcomes.'));
    return wrap;
  }

  const hasConsSort = (rows) => rows.some(r => r.nClusters >= 3 && isFinite(r.t));
  function pick(r, k) {
    if (k === 'event') return 0;
    if (k === 'venue') return 0;
    if (k === 'start') return -(r.startSec || 0);
    if (k === 'verdict' || k === 'why' || k === 'cat' || k === 'side' || k === 'market' || k === 'g') return 0;
    if (k === 'refEV' || k === 'refFair') { const v = r[k]; return (v === null || v === undefined) ? NaN : v; }
    return r[k];
  }

  function boardRow(r, cols, st) {
    const vd = r.verdict.replace(' ', '');
    const tr = h('tr', { class:'v-' + vd + (VB.store.get().ui.expanded === rowKey(r) ? ' sel' : ''),
                         onclick: () => { location.hash = '#/market/' + r.marketId; } });
    const cell = (c) => {
      const [k, , right] = c;
      const td = h('td', { class: right ? 'r' : '' });
      switch (k) {
        case 'g': td.className = 'g'; td.textContent = glyph(r); break;
        case 'cat': td.textContent = r.cat; break;
        case 'start': td.className = 'r'; td.textContent = until(r.startSec); break;
        case 'event': td.className = 'k';
          /* Sized for real names: "St. Louis Cardinals @ Colorado Rockies" is
             38 chars, where the synthetic slate averaged ~20. Full label in
             the tooltip so nothing is unreachable. */
          td.textContent = trunc(r.eventLabel, 38);
          if (r.eventLabel.length > 38) td.setAttribute('data-tip', r.eventLabel);
          break;
        case 'market': td.textContent = r.marketLabel + (r.line !== null && r.line !== undefined ? ' ' + r.line : ''); break;
        case 'side': td.textContent = trunc(String(r.side), 10); break;
        case 'venue': {
          /* Brand chip + name. All the chroma in this app lives here: chrome
             is achromatic by measurement (a coloured accent collides with the
             coloured polarity pair at normal dE 9.9), so 19 distinct brand
             hues are what make a row scannable by book at a glance. */
          const cell = h('span', { class:'vcell' });
          cell.appendChild(VB.dom.venueChip(r.venueId, 18));
          cell.appendChild(h('span', {}, trunc(r.venueName, 13)));
          td.appendChild(cell);
          break;
        }
        case 'dGross': {
          /* A price is a thing you press, so it renders as a bordered pill
             with a bold figure. This is the single most book-like element on
             the row and it costs nothing analytically. */
          td.className = 'r k';
          td.appendChild(h('span', { class:'oddspill' }, price(r.dGross)));
          break;
        }
        case 'qo': td.textContent = isFinite(r.qo) ? (r.qo * 100).toFixed(1) + '%' : '--'; break;
        case 'refFair': td.textContent =
          (r.refFair !== null && r.refFair !== undefined && isFinite(r.refFair))
            ? (r.refFair * 100).toFixed(1) + '%' : '--'; break;
        case 'refEV': {
          const v = r.refEV;
          const ok = (v !== null && v !== undefined && isFinite(v));
          td.className = 'r ' + (ok ? cls(v) : 'muted');
          td.textContent = ok ? sgn(v * 100, 2) : '--';
          if (ok && r.refNote) td.setAttribute('data-tip',
            'Fair ' + (r.refFair * 100).toFixed(1) + '% from the Polymarket order book. ' +
            r.refNote + (r.refPush ? '. Push probability ' + (r.refPush * 100).toFixed(1) + '%' : ''));
          break;
        }
        case 'pFair': td.textContent = isFinite(r.pFair) ? r.pFair.toFixed(4) : '--'; break;
        case 'ep': td.className = 'r ' + cls(r.ep); td.textContent = sgn(r.ep * 100, 2); break;
        case 'eAdj': td.className = 'r ' + cls(r.eAdj); td.textContent = isFinite(r.eAdj) ? sgn(r.eAdj * 100, 2) : '--'; break;
        case 'evNet': td.className = 'r ' + cls(r.evNet); td.textContent = isFinite(r.evNet) ? sgn(r.evNet * 100, 2) : '--'; break;
        case 't': td.textContent = isFinite(r.t) ? sgn(r.t, 1) : '--'; break;
        case 'seTotal': td.textContent = isFinite(r.seTotal) ? (r.seTotal * 100).toFixed(2) : '--'; break;
        case 'ageSec': td.textContent = (r.verdict === 'AGED' ? '! [' + ago(r.ageSec) + ']' : ago(r.ageSec)); 
                       if (r.verdict === 'AGED') td.className = 'r warn'; break;
        case 'nClusters': td.textContent = r.nClusters || '--'; break;
        case 'rung': td.className = 'r k';
          td.textContent = r.needsBankroll ? 'set bankroll' : (r.rung !== null && r.rung !== undefined ? r.rung.toFixed(2) + 'u' : '0.00u'); break;
        /* AMOUNT reads em-dash, never $0.00. A dollar sign on a pass row
           looks like an amount. */
        case 'amount': td.className = 'r k';
          td.textContent = r.needsBankroll ? '—' : (r.rung ? money(r.amountCapped !== undefined ? r.amountCapped : r.amount) : '—'); break;
        case 'evUsd': td.className = 'r ' + cls(r.evUsd);
          td.textContent = r.rung && isFinite(r.evUsd) ? sgn(r.evUsd, 2) : '—'; break;
        case 'verdict': td.className = 'vdcell';
          td.appendChild(h('span', { class:'vd vd-' + vd }, r.verdict)); break;
        case 'why': td.className = 'why'; td.textContent = r.why || ''; break;
        default: td.textContent = '';
      }
      return td;
    };
    for (const c of cols) tr.appendChild(cell(c));
    return tr;
  }
  const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
  const rowKey = (r) => r.marketId + '|' + r.venueId + '|' + r.side;

  let renderFn = function () {};
  const setRender = (f) => { renderFn = f; };
  const render = () => renderFn();
  return { board, filterBar, boardRow, trunc, rowKey, price, setRender, render, pick, GLOSS };
})();
