/* ----------------------------------------------------------- L2 pipeline */
VB.pipe = (function () {
  const U = VB.util, O = VB.odds, D = VB.devig, C = VB.consensus,
        K = VB.stake, A = VB.arb, M = VB.multiplicity, SC = VB.score;
  const { clamp } = U;

  const DEFAULTS = {
    lambda: 0.25, R: 0.35,
    minEVPct: 0.020, minEdgePP: 0.010, minT: 2.0,
    minClusters: 3, requireTier1: true, maxAgeMin: 15,
    multiplicityAdjust: true,          /* no toggle */
    accessibleOnly: true,
    arbSuspect: 0.04, quoteOutlierPP: 0.06,
    caps: { maxStakeUnits: 2.0, maxStakePctBankroll: 0.02,
            maxPerEventUnits: 3.0, maxPerPlayerUnits: 2.0,
            maxOpenUnits: 10.0, maxDailyUnits: 10.0 }
  };

  /* Verdict precedence, first match wins. Order matters: a row must not be
     called PASS when the real reason is that its pairing is suspect. */
  const VERDICT_ORDER = ['NO PRICE','SUSPECT','AGED','LIMITED','PASS','THIN','BET'];

  /* PHASE A -- market-derived. Depends on quotes, the venue set and the
     staleness gate. INDEPENDENT of every money setting, which is why
     changing bankroll or risk level cannot move EDGE, t, or the verdict's
     pricing inputs. */
  function phaseA(market, venuesById, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const nOut = market.outcomes.length;

    /* Group quotes by venue and devig each venue's own complete book. */
    const byVenue = {};
    for (const q of market.quotes) {
      (byVenue[q.venueId] = byVenue[q.venueId] || [])[q.outcomeIx] = q;
    }
    const vList = [], vProbs = [], vMeta = [];
    for (const vid in byVenue) {
      const row = byVenue[vid], v = venuesById[vid];
      if (!v || !v.enabled) continue;
      let complete = true;
      for (let i = 0; i < nOut; i++) if (!row[i]) complete = false;
      if (!complete) continue;         /* an incomplete set cannot be devigged */

      let probs, md = null, bDevig = 0;
      /* An exchange is only an order book if the feed actually carried the
         book. Betfair and Matchbook arrive from The Odds API as plain back
         prices with no depth at all, and midpoint(null, null) is NaN -- one
         such venue in the pool turned every fair price in the market into
         NaN, because a logit pool has no immunity to a single bad member.
         Measured on a 20-book NFL market: 38 of 40 rows lost their fair
         price, and the two that survived were the exchange's own rows,
         which are the only ones that exclude its cluster.
         So the treatment follows the DATA, not the venue's label: with a
         two-sided book, use the mid; with back prices only, de-vig them
         like any other price. The "do not devig an exchange" rule is about
         a MID, which is already near vig-free. A back price is not a mid --
         it carries the exchange's spread on one side, so de-vigging the two
         back prices is the correct treatment, not a double-count. */
      /* Number.isFinite, not the global isFinite, and the difference is the
         whole bug: the global one coerces, so isFinite(null) is true --
         a missing bid reads as present, the mid comes back NaN, and the
         pool it feeds is NaN too. Every depth check here is strict. */
      let hasBook = v.model === 'order_book';
      if (hasBook) {
        for (let i = 0; i < nOut; i++) {
          if (!Number.isFinite(row[i].bidProb) || !Number.isFinite(row[i].askProb)) {
            hasBook = false; break;
          }
        }
      }
      if (hasBook) {
        const mid = [];
        for (let i = 0; i < nOut; i++) mid.push(D.midpoint(row[i].bidProb, row[i].askProb));
        const Z = mid.reduce((a, b) => a + b, 0);
        probs = mid.map(x => x / Z);
        bDevig = 0.003;                /* spread-to-mid uncertainty: an order book
                                          carries less model risk than a devig, but
                                          not none. */
      } else {
        const ds = [];
        for (let i = 0; i < nOut; i++) ds.push(row[i].dGross);
        md = D.medianDevig(ds);
        probs = md.p;
        /* b_devig is a BIAS FLOOR, not just the observed method spread.
           On a symmetric two-way market all four methods coincide, so the
           spread is ~0 -- but agreement is not evidence of correctness:
           every method assumes the book's margin allocation follows one of
           four rules, and they can share the same error. Letting b_devig
           fall to zero produced t values of 20 and a board that looked
           certain about a modelling assumption. */
        bDevig = Math.max(C.B_DEVIG, md.bDevig.reduce((a, b) => a + b, 0) / nOut);
      }
      vList.push(Object.assign({}, v, {
        ageSec: row[0].ageSec,
        spreadCents: row[0].spreadCents,
        limitUsd: v.limitUsd
      }));
      /* A venue that still cannot produce usable probabilities does not
         join the pool at all. Dropping it costs one voter; letting it in
         costs every fair price in the market. */
      let usable = true;
      for (let i = 0; i < nOut; i++) {
        if (!(Number.isFinite(probs[i]) && probs[i] > 0 && probs[i] < 1)) { usable = false; break; }
      }
      if (!usable) { vList.pop(); continue; }
      vProbs.push(probs);
      vMeta.push({ vid, row, md, bDevig, priceOnlyExchange: v.model === 'order_book' && !hasBook });
    }

    /* One offer row per (venue, outcome). Each gets its OWN consensus with
       its entire cluster removed -- the full weight pipeline is re-run per
       offer rather than using the algebraic shortcut, because cluster caps
       reallocate weight when a member is removed and the shortcut is only
       exact if the weights are unchanged. */
    const rows = [];
    for (let vi = 0; vi < vList.length; vi++) {
      const v = vList[vi], meta = vMeta[vi];
      const built = C.build(vList, vProbs, { excludeCluster: v.cluster });
      const all = C.build(vList, vProbs, {});
      for (let ix = 0; ix < nOut; ix++) {
        const q = meta.row[ix];
        const dGross = q.dGross;
        const dNet = VB.seed.netDecimal(dGross, v);
        const qo = 1 / dNet;
        const r = {
          marketId: market.id, eventId: market.eventId, cat: market.cat,
          eventLabel: market.eventLabel, marketLabel: market.marketLabel,
          side: market.outcomes[ix], line: market.line,
          startSec: market.startSec, isLive: !!market.isLive,
          kind: market.kind, playerKey: market.playerKey || null,
          srcId: market.srcId || 'demo',
          venueId: v.id, venueName: v.name, venueTier: v.tier,
          cluster: v.cluster, accessible: !!v.accessible,
          dGross, dNet, qo, ageSec: q.ageSec, limitUsd: v.limitUsd,
          pairConfidence: market.pairConfidence === undefined ? 1 : market.pairConfidence,
          methodNames: meta.md ? meta.md.names : ['orderbook_mid'],
          methodProbs: meta.md ? meta.md.methods : null,
          pOwnDevig: vProbs[vi][ix]
        };
        if (!built.ok) { r.noPrice = built.reason; rows.push(r); continue; }

        r.pFair = built.p[ix];
        r.pFairAll = all.ok ? all.p[ix] : NaN;
        r.vEff = built.vEff;
        r.nVoters = built.nVoters;
        r.nClusters = built.nClusters;
        r.hasT1 = built.hasT1;

        /* Edge against the RAW OFFERED PRICE, never against this venue's own
           devigged probability. That bug roughly doubles the answer -- it
           manufactures edge out of vig -- and it is the single most
           expensive mistake in this class of app. */
        r.ep = r.pFair - r.qo;
        r.evNet = r.pFair * r.dNet - 1;
        r.evGross = r.pFair * r.dGross - 1;

        const seL = built.seLogitByOutcome ? built.seLogitByOutcome[ix] : built.seLogit;
        const se = C.seTotal(r.pFair, seL);
        const ageMin = q.ageSec / 60;
        r.bStale = M.bStale(ageMin);
        r.seSamp = se.seSamp;
        r.seTotal = Math.sqrt(se.seSamp * se.seSamp
                              + meta.bDevig * meta.bDevig
                              + r.bStale * r.bStale);
        r.t = r.seTotal > 0 ? r.ep / r.seTotal : NaN;
        r.signStable = meta.md ? D.signStableFor(meta.md, ix, r.dNet) : true;
        r.outlierThresh = A.quoteOutlierThreshold(v.claHist);
        r.quoteOutlier = A.isQuoteOutlier(r.pOwnDevig, r.pFair, built.nVoters, v.claHist);
        rows.push(r);
      }
    }
    return { rows, nVenues: vList.length };
  }

  /* PHASE B -- multiplicity and gates. M is the count of markets EVALUATED
     this render, not displayed: filtering the board does not refund the
     multiplicity you already paid for. */
  function gate(r, o, M_evaluated) {
    const g = {};
    g.G1 = r.pairConfidence >= 1;
    g.G5 = r.nClusters >= o.minClusters;
    g.G6 = !o.requireTier1 || !!r.hasT1;
    g.G13a = !r.arbSuspect;
    g.G13b = !r.quoteOutlier;
    g.G9 = r.ageSec / 60 <= (o.maxAgeMin || 60);
    g.G12 = !o.accessibleOnly || r.accessible;
    g.G2 = r.evNet >= o.minEVPct;
    g.G3 = r.ep >= o.minEdgePP;
    g.G8 = !!r.signStable;
    g.G10 = r.qo >= 0.02 || r.vEff >= 5;
    g.G7 = isFinite(r.t) && r.t >= o.minT;
    g.G11 = !r.isLive && r.kind !== 'prop' && r.kind !== 'parlay';

    r.eCrit = o.multiplicityAdjust ? M.eCrit(r.seTotal, M_evaluated) : 0;
    r.eAdj = r.ep - r.eCrit;
    g.G4 = !o.multiplicityAdjust || r.eAdj > 0;
    r.gates = g;

    /* Verdict precedence. WHY is ALWAYS populated, max 40 chars. */
    if (r.noPrice || !g.G5 || !g.G6) {
      r.verdict = 'NO PRICE';
      r.why = r.noPrice === 'no_voters' ? 'no other venue prices this'
            : !g.G6 ? 'no sharp venue in consensus'
            : r.nClusters + ' clusters priced, need ' + o.minClusters;
    } else if (!g.G1) { r.verdict = 'SUSPECT'; r.why = 'pairing unconfirmed, see review'; }
    else if (!g.G13a) { r.verdict = 'SUSPECT'; r.why = 'arb ' + (r.arbRoi*100).toFixed(1) + '% implausible, check pairing'; }
    else if (!g.G13b) { r.verdict = 'SUSPECT'; r.why = 'quote ' + ((r.pOwnDevig-r.pFair)*100).toFixed(1) + 'pp off, limit ' + (r.outlierThresh*100).toFixed(1) + 'pp'; }
    else if (!g.G11) { r.verdict = 'NO PRICE'; r.why = r.isLive ? 'live: no cross-venue reference' : r.kind + ': excluded from cross-venue EV'; }
    else if (!g.G9) { r.verdict = 'AGED'; r.why = 'price ' + fmtAge(r.ageSec) + ' old, budget ' + o.maxAgeMin + 'm'; }
    else if (!g.G8) { r.verdict = 'PASS'; r.why = 'devig sign unstable'; }
    else if (r.evNet < 0) { r.verdict = 'PASS'; r.why = 'best price ' + ((-r.evNet)*100).toFixed(1) + '% worse than fair'; }
    else if (!g.G2) { r.verdict = 'PASS'; r.why = 'EV ' + (r.evNet*100).toFixed(1) + '% below ' + (o.minEVPct*100).toFixed(1) + '% bar'; }
    else if (!g.G3) { r.verdict = 'PASS'; r.why = 'edge ' + (r.ep*100).toFixed(2) + 'pp below ' + (o.minEdgePP*100).toFixed(1) + 'pp'; }
    else if (!g.G10) { r.verdict = 'PASS'; r.why = 'deep tail, needs 5 clusters'; }
    else if (!g.G12) { r.verdict = 'LIMITED'; r.why = 'no account marked at ' + r.venueName; }
    else if (!g.G7) { r.verdict = 'THIN'; r.why = 't ' + r.t.toFixed(1) + ' below 2.0, sign unreliable'; }
    else if (!g.G4) { r.verdict = 'THIN'; r.why = 'under noise line ' + (r.eCrit*100).toFixed(2) + 'pp (M=' + M_evaluated + ')'; }
    else { r.verdict = 'BET'; r.why = r.nClusters + ' clusters, t ' + r.t.toFixed(1) + ', sharp anchored'; }
    if (r.why && r.why.length > 40) r.why = r.why.slice(0, 39) + '…';
    return r;
  }

  /* PHASE C -- money. Only this phase depends on bankroll, unit and risk
     level, which is why moving the risk slider can never re-rate the board. */
  function sizeRow(r, settings) {
    if (r.verdict !== 'BET') {
      r.rung = 0; r.amount = 0;
      /* The drill-down may show what it WOULD size; the board may not. */
      if (r.evNet > 0 && settings.bankroll > 0) {
        const w = K.size({ pFair: r.pFair, dNet: r.dNet, unitUsd: settings.unitUsd,
                           bankroll: settings.bankroll, lambda: settings.lambda,
                           R: settings.R });
        r.wouldRung = w.rung; r.wouldAmount = w.amount;
      }
      return r;
    }
    const z = K.size({ pFair: r.pFair, dNet: r.dNet, unitUsd: settings.unitUsd,
                       bankroll: settings.bankroll, lambda: settings.lambda,
                       R: settings.R, nCorr: r.nCorr || 1, rho: r.rho || 0 });
    if (z.unset) { r.rung = null; r.amount = null; r.needsBankroll = true; return r; }
    r.fKelly = z.fKelly; r.fFinal = z.fFinal; r.uRaw = z.uRaw;
    r.rung = z.rung;
    r.amount = z.rung * settings.unitUsd;      /* exactly. 1.0u === unit_$ */
    const cap = K.applyCaps(r.amount, settings.caps, settings.bankroll,
                            settings.unitUsd, r.limitUsd);
    if (cap.stake < r.amount) {
      r.amountCapped = cap.stake; r.cappedBy = cap.cappedBy;
    }
    r.evUsd = (r.amountCapped !== undefined ? r.amountCapped : r.amount) * r.evNet;
    if (r.rung === 0) { r.verdict = 'THIN'; r.why = 'sizes below 0.25u floor'; }
    return r;
  }

  function fmtAge(s) {
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60 ? String(s % 60).padStart(2,'0') + 's' : '');
    return (s / 3600).toFixed(1) + 'h';
  }

  /* Arb detection per market, on best NET price per outcome across
     ACCESSIBLE-eligible venues, with confidence == 1.0 required. */
  function arbForMarket(market, rows) {
    const nOut = market.outcomes.length;
    const best = new Array(nOut).fill(null);
    for (const r of rows) {
      if (r.pairConfidence < 1) continue;
      if (!best[r.side_ix === undefined ? market.outcomes.indexOf(r.side) : r.side_ix]) {}
      const ix = market.outcomes.indexOf(r.side);
      if (ix < 0) continue;
      if (!best[ix] || r.dNet > best[ix].dNet) best[ix] = r;
    }
    if (best.some(x => !x)) return null;
    const det = A.detect(best.map(x => x.dNet));
    return { det, best, suspect: A.isSuspect(det.roi) };
  }
  return { DEFAULTS, VERDICT_ORDER, phaseA, gate, sizeRow, arbForMarket, fmtAge };
})();
