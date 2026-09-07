/* ----------------------------------------------------------- L2 adapters */
VB.adapters = (function () {
  const O = VB.odds;

  /* Probed live on 2026-09-06 from a US IP. These are measurements, not
     assumptions, and they decide what is buildable:
       Polymarket Gamma  200, access-control-allow-origin: *          CALLABLE
       Polymarket CLOB   200, ACAO *, allow-credentials: true         CALLABLE
       The Odds API      401 on a bad key, ACAO *, expose-headers *   CALLABLE
       Kalshi            403, ZERO CORS headers                       BLOCKED
     From file:// the document origin is the opaque string "null", so a
     wildcard ACAO matches but an allowlist-echo does not, and any custom
     header triggers a preflight that these APIs do not answer. That is why
     the key goes in the QUERY STRING, never a header. */

  const HEALTH = { UNKNOWN:'unknown', OK:'ok', CORS:'blocked_cors',
                   AUTH:'unauthorized', RATE:'rate_limited', OFFLINE:'offline',
                   SHAPE:'bad_shape' };

  /* Token bucket per adapter, so a burst cannot get the user rate-limited.
     Polymarket throttles by IP and delays rather than rejecting, which in a
     browser looks like a hang, so the bucket is the mitigation. */
  function bucket(capacity, refillPerSec) {
    return { capacity, refillPerSec, tokens: capacity, last: Date.now() };
  }
  function take(b, cost) {
    const now = Date.now();
    b.tokens = Math.min(b.capacity, b.tokens + (now - b.last) / 1000 * b.refillPerSec);
    b.last = now;
    if (b.tokens < cost) return { ok:false, waitMs: Math.ceil((cost - b.tokens) / b.refillPerSec * 1000) };
    b.tokens -= cost;
    return { ok:true };
  }

  /* Classify the failure rather than showing a generic error, because the
     remedy differs: blocked_cors needs a proxy, unauthorized needs a key,
     rate_limited needs a wait. */
  async function probe(url) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { method:'GET', mode:'cors', credentials:'omit' });
      const latency = Date.now() - t0;
      if (r.status === 401 || r.status === 403) return { status:HEALTH.AUTH, http:r.status, latency };
      if (r.status === 429) return { status:HEALTH.RATE, http:429, latency };
      if (!r.ok) return { status:HEALTH.SHAPE, http:r.status, latency };
      return { status:HEALTH.OK, http:r.status, latency,
               remaining: r.headers.get('x-requests-remaining'),
               used: r.headers.get('x-requests-used') };
    } catch (e) {
      /* A TypeError from fetch with no status is the CORS signature: the
         browser refuses to surface the response at all. */
      return { status:HEALTH.CORS, error:String(e.message || e), latency: Date.now() - t0 };
    }
  }

  /* ================================================== POLYMARKET
     No key. Prices arrive as decimal 0-1 inside JSON-ENCODED STRINGS, which
     is the number one gotcha: `outcomes` is the literal string
     '["Yes", "No"]', not an array. A raw pass-through must be rejected loudly
     rather than silently producing garbage.
     Gamma's outcomePrices are MIDS normalized to sum to 1 -- verified across
     100 live markets, every one summed to exactly 1.00000. So Gamma gives a
     fair-value signal and NOT a two-sided book; a real bid/ask spread has to
     come from the CLOB. Devigging a Gamma mid would be double-counting. */
  const polymarket = {
    id: 'polymarket', label: 'Polymarket', kind: 'rest',
    gamma: 'https://gamma-api.polymarket.com',
    clob: 'https://clob.polymarket.com',
    bucket: bucket(8, 0.6),
    capabilities: () => ({ needsKey:false, corsSafe:'yes', quotes:true,
                           orderbook:true, settled:false, creditsPerCall:'free' }),
    healthUrl() { return this.gamma + '/markets?closed=false&limit=1'; },
    quotesUrl(limit) {
      return this.gamma + '/markets?closed=false&limit=' + (limit || 120) +
             '&order=volume24hr&ascending=false';
    },
    /* PURE. No network. Same function the manual-paste path calls, so a
       pasted payload produces byte-identical rows to a live fetch. */
    normalize(raw) {
      const warnings = [], quotes = [];
      let rejected = 0;
      const arr = Array.isArray(raw) ? raw : (raw && raw.data) || [];
      if (!Array.isArray(arr)) return { quotes:[], events:[], warnings:['payload is not an array'], rejected:0 };
      for (const m of arr) {
        let outs, prices;
        try {
          outs = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
          prices = (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices);
        } catch (e) { rejected++; continue; }
        if (!Array.isArray(outs) || !Array.isArray(prices)) { rejected++; continue; }
        if (outs.length !== prices.length || outs.length < 2) { rejected++; continue; }
        const p = prices.map(Number);
        if (p.some(x => !isFinite(x) || x <= 0 || x >= 1)) { rejected++; continue; }
        const liq = Number(m.liquidity || 0), vol = Number(m.volume || 0);
        const end = m.endDate || m.end_date_iso || null;
        quotes.push({
          srcId: 'polymarket', venueId: 'polymarket',
          nativeId: String(m.id),
          question: String(m.question || m.slug || '').trim(),
          conditionId: m.conditionId || null,
          outcomes: outs.map(String),
          /* Mid signal per outcome, and the decimal price to transact at.
             Gamma has no ask, so ask == mid here and the CLOB call is what
             upgrades it. Flagged so the engine never mistakes a mid for an
             executable price. */
          midProbs: p,
          askProbs: p.slice(),
          bidProbs: p.slice(),
          spreadCents: (m.spread !== undefined && m.spread !== null) ? Number(m.spread) * 100 : null,
          isMidOnly: true,
          liquidityUsd: liq, volumeUsd: vol,
          endDate: end,
          negRisk: !!m.negRisk,
          clobTokenIds: (() => { try {
            return typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
          } catch (e) { return []; } })(),
          fetchedAtMs: Date.now()
        });
      }
      if (rejected) warnings.push(rejected + ' markets rejected (unparseable outcomes/prices)');
      const midOnly = quotes.filter(q => q.isMidOnly).length;
      if (midOnly) warnings.push(midOnly + ' markets are Gamma mids, not executable asks — ' +
        'order-book depth requires the CLOB endpoint');
      return { quotes, events: [], warnings, rejected };
    }
  };

  /* ================================================== THE ODDS API
     The only source that brings MANY sportsbooks at once, which is what the
     consensus actually needs. Key goes in the query string deliberately: a
     custom header would trigger a CORS preflight these endpoints do not
     answer from an opaque origin.
     1 credit = 1 sport x 1 market x 1 region, so cost is stated BEFORE the
     call is made. `outcomes[].name` is a TEAM NAME STRING and must be mapped
     to home/away via the event's home_team -- never by array order. */
  const oddsapi = {
    id: 'oddsapi', label: 'The Odds API', kind: 'rest',
    base: 'https://api.the-odds-api.com/v4',
    bucket: bucket(5, 0.25),
    capabilities: () => ({ needsKey:true, corsSafe:'yes', quotes:true,
                           settled:true, creditsPerCall:'markets x regions' }),
    /* /sports is documented as NOT consuming a credit, so the key can be
       validated for free before any data pull spends quota. Getting a 401
       after burning credits is a bad first experience. */
    healthUrl(key) { return this.base + '/sports/?apiKey=' + encodeURIComponent(key || 'probe'); },
    validateUrl(key) { return this.base + '/sports/?apiKey=' + encodeURIComponent(key); },
    quotesUrl(key, sportKey, markets, regions) {
      return this.base + '/sports/' + sportKey + '/odds/?apiKey=' + encodeURIComponent(key) +
        '&regions=' + (regions || 'us') + '&markets=' + (markets || 'h2h,spreads,totals') +
        '&oddsFormat=decimal&dateFormat=iso';
    },
    cost(markets, regions) {
      return (markets || 'h2h,spreads,totals').split(',').length *
             (regions || 'us').split(',').length;
    },
    normalize(raw) {
      const warnings = [], quotes = [];
      let rejected = 0;
      const arr = Array.isArray(raw) ? raw : [];
      for (const ev of arr) {
        const home = ev.home_team, away = ev.away_team;
        if (!ev.bookmakers) { rejected++; continue; }
        for (const bk of ev.bookmakers) {
          for (const mk of (bk.markets || [])) {
            const outs = mk.outcomes || [];
            if (outs.length < 2) { rejected++; continue; }
            const sides = [], decs = [], points = [];
            let ok = true;
            for (const o of outs) {
              const d = Number(o.price);
              if (!isFinite(d) || d <= 1) { ok = false; break; }
              /* Map by NAME, not by position. A reversed array must still
                 resolve correctly. */
              let side;
              if (mk.key === 'totals') side = String(o.name).toLowerCase();
              else if (o.name === home) side = 'home';
              else if (o.name === away) side = 'away';
              else if (String(o.name).toLowerCase() === 'draw') side = 'draw';
              else side = String(o.name);
              sides.push(side); decs.push(d);
              points.push(o.point === undefined ? null : Number(o.point));
            }
            if (!ok) { rejected++; continue; }
            /* The handicap has to be carried in ONE orientation or the same
               market splits in two. `line` was the first non-null point,
               i.e. the point of whichever side the book happened to list
               first -- so a book listing the away team first landed under
               +3.5 while the rest sat under -3.5, halving the book count on
               both. homeLine pins it to the home side, which is also the
               orientation ESPN publishes, so the two feeds can be matched. */
            const hix = sides.indexOf('home');
            const homeLine = (hix >= 0 && points[hix] !== null && points[hix] !== undefined)
              ? Number(points[hix]) : null;
            quotes.push({
              srcId: 'oddsapi', venueId: bk.key, venueLabel: bk.title, homeLine,
              nativeId: ev.id, sportKey: ev.sport_key,
              eventLabel: (away && home) ? (away + ' @ ' + home) : (ev.sport_title || ''),
              home, away,
              marketKey: mk.key, sides, decimals: decs, points,
              line: points.find(x => x !== null) !== undefined ? points.find(x => x !== null) : null,
              commenceTime: ev.commence_time,
              lastUpdate: mk.last_update || bk.last_update || null,
              fetchedAtMs: Date.now()
            });
          }
        }
      }
      if (rejected) warnings.push(rejected + ' markets rejected (bad price or outcome count)');
      const venues = {};
      for (const q of quotes) venues[q.venueId] = q.venueLabel;
      return { quotes, events: [], warnings, rejected,
               venuesDiscovered: Object.keys(venues).map(k => ({ id:k, label:venues[k] })) };
    }
  };


  /* ================================================== ESPN (free, no key)
     Probed 2026-09-06: site.api.espn.com returns HTTP 200 with
     `access-control-allow-origin: *`, so it is callable straight from
     file:// with no key and no signup. Today it carried real odds on 16/16
     NFL games, 15/15 MLB and 4/25 NCAAF.
     THE LIMITATION THAT MATTERS: ESPN publishes exactly ONE provider
     (DraftKings). I checked their deeper core-API odds endpoint too and it
     also returns a single item. So this gives real games, real teams, real
     start times and a real price -- but one venue, therefore one cluster,
     therefore no consensus. The breadth gate will correctly refuse to price
     it. It makes the board REAL; it does not make it a value board. */
  const espn = {
    id: 'espn', label: 'ESPN (DraftKings)', kind: 'rest',
    /* HOST CHOICE IS LOAD-BEARING AND WAS FOUND BY TESTING, NOT BY READING
       HEADERS. `site.api.espn.com` returns `access-control-allow-origin: *`
       to curl and looks perfectly callable -- and a real browser fetch to it
       fails in 10ms from BOTH a file:// origin and an http://localhost
       origin. curl does not enforce CORS, so verifying the header proves
       nothing about the browser.
       Measured, per host, from a real page:
         site.api.espn.com        BLOCKED  (curl 200, browser throws)
         sports.core.api.espn.com READABLE (but 2 requests per game)
         cdn.espn.com/core        READABLE and returns the whole scoreboard,
                                  odds included, in ONE call.
       So this uses cdn.espn.com. Its payload nests the scoreboard under
       content.sbData.events rather than at the top level. */
    base: 'https://cdn.espn.com/core',
    bucket: bucket(10, 1),
    LEAGUES: {
      NFL:'nfl', NCAAF:'college-football', NBA:'nba',
      NCAAB:'mens-college-basketball', MLB:'mlb', NHL:'nhl', SOC:'soccer'
    },
    capabilities: () => ({ needsKey:false, corsSafe:'yes', quotes:true,
                           settled:false, singleProvider:true, creditsPerCall:'free' }),
    healthUrl() { return this.base + '/nfl/scoreboard?xhr=1'; },
    /* cdn.espn.com ignores `limit` and `dates` -- verified: every variant
       returns the same 25-event window centred on now. That window did
       contain every currently-priced game in each league I checked
       (NFL 16/16, NCAAF 4, MLB 5), because ESPN prices near kickoff. On a
       full college Saturday the window can truncate, which the load summary
       reports rather than hiding. */
    quotesUrl(cat) {
      const path = this.LEAGUES[cat] || this.LEAGUES.NFL;
      let u = this.base + '/' + path + '/scoreboard?xhr=1';
      if (cat === 'SOC') u += '&league=eng.1';
      return u;
    },
    dateKey(d) {
      const t = d || new Date();
      const p = (n) => String(n).padStart(2, '0');
      return '' + t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate());
    },

    /* PURE. Same normalizer the paste path uses.
       The prices live in NESTED objects -- `moneyline.home.close.odds`,
       `pointSpread.home.close.{line,odds}`, `total.over.close.{line,odds}` --
       not in the flat `homeTeamOdds.moneyLine` field, which is null on every
       event I checked. Reading the flat field returns real games with no
       prices, which is worse than useless: a line with no price cannot be
       evaluated and would silently drop every market.
       ESPN also ships a DraftKings bet-slip deep link per outcome, which is
       carried through so a row can open the actual bet. */
    normalize(raw, cat) {
      const warnings = [], quotes = [];
      let rejected = 0, noOdds = 0;
      /* cdn.espn.com nests the scoreboard; site.api puts it at the top
         level. Accept both so a pasted payload from either host works. */
      const events = (raw && raw.events)
        || (raw && raw.content && raw.content.sbData && raw.content.sbData.events)
        || [];

      /* Prefer the current/close snapshot, fall back to open. */
      const snap = (side) => (side && (side.close || side.current || side.open)) || null;
      const amer = (v) => {
        if (v === undefined || v === null) return NaN;
        const t = String(v).trim().replace('+', '');
        if (/^even$/i.test(t) || t === 'EV') return 100;
        const n = Number(t);
        return isFinite(n) ? n : NaN;
      };
      const lineNum = (v) => {
        if (v === undefined || v === null) return null;
        const m = String(v).match(/-?\d+(\.\d+)?/);
        return m ? Number(m[0]) : null;
      };
      const link = (side) => {
        const sn = snap(side);
        return (sn && sn.link && sn.link.href) || null;
      };

      let finished = 0, inplay = 0;
      for (const ev of events) {
        const comps = ev.competitions || [];
        if (!comps.length) { rejected++; continue; }
        const c = comps[0];
        const state = ((c.status || {}).type || {}).state || null;
        /* A settled game has no odds and cannot be bet. Counting it as
           "no odds" made a finished Saturday slate look like a feed failure. */
        if (state === 'post') { finished++; continue; }
        if (state === 'in') inplay++;
        const odds = (c.odds || []).filter(Boolean);
        if (!odds.length) { noOdds++; continue; }
        const o = odds[0];
        const prov = (o.provider && o.provider.name) || 'DraftKings';
        const teams = c.competitors || [];
        let home = null, away = null;
        for (const t of teams) {
          const nm = (t.team && (t.team.displayName || t.team.name)) || '';
          if (t.homeAway === 'home') home = nm; else if (t.homeAway === 'away') away = nm;
        }
        if (!home || !away) { rejected++; continue; }

        const row = {
          srcId:'espn', venueId:'draftkings', venueLabel:prov,
          nativeId:String(ev.id), cat:cat || 'NFL',
          eventLabel: away + ' @ ' + home, home, away,
          commenceTime: ev.date || null,
          statusState: ((c.status || {}).type || {}).state || null,
          moneyline:null, spread:null, total:null,
          detailsRaw: o.details || null, fetchedAtMs: Date.now()
        };

        const ml = o.moneyline;
        if (ml) {
          const hs = snap(ml.home), as = snap(ml.away);
          const h = amer(hs && hs.odds), a = amer(as && as.odds);
          if (isFinite(h) && isFinite(a) && Math.abs(h) >= 100 && Math.abs(a) >= 100) {
            row.moneyline = { home:h, away:a,
                              linkHome: link(ml.home), linkAway: link(ml.away) };
          }
        }
        const ps = o.pointSpread;
        if (ps) {
          const hs = snap(ps.home), as = snap(ps.away);
          const hl = lineNum(hs && hs.line);
          const h = amer(hs && hs.odds), a = amer(as && as.odds);
          if (hl !== null && isFinite(h) && isFinite(a)
              && Math.abs(h) >= 100 && Math.abs(a) >= 100) {
            row.spread = { line:hl, home:h, away:a,
                           linkHome: link(ps.home), linkAway: link(ps.away) };
          }
        }
        const tt = o.total;
        if (tt) {
          const os_ = snap(tt.over), us = snap(tt.under);
          const tl = lineNum(os_ && os_.line);
          const ov = amer(os_ && os_.odds), un = amer(us && us.odds);
          if (tl !== null && isFinite(ov) && isFinite(un)
              && Math.abs(ov) >= 100 && Math.abs(un) >= 100) {
            row.total = { line:tl, over:ov, under:un,
                          linkOver: link(tt.over), linkUnder: link(tt.under) };
          }
        }
        if (!row.moneyline && !row.spread && !row.total) { noOdds++; continue; }
        quotes.push(row);
      }
      const nMl = quotes.filter(q => q.moneyline).length;
      const nSp = quotes.filter(q => q.spread).length;
      const nTo = quotes.filter(q => q.total).length;
      warnings.push(events.length + ' events returned · ' + quotes.length + ' upcoming and priced · ' +
        finished + ' already final · ' + noOdds + ' not priced yet' +
        (inplay ? ' · ' + inplay + ' in progress' : '') +
        (rejected ? ' · ' + rejected + ' malformed' : ''));
      warnings.push('priced markets: ' + nMl + ' moneyline, ' + nSp + ' spread, ' + nTo + ' total');
      warnings.push('ESPN publishes ONE provider (' + ((quotes[0] && quotes[0].venueLabel) ||
        'DraftKings') + '). These are REAL prices from a single venue, so the consensus ' +
        'cannot form: markets will read NO PRICE until a multi-book source is connected.');
      return { quotes, events: [], warnings, rejected };
    }
  };

  const byId = { polymarket, oddsapi, espn };
  return { HEALTH, bucket, take, probe, polymarket, oddsapi, espn, byId };
})();
