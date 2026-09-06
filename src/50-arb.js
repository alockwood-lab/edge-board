/* ---------------------------------------------------------------- L1 arb */
VB.arb = (function () {
  /* Best net price per outcome across venues. S* < 1 is an arbitrage;
     R = 1/S* - 1 per unit of total outlay, split s_i = (1/d_i)/S*, which
     equalizes payoff across outcomes by construction. Fees and commission
     must already be inside the decimals -- a fee-blind detector prints
     arbitrages that do not exist. */
  function detect(bestNetDecimals, eps) {
    const e = (eps === undefined ? 1e-9 : eps);
    const S = bestNetDecimals.reduce((s, d) => s + 1 / d, 0);
    const roi = 1 / S - 1;
    const split = bestNetDecimals.map(d => (1 / d) / S);
    return { S, isArb: S < 1 - e, roi, split };
  }
  const stakes = (ds, total) => detect(ds).split.map(f => f * total);

  /* A large apparent arb is a data-quality alarm, not an opportunity: the
     4-8% band is exactly where realistic entity mis-mappings land, and a
     fake arb is indistinguishable from a real one by inspection. Threshold
     is set at the honest edge of genuine, NOT calibrated to the one case we
     planted in the demo -- that would be calibrating to our own fixture. */
  const SUSPECT_ROI = 0.04;
  const isSuspect = (roi) => roi >= SUSPECT_ROI;

  /* A middle needs a DISTRIBUTION, not a price. Read the CDF off the
     alternate-lines ladder; never fit a normal to NFL margin, where the
     entire value of a 2.5/3.5 middle is the point mass at exactly 3 that a
     continuous fit smears away. */
  function middle(dA, dB, pMid, pHi) {
    const sA = (1 / dA) / (1 / dA + 1 / dB);
    const sB = 1 - sA;
    const X = sA * dA - 1, Y = sB * dB - 1;
    const ev = Y + pHi * (X - Y) + pMid * sA * dA;
    const pMidBreakeven = -(Y + pHi * (X - Y)) / (sA * dA);
    return { sA, sB, maxLossPerUnit: Math.min(X, Y), ev, pMidBreakeven,
             isFreeMiddle: (1 / dA + 1 / dB) <= 1 };
  }

  /* A quote deviating far from an established consensus is usually a mapping
     error, not alpha -- but "far" MUST be measured against that venue's own
     known dispersion, not a flat threshold.
     A flat 6pp gate is a calibration error: a soft book's designed logit
     noise of 0.21 produces ~5pp of probability deviation as a matter of
     course, so a flat gate quarantines precisely the soft prices this app
     exists to find. Meanwhile 6pp from a sharp book IS almost certainly a
     data error.
     So: quarantine at 4 standard deviations of the VENUE'S OWN historical
     deviation, floored at 6pp so a venue with no history is still guarded.
     sqrt(CLA) is exactly that per-venue SD and the leaderboard already
     computes it, so this costs nothing. */
  const QUOTE_OUTLIER_PP = 0.06;
  const QUOTE_OUTLIER_SD = 4;
  function quoteOutlierThreshold(venueCla) {
    const sd = (venueCla > 0) ? Math.sqrt(venueCla) : 0;
    return Math.max(QUOTE_OUTLIER_PP, QUOTE_OUTLIER_SD * sd);
  }
  function isQuoteOutlier(pVenue, pConsensus, nVenues, venueCla) {
    if (nVenues < 5) return false;
    return Math.abs(pVenue - pConsensus) > quoteOutlierThreshold(venueCla);
  }

  return { detect, stakes, isSuspect, middle, isQuoteOutlier,
           quoteOutlierThreshold, SUSPECT_ROI, QUOTE_OUTLIER_PP, QUOTE_OUTLIER_SD };
})();
