/* --------------------------------------------------------- L2 live ingest */
VB.live = (function () {
  const A = VB.adapters, O = VB.odds, SD = VB.seed;

  /* Map The Odds API bookmaker keys onto the existing venue registry so live
     books inherit their tier and, critically, their CLUSTER. Getting the
     cluster wrong is not cosmetic: FanDuel and Betfair share a parent, so if
     they land in separate clusters the leave-one-cluster-out consensus lets a
     corporate sibling vote in the fair line that judges its own group. */
  const KEYMAP = {
    /* Feed key -> venue in our registry. Mapping a book onto a registry
       venue is how it inherits that venue's tier. Books NOT listed here get
       their own id, which is deliberate: two different companies must never
       share a venue id or their quotes overwrite each other. */
    draftkings:'draftkings', fanduel:'fanduel', betmgm:'betmgm',
    caesars:'caesars', williamhill_us:'caesars',
    betrivers:'betrivers', espnbet:'espnbet', fanatics:'fanatics',
    betonlineag:'betonline', bovada:'bovada',
    pinnacle:'pinnacle', novig:'novig', prophetx:'prophetx',
    bet365:'bet365', bet365_au:'bet365', smarkets:'smarkets',
    betfair:'betfair', betfair_ex_uk:'betfair', betfair_ex_eu:'betfair',
    betfair_ex_au:'betfair', betfair_sb_uk:'betfair',
    superbook:'circa', circasports:'circa'
  };

  /* Shared pricing lineage, kept SEPARATE from the id mapping.
     Conflating them was a real bug: LowVig, BetUS and MyBookie were all
     mapped to the venue id `betonline`, so their quotes overwrote each other
     in the per-venue map and 9 books silently collapsed to 6 -- losing the
     prices the best-price comparison exists to find. Distinct ids keep every
     price; the shared CLUSTER still gives the family ONE vote in the
     consensus, which is the part that matters. */
  const CLUSTERMAP = {
    lowvig:'offshore', betonlineag:'offshore', mybookieag:'offshore',
    betus:'offshore', everygame:'offshore', betanything:'offshore',
    gtbets:'offshore',
    fanduel:'flutter', betfair:'flutter', betfair_ex_uk:'flutter',
    betfair_ex_eu:'flutter', betfair_ex_au:'flutter', betfair_sb_uk:'flutter',
    ballybet:'betrivers', betparx:'betrivers', windcreek:'betrivers',
    unibet_us:'kindred', unibet_eu:'kindred', unibet_nl:'kindred',
    unibet_se:'kindred', leovegas_se:'kindred',
    nordicbet:'betsson', betsson:'betsson', coolbet:'betsson',
    hardrockbet:'fanatics', wynnbet:'betmgm', tipico_us:'betmgm',
    marathonbet:'marathon', williamhill_us:'caesars', matchbook:'matchbook'
  };
  /* Sharp references: an exchange or a market-maker. The gate requires at
     least one of these before it will produce a fair price at all. */
  const TIER1 = { pinnacle:1, betfair:1, betfair_ex_eu:1, betfair_ex_uk:1,
                  matchbook:1, smarkets:1, circasports:1, superbook:1 };

  /* An unknown live venue is registered ENABLED but NOT in the consensus.
     A source we have never measured must not be able to silently move the
     fair line on its first appearance. */
  /* RECOGNISED BOOKS ARE ALLOWED TO VOTE.
     Without this, only Pinnacle, Betfair and BetOnline were voting -- three
     clusters -- and leave-one-cluster-out drops the offer's own, leaving two
     against a gate that needs three. 486 real markets loaded and produced
     zero consensus rows. The safeguard that an UNKNOWN source must not move
     the fair line still holds; these are simply not unknown. Each carries a
     real cluster so corporate groups count once, not once per brand. */
  const KNOWN = {
    williamhill:{n:'William Hill',c:'williamhill',t:2},
    unibet_eu:{n:'Unibet',c:'kindred',t:2}, unibet_nl:{n:'Unibet NL',c:'kindred',t:2},
    unibet_se:{n:'Unibet SE',c:'kindred',t:2}, unibet_uk:{n:'Unibet UK',c:'kindred',t:2},
    leovegas_se:{n:'LeoVegas',c:'kindred',t:2},
    nordicbet:{n:'NordicBet',c:'betsson',t:2}, betsson:{n:'Betsson',c:'betsson',t:2},
    coolbet:{n:'Coolbet',c:'betsson',t:2},
    marathonbet:{n:'Marathon Bet',c:'marathon',t:2},
    onexbet:{n:'1xBet',c:'onexbet',t:2}, tipico:{n:'Tipico',c:'tipico',t:2},
    betclic:{n:'Betclic',c:'betclic',t:2}, pmu:{n:'PMU',c:'pmu',t:2},
    gtbets:{n:'GTbets',c:'offshore',t:3}, everygame:{n:'Everygame',c:'offshore',t:3},
    mybookieag:{n:'MyBookie',c:'offshore',t:3}, lowvig:{n:'LowVig',c:'offshore',t:3},
    betus:{n:'BetUS',c:'offshore',t:3}, betanything:{n:'BetAnything',c:'betanything',t:3},
    /* Exchanges are sharp references, hence tier 1. */
    matchbook:{n:'Matchbook',c:'matchbook',t:1}, smarkets:{n:'Smarkets',c:'smarkets',t:1}
  };

  function resolveVenue(key, label, registry) {
    const mapped = KEYMAP[key];
    if (mapped && registry[mapped]) {
      const cl = CLUSTERMAP[key];
      if (cl) registry[mapped].cluster = cl;
      return { id: mapped, known: true };
    }
    const k = KNOWN[key];
    const id = k ? key : ('live_' + key);
    if (!registry[id]) {
      registry[id] = { id, name: (k && k.n) || label || key,
                       cluster: (k && k.c) || CLUSTERMAP[key] || id,
                       tier: k ? k.t : 3,
                       kind: 'book', model: 'fixed_odds',
                       publishesProbability: false, depthTier: 2, cov: 0.5,
                       limitUsd: 320, updSec: 60, fee: null, sigma: null,
                       accessible: false,
                       /* A named book votes; a genuinely unknown one does not. */
                       includeInConsensus: !!k,
                       enabled: true, claHist: 0, sharp: 50, isLive: true };
    }
    return { id, known: !!k };
  }


  const SPORT_CAT = {
    americanfootball_nfl:'NFL', americanfootball_ncaaf:'NCAAF',
    baseball_mlb:'MLB', basketball_nba:'NBA', basketball_ncaab:'NCAAB',
    icehockey_nhl:'NHL', soccer_epl:'SOC', soccer_usa_mls:'SOC',
    soccer_uefa_champs_league:'SOC', tennis_atp_us_open:'TEN',
    mma_mixed_martial_arts:'MMA', golf_pga_championship:'GOLF'
  };
  const MKT_LABEL = { h2h:'MONEYLINE', spreads:'SPREAD', totals:'TOTAL',
                      h2h_3_way:'1X2', outrights:'OUTRIGHT' };

  /* Build canonical markets from Odds API rows. The aggregator already
     normalized event ids and team strings, so grouping on
     (nativeId | marketKey | line) is an EXACT key -- this is the
     trust-the-aggregator path, and it is why pairConfidence is 1.0 here
     rather than something fuzzy. There is no numeric tolerance on `line`,
     ever: a -3.5 can never group with a -3.0. */
  function marketsFromOddsApi(norm, registry, nowMs) {
    const groups = {};
    const discovered = [];
    for (const q of norm.quotes) {
      const v = resolveVenue(q.venueId, q.venueLabel, registry);
      if (!v.known) discovered.push({ key:q.venueId, label:q.venueLabel, id:v.id });
      /* Spreads group on the HOME handicap, never on "whichever point the
         book listed first" -- see homeLine in the adapter. Totals are
         orientation-free, so their own line is already canonical. */
      const canon = q.marketKey === 'spreads'
        ? (q.homeLine === null || q.homeLine === undefined ? q.line : q.homeLine)
        : q.line;
      const lineKey = (canon === null || canon === undefined) ? 'null' : String(canon);
      const key = q.nativeId + '|' + q.marketKey + '|' + lineKey;
      let g = groups[key];
      if (!g) {
        /* Outcome order is fixed by the FIRST venue seen and every later
           venue is mapped onto it by side name, so a venue that lists
           outcomes in a different order still lands in the right column. */
        g = groups[key] = {
          /* Deterministic, not positional. The id used to embed the group's
             insertion index, so a refresh that returned events in a
             different order renumbered every market and broke any open
             drill-down link. */
          id: 'L_' + q.nativeId + '_' + q.marketKey + '_' + lineKey,
          eventId: 'LE_' + q.nativeId,
          cat: SPORT_CAT[q.sportKey] || 'OTHER',
          kind: q.marketKey === 'totals' ? 'total'
              : q.marketKey === 'spreads' ? 'spread' : 'moneyline',
          eventLabel: q.eventLabel,
          marketLabel: MKT_LABEL[q.marketKey] || q.marketKey.toUpperCase(),
          outcomes: q.sides.slice(),
          line: canon === undefined ? null : canon,
          startMs: q.commenceTime ? Date.parse(q.commenceTime) : NaN,
          startSec: q.commenceTime ? Math.max(0, (Date.parse(q.commenceTime) - nowMs) / 1000) : NaN,
          isLive: false, pairConfidence: 1, srcId: 'oddsapi', quotes: []
        };
      }
      const upd = q.lastUpdate ? Date.parse(q.lastUpdate) : nowMs;
      const ageSec = Math.max(0, Math.round((nowMs - upd) / 1000));
      for (let i = 0; i < q.sides.length; i++) {
        const ix = g.outcomes.indexOf(q.sides[i]);
        if (ix < 0) continue;                    /* side this market does not carry */
        g.quotes.push({ venueId: v.id, outcomeIx: ix,
                        dGross: q.decimals[i], bidProb: null, askProb: null,
                        spreadCents: null, ageSec, ts: upd, srcId: 'oddsapi' });
      }
    }
    return { markets: Object.keys(groups).map(k => groups[k]), discovered };
  }

  /* Polymarket contracts arrive as standalone questions. They are NOT
     auto-matched to sportsbook markets: two contracts can be identical in
     spirit and settle differently, and auto-linking on the question string
     eventually pairs two markets that resolve on different criteria and
     prints a fake edge. So each becomes a single-venue market, which the
     breadth gate then correctly reports as NO PRICE rather than inventing a
     consensus from one opinion. */
  function marketsFromPolymarket(norm, registry, nowMs) {
    const out = [];
    if (!registry['polymarket']) return out;
    norm.quotes.forEach((q, n) => {
      if (q.outcomes.length !== 2) return;       /* multi-outcome negRisk groups deferred */
      const m = { id: 'PM' + n, eventId: 'PME' + n, cat: catForQuestion(q.question),
                  kind: 'binary', eventLabel: q.question.slice(0, 70),
                  marketLabel: 'BINARY', outcomes: q.outcomes.slice(), line: null,
                  startSec: q.endDate ? Math.max(0, (Date.parse(q.endDate) - nowMs) / 1000) : NaN,
                  isLive: false, pairConfidence: 1, srcId: 'polymarket',
                  liquidityUsd: q.liquidityUsd, isMidOnly: q.isMidOnly, quotes: [] };
      for (let i = 0; i < 2; i++) {
        m.quotes.push({ venueId: 'polymarket', outcomeIx: i,
                        dGross: 1 / q.askProbs[i],
                        bidProb: q.bidProbs[i], askProb: q.askProbs[i],
                        spreadCents: q.spreadCents, ageSec: 5, ts: nowMs - 5000,
                        srcId: 'polymarket' });
      }
      out.push(m);
    });
    return out;
  }
  function catForQuestion(q) {
    const s = String(q).toLowerCase();
    if (/\b(nfl|touchdown|super bowl)\b/.test(s)) return 'NFL';
    if (/\b(nba|finals mvp)\b/.test(s)) return 'NBA';
    if (/\b(mlb|world series)\b/.test(s)) return 'MLB';
    if (/\b(nhl|stanley cup)\b/.test(s)) return 'NHL';
    if (/\b(premier league|la liga|serie a|uefa|fc|united|city)\b/.test(s)) return 'SOC';
    if (/\b(fed|cpi|rate|inflation|recession|gdp)\b/.test(s)) return 'ECON';
    if (/\b(senate|house|president|election|governor|nominee)\b/.test(s)) return 'POL';
    if (/\b(oscar|emmy|grammy|box office|album)\b/.test(s)) return 'AWD';
    if (/\b(ai|gpt|openai|model|chip|ipo|antitrust)\b/.test(s)) return 'TECH';
    return 'OTHER';
  }
  /* ESPN -> markets. Real games, real prices, ONE venue. Each market gets a
     single quote, which the breadth gate then correctly reports as NO PRICE
     rather than inventing a fair line from one opinion. The point of loading
     it is that the schedule, the teams, the start times and the price are
     all real. */
  function marketsFromEspn(norm, registry, nowMs) {
    const out = [];
    if (!registry['draftkings']) return out;
    const O = VB.odds;
    const q2 = (dh, da, link1, link2) => ([
      { venueId:'draftkings', outcomeIx:0, dGross:dh, bidProb:null, askProb:null,
        spreadCents:null, ageSec:20, ts:nowMs - 20000, srcId:'espn', deepLink:link1 },
      { venueId:'draftkings', outcomeIx:1, dGross:da, bidProb:null, askProb:null,
        spreadCents:null, ageSec:20, ts:nowMs - 20000, srcId:'espn', deepLink:link2 }
    ]);
    for (const q of norm.quotes) {
      const startSec = q.commenceTime
        ? Math.max(0, (Date.parse(q.commenceTime) - nowMs) / 1000) : NaN;
      const base = { eventId:'ES_' + q.nativeId, cat:q.cat, eventLabel:q.eventLabel,
                     startMs: q.commenceTime ? Date.parse(q.commenceTime) : NaN,
                     startSec, isLive: q.statusState === 'in',
                     pairConfidence:1, srcId:'espn' };
      if (q.moneyline) {
        const dh = O.americanToDecimal(q.moneyline.home);
        const da = O.americanToDecimal(q.moneyline.away);
        if (isFinite(dh) && isFinite(da)) out.push(Object.assign({}, base, {
          id:'ESM' + q.nativeId, kind:'moneyline', marketLabel:'MONEYLINE',
          outcomes:['home','away'], line:null,
          quotes:q2(dh, da, q.moneyline.linkHome, q.moneyline.linkAway) }));
      }
      if (q.spread) {
        const dh = O.americanToDecimal(q.spread.home);
        const da = O.americanToDecimal(q.spread.away);
        if (isFinite(dh) && isFinite(da)) out.push(Object.assign({}, base, {
          id:'ESS' + q.nativeId, kind:'spread', marketLabel:'SPREAD',
          outcomes:['home','away'], line:q.spread.line,
          quotes:q2(dh, da, q.spread.linkHome, q.spread.linkAway) }));
      }
      if (q.total) {
        const dov = O.americanToDecimal(q.total.over);
        const dun = O.americanToDecimal(q.total.under);
        if (isFinite(dov) && isFinite(dun)) out.push(Object.assign({}, base, {
          id:'EST' + q.nativeId, kind:'total', marketLabel:'TOTAL',
          outcomes:['over','under'], line:q.total.line,
          quotes:q2(dov, dun, q.total.linkOver, q.total.linkUnder) }));
      }
    }
    return out;
  }

  /* ------------------------------------------------- CROSS-SOURCE MERGE
     Each feed built its own market objects, so the same NFL game existed
     twice: an ESPN copy carrying DraftKings alone, and an Odds API copy
     carrying the EU books. Nothing joined them. Two consequences, both
     fatal to the point of the app:

       1. Every game was listed twice, so the board's game count was double
          the real slate.
       2. The book you can actually bet at sat in a different market object
          from the consensus that would judge it. DraftKings came from ESPN;
          the sharp anchors came from `regions=eu`. So the one comparison
          this product exists to make -- is DraftKings' price beatable --
          was never computed. Clicking a game landed on whichever copy the
          layout picked, and the ESPN copy has one book, which cannot clear
          a 3-cluster gate. Hence "NO CALL" on a market that 21 books quote.

     The join is strict on purpose. Key is league + normalized matchup +
     market kind + handicap, and the two candidates must start within six
     hours of each other. No fuzzy team matching and no numeric tolerance on
     the line: a -3.5 never merges with a -3.0, and a mispaired market would
     print an edge that does not exist, which is worse than showing none. */
  function mergeKeyOf(m) {
    const label = String(m.eventLabel || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9@]+/g, ' ').trim();
    if (!label || !m.kind) return null;
    const lineKey = (m.line === null || m.line === undefined) ? 'null' : String(m.line);
    return String(m.cat) + '|' + label + '|' + String(m.kind) + '|' + lineKey;
  }

  function mergeSources(markets) {
    const out = [], groups = {}, order = [], eventAlias = {};
    for (const m of (markets || [])) {
      const k = mergeKeyOf(m);
      if (!k) { out.push(m); continue; }
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(m);
    }
    const SIX_H = 6 * 3600 * 1000;
    for (const k of order) {
      const set = groups[k];
      if (set.length === 1) { out.push(set[0]); continue; }
      /* Same key, but verify the kickoffs agree before joining. */
      const anchor = set.find(m => isFinite(m.startMs)) || set[0];
      const join = [], reject = [];
      for (const m of set) {
        const ok = !isFinite(m.startMs) || !isFinite(anchor.startMs)
          || Math.abs(m.startMs - anchor.startMs) <= SIX_H;
        (ok ? join : reject).push(m);
      }
      for (const m of reject) out.push(m);
      if (join.length === 1) { out.push(join[0]); continue; }
      /* Outcome order is fixed by the first member; later members map onto
         it by side NAME, so a feed that lists the sides the other way round
         still lands in the right column. A member whose sides cannot be
         mapped is kept separate rather than silently bent to fit. */
      const baseIx = join.findIndex(m => m.srcId === 'espn');
      const base = join[baseIx >= 0 ? baseIx : 0];
      const outcomes = base.outcomes.slice();
      const merged = Object.assign({}, base, {
        outcomes, quotes: [], srcIds: [], ids: [],
        srcId: 'merged', pairConfidence: 1
      });
      const seen = {};                 /* venueId|ix -> the quote we kept */
      let dropped = 0;
      for (const m of join) {
        const map = m.outcomes.map(o => outcomes.indexOf(o));
        if (map.some(x => x < 0)) { out.push(m); continue; }
        merged.ids.push(m.id);
        if (m.eventId !== base.eventId) eventAlias[m.eventId] = base.eventId;
        if (merged.srcIds.indexOf(m.srcId) < 0) merged.srcIds.push(m.srcId);
        if (isFinite(m.pairConfidence)) {
          merged.pairConfidence = Math.min(merged.pairConfidence, m.pairConfidence);
        }
        merged.isLive = merged.isLive || m.isLive;
        for (const q of m.quotes) {
          const ix = map[q.outcomeIx];
          if (ix === undefined || ix < 0) { dropped++; continue; }
          const kk = q.venueId + '|' + ix;
          const prev = seen[kk];
          /* One venue reached by two feeds: keep the fresher quote. Age is
             the tiebreak because a stale duplicate would otherwise decide
             the price purely by feed ordering. */
          if (prev && !(isFinite(q.ageSec) && isFinite(prev.ageSec) && q.ageSec < prev.ageSec)) {
            dropped++; continue;
          }
          const copy = Object.assign({}, q, { outcomeIx: ix });
          if (prev) {
            merged.quotes[merged.quotes.indexOf(prev)] = copy;
          } else merged.quotes.push(copy);
          seen[kk] = copy;
        }
      }
      if (!merged.ids.length) continue;
      if (merged.ids.length === 1) { out.push(join.find(m => m.id === merged.ids[0])); continue; }
      merged.id = merged.ids[0];
      merged.mergedFrom = merged.ids.slice();
      merged.mergedDropped = dropped;
      out.push(merged);
    }
    /* Joining the main markets is not enough to make a game ONE game. A
       book quoting -3.0 when the rest are on -3.5 produces a spread market
       with no counterpart in the other feed, so it stays unjoined and drags
       its own feed's event id along with it -- and the games layout, which
       groups by event id, shows the matchup twice: once with the joined
       markets, once with the leftover alternate lines. So every event id
       that took part in a join is rewritten to the surviving one, which
       collapses the alternates into the same band. Rewriting is done on
       copies: M.slate.markets is the raw per-feed store that refresh keys
       off, and mutating it here would corrupt the next refresh. */
    if (!Object.keys(eventAlias).length) return out;
    return out.map((m) => {
      const to = eventAlias[m.eventId];
      return to ? Object.assign({}, m, { eventId: to, eventIdWas: m.eventId }) : m;
    });
  }

  return { KEYMAP, resolveVenue, mergeSources, mergeKeyOf,
           marketsFromOddsApi, marketsFromPolymarket, marketsFromEspn,
           SPORT_CAT, MKT_LABEL, catForQuestion };
})();
