/* -------------------------------------------- L2  sharp-reference comparison */
VB.refcmp = (function () {
  const O = VB.odds;

  /* THE POINT OF THIS MODULE.
     Showing a DraftKings line is worthless -- you can read that on DraftKings.
     Edge requires a second, INDEPENDENT opinion, and the consensus engine
     needs three clusters before it will price anything. Two free sources are
     reachable from a browser, and one of them is an exchange:
       DraftKings (via ESPN)  a soft book, ~4.5% two-sided hold
       Polymarket             an order book, near-zero vig, real liquidity
     An exchange mid is the classic sharp reference, so this measures the
     book's offered price against it directly. That is NOT a consensus and it
     is not labelled as one -- it is a two-venue reference comparison, which
     is exactly what the architecture recommended: use sharp venues as the
     fair-value reference and score retail books on their distance from it.

     THE LINE PROBLEM, AND WHY IT IS SOLVABLE.
     Measured today: the games match but the lines do not. Polymarket sits on
     half-runs where DraftKings sits on whole numbers (DK 7.0 vs PM 6.5; DK
     11.0 vs PM 10.5 AND 11.5). A 7 may never be compared with a 7.5 -- that
     is the no-tolerance-on-line rule and breaking it invents edge.
     But when the reference BRACKETS the offered whole-number line, the three
     outcome probabilities are EXACTLY derivable, with no interpolation:
       P(over N)  = P(>= N+1) = P(over N+0.5)
       P(push)    = P(over N-0.5) - P(over N+0.5)
       P(under N) = 1 - P(over N-0.5)
     That is an identity, not an estimate. Verified on a live market:
     PM 10.5 -> 0.555, PM 11.5 -> 0.455 gives over 0.4550 / push 0.1000 /
     under 0.4450, summing to exactly 1. */

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const EPS = 1e-9;

  /* Parse the reference pool out of a Polymarket payload. Only markets whose
     title is an unambiguous game market are kept; anything whose settlement
     basis cannot be read off the title is discarded rather than guessed. */
  function buildPool(pmQuotes) {
    const pool = { totals: {}, spreads: {}, ml: {} };
    for (const q of pmQuotes || []) {
      const title = String(q.question || '');
      const liq = q.liquidityUsd || 0;
      const spreadC = (q.spreadCents === null || q.spreadCents === undefined)
        ? null : q.spreadCents;
      /* "Away vs. Home: O/U 8.5" */
      let m = title.match(/^(.+?)\s+vs\.?\s+(.+?):\s*O\/U\s+([\d.]+)\s*$/i);
      if (m && q.outcomes.length === 2) {
        const key = norm(m[1]) + '|' + norm(m[2]);
        const line = Number(m[3]);
        const overIx = /^over/i.test(q.outcomes[0]) ? 0 : 1;
        (pool.totals[key] = pool.totals[key] || []).push({
          line, pOver: q.midProbs[overIx], liq, spreadC, title });
        continue;
      }
      /* "Away vs. Home" moneyline. Only usable if it settles on THIS game,
         which the endDate has to confirm -- a same-titled series market
         settles on a different event entirely and matching it would be a
         category error, not a rounding error. */
      m = title.match(/^(.+?)\s+vs\.?\s+(.+?)\s*$/i);
      if (m && q.outcomes.length === 2 && !/O\/U|spread|:/i.test(title)) {
        const key = norm(m[1]) + '|' + norm(m[2]);
        pool.ml[key] = pool.ml[key] || [];
        pool.ml[key].push({ pAway: q.midProbs[0], pHome: q.midProbs[1],
                            liq, spreadC, endDate: q.endDate, title });
      }
    }
    return pool;
  }

  /* Derive the reference probabilities at the OFFERED line. */
  function refForTotal(entries, line) {
    if (!entries || !entries.length) return null;
    const exact = entries.find(e => Math.abs(e.line - line) < EPS);
    if (exact) {
      /* Half-line: no push, so the mid is the fair probability directly. */
      if (Math.abs(line * 2 - Math.round(line * 2)) < EPS && Math.abs(line - Math.round(line)) > EPS) {
        return { pOver: exact.pOver, pUnder: 1 - exact.pOver, pPush: 0,
                 method: 'exact', liq: exact.liq, note: 'reference quotes this exact line' };
      }
      return { pOver: exact.pOver, pUnder: 1 - exact.pOver, pPush: 0,
               method: 'exact', liq: exact.liq, note: 'reference quotes this exact line' };
    }
    /* Whole-number line bracketed by N-0.5 and N+0.5 -> exact derivation. */
    if (Math.abs(line - Math.round(line)) < EPS) {
      const lo = entries.find(e => Math.abs(e.line - (line - 0.5)) < EPS);
      const hi = entries.find(e => Math.abs(e.line - (line + 0.5)) < EPS);
      if (lo && hi && lo.pOver >= hi.pOver) {
        return { pOver: hi.pOver, pPush: lo.pOver - hi.pOver, pUnder: 1 - lo.pOver,
                 method: 'derived', liq: Math.min(lo.liq, hi.liq),
                 note: 'derived exactly from reference lines ' + (line - 0.5) +
                       ' and ' + (line + 0.5) + ' — no interpolation' };
      }
    }
    /* No bracket, no comparison. Interpolating across a gap would be an
       estimate dressed as a measurement. */
    return null;
  }

  /* EV with a push branch: a push returns the stake, so it is neither a win
     nor a loss and must not be folded into either. */
  function evWithPush(pWin, pLose, dNet) { return pWin * (dNet - 1) - pLose; }

  /* Attach reference figures to the offer rows that can be judged. */
  function apply(rows, pool, venuesById) {
    let matched = 0, skippedLine = 0, noRef = 0;
    const byMarket = {};
    for (const r of rows) byMarket[r.marketId] = byMarket[r.marketId] || [];
    for (const r of rows) {
      r.refFair = null; r.refEdge = null; r.refEV = null; r.refMethod = null;
      /* Only judge a real book's price, and never judge the reference with
         itself. */
      if (r.srcId === 'demo' || r.venueId === 'polymarket') continue;
      const parts = String(r.eventLabel).split(/\s+@\s+/);
      if (parts.length !== 2) { noRef++; continue; }
      const key = norm(parts[0]) + '|' + norm(parts[1]);

      if (r.marketLabel === 'TOTAL' && isFinite(r.line)) {
        const ref = refForTotal(pool.totals[key], r.line);
        if (!ref) { skippedLine++; continue; }
        const isOver = String(r.side).toLowerCase() === 'over';
        const pWin = isOver ? ref.pOver : ref.pUnder;
        const pLose = isOver ? ref.pUnder : ref.pOver;
        r.refFair = pWin;
        r.refPush = ref.pPush;
        r.refEdge = pWin - r.qo;
        r.refEV = evWithPush(pWin, pLose, r.dNet);
        r.refMethod = ref.method;
        r.refNote = ref.note;
        r.refLiq = ref.liq;
        matched++;
      }
      /* Moneylines are deliberately NOT matched here: every Polymarket
         "A vs. B" market on this slate ends a week out, which means it
         settles on a series rather than tonight's game. Same words,
         different contract. */
    }
    return { matched, skippedLine, noRef };
  }
  return { buildPool, refForTotal, apply, evWithPush, norm };
})();
