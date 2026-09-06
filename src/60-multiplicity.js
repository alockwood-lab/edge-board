/* ------------------------------------------------------- L1 multiplicity */
VB.multiplicity = (function () {
  /* THE MOST IMPORTANT HONESTY MECHANISM IN THE PRODUCT, and it is ON by
     default with no toggle.
     The board shows the user the MAXIMUM of many noisy estimates, and the
     maximum of noise looks exactly like edge. For M markets evaluated with
     edge-estimate noise SD s, the expected largest pure-noise value is
     s*a(M). At M=500 and s=0.73pp that is 2.12pp of apparent edge with NO
     real mispricing anywhere -- which EXCEEDS the 1.78pp edge in the
     reference calculation. */
  function a(M) {
    const m = Math.max(2, M);
    const L = Math.sqrt(2 * Math.log(m));
    return L - (Math.log(Math.log(m)) + Math.log(4 * Math.PI)) / (2 * L);
  }

  /* M is the count of markets EVALUATED this render, not the count
     displayed. Filtering the board does not reduce the multiplicity you
     already paid for. */
  const eCrit = (seTotal, M) => seTotal * a(M);
  const eAdj = (ep, seTotal, M) => ep - eCrit(seTotal, M);

  /* Staleness bias, fitted to the three measured drift points:
     0.12pp at 1 min, 0.48pp at 15 min, 0.97pp at 60 min. At a 2pp gate a
     one-hour-old quote contributes roughly half the threshold in pure
     noise, so this is not a rounding term. */
  const B_STALE_A = 0.0012, B_STALE_B = 0.512;
  const bStale = (ageMin) => B_STALE_A * Math.pow(Math.max(ageMin, 1), B_STALE_B);

  /* The relief valve is a SMALLER M, not a lower floor -- and the user must
     be told the lever is weak, because a(M) grows like sqrt(ln M). */
  function scopeRelief(mWide, mNarrow, seTotal) {
    return { wide: eCrit(seTotal, mWide), narrow: eCrit(seTotal, mNarrow),
             gainPP: (eCrit(seTotal, mWide) - eCrit(seTotal, mNarrow)) * 100 };
  }
  return { a, eCrit, eAdj, bStale, scopeRelief, B_STALE_A, B_STALE_B };
})();
