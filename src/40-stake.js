/* -------------------------------------------------------------- L1 stake */
VB.stake = (function () {
  const { clamp, Phi } = VB.util;

  /* R is an EDGE CORRECTION, not a risk preference, and the distinction is
     load-bearing. Shrinking the probability toward the offer and then
     running Kelly is algebraically identical to shrinking the Kelly
     fraction:  p_adj = q + R(p-q)  =>  f*_adj = R*f*  exactly.
     So R belongs to the estimator. The consequence: if R is doing its job
     then R*f* IS true Kelly, which is a 50% chance of ever halving the
     bankroll. That is why lambda is separately required -- applying both is
     not double-haircutting, and calling lambda an estimation correction
     would be. */
  const R_PRIOR = 0.35;              /* replaced by beta-hat from the CLV regression at N>=200 */
  const R_MIN_OBS = 200;
  const LAMBDA_DEFAULT = 0.25;       /* Conservative */
  const U_FRAC = 0.01;               /* 1 unit = 1% of bankroll */

  /* EV per unit staked. p is the leave-one-CLUSTER-out consensus fair
     probability and d is the RAW OFFERED price. Comparing a venue against
     its OWN devigged probability is the most expensive bug in this class of
     app: it manufactures edge out of vig and roughly doubles the answer
     (0.101 against the correct 0.0505). */
  const ev = (p, d) => p * d - 1;
  const edgeProb = (p, d) => p - 1 / d;

  /* EV% = e_p / q_o. A fixed probability edge is worth wildly different EV%
     at different prices -- 1pp is 2.0% EV at even money and 33.3% at 3c.
     So the board must threshold on BOTH, and the ladder must never be built
     on EV%. */
  const evPctFromEdge = (ep, qo) => ep / qo;

  /* f* = (p*d - 1)/(d - 1) = EV%/b. That identity is why a 5% EV is a 3.4%
     stake at +145 but a 15.0% stake at -300: an EV%-based ladder is a 4.4x
     sizing error at the extremes, and it is the single most common flaw in
     edge-to-unit mappings. */
  function kelly(p, d) {
    const b = d - 1;
    if (!(b > 0)) return 0;
    const f = (p * d - 1) / b;
    return f > 0 ? f : 0;
  }

  /* Pushes return the stake rather than losing it, so they INCREASE the
     optimal stake: f* = (pb - q)/(b(1 - pPush)). A -110 bet on an NFL 3
     with pPush=0.09 gets a 1.10x larger Kelly than the naive formula. */
  function kellyWithPush(p, d, pPush) {
    const b = d - 1, q = 1 - p - pPush;
    if (!(b > 0)) return 0;
    const f = (p * b - q) / (b * (1 - pPush));
    return f > 0 ? f : 0;
  }

  /* Homogeneous-correlation haircut, exact for the equicorrelation case.
     Three bets on one game at rho=0.75 -> 40% of standalone size each. */
  const corrHaircut = (k, rho) => 1 / (1 + Math.max(0, k - 1) * rho);
  const RHO = { same_game_same_side: 0.75, same_game_aligned: 0.30,
                same_player: 0.50, same_league_same_day: 0.05, different_sport: 0.02 };

  /* Rung boundaries are GEOMETRIC midpoints, not arithmetic. Growth loss
     near f* is proportional to the squared RELATIVE stake error, so
     equalizing relative error across rungs equalizes worst-case growth loss.
     The ladder bottoms at 0.25u because a properly de-biased quarter-Kelly
     regime genuinely produces stake fractions that small -- a ladder
     starting at 0.5u would silently delete qualifying bets, which is what a
     0.7071 floor was measured doing. */
  const RUNGS = [0.25, 0.5, 1.0, 1.5, 2.0];
  const RUNG_BOUNDS = [0.17677669529663687,   /* 0.25 / sqrt(2) */
                       0.35355339059327373,   /* sqrt(0.25*0.5) */
                       0.70710678118654752,   /* sqrt(0.5*1.0)  */
                       1.22474487139158905,   /* sqrt(1.0*1.5)  */
                       1.73205080756887729];  /* sqrt(1.5*2.0)  */
  const FLOOR_U = RUNG_BOUNDS[0];
  function quantize(uRaw) {
    if (!(uRaw >= RUNG_BOUNDS[0])) return 0;
    for (let i = 1; i < RUNG_BOUNDS.length; i++) {
      if (uRaw < RUNG_BOUNDS[i]) return RUNGS[i - 1];
    }
    return 2.0;                      /* hard per-bet cap */
  }
  const snapLadder = quantize;       /* alias */

  /* THE RATIFIED SIZING CHAIN. ONE multiplication chain, ONE quantization,
     at the end. Quantizing f_final rather than an intermediate is what makes
     1.0u === unit_$ true BY CONSTRUCTION -- so the unit column and the money
     column are the same number and the app never has to explain that it
     redefined the user's own word.
       R  de-biases the EDGE ESTIMATE. Without it every stake is inflated by
          ~1/0.35 = 2.9x. Read-only: an editable R is a control that disables
          the bias correction while wearing the costume of a risk preference.
       l  controls DRAWDOWN against an unbiased edge. Without it the user is
          at full Kelly relative to truth -- a 50% chance of ever halving.
     Both are required; applying either twice is the bug. */
  function size(args) {
    const p = args.pFair, d = args.dNet;
    const R = (args.R === undefined ? R_PRIOR : args.R);
    const lambda = (args.lambda === undefined ? LAMBDA_DEFAULT : args.lambda);
    const unitUsd = args.unitUsd;
    const bankroll = args.bankroll;
    if (!(bankroll > 0) || !(unitUsd > 0)) return { unset: true };

    const evNet = ev(p, d);
    const fKelly = args.pPush ? kellyWithPush(p, d, args.pPush) : kelly(p, d);
    const fDebiased = R * fKelly;
    const fFinal = lambda * fDebiased * corrHaircut(args.nCorr || 1, args.rho || 0);
    const uRaw = fFinal * bankroll / unitUsd;
    const rung = quantize(uRaw);
    const amount = rung * unitUsd;   /* exactly. no further multiplier. */

    return { evNet, fKelly, R, fDebiased, lambda, fFinal, uRaw, rung, amount,
             bankroll, unitUsd, uFracImplied: unitUsd / bankroll,
             suppressed: rung === 0 ? 'below_floor' : null };
  }

  /* What bankroll would make 1.0u a typical qualifying bet, and what unit
     would make 1.0u typical at the user's actual bankroll. Both are
     first-run disclosures, not settings the app changes on its own. */
  function impliedBankrollFor1u(typicalFFinal, unitUsd) {
    if (!(typicalFFinal > 0)) return NaN;
    return unitUsd / typicalFFinal;
  }
  function suggestedUnitFor1u(typicalFFinal, bankroll) {
    if (!(typicalFFinal > 0)) return NaN;
    return typicalFFinal * bankroll;
  }

  /* Cap cascade. Returns WHICH cap bound, as a string, because a stake the
     user cannot explain is a stake the user will not place. */
  function applyCaps(stakeUsd, caps, bankroll, unitUsd, venueLimit) {
    let s = stakeUsd, by = 'none';
    const cand = [['maxStakePctBankroll', caps.maxStakePctBankroll * bankroll],
                  ['maxStakeUnits', caps.maxStakeUnits * unitUsd],
                  ['maxStakeAbs', caps.maxStakeAbs],
                  ['venueLimit', (venueLimit > 0 ? venueLimit : null)]];
    for (let i = 0; i < cand.length; i++) {
      const lim = cand[i][1];
      if (lim !== null && lim !== undefined && isFinite(lim) && lim < s) { s = lim; by = cand[i][0]; }
    }
    return { stake: s, cappedBy: by };
  }

  /* Rounding must never breach a cap, so it always rounds DOWN. */
  function roundStake(s, inc) {
    if (!(inc > 0)) return Math.floor(s * 100) / 100;
    return Math.floor(s / inc) * inc;
  }

  /* Proportional scaling is the EXACT solution to maximizing the quadratic
     growth approximation under a total-exposure constraint when pairwise
     correlations are homogeneous; it is an approximation otherwise. */
  function scaleToExposure(stakes, maxTotal) {
    const T = stakes.reduce((a, b) => a + b, 0);
    if (!(T > maxTotal) || !(T > 0)) return { stakes, scale: 1 };
    const k = maxTotal / T;
    return { stakes: stakes.map(x => x * k), scale: k };
  }

  /* Growth retained at lambda relative to true Kelly is lambda(2-lambda):
     zero at 2x Kelly and NEGATIVE beyond. Over-betting is not symmetric
     with under-betting, which is why the default is conservative while R is
     still a seeded prior. */
  const growthRetained = (lambda) => lambda * (2 - lambda);

  /* P(bankroll ever falls to fraction x) = x^(2/lambda - 1).
     Full Kelly carries a 50% chance of EVER halving the bankroll -- a
     property of the growth-optimal strategy, not a criticism of it.
     Caveat that must ship with it: this is lambda relative to TRUE Kelly,
     so if R is overstated the effective lambda is larger and these numbers
     are optimistic. If the true edge is zero, P(ruin) = 1. */
  const pEverDrawdown = (x, lambda) => Math.pow(x, 2 / lambda - 1);

  /* P(down after N bets). The normal approximation UNDERSTATES the risk for
     long prices because the return distribution is right-skewed and the
     median result is worse than the mean, so the exact binomial is used
     below N=200. */
  function pDownAfterN(p, d, N) {
    const mu = p * d - 1, sd = Math.sqrt(p * (1 - p)) * d;
    if (!(sd > 0)) return NaN;
    if (N < 200) return pDownExact(p, d, N);
    return Phi(-Math.sqrt(N) * mu / sd);
  }
  function pDownExact(p, d, N) {
    const need = Math.ceil(N / d);            /* wins required to break even */
    let lp = N * Math.log(1 - p), acc = 0;
    for (let k = 0; k < need; k++) {
      if (k > 0) lp += Math.log((N - k + 1) / k) + Math.log(p / (1 - p));
      acc += Math.exp(lp);
    }
    return clamp(acc, 0, 1);
  }
  const sharpe = (p, d) => (p * d - 1) / (Math.sqrt(p * (1 - p)) * d);

  /* lambda_eff is lambda measured against TRUE Kelly, so if the shipped R
     overstates reliability the effective lambda is LARGER and every risk
     figure computed from lambda alone is optimistic. No drawdown number
     computed from an assumed-exact R may ever be displayed without its
     sensitivity row beside it. */
  const lambdaEff = (lambda, rShipped, rTrue) => lambda * (rShipped / rTrue);
  const R_SENSITIVITY = 0.20;        /* pessimistic R until the CLV regression lands */

  return { ev, edgeProb, evPctFromEdge, kelly, kellyWithPush, corrHaircut, RHO,
           quantize, snapLadder, size, applyCaps, roundStake, scaleToExposure,
           growthRetained, pEverDrawdown, pDownAfterN, pDownExact, sharpe,
           lambdaEff, impliedBankrollFor1u, suggestedUnitFor1u,
           R_PRIOR, R_MIN_OBS, R_SENSITIVITY, LAMBDA_DEFAULT, U_FRAC,
           FLOOR_U, RUNGS, RUNG_BOUNDS };
})();
