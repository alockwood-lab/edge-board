/* ========================== L4  router and boot ======================== */
VB.selftest = (function () {
  const U = VB.util, O = VB.odds, D = VB.devig, C = VB.consensus,
        K = VB.stake, A = VB.arb, MU = VB.multiplicity, SC = VB.score;
  const T = [];
  const eq = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-12 : tol);
  function t(name, fn) { T.push({ name, fn }); }

  t('A1 odds: -110 → 1.90909…, ±100 both map to 2.0', () => {
    if (!eq(O.americanToDecimal(-110), 1.9090909090909092)) return 'am(-110)';
    if (!eq(O.americanToDecimal(100), 2) || !eq(O.americanToDecimal(-100), 2)) return '±100';
    if (O.decimalToAmerican(2) !== 100) return 'd=2 canonical';
    let bad = 0;
    for (let a = 100; a <= 2000; a++) {
      if (Math.round(O.decimalToAmerican(O.americanToDecimal(a))) !== a) bad++;
      if (Math.round(O.decimalToAmerican(O.americanToDecimal(-a))) !== -a) bad++;
    }
    return bad === 1 ? true : 'round-trip failures: ' + bad + ' (expect exactly 1, at -100)';
  });
  t('A2 devig sums to 1, multiplicative 2-way and 3-way', () => {
    const a = D.multiplicative([1.91, 1.91]);
    if (a.p[0] !== 0.5 || a.p[0] + a.p[1] - 1 !== 0) return '2-way not exact';
    if (!eq(a.S, 1.0471204188481675)) return 'S';
    const b = D.multiplicative([2.10, 3.40, 3.60]);
    if (!eq(b.p[0], 0.4543429844, 1e-9)) return '3-way p0';
    return Math.abs(b.p.reduce((x, y) => x + y, 0) - 1) < 1e-12 || 'sum';
  });
  t('A3 power devig: k = 1.04611206, k>1 for an overround book', () => {
    const r = D.power([2.10, 3.40, 3.60]);
    if (!(r.k > 1)) return 'k must exceed 1 (bisection sign inverted?)';
    if (!eq(r.k, 1.04611206, 1e-6)) return 'k=' + r.k;
    return eq(r.p[0], 0.4601744579, 1e-9) || 'p0';
  });
  t('A37 general-n Shin: z = 0.0240828, longshot direction correct', () => {
    const s = D.shin([2.10, 3.40, 3.60]);
    if (!eq(s.z, 0.0240828, 1e-7)) return 'z=' + s.z;
    if (Math.abs(s.p.reduce((a, b) => a + b, 0) - 1) > 1e-10) return 'sum';
    const m = D.multiplicative([2.10, 3.40, 3.60]).p;
    if (!(s.p[0] > m[0])) return 'Shin must raise the favourite';
    return s.p[2] < m[2] || 'Shin must lower the longshot';
  });
  t('A37b median set: 4 members when all converge, mult never twice', () => {
    const md = D.medianDevig([2.10, 3.40, 3.60]);
    if (md.names.length !== 4) return 'members=' + md.names.join(',');
    const fb = D.medianDevig([1 / 0.55, 1 / 0.45]);
    if (fb.names.filter(n => n === 'multiplicative').length !== 1) return 'multiplicative duplicated';
    return true;
  });
  t('A11 fair-book invariance: a zero-vig book devigs to itself', () => {
    const d = [1 / 0.55, 1 / 0.45];
    if (!eq(D.multiplicative(d).p[0], 0.55, 1e-14)) return 'multiplicative';
    const pw = D.power(d);
    if (pw.k !== 1) return 'power k must be exactly 1, got ' + pw.k;
    if (!eq(pw.p[0], 0.55, 1e-14)) return 'power p';
    return eq(D.shin(d).p[0], 0.55, 1e-10) || 'shin (tolerance 1e-10, removable singularity at z→0)';
  });
  t('A5 EV sign, and the devig trap must not double the edge', () => {
    if (!eq(K.ev(0.55, 2.00), 0.1)) return 'EV(0.55,2)';
    if (K.ev(0.50, 2.00) !== 0) return 'EV(0.5,2) must be exactly 0';
    if (!eq(K.ev(0.45, 2.00), -0.1)) return 'EV(0.45,2)';
    const right = K.ev(0.55, 1.91);
    if (!eq(right, 0.0505, 1e-12)) return 'reference=' + right;
    return right < 0.06 || 'the own-devig bug would give ~0.1000';
  });
  t('A7 Kelly uses net odds b = d−1', () => {
    if (!eq(K.kelly(0.10, 12.00), 0.018181818181818, 1e-12)) return 'p=.1 d=12';
    if (eq(K.kelly(0.10, 12.00), 0.016666666666667, 1e-6)) return 'the b-vs-d bug is present';
    return eq(K.kelly(0.70, 2.00), 0.3999999999999999) || 'p=.7 d=2';
  });
  t('A6 Kelly monotone in edge, clamped at zero', () => {
    let prev = -1;
    for (let i = 1; i < 4000; i++) {
      const f = K.kelly(0.5 + 0.5 * i / 4000, 2.0);
      if (f <= prev) return 'not strictly increasing at i=' + i;
      prev = f;
    }
    return (K.kelly(0.50, 2) === 0 && K.kelly(0.45, 2) === 0) || 'must clamp to 0';
  });
  t('A8 arbitrage on a known arb, equal payoffs', () => {
    const d = A.detect([2.10, 2.05]);
    if (!eq(d.S, 0.963995354239, 1e-12)) return 'S';
    if (!d.isArb) return 'isArb';
    if (!eq(d.roi, 0.0373493976, 1e-9)) return 'roi';
    const s = A.stakes([2.10, 2.05], 1000);
    if (!eq(s[0] + s[1], 1000, 1e-9)) return 'stakes must sum to the outlay';
    if (Math.abs(s[0] * 2.10 - s[1] * 2.05) > 1e-9) return 'payoffs must be equal';
    const n = A.detect([1.95, 1.95]);
    return (!n.isArb && eq(n.roi, -0.025, 1e-12)) || 'negative case';
  });
  t('A9 any arb at or above 4% ROI is SUSPECT, never BET', () => {
    if (A.isSuspect(0.037)) return '3.7% must not be suspect';
    return A.isSuspect(0.04) && A.isSuspect(0.09) || '4% and 9% must be suspect';
  });
  t('A31 sizing chain: reference bet → 0.25u / $12.50 exactly', () => {
    /* The ratified reference is DEFINED by EV_net = 4.37% at +145, so pFair
       is derived from it rather than quoted at a rounded value. */
    const pRef = 1.0437 / 2.45;
    const z = K.size({ pFair:pRef, dNet:2.45, unitUsd:50, bankroll:5000 });
    if (!eq(z.evNet, 0.0437, 1e-12)) return 'ev=' + z.evNet;
    if (!eq(z.fKelly, 0.030137931, 1e-8)) return 'f_kelly=' + z.fKelly;
    if (!eq(z.fDebiased, 0.010548276, 1e-8)) return 'f_debiased=' + z.fDebiased;
    if (!eq(z.fFinal, 0.002637069, 1e-8)) return 'f_final=' + z.fFinal;
    if (!eq(z.uRaw, 0.2637, 1e-4)) return 'uRaw=' + z.uRaw;
    if (z.rung !== 0.25) return 'rung=' + z.rung;
    return z.amount === 12.5 || 'amount=' + z.amount;
  });
  t('A32 amount === rung × unit for every rung, to the cent', () => {
    for (const u of K.RUNGS) if (u * 50 !== Number((u * 50).toFixed(2))) return 'rung ' + u;
    return true;
  });
  t('A33 ladder floor boundary is 0.1768', () => {
    if (K.quantize(0.1767) !== 0) return '0.1767 must suppress';
    if (K.quantize(0.1769) !== 0.25) return '0.1769 must be 0.25u';
    for (let i = 0; i < K.RUNG_BOUNDS.length; i++) {
      const geo = i === 0 ? K.RUNGS[0] / Math.SQRT2 : Math.sqrt(K.RUNGS[i - 1] * K.RUNGS[i]);
      if (!eq(K.RUNG_BOUNDS[i], geo, 1e-15)) return 'bound ' + i + ' not a geometric midpoint';
    }
    return true;
  });
  t('A34 risk pair: 0.78% at λ=0.25, 8.4% if R is really 0.20', () => {
    if (!eq(K.pEverDrawdown(0.5, 0.25) * 100, 0.78, 0.01)) return 'λ=0.25';
    const le = K.lambdaEff(0.25, 0.35, 0.20);
    if (!eq(K.pEverDrawdown(0.5, le) * 100, 8.4, 0.1)) return 'sensitivity';
    if (!eq(K.pEverDrawdown(0.5, 1.0) * 100, 50, 0.01)) return 'full Kelly must be 50%';
    return eq(K.pEverDrawdown(0.5, K.lambdaEff(1.0, 0.35, 0.20)) * 100, 90.6, 0.2) || 'λ=1 sensitivity';
  });
  t('A10 caps: the binding cap is named, rounding never breaches', () => {
    const caps = { maxStakePctBankroll:0.02, maxStakeUnits:5, maxStakeAbs:null };
    const r = K.applyCaps(2000, caps, 10000, 100, 0);
    if (r.stake !== 200) return 'stake=' + r.stake;
    if (r.cappedBy !== 'maxStakePctBankroll') return 'cappedBy=' + r.cappedBy;
    return K.roundStake(203, 5) === 200 || 'rounding must go down';
  });
  t('A15 multiplicity: a(500)=2.908, e_crit=2.12pp, 1.78pp → THIN', () => {
    if (!eq(MU.a(500), 2.908, 0.002)) return 'a(500)=' + MU.a(500);
    const ec = MU.eCrit(0.0073, 500);
    if (!eq(ec * 100, 2.12, 0.01)) return 'e_crit=' + (ec * 100);
    return MU.eAdj(0.0178, 0.0073, 500) < 0 || 'the reference 1.78pp edge must NOT clear the noise line';
  });
  t('A16 staleness bias fits all three measured drift points', () => {
    if (!eq(MU.bStale(1) * 100, 0.12, 0.005)) return '1min';
    if (!eq(MU.bStale(15) * 100, 0.48, 0.01)) return '15min';
    return eq(MU.bStale(60) * 100, 0.97, 0.02) || '60min';
  });
  t('A18 cluster weights sum to 1; cap relaxes when infeasible', () => {
    const mk = (id, cl) => ({ id, cluster:cl, sharp:50, limitUsd:1000, ageSec:10,
                              includeInConsensus:true, tier:2, model:'fixed_odds' });
    const twelve = [];
    for (let i = 0; i < 12; i++) twelve.push(mk('v' + i, 'one'));
    twelve.push(mk('a', 'two'), mk('b', 'three'), mk('c', 'four'));
    const n = C.normalizeWithCaps(twelve, C.rawWeights(twelve, false));
    if (Math.abs(n.clusters.one - 0.35) > 1e-9) return '12-venue cluster must cap at 0.350, got ' + n.clusters.one;
    if (Math.abs(n.w.reduce((a, b) => a + b, 0) - 1) > 1e-9) return 'weights must sum to 1';
    const two = [mk('x', 'p'), mk('y', 'q')];
    const n2 = C.normalizeWithCaps(two, C.rawWeights(two, false));
    if (Math.abs(n2.w.reduce((a, b) => a + b, 0) - 1) > 1e-9) return 'infeasible cap must relax, sum=' +
      n2.w.reduce((a, b) => a + b, 0);
    return eq(n2.effCap, 0.5, 1e-12) || 'effCap must relax to 0.5 with two clusters';
  });
  t('A-pool log-linear pool is idempotent and sharper than arithmetic', () => {
    const u = C.pool([[0.42, 0.58], [0.42, 0.58], [0.42, 0.58]], [0.4, 0.35, 0.25]);
    if (Math.abs(u[0] - 0.42) > 1e-12) return 'unanimous market must be unchanged';
    const p = C.pool([[0.20, 0.80], [0.40, 0.60]], [0.5, 0.5])[0];
    return (p < 0.30 && eq(p, 0.28990, 1e-4)) || 'logit pooling must be sharper, got ' + p;
  });
  t('A13 dropped components redistribute to exactly 1.000', () => {
    for (const av of [{ cla:1, calib:1, logLoss:1, brier:1 }, { cla:1, calib:1 }, { cla:1 }]) {
      const rd = SC.redistribute(SC.SHARP_W, av);
      const s = Object.keys(rd.weights).reduce((a, k) => a + rd.weights[k], 0);
      if (Math.abs(s - 1) > 1e-12) return 'sum=' + s;
    }
    return true;
  });
  t('A-ece debias: a perfect venue at n=30/bin must not read miscalibrated', () => {
    const rng = U.mulberry32(12345);
    let naive = 0, adj = 0, R = 200;
    for (let s = 0; s < R; s++) {
      const bins = [];
      for (let i = 0; i < 10; i++) {
        const p = 0.05 + i * 0.1;
        let w = 0; for (let k = 0; k < 30; k++) if (rng() < p) w++;
        bins.push({ n:30, pMean:p, oMean:w / 30 });
      }
      let nv = 0; for (const b of bins) nv += 0.1 * Math.abs(b.oMean - b.pMean);
      naive += nv; adj += SC.eceAdjusted(bins);
    }
    naive /= R; adj /= R;
    return (naive > 0.04 && adj < 0.025) || 'naive=' + (naive * 100).toFixed(2) + 'pp adj=' + (adj * 100).toFixed(2) + 'pp';
  });
  t('A12 determinism: mulberry32(42) and xmur3 are byte-stable', () => {
    const r = U.mulberry32(42), got = [r(), r(), r(), r(), r()];
    const want = [0.6011037519201636, 0.4482905589975417, 0.8524657934904099,
                  0.6697340414393693, 0.17481389874592423];
    for (let i = 0; i < 5; i++) if (!eq(got[i], want[i], 1e-15)) return 'draw ' + i + '=' + got[i];
    return U.xmur3('quotes:42')() === 403775644 || 'xmur3';
  });
  t('A-snap grid snapping is idempotent', () => {
    for (let a = 100; a <= 3000; a += 7) {
      const d = O.americanToDecimal(a), s1 = O.snapToGrid(d), s2 = O.snapToGrid(s1);
      if (Math.abs(s1 - s2) > 1e-12) return 'not idempotent at +' + a;
    }
    return true;
  });
  t('A4 40-outcome devig: no Kahan needed, drift under 1e-15', () => {
    const ds = []; for (let i = 0; i < 40; i++) ds.push(20 + i * 3);
    const p = D.multiplicative(ds).p;
    const drift = Math.abs(p.reduce((a, b) => a + b, 0) - 1);
    return drift <= 1e-15 || 'drift=' + drift;
  });
  t('A17 sign-instability across devig methods refuses the bet', () => {
    const ds = [O.americanToDecimal(-500), O.americanToDecimal(380)];
    const md = D.medianDevig(ds);
    const spread = md.spread[1];
    if (!(spread > 0.015)) return 'the -500/+380 identification case must spread >1.5pp, got ' +
      (spread * 100).toFixed(2) + 'pp';
    /* Construct an offer priced inside the method spread: some methods say
       positive, some negative, so the gate must refuse it. */
    const vals = md.names.map(n => md.methods[n][1]).sort((a, b) => a - b);
    const mid = (vals[0] + vals[vals.length - 1]) / 2;
    return D.signStableFor(md, 1, 1 / mid) === false || 'a price inside the spread must be unstable';
  });
  t('A11b Brier is n/a for venues that do not publish probabilities', () => {
    const av = { cla:1, calib:1, logLoss:1, brier:1 };
    const c = { n:5000, nSettled:5000, cla:0.001, claSE:0.0001, brier:0.2,
                brierSE:0.001, logLoss:0.6, ece:0.01, publishesProbability:false };
    const s = SC.sharp(c, { cla:[0.001, 0.002, 0.003], calib:[0.01, 0.02, 0.03],
                            logLoss:[0.6, 0.62, 0.64], brier:[0.2, 0.21, 0.22] }, 2);
    return (s.dropped.indexOf('brier') >= 0) || 'brier must be dropped, dropped=' + s.dropped.join(',');
  });
  t('A-tie non-significant gaps render as a tie, not a rank', () => {
    if (SC.isTie({ cla:0.181, claSE:0.0008 }, { cla:0.186, claSE:0.0008 })) return 'a real gap must not tie';
    return SC.isTie({ cla:0.181, claSE:0.0060 }, { cla:0.183, claSE:0.0060 }) || 'noise must tie';
  });
  t('A-outlier threshold scales with each venue’s own dispersion', () => {
    const sharpT = A.quoteOutlierThreshold(0.0001);   /* sqrt = 1.0pp */
    const softT = A.quoteOutlierThreshold(0.00125);   /* sqrt = 3.54pp */
    if (!eq(sharpT, 0.06, 1e-9)) return 'sharp venue must floor at 6pp, got ' + sharpT;
    if (!(softT > 0.13)) return 'soft venue must widen past 13pp, got ' + softT;
    if (!A.isQuoteOutlier(0.50, 0.425, 8, 0.0001)) return '7.5pp from a sharp book must quarantine';
    return !A.isQuoteOutlier(0.50, 0.425, 8, 0.00125) || '7.5pp from a soft book must be allowed';
  });

  function run() {
    const out = [];
    for (const x of T) {
      let r;
      try { r = x.fn(); } catch (e) { r = 'threw: ' + e.message; }
      out.push({ name:x.name, pass: r === true, detail: r === true ? '' : String(r) });
    }
    return out;
  }
  return { run, count: () => T.length };
})();

/* ------------------------------------------------------------- router */
VB.router = (function () {
  const { h, clear, money } = VB.dom;
  const ROUTES = [
    ['#/board/all', 'Board'], ['#/leaderboard', 'Leaderboard'], ['#/ask', 'Ask'],
    ['#/slip', 'Slip'], ['#/review', 'Review'], ['#/settings', 'Settings'], ['#/selftest', 'Self-test']
  ];
  function parse() {
    const raw = location.hash || '#/board/all';
    const qi = raw.indexOf('?');
    const path = (qi < 0 ? raw : raw.slice(0, qi)).replace(/^#\/?/, '');
    const params = new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1));
    return { seg: path.split('/').filter(Boolean), params };
  }
  function nav() {
    const el = document.getElementById('nav');
    clear(el);
    const { seg } = parse();
    const cur = '#/' + seg.join('/');
    for (const [href, label] of ROUTES) {
      const on = cur.indexOf(href.split('/').slice(0, 2).join('/')) === 0;
      el.appendChild(h('a', { href, class: on ? 'on' : '' }, label));
    }
    el.appendChild(h('span', { class:'grow', style:'flex:1' }));
    const S = VB.store.get(), st = S.settings, M = VB.model.get();
    el.appendChild(h('span', { class:'clock' },
      (st.bankroll ? '1u=' + money(st.unitUsd) + ' · bankroll ' + money(st.bankroll) + ' · λ ' + st.lambda : 'bankroll not set') +
      ' · noise line ' + (M ? (M.eCritMedian * 100).toFixed(2) + 'pp @ M=' + M.nEval.toLocaleString() : '--')));
  }
  function strip() {
    const el = document.getElementById('demostrip');
    clear(el);
    const S = VB.store.get();
    const live = VB.model.get() ? Object.keys(VB.model.liveStats()) : [];
    const au = VB.model.autoStatus ? VB.model.autoStatus() : null;
    if (au && au.running) {
      el.className = 'fetching';
      el.appendChild(h('span', {}, 'FETCHING LIVE LINES'));
      el.appendChild(h('span', { class:'sep' },
        'Pulling real odds from ESPN for ' + VB.model.AUTO_LEAGUES.join(', ') + '…'));
      return;
    }
    el.className = '';
    if (live.length) {
      const M2 = VB.model.get();
      const nReal = M2 && M2.rows ? M2.rows.length : 0;
      const nGames = M2 && M2.rows
        ? Object.keys(M2.rows.reduce((a, r) => (a[r.eventId] = 1, a), {})).length : 0;
      const ref = M2 && M2.refMeta;
      const nRef = M2 && M2.refStats ? M2.refStats.matched : 0;
      el.className = 'liveok';
      const ol = (au && au.oddsLeagues) || [];
      const staleL = ol.filter(x => x.stale);
      el.className = staleL.length ? 'fetching' : 'liveok';
      el.appendChild(h('span', {}, staleL.length ? 'CACHED' : 'LIVE'));
      el.appendChild(h('span', { class:'sep' },
        nReal.toLocaleString() + ' market prices across ' + nGames + ' games from ' +
        live.join(' + ') + (ref ? ', plus ' + ref.totals + ' exchange markets as a fair-value ' +
        'reference (' + nRef + ' matched)' : '') +
        (staleL.length ? '. NOTE: ' + staleL.map(x => x.cat + ' is a cached pull from ' +
          Math.round(x.ageMs / 60000) + 'm ago — the live fetch failed'). join('; ') : '') +
        '. Prices are live; EV is modelled from them and is never a realised outcome.'));
    } else if (au && au.done) {
      el.className = '';
      el.appendChild(h('span', {}, 'NO LIVE DATA'));
      el.appendChild(h('span', { class:'sep' },
        (au.failed ? 'The feed could not be reached (' + au.errors.slice(0, 2).join('; ') + '). '
                   : 'No priced markets returned. ') +
        'This build carries no synthetic fallback, so the board stays empty rather than ' +
        'showing invented prices. Retry from Settings.'));
    } else {
      el.className = 'fetching';
      el.appendChild(h('span', {}, 'STARTING'));
      el.appendChild(h('span', { class:'sep' }, 'Connecting to the live feed…'));
    }
  }
  function selftest() {
    const res = VB.selftest.run();
    const pass = res.filter(r => r.pass).length;
    const wrap = h('div');
    wrap.appendChild(h('h1', {}, 'Self-test — ' + pass + '/' + res.length + ' passing'));
    wrap.appendChild(h('div', { class:'sub' },
      'Assertions run against the live engine in this page. Tolerances are not decorative: ' +
      'EV(0.55,2.00) returns 0.10000000000000009, so nothing compares computed floats with ===.'));
    const tb = h('tbody');
    for (const r of res) tb.appendChild(h('tr', {}, [
      h('td', { class: r.pass ? 'pos' : 'neg' }, r.pass ? 'PASS' : 'FAIL'),
      h('td', {}, r.name),
      h('td', { class:'small muted' }, r.detail)
    ]));
    wrap.appendChild(h('table', {}, [h('thead', {}, h('tr', {},
      ['', 'ASSERTION', 'DETAIL'].map(c => h('th', {}, c)))), tb]));
    const M = VB.model.get();
    wrap.appendChild(h('div', { class:'panel', style:'margin-top:10px' }, [
      h('h2', {}, 'Timing'),
      h('dl', { class:'kv' }, [
        h('dt', {}, 'settled history'), h('dd', {}, M.timing.hist.toFixed(0) + ' ms'),
        h('dt', {}, 'slate + plants'), h('dd', {}, M.timing.slate.toFixed(0) + ' ms'),
        h('dt', {}, 'full pipeline'), h('dd', {}, M.timing.compute.toFixed(0) + ' ms'),
        h('dt', {}, 'offer rows'), h('dd', {}, M.nEval.toLocaleString())
      ])
    ]));
    return wrap;
  }
  function render() {
    const { seg, params } = parse();
    const app = document.getElementById('app');
    clear(app);
    nav();
    strip();
    const S = VB.store.get();
    let view;
    try {
      switch (seg[0]) {
        case 'board': view = VB.views.board(seg[1] || 'all', params.get('mode') === 'all' ? 'all' : 'value'); break;
        case 'market': view = VB.views2.market(seg[1]); break;
        case 'leaderboard': view = VB.views2.leaderboard(); break;
        case 'review': view = VB.views3.review(); break;
        case 'slip': view = VB.views3.slip(); break;
        case 'settings': view = VB.views4.settings(); break;
        case 'ask': view = VB.views4.ask(params.get('q') || ''); break;
        case 'selftest': view = selftest(); break;
        default: location.hash = '#/board/all'; return;
      }
    } catch (e) {
      view = h('div', { class:'note c' }, 'View error: ' + e.message);
      document.documentElement.dataset.vbBoot = 'error';
      window.__vbErrs.push({ m:e.message, stack:e.stack });
    }
    app.appendChild(view);
    document.getElementById('rgfoot').textContent =
      'This app models estimates and places no bets. Caps: 2u per bet, 3u per event, 10u total open. ' +
      'Editable in Settings.';
  }
  let badgeState = null;
  function paintBadge() {
    const badge = document.getElementById('badge');
    if (!badge || !badgeState) return;
    const M = VB.model.get();
    const au = VB.model.autoStatus ? VB.model.autoStatus() : null;
    const games = (M && M.rows)
      ? Object.keys(M.rows.reduce((a, r) => (a[r.eventId] = 1, a), {})).length : 0;
    const nRef = (M && M.refStats) ? M.refStats.matched : 0;
    badge.textContent = (au && au.running ? 'fetching' : 'live') + ' · ' +
      ((M && M.nEval) || 0).toLocaleString() + ' rows · ' + games + ' games' +
      (nRef ? ' · ' + nRef + ' vs exchange' : '') +
      ' · pipeline ' + ((M && M.timing.compute) || 0).toFixed(0) + 'ms' +
      ' · boot ' + badgeState.bootMs.toFixed(0) + 'ms' +
      ' · tests ' + badgeState.pass + '/' + badgeState.total +
      ' · ' + window.__vbErrs.length + ' errors';
  }

  function boot() {
    const t0 = performance.now();
    VB.store.load();
    const S = VB.store.get();
    if (S.settings.noColour) document.documentElement.dataset.nocolour = '1';
    strip();
    VB.model.boot();
    VB.dom.initTips();
    VB.views.setRender(render);
    window.addEventListener('hashchange', render);
    render();
    const res = VB.selftest.run();
    const pass = res.filter(r => r.pass).length;
    const fails = res.filter(r => !r.pass);
    const M = VB.model.get();
    const bootMs = performance.now() - t0;
    /* The badge is stamped again after the feed lands, otherwise it reports
       the pre-fetch state forever and reads "0 rows" on a working app. */
    badgeState = { pass, total: res.length, bootMs };
    paintBadge();
    if (fails.length) {
      const badge = document.getElementById('badge');
      if (badge) badge.style.color = 'var(--neg)';
      document.getElementById('boot').textContent =
        fails.length + ' self-test failure(s): ' + fails.map(f => f.name).join(' | ');
      document.documentElement.dataset.vbBoot = 'error';
    } else if (window.__vbErrs.length === 0) {
      /* Set only on the LAST line of a clean boot, so a partial boot cannot
         claim success. */
      document.documentElement.dataset.vbBoot = 'ok';
    }
    /* ?preset=1 fills bankroll and unit IN MEMORY ONLY (never persisted) so
       the board can be previewed or screenshotted without the modal. It does
       not skip any disclosure: the demo strip, the synthetic watermark and
       every caveat still render. */
    const pre = (location.hash.indexOf('preset=1') >= 0);
    /* Kick the live fetch immediately after first paint. Boot is already
       complete at this point, so a dead network costs nothing but a banner. */
    setTimeout(function () {
      VB.model.autoLoadLive(function () {
        strip(); render(); paintBadge();
        /* Free sources keep themselves current; the metered one does not
           without an explicit opt-in. */
        VB.model.startTimers(function () { strip(); render(); paintBadge(); });
      });
      strip(); render(); paintBadge();
    }, 30);

    if (pre && !S.settings.bankroll) {
      S.settings.bankroll = 5000; S.settings.unitUsd = 50;
      VB.model.compute(); render();
    } else if (!S.ui.firstRunSeen || !S.settings.bankroll) {
      VB.views4.firstRun();
    }
  }
  return { boot, render, parse, nav };
})();
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', VB.router.boot);
  else VB.router.boot();
}
