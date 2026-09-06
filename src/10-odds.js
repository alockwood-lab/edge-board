/* --------------------------------------------------------------- L1 odds */
VB.odds = (function () {
  const { clamp } = VB.util;

  /* American odds are a TWO-BRANCH map from d in (1,inf) onto
     (-inf,-100] U [+100,inf). The interval (-100,+100) is NOT in the range --
     the "discontinuity at zero" is a gap in the codomain, not a removable
     singularity. There is no A=0, no A=+50. */
  function americanToDecimal(a) {
    if (!isFinite(a) || Math.abs(a) < 100) return NaN;
    return a > 0 ? 1 + a / 100 : 1 - 100 / a;
  }

  /* d=2 maps to +100 and -100 equally, so this is not a bijection. We
     canonicalize evens to +100 (the conventional quote). Consequence:
     sign(A) is NOT a valid favourite/underdog test -- use d vs 2. */
  const canonicalizeAmerican = (a) => (a === -100 ? 100 : a);
  function decimalToAmerican(d) {
    if (!(d > 1)) return NaN;
    if (Math.abs(d - 2) < 1e-6) return 100;      /* float noise flips the branch */
    const a = d >= 2 ? (d - 1) * 100 : -100 / (d - 1);
    return canonicalizeAmerican(a);
  }

  /* A feed value in (-100,+100) is not an American price. If it looks like
     a decimal odd misrouted into an American field, say so -- never coerce. */
  function sniffPrice(raw) {
    const v = typeof raw === 'string' ? raw.trim().toUpperCase() : raw;
    if (v === 'EVEN' || v === 'EV' || v === 'PK') return { format: 'american', value: 100 };
    const n = Number(v);
    if (!isFinite(n) || n === 0) return { format: 'reject', reason: 'null-or-zero' };
    if (Math.abs(n) >= 100) return { format: 'american', value: n };
    if (n > 1 && n < 20) return { format: 'suspect_decimal', value: n,
                                  reason: 'in (1,20): likely a decimal odd in an American field' };
    return { format: 'reject', reason: 'in (-100,+100): not a valid American price' };
  }

  const fractionalToDecimal = (n, m) => 1 + n / m;
  const probToDecimal = (p) => 1 / p;
  const decimalToProb = (d) => 1 / d;

  /* Best rational approximation via continued-fraction convergents.
     1/(1/d) round-trips exactly in float64; d -> n/m -> d does not. */
  function toFraction(dec, maxDen) {
    const cap = maxDen || 1000;
    let x = dec - 1, h1 = 1, h0 = 0, k1 = 0, k0 = 1, b = x, best = [1, 1];
    for (let i = 0; i < 32; i++) {
      const a = Math.floor(b);
      const nh = a * h1 + h0; h0 = h1; h1 = nh;
      const nk = a * k1 + k0; k0 = k1; k1 = nk;
      if (k1 > cap) break;
      best = [h1, k1];
      if (b === a) break;
      b = 1 / (b - a);
    }
    return best;
  }

  /* Prediction markets quote integer cents and the contract pays $1, so
     d = 100/c. Reading 40c as +150 by analogy is the classic bug; NO at
     (100-c) is a separate tradable outcome with its own book, not a mirror.
     c=0 is UNPRICED -- clamping it to an epsilon is how you generate a
     900% EV bet on nothing. */
  function centsToDecimal(c) {
    if (!(c > 0)) return Infinity;               /* unpriced, not a bet */
    return 100 / c;
  }
  const decimalToCents = (d) => 100 / d;
  const PM_TICK = { kalshi: [1, 99], polymarket: [0.1, 99.9] };

  /* Prediction-market booksum from the two asks, so PM venues drop straight
     into the hold component. YES_ask + NO_ask >= 100 always. */
  const pmBookSum = (yesAskCents, noAskCents) => (yesAskCents + noAskCents) / 100;

  /* PM capital is locked until settlement, so a contract is a DISCOUNTED
     claim: PM prices systematically UNDERSTATE probability on long-dated
     markets. At r=5% and T=0.5yr this is a 2.5% relative adjustment --
     larger than the median edge this app reports. Applied above 30 days. */
  function pmTimeValue(pRaw, years, r) {
    if (!(years > 30 / 365)) return pRaw;
    return Math.min(0.9999, pRaw * Math.pow(1 + (r === undefined ? 0.05 : r), years));
  }

  /* Books post on a grid. Snapping is where genuine cross-venue arbitrage
     comes from, so it happens before the board sees the price, not after.
     Steps: 5 below 300, 10 below 1000, 25 above. */
  function snapToGrid(d, mode) {
    if (mode === 'cents') return centsToDecimal(clamp(Math.round(decimalToCents(d)), 1, 99));
    const a = d >= 2 ? (d - 1) * 100 : -100 / (d - 1);
    const m = Math.abs(a);
    const step = m < 300 ? 5 : m < 1000 ? 10 : 25;
    let s = Math.round(a / step) * step;
    if (Math.abs(s) < 100) s = a < 0 ? -100 : 100;
    return americanToDecimal(s);
  }

  /* One American cent near even money is worth ~0.23 probability points --
     about a quarter of the app's whole minimum edge. So decimal is stored
     and American is display-only; a d -> round(A) -> d round trip at -110
     injects up to 0.11pp of error and we are hunting 1-2pp. */
  const centSensitivity = (a) => 100 / Math.pow(Math.abs(a) + 100, 2);

  const bookSum = (ds) => ds.reduce((s, d) => s + 1 / d, 0);
  const hold = (ds) => 1 - 1 / bookSum(ds);

  /* Commission is charged on net winnings, so it bites long prices far
     harder than short ones -- the opposite of a book's vig profile. */
  const commissionAdjusted = (d, c) => 1 + (d - 1) * (1 - c);

  /* Kalshi-form per-contract fee, maximal at P=0.50 and vanishing in the
     tails: at a 4pp edge it eats 25-50% of gross EV and erases a 2pp edge
     outright. Fee dispatch is by formula id, never a sprinkled constant. */
  function pmFeeAdjusted(d, k) {
    const P = 1 / d, kk = (k === undefined ? 0.07 : k);
    return 1 / (P * (1 + kk * (1 - P)));
  }

  const fmtAmerican = (a) => (!isFinite(a) ? '--' : (a > 0 ? '+' : '') + Math.round(a));
  return { americanToDecimal, decimalToAmerican, canonicalizeAmerican, sniffPrice,
           fractionalToDecimal, probToDecimal, decimalToProb, toFraction,
           centsToDecimal, decimalToCents, pmBookSum, pmTimeValue, PM_TICK,
           snapToGrid, centSensitivity, bookSum, hold,
           commissionAdjusted, pmFeeAdjusted, fmtAmerican };
})();
