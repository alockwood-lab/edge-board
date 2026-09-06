/* -------------------------------------------------------------- L1 score */
VB.score = (function () {
  const { clamp, sig } = VB.util;

  /* TWO SCORES, NO COMPOSITE. The leaderboard answers two opposite
     questions and one blended number is wrong for both:
       SHARP -- whose price to trust. Weights the consensus. Sharp venues rise.
       USE   -- where to bet. Ranks bet targets. SOFT venues rise, because
                that is where the edges are.
     A composite would hide exactly the venue that is sharp AND unusable. */

  const SHARP_W = { cla: 0.60, calib: 0.20, logLoss: 0.10, brier: 0.10 };
  const USE_W = { hold: 0.45, depth: 0.35, breadth: 0.20 };

  /* n gates. Closing-line accuracy recovers a known injected ordering at
     n=500 with adjacent t-stats of 4.7-7.7. Outcome-based Brier gets the
     ordering WRONG at n=6,000 and needs ~20,000, so it is gated hard and
     carries a tenth of the weight -- a weight set that gave Brier 0.15 and
     CLA 0.30 would spend a third of its budget on decoration. */
  const N_GATE = { cla: 300, calib: 500, logLoss: 1000, brier: 1000 };

  /* Shrinkage k = sigma_within^2 / sigma_between^2 -- derived, not taste.
     k_brier ~ 1500 means at 300 settled observations the Brier component is
     83% prior and 17% data. k_cla ~ 80 means CLA is genuinely MEASURED
     within weeks. */
  const K = { cla: 80, calib: 800, logLoss: 1200, brier: 1500, hold: 10 };
  const TIER_PRIOR = { 1: 62, 2: 50, 3: 42 };

  /* Naive ECE is biased upward by sqrt(2/pi)*sqrt(p(1-p)/n_b) per bin: a
     PERFECTLY calibrated venue with 300 settled bets scores ~7pp of pure
     noise. Uncorrected, the calibration component is a sample-size proxy. */
  function eceAdjusted(bins) {
    let ece = 0, N = 0;
    for (const b of bins) N += b.n;
    if (!N) return NaN;
    for (const b of bins) {
      if (!b.n) continue;
      const noise = Math.sqrt(2 / Math.PI) * Math.sqrt(b.pMean * (1 - b.pMean) / b.n);
      ece += (b.n / N) * Math.max(0, Math.abs(b.oMean - b.pMean) - noise);
    }
    return ece;
  }

  /* Favourite-longshot fingerprint: logit(observed) = alpha + beta*logit(pred).
     beta < 1 means the venue's prices are over-extreme; alpha != 0 means a
     systematic side lean. |beta - 1| feeds the calibration score. */
  function flsFit(bins) {
    const pts = bins.filter(b => b.n > 0 && b.pMean > 0 && b.pMean < 1
                                 && b.oMean > 0 && b.oMean < 1);
    if (pts.length < 3) return { alpha: NaN, beta: NaN, n: pts.length };
    const lx = pts.map(b => Math.log(b.pMean / (1 - b.pMean)));
    const ly = pts.map(b => Math.log(b.oMean / (1 - b.oMean)));
    const w = pts.map(b => b.n), W = w.reduce((a, b) => a + b, 0);
    const mx = lx.reduce((s, x, i) => s + w[i] * x, 0) / W;
    const my = ly.reduce((s, y, i) => s + w[i] * y, 0) / W;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < pts.length; i++) {
      sxy += w[i] * (lx[i] - mx) * (ly[i] - my);
      sxx += w[i] * (lx[i] - mx) * (lx[i] - mx);
    }
    const beta = sxx > 0 ? sxy / sxx : NaN;
    return { alpha: my - beta * mx, beta, n: pts.length };
  }

  /* Raw components from sufficient statistics -- never from stored rows.
     35 numbers per venue recovers every metric AND its standard error. */
  function components(s) {
    if (!s || !s.n) return null;
    const n = s.n;
    const cla = s.claSum / n;
    const claSE = Math.sqrt(Math.max(0, s.claSumSq / n - cla * cla) / n);
    const brier = s.nSettled ? s.brierSum / s.nSettled : NaN;
    const brierSE = s.nSettled
      ? Math.sqrt(Math.max(0, s.brierSumSq / s.nSettled - brier * brier) / s.nSettled)
      : NaN;
    return { n, nSettled: s.nSettled || 0,
             cla, claSE, claT: claSE > 0 ? cla / claSE : NaN,
             brier, brierSE, logLoss: s.nSettled ? s.logSum / s.nSettled : NaN,
             ece: s.bins ? eceAdjusted(s.bins) : NaN,
             fls: s.bins ? flsFit(s.bins) : null,
             hold: s.holdSum && s.nHold ? s.holdSum / s.nHold : NaN,
             breadth: s.breadth, depthTier: s.depthTier };
  }

  /* Robust standardize against the cohort, then ONE logistic at the end.
     Robust z over mean/SD because with 19 venues one broken adapter destroys
     a mean and inflates an SD. Logistic over min-max because min-max is
     wrecked by a single outlier and rescales everyone when a venue is added. */
  function robustZ(x, vals) {
    const v = vals.filter(isFinite).slice().sort((a, b) => a - b);
    if (v.length < 3 || !isFinite(x)) return 0;
    const med = v[Math.floor(v.length / 2)];
    const devs = v.map(y => Math.abs(y - med)).sort((a, b) => a - b);
    const mad = devs[Math.floor(devs.length / 2)];
    if (!(mad > 0)) return 0;
    return (x - med) / (1.4826 * mad);
  }
  const toScore = (z) => 100 * sig(z / 1.5);
  const shrinkZ = (z, n, k) => z * (n / (n + k));

  /* Anchored so the score does not inflate when the whole cohort is bad. */
  const holdScore = (h) => 100 * clamp(1 - (h - 0.01) / (0.12 - 0.01), 0, 1);

  /* Any component below its n gate renders "insufficient data" and its
     weight is REDISTRIBUTED PROPORTIONALLY, with the redistribution
     disclosed and asserted to sum to 1.000. No back-filling with priors,
     no "provisional score". */
  function redistribute(weights, available) {
    const live = Object.keys(weights).filter(k => available[k]);
    const lost = Object.keys(weights).filter(k => !available[k]);
    const kept = live.reduce((s, k) => s + weights[k], 0);
    const out = {};
    if (!(kept > 0)) return { weights: out, dropped: lost, ok: false };
    for (const k of live) out[k] = weights[k] / kept;
    return { weights: out, dropped: lost, ok: true };
  }

  function sharp(c, cohort, tier) {
    if (!c) return { state: 'unrated', n: 0 };
    const avail = {
      cla: c.n >= N_GATE.cla && isFinite(c.cla),
      calib: c.nSettled >= N_GATE.calib && isFinite(c.ece),
      logLoss: c.nSettled >= N_GATE.logLoss && isFinite(c.logLoss),
      brier: c.nSettled >= N_GATE.brier && isFinite(c.brier) && c.publishesProbability
    };
    const rd = redistribute(SHARP_W, avail);
    if (!rd.ok) return { state: 'prior_only', prior: TIER_PRIOR[tier] || 50,
                         n: c.n, nSettled: c.nSettled, dropped: rd.dropped };
    /* Lower is better for every error metric, so negate before scoring. */
    let zsum = 0;
    const parts = {};
    if (avail.cla) {
      const z = shrinkZ(robustZ(-c.cla, cohort.cla.map(x => -x)), c.n, K.cla);
      parts.cla = z; zsum += rd.weights.cla * z;
    }
    if (avail.calib) {
      const pen = -(c.ece + (c.fls && isFinite(c.fls.beta) ? Math.abs(c.fls.beta - 1) * 0.05 : 0));
      const z = shrinkZ(robustZ(pen, cohort.calib.map(x => -x)), c.nSettled, K.calib);
      parts.calib = z; zsum += rd.weights.calib * z;
    }
    if (avail.logLoss) {
      const z = shrinkZ(robustZ(-c.logLoss, cohort.logLoss.map(x => -x)), c.nSettled, K.logLoss);
      parts.logLoss = z; zsum += rd.weights.logLoss * z;
    }
    if (avail.brier) {
      const z = shrinkZ(robustZ(-c.brier, cohort.brier.map(x => -x)), c.nSettled, K.brier);
      parts.brier = z; zsum += rd.weights.brier * z;
    }
    return { state: 'rated', score: toScore(zsum), z: zsum, parts,
             weights: rd.weights, dropped: rd.dropped, n: c.n, nSettled: c.nSettled,
             claT: c.claT };
  }

  function use(c, cohort) {
    if (!c) return { state: 'unrated' };
    const avail = { hold: isFinite(c.hold), depth: isFinite(c.depthTier),
                    breadth: isFinite(c.breadth) };
    const rd = redistribute(USE_W, avail);
    if (!rd.ok) return { state: 'unrated' };
    let sc = 0;
    if (avail.hold) sc += rd.weights.hold * holdScore(c.hold);
    if (avail.depth) sc += rd.weights.depth * (100 * clamp(c.depthTier / 5, 0, 1));
    if (avail.breadth) sc += rd.weights.breadth * (100 * clamp(c.breadth, 0, 1));
    return { state: 'rated', score: sc, weights: rd.weights, dropped: rd.dropped };
  }

  /* Two venues whose scores differ by less than 2 PAIRED standard errors are
     a TIE. A non-significant gap must never render as a rank. */
  function isTie(a, b) {
    if (!a || !b || !isFinite(a.cla) || !isFinite(b.cla)) return true;
    const se = Math.sqrt(a.claSE * a.claSE + b.claSE * b.claSE);
    if (!(se > 0)) return true;
    return Math.abs(a.cla - b.cla) / se < 2;
  }

  /* Rank on CLA ascending (lower deviation from the closing consensus is
     better), collapsing non-significant adjacent gaps into shared ranks.
     Unrated venues never rank above a rated one regardless of score. */
  function rank(rows) {
    const rated = rows.filter(r => r.comp && r.comp.n >= N_GATE.cla)
                      .sort((a, b) => a.comp.cla - b.comp.cla);
    const unrated = rows.filter(r => !(r.comp && r.comp.n >= N_GATE.cla));
    /* Tie groups must be anchored, not chained. Comparing each row only with
       its immediate predecessor makes ties transitive -- A ties B, B ties C,
       so A and C land in the same band even when they are plainly
       distinguishable. A group therefore extends only while the row still
       ties the group's FIRST member. */
    let anchor = null, rk = 0;
    rated.forEach((r, i) => {
      if (i === 0 || !isTie(anchor.comp, r.comp)) { anchor = r; rk = i + 1; r.tiedWithPrev = false; }
      else r.tiedWithPrev = true;
      r.rank = rk;
    });
    unrated.forEach(r => { r.rank = null; r.state = 'unrated'; });
    return { rated, unrated };
  }
  return { components, sharp, use, isTie, rank, eceAdjusted, flsFit, robustZ,
           toScore, shrinkZ, holdScore, redistribute,
           SHARP_W, USE_W, N_GATE, K, TIER_PRIOR };
})();
