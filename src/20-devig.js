/* -------------------------------------------------------------- L1 devig */
VB.devig = (function () {
  const { clamp } = VB.util;

  /* DEVIGGING IS NOT IDENTIFIED FROM DATA. It is a modelling assumption.
     Every method below closes an under-determined system by imposing a
     one-parameter margin-allocation rule, and no amount of price data from
     a single venue can distinguish them. On a -500/+380 line the four
     methods disagree by 1.95pp / 54 American cents -- LARGER than the
     median edge this app reports. That is why all four are computed and a
     sign flip across them refuses the bet. On a symmetric two-way market
     (-110/-110, and every standard spread or total) all four coincide. */

  /* (a) Proportional. Assumes margin is a constant proportional markup, so
     it preserves true probability ratios. Removes NONE of the margin that
     books load onto longshots, so p_longshot comes out too HIGH -- it
     manufactures false positive edges on underdogs, which is the failure
     mode this app least wants. */
  function multiplicative(ds) {
    const q = ds.map(d => 1 / d), S = q.reduce((a, b) => a + b, 0);
    return { p: q.map(x => x / S), S };
  }

  /* (b) Equal-margin. Assumes a flat absolute margin per outcome. Fails
     hard for large n: p_i < 0 whenever q_i < M/n, so a 24-runner field with
     M=0.25 drives every 50/1 shot negative. Clamping silently converts it
     into a hybrid and destroys its defining property, so it is rejected
     rather than patched. Agrees with multiplicative exactly iff all q equal. */
  function additive(ds) {
    const q = ds.map(d => 1 / d), S = q.reduce((a, b) => a + b, 0);
    const n = q.length, M = S - 1, adj = M / n;
    const minQ = Math.min.apply(null, q);
    if (minQ < 1.5 * adj) return { p: null, S, rejected: 'negative-probability risk' };
    const p = q.map(x => x - adj), T = p.reduce((a, b) => a + b, 0);
    return { p: p.map(x => x / T), S };
  }

  /* (c) Power. Solve sum(q_i^k) = 1. f'(k) = sum(q^k ln q) < 0 so f is
     strictly decreasing: a unique root always exists, k>1 iff S>1, and
     p in (0,1) summing to 1 is GUARANTEED for any n with no negative-
     probability escape hatch. Relative haircut p/q = q^(k-1) is smaller for
     smaller q, so it strips proportionally more margin from longshots --
     the direction favourite-longshot bias requires. It is the most
     aggressive longshot corrector of the four, so where the true loading is
     mild it over-corrects and costs missed bets rather than lost money.
     Newton seeded from a log-space linearization, bisection bracket kept so
     a bad Newton step degrades instead of diverging: 3-5 iterations to
     1e-12 versus ~56 for pure bisection. */
  function power(ds, tol, maxIter) {
    const t = tol || 1e-12, mx = maxIter || 60;
    const qc = ds.map(d => clamp(1 / d, 1e-6, 1 - 1e-6));
    const S = qc.reduce((a, b) => a + b, 0);
    if (Math.abs(S - 1) < 1e-12) return { p: qc.slice(), k: 1, S, iters: 0 };
    const lq = qc.map(Math.log);
    const f = (k) => qc.reduce((s, x, i) => s + Math.exp(k * lq[i]), 0) - 1;
    const fp = (k) => qc.reduce((s, x, i) => s + Math.exp(k * lq[i]) * lq[i], 0);

    let lo, hi;
    if (S > 1) { lo = 1; hi = 2; while (f(hi) > 0 && hi < 64) hi *= 2; }
    else { hi = 1; lo = 0.5; while (f(lo) < 0 && lo > 1e-3) lo /= 2; }

    const meanNegLog = -lq.reduce((a, b) => a + b, 0) / lq.length;
    let k = clamp(1 + Math.log(S) / meanNegLog, lo, hi), iters = 0;
    for (let i = 0; i < mx; i++) {
      iters = i + 1;
      const v = f(k);
      if (Math.abs(v) < t) break;
      if (v > 0) lo = k; else hi = k;
      const kn = k - v / fp(k);
      k = (kn > lo && kn < hi && isFinite(kn)) ? kn : 0.5 * (lo + hi);
      if (hi - lo < 1e-14) break;
    }
    const raw = qc.map((x, i) => Math.exp(k * lq[i]));
    const Z = raw.reduce((a, b) => a + b, 0);
    return { p: raw.map(x => x / Z), k, S, iters };
  }

  /* (d) Shin. Models a book pricing to break even against a fraction z of
     insider money. Normalization: sum(sqrt(z^2 + 4(1-z)q^2/S)) = 2(1-z) + nz.
     At z=0 it gives p = q/sqrt(S) which sums to sqrt(S), so z=0 solves it
     iff S=1 and z>0 strictly whenever S>1. Bisection only -- the derivative
     is ugly and the function is cheap; 32 iterations to 1e-10 on a 0.5
     bracket. NO closed form is used: the circulating n=2 closed form failed
     a residual check by 0.003 in z (0.3pp in p).
     z has no meaning for an exchange or prediction market, where no
     bookmaker is balancing against insiders -- never apply Shin to PM prices. */
  function shin(ds, tol) {
    const t = tol || 1e-12;
    const q = ds.map(d => 1 / d), n = q.length;
    const S = q.reduce((a, b) => a + b, 0);
    if (S <= 1 + 1e-12) return { p: multiplicative(ds).p, z: 0, S, degenerate: true };
    const g = (z) => q.reduce((s, x) =>
      s + Math.sqrt(z * z + 4 * (1 - z) * x * x / S), 0) - 2 * (1 - z) - n * z;
    let lo = 0, hi = 0.5;
    while (g(lo) * g(hi) > 0 && hi < 0.999) hi = Math.min(0.999, hi * 1.5);
    if (g(lo) * g(hi) > 0) return { p: power(ds).p, z: NaN, S, fallback: 'power' };
    let z = 0;
    for (let i = 0; i < 200; i++) {
      z = 0.5 * (lo + hi);
      const v = g(z);
      if (Math.abs(v) < t || hi - lo < 1e-15) break;
      if (g(lo) * v <= 0) hi = z; else lo = z;
    }
    if (z < 1e-9) return { p: multiplicative(ds).p, z: 0, S, degenerate: true };
    const den = 2 * (1 - z);
    const raw = q.map(x => (Math.sqrt(z * z + 4 * (1 - z) * x * x / S) - z) / den);
    const Z = raw.reduce((a, b) => a + b, 0);
    return { p: raw.map(x => x / Z), z, S };
  }

  /* RATIFIED: there is NO default method. The fair probability used
     everywhere is the MEDIAN of the applicable methods, per venue per
     market. Picking one winner among four methods measured to disagree by
     1.95pp -- larger than the median edge this app reports -- is picking a
     number, not computing one. The median makes the displayed figure
     consistent with the gate that guards it, and turns the disagreement
     into a QUANTITY (half the method spread becomes b_devig in the error
     budget) instead of a hidden modelling choice.
     No user setting changes which number the board uses: a method switcher
     is a method-shopping tool. All four stay visible on the drill-down as a
     diagnostic. */
  function medianDevig(ds) {
    const applicable = {}, flags = [];
    applicable.multiplicative = multiplicative(ds).p;
    const add = additive(ds);
    if (add.p) applicable.additive = add.p;
    else flags.push('additive_clipped');
    const pw = power(ds);
    applicable.power = pw.p;
    const sh = shin(ds);
    if (sh.degenerate) flags.push('shin_degenerate');
    else if (sh.fallback) flags.push('shin_fallback');
    else applicable.shin = sh.p;

    const names = Object.keys(applicable);
    const n = ds.length;
    const p = [];
    for (let i = 0; i < n; i++) {
      const vals = names.map(m => applicable[m][i]).sort((a, b) => a - b);
      const k = vals.length;
      p.push(k % 2 ? vals[(k - 1) / 2] : 0.5 * (vals[k / 2 - 1] + vals[k / 2]));
    }
    /* One multiplicative renormalization -- the median of per-outcome
       medians does not sum to 1 in general. */
    const Z = p.reduce((a, b) => a + b, 0);
    const pn = p.map(x => x / Z);

    /* Method spread per outcome, and the b_devig convention: half the
       spread. Stated convention, not a derivation. */
    const spread = [];
    for (let i = 0; i < n; i++) {
      let lo = Infinity, hi = -Infinity;
      for (const m of names) {
        const v = applicable[m][i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      spread.push(hi - lo);
    }
    return { p: pn, methods: applicable, names, spread,
             bDevig: spread.map(x => x / 2), flags };
  }

  /* signStable is evaluated across the SAME applicable set the median used.
     A market where multiplicative says positive and Shin says negative
     renders PASS with "devig sign unstable", regardless of EV%. */
  function signStableFor(md, ix, offeredDecimal) {
    const q = 1 / offeredDecimal;
    let pos = 0, tot = 0;
    for (const m of md.names) { tot++; if (md.methods[m][ix] - q > 0) pos++; }
    return tot > 0 && (pos === tot || pos === 0);
  }

  const METHODS = ['multiplicative', 'additive', 'power', 'shin'];
  const DEFAULT_METHOD = 'power';     /* failure-mode grounds, not proven optimum */

  function apply(ds, method) {
    switch (method) {
      case 'additive': { const r = additive(ds); return r.p || multiplicative(ds).p; }
      case 'power': return power(ds).p;
      case 'shin': return shin(ds).p;
      default: return multiplicative(ds).p;
    }
  }

  /* Exchanges and prediction markets are NOT devigged. The mid of a
     two-sided book is already near vig-free; commission and per-contract
     fees apply to YOUR EXECUTION, not to the venue's implied probability.
     Devigging a Betfair mid double-counts. Signal = mid, execution = ask. */
  const midpoint = (bidProb, askProb) => (bidProb + askProb) / 2;

  function allMethods(ds) {
    const out = {};
    for (const m of METHODS) {
      const p = apply(ds, m);
      if (p) out[m] = p;
    }
    return out;
  }

  /* The identification problem turned into a visible filter rather than a
     hidden bias: if the sign of the edge flips across the four methods the
     bet is not recommended, it is labelled method-sensitive with the range. */
  function methodSensitivity(ds, ix, offeredDecimal) {
    const q = 1 / offeredDecimal, all = allMethods(ds);
    const edges = {}; let lo = Infinity, hi = -Infinity, pos = 0, tot = 0;
    for (const m in all) {
      const e = all[m][ix] - q;
      edges[m] = e; tot++;
      if (e > 0) pos++;
      if (e < lo) lo = e;
      if (e > hi) hi = e;
    }
    return { edges, min: lo, max: hi, spread: hi - lo,
             signStable: (pos === tot || pos === 0), nMethods: tot };
  }
  return { multiplicative, additive, power, shin, apply, allMethods, midpoint,
           methodSensitivity, medianDevig, signStableFor, METHODS, DEFAULT_METHOD };
})();
