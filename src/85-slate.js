/* -------------------------------------------------------------- L2 slate */
VB.slate = (function () {
  const U = VB.util, O = VB.odds, S = VB.seed;
  const { clamp, logit, sig, gauss } = U;
  const DEMO_NOW = 0;   /* all times are OFFSETS from app launch, never absolute,
                           so the demo's countdowns and age chips are correct
                           whenever it is opened. Absolute dates would render
                           the whole board stale within a day. */

  function pick(arr, rng, n) {
    const a = arr.slice(), out = [];
    while (out.length < n && a.length) out.push(a.splice(Math.floor(rng() * a.length), 1)[0]);
    return out;
  }

  function build() {
    const rng = S.rngFor('slate');
    const events = [], markets = [];
    let eid = 0, mid = 0;

    for (const cat of S.CATS) {
      const names = S.TEAMS[cat.key] || [];
      /* --- games --- */
      for (let g = 0; g < cat.nGames; g++) {
        const pair = pick(names, rng, 2);
        if (pair.length < 2) break;
        const startSec = Math.round((0.5 + rng() * 200) * 3600);
        const isSoccer = cat.key === 'SOC';
        const ev = { id: 'e' + (++eid), cat: cat.key, kind: 'match',
                     label: pair[0] + ' v ' + pair[1], home: pair[0], away: pair[1],
                     startSec, latent: gauss(rng) * 1.1 };
        events.push(ev);

        /* Moneyline (3-way for soccer). */
        const pH = sig(ev.latent);
        if (isSoccer) {
          const zd = -0.35 + rng() * 0.2;
          const e3 = [ev.latent, zd, -ev.latent].map(Math.exp);
          const Z3 = e3.reduce((a, b) => a + b, 0);
          markets.push(mk(++mid, ev, 'ml3', '1X2', ['home','draw','away'],
                          e3.map(x => x / Z3), null, cat));
        } else {
          markets.push(mk(++mid, ev, 'moneyline', 'MONEYLINE', ['home','away'],
                          [pH, 1 - pH], null, cat));
        }
        /* Spread and total sit near a coinflip -- that is what a PRICED line
           actually looks like, so they are not drawn from the latent. */
        if (cat.key !== 'TEN' && cat.key !== 'MMA') {
          const ps = clamp(0.5 + 0.03 * gauss(rng), 0.42, 0.58);
          const line = Math.round((ev.latent * -3.2) * 2) / 2 - 0.5;
          markets.push(mk(++mid, ev, 'spread', 'SPREAD', ['home','away'],
                          [ps, 1 - ps], line, cat));
          const pt = clamp(0.5 + 0.03 * gauss(rng), 0.42, 0.58);
          const base = { NFL:44.5, NCAAF:52.5, MLB:8.5, SOC:2.5, NBA:224.5, NHL:6.5 }[cat.key] || 45.5;
          markets.push(mk(++mid, ev, 'total', 'TOTAL', ['over','under'],
                          [pt, 1 - pt], base + Math.round(rng() * 8 - 4), cat));
        }
        /* Player props exist and are REACHABLE, but are excluded from
           cross-venue EV by G11 -- stat definitions differ between venues,
           so the same words are a different contract. */
        if ((cat.key === 'NFL' || cat.key === 'MLB') && g < 4) {
          const pp = clamp(0.5 + 0.04 * gauss(rng), 0.40, 0.60);
          const m = mk(++mid, ev, 'prop', 'PLAYER', ['over','under'], [pp, 1 - pp],
                       Math.round(240 + rng() * 80) + 0.5, cat);
          m.playerKey = pair[0] + ' starter';
          m.propStat = cat.key === 'NFL' ? 'pass yds' : 'strikeouts';
          markets.push(m);
        }
      }
      /* --- futures / outrights / binaries --- */
      const nF = cat.futuresOnly ? (names.length > 12 ? 2 : 1) : 1;
      for (let f = 0; f < nF; f++) {
        const isBinary = ['POL','ECON','AWD','TECH'].indexOf(cat.key) >= 0;
        if (isBinary) {
          const subj = pick(names, rng, Math.min(6, names.length));
          for (const sname of subj) {
            const ev = { id: 'e' + (++eid), cat: cat.key, kind: 'non_sport_question',
                         label: sname, startSec: Math.round((240 + rng() * 4000) * 3600),
                         latent: gauss(rng) * 0.9 };
            events.push(ev);
            const py = clamp(sig(ev.latent), 0.04, 0.96);
            markets.push(mk(++mid, ev, 'binary', 'BINARY', ['yes','no'],
                            [py, 1 - py], null, cat));
          }
        } else {
          /* Take the TOP of the list in order and give it a monotonically
             decreasing field, rather than sampling teams at random and
             assigning random strengths. A synthetic futures market that
             names real teams and then implies the best team in the sport is
             a longshot is obviously false to anyone who follows it, and one
             visibly absurd row costs more credibility than the whole market
             is worth. The team lists are ordered strongest-first for exactly
             this reason. The prices are still synthetic -- the ORDERING is
             what has to be defensible. */
          const field = names.slice(0, Math.min(10, names.length));
          const ev = { id: 'e' + (++eid), cat: cat.key, kind: 'season_outright',
                       label: cat.label + ' — season winner (synthetic)',
                       startSec: Math.round((300 + rng() * 3000) * 3600), latent: 0 };
          events.push(ev);
          /* Geometric decay with a little jitter: a plausible futures shape,
             favourite first, and never re-ordered by noise. */
          const raw = field.map((_, i) => Math.exp(-0.42 * i) * (0.92 + 0.16 * rng()));
          raw.sort((a, b) => b - a);
          const Z = raw.reduce((a, b) => a + b, 0);
          const m = mk(++mid, ev, 'outright', 'OUTRIGHT', field, raw.map(x => x / Z), null, cat);
          markets.push(m);
        }
      }
    }

    /* Quotes for every market. */
    for (const m of markets) m.quotes = S.priceRows(m.pTrue, m, DEMO_NOW);
    return { events, markets };
  }

  function mk(id, ev, kind, label, outcomes, pTrue, line, cat) {
    const Z = pTrue.reduce((a, b) => a + b, 0);
    return { id: 'm' + id, eventId: ev.id, cat: cat.key, kind,
             eventLabel: ev.label, marketLabel: label,
             outcomes, pTrue: pTrue.map(x => x / Z), line,
             startSec: ev.startSec, isLive: false, pairConfidence: 1 };
  }

  /* --------------------------------------------------------------- PLANTS
     Every plant is VERIFIED BY THE PRODUCTION MATH, not declared. The
     generator calls the same devig, consensus and arb functions the board
     calls, bisects the nudge until the MEASURED value lands in band, and
     records the measured value -- never the target. If the generator and
     the engine ever disagree, the plant fails to converge and the count
     drops, which the self-test catches immediately. */
  function plant(model, venuesById, opts) {
    const rng = S.rngFor('plants');
    const man = { ev: [], arb: [], fakeArb: null, misMap: null,
                  stale: [], thinMarket: null, attempted: 0, skipped: 0 };
    const P = VB.pipe;

    const measure = (m, venueId, side) => {
      const a = P.phaseA(m, venuesById, {});
      const row = a.rows.find(r => r.venueId === venueId && r.side === side);
      return row || null;
    };

    /* 1. Positive-EV plants: nudge ONE soft venue on ONE outcome, bisecting
          the nudge against the real consensus engine until the measured
          edge lands in band. Re-verified AFTER grid snapping, because
          snapping moves the price. */
    const soft = ['bovada','betonline','fanatics','betrivers','espnbet','caesars'];
    /* >20 quotes, not >30: a two-way market with 12 venues has only 24
       quote rows, so a 30-row floor silently excluded every moneyline,
       spread and total from the candidate pool and left only 3-way and
       multi-outcome markets to plant into. */
    const cands = model.markets.filter(m =>
      m.kind !== 'prop' && m.outcomes.length <= 3 && m.quotes.length > 20);

    /* Target the edge in PROBABILITY POINTS, not EV%. Targeting EV% runs
       away on long prices, because EV = p*d - 1 explodes as d grows: a
       modest multiplier on a +2000 draw produces a 1000% "edge" that is a
       generator bug wearing the costume of a plant. Probability points are
       bounded and are also the quantity the noise line is drawn in, so
       aiming here is what makes a plant actually clear the gates. */
    const EP_BAND = [0.026, 0.042];      /* 2.6pp to 4.2pp -- above the ~1.8pp noise
                                            line, below the level that trips the arb gate */
    const EV_SANE = [0.015, 0.140];      /* reject anything outside this outright */
    const want = 12;
    for (const m of cands) {
      if (man.ev.length >= want) break;
      const vid = soft[Math.floor(rng() * soft.length)];
      const ix = Math.floor(rng() * m.outcomes.length);
      const q = m.quotes.find(x => x.venueId === vid && x.outcomeIx === ix);
      if (!q) continue;
      man.attempted++;
      const orig = q.dGross;
      const target = EP_BAND[0] + rng() * (EP_BAND[1] - EP_BAND[0]);

      /* Bisect the price multiplier against the REAL consensus engine.
         Monotone: a longer offered price lowers q_o, so ep = pFair - q_o
         rises. Bracket first, then narrow. */
      let lo = 1.0, hi = 1.0, row = null, ok = false;
      for (let e = 0; e < 8; e++) {
        hi = 1 + (e + 1) * 0.12;
        q.dGross = O.snapToGrid(orig * hi, 'american');
        row = measure(m, vid, m.outcomes[ix]);
        if (row && isFinite(row.ep) && row.ep >= target) { ok = true; break; }
      }
      if (!ok) { q.dGross = orig; man.skipped++; continue; }
      for (let it = 0; it < 24 && hi - lo > 1e-4; it++) {
        const k = 0.5 * (lo + hi);
        q.dGross = O.snapToGrid(orig * k, 'american');
        row = measure(m, vid, m.outcomes[ix]);
        if (!row || !isFinite(row.ep)) break;
        if (row.ep < target) lo = k; else hi = k;
      }
      /* Re-verify AFTER snapping, and reject anything outside the band.
         A plant that did not converge is a generator failure and is
         reverted, never accepted with whatever the last probe happened to
         be -- that is how a 200% EV row reaches a screen. */
      q.dGross = O.snapToGrid(orig * hi, 'american');
      row = measure(m, vid, m.outcomes[ix]);
      /* Verify against the ARB gate too. Making one side long enough to
         carry a 5pp edge can simultaneously push the best-price book sum
         past the 4% implausibility threshold, at which point the production
         engine quarantines the very row we planted -- correctly, but it
         leaves the demo with its best opportunities showing as SUSPECT.
         The plant is only accepted if it survives every gate the board
         applies, which is the whole point of verifying with the real math
         rather than declaring a target. */
      const aAll = P.phaseA(m, venuesById, {});
      const arbChk = P.arbForMarket(m, aAll.rows);
      const arbClean = !arbChk || !arbChk.det.isArb || !arbChk.suspect;
      const good = row && isFinite(row.ep) && arbClean
        && row.ep >= EP_BAND[0] * 0.85 && row.ep <= EP_BAND[1] * 1.35
        && row.evNet >= EV_SANE[0] && row.evNet <= EV_SANE[1]
        && isFinite(row.t) && row.t >= 2.0;
      if (!good) { q.dGross = orig; man.skipped++; continue; }
      man.ev.push({ marketId: m.id, venueId: vid, side: m.outcomes[ix],
                    evMeasured: row.evNet, epMeasured: row.ep,
                    tMeasured: row.t, dGross: row.dGross });
    }

    /* 2. Two genuine arbitrages that survive the fee and commission math.
          Solved for a target book sum below 1, snapped FIRST, then handed
          to the detector -- never the other way round. */
    const twoWay = model.markets.filter(m => m.outcomes.length === 2
      && m.kind !== 'prop' && !man.ev.some(e => e.marketId === m.id));
    for (const m of twoWay) {
      if (man.arb.length >= 2) break;
      const vA = 'betrivers', vB = 'betfair';
      const qA = m.quotes.find(x => x.venueId === vA && x.outcomeIx === 0);
      const qB = m.quotes.find(x => x.venueId === vB && x.outcomeIx === 1);
      if (!qA || !qB) continue;
      const oA = qA.dGross, oB = qB.dGross, oBid = qB.bidProb, oAsk = qB.askProb;
      const targetS = 1 - (0.015 + rng() * 0.015);
      qA.dGross = O.snapToGrid(1 / (m.pTrue[0] * targetS), 'american');
      /* Betfair pays commission on net winnings, so the gross price must be
         solved for the NET target, not set to it. */
      const needNet = 1 / (m.pTrue[1] * targetS);
      const grossNeeded = 1 + (needNet - 1) / (1 - 0.02);
      qB.askProb = clamp(1 / grossNeeded, 0.01, 0.99);
      qB.bidProb = clamp(qB.askProb - 0.01, 0.005, 0.985);
      qB.dGross = O.snapToGrid(grossNeeded, 'cents');
      const rA = measure(m, vA, m.outcomes[0]), rB = measure(m, vB, m.outcomes[1]);
      if (!rA || !rB) { qA.dGross = oA; qB.dGross = oB; qB.bidProb = oBid; qB.askProb = oAsk; continue; }
      const det = VB.arb.detect([rA.dNet, rB.dNet]);
      if (!det.isArb || det.roi < 0.008 || VB.arb.isSuspect(det.roi)) {
        qA.dGross = oA; qB.dGross = oB; qB.bidProb = oBid; qB.askProb = oAsk; continue;
      }
      man.arb.push({ marketId: m.id, venues: [vA, vB], roiMeasured: det.roi,
                     bookSum: det.S, netPrices: [rA.dNet, rB.dNet] });
    }

    /* 3. ONE FAKE arbitrage that exists ONLY if Kalshi's per-contract fee is
          ignored. This is the regression test for fee dispatch: with fees on
          it must NOT be an arb; with fees stubbed to zero it must be one. */
    for (const m of twoWay) {
      if (man.fakeArb) break;
      if (man.arb.some(a => a.marketId === m.id)) continue;
      const qK = m.quotes.find(x => x.venueId === 'kalshi' && x.outcomeIx === 0);
      const qO = m.quotes.find(x => x.venueId === 'draftkings' && x.outcomeIx === 1);
      if (!qK || !qO) continue;
      /* Aim the GROSS book sum just under 1 while the NET sum stays above it. */
      const targetGross = 0.985;
      const pk = clamp(m.pTrue[0] * targetGross, 0.03, 0.95);
      qK.askProb = pk; qK.bidProb = clamp(pk - 0.01, 0.005, 0.94);
      qK.dGross = O.snapToGrid(1 / pk, 'cents');
      qO.dGross = O.snapToGrid(1 / (m.pTrue[1] * targetGross), 'american');
      const kv = venuesById['kalshi'];
      const dNetK = S.netDecimal(qK.dGross, kv);
      const grossSum = 1 / qK.dGross + 1 / qO.dGross;
      const netSum = 1 / dNetK + 1 / qO.dGross;
      if (grossSum < 1 && netSum > 1) {
        man.fakeArb = { marketId: m.id, grossSum, netSum,
                        arbIfFeeIgnored: 1 / grossSum - 1, arbWithFee: 1 / netSum - 1 };
      }
    }

    /* 4. The single most important test case in the dataset: a 9% "edge"
          created by pricing Miami (FL) against Miami (OH). It must land in
          the review queue with confidence < 1.0, must be ABSENT from the
          board in both modes, and must be unstakeable. */
    const ncaaf = model.markets.filter(m => m.cat === 'NCAAF' && m.outcomes.length === 2);
    if (ncaaf.length) {
      const src = ncaaf[0];
      const fake = JSON.parse(JSON.stringify(src));
      fake.id = 'm-mismap';
      fake.eventId = 'e-mismap';
      fake.eventLabel = 'Miami (FL) v Miami (OH)';
      fake.pairConfidence = 0.78;
      fake.mismapNote = 'Miami (FL) priced against Miami (OH)';
      for (const q of fake.quotes) {
        if (q.venueId === 'fanatics' && q.outcomeIx === 0) q.dGross = O.snapToGrid(q.dGross * 1.35, 'american');
      }
      model.markets.push(fake);
      man.misMap = { marketId: fake.id, pairConfidence: 0.78 };
    }

    /* 5. Deliberate staleness: amber, red, and a frozen quote. */
    const stalers = model.markets.filter(m => m.quotes.length > 20).slice(0, 3);
    [[0, 8 * 60], [1, 22 * 60], [2, 95 * 60]].forEach(([i, age]) => {
      const m = stalers[i]; if (!m) return;
      for (const q of m.quotes) if (q.venueId === 'caesars') { q.ageSec = age; q.ts = -age; }
      man.stale.push({ marketId: m.id, venueId: 'caesars', ageSec: age });
    });

    /* 6. One market with only two clusters quoting, to prove the breadth
          gate suppresses it rather than inventing a consensus. */
    const thin = model.markets.filter(m => m.cat === 'NCAAB' && m.outcomes.length > 3)[0]
              || model.markets[model.markets.length - 2];
    if (thin) {
      thin.quotes = thin.quotes.filter(q => q.venueId === 'pinnacle' || q.venueId === 'bovada');
      man.thinMarket = { marketId: thin.id, clusters: 2 };
    }
    return man;
  }
  return { build, plant, DEMO_NOW };
})();
