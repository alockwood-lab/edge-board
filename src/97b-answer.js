/* ------------------------------------------------- L4  the answer tile */
VB.answer = (function () {
  const { h, sgn, cls, money, ago, until } = VB.dom;
  const O = VB.odds;
  const price = (d) => O.fmtAmerican(O.decimalToAmerican(d));

  /* Nobody wants to read a 21-row venue table to find out whether to bet.
     They want the answer, then the evidence if they choose to look. So the
     drill-down leads with a verdict, one plain sentence, and a per-side grid
     of consensus-fair against best-available -- and everything else
     collapses behind it. */

  function summarise(market, rows) {
    const outs = market.outcomes;
    const per = outs.map((side) => {
      const set = rows.filter(r => String(r.side) === String(side));
      if (!set.length) return null;
      /* Consensus fair, taken from any row that has one -- p_c is a property
         of the market and the venue set, not of the row. */
      const withC = set.find(r => isFinite(r.pFair) && r.nClusters >= 3);
      const pFair = withC ? withC.pFair : null;
      const refRow = set.find(r => r.refFair !== null && r.refFair !== undefined
                                   && isFinite(r.refFair));
      let best = null;
      for (const r of set) if (!best || r.dNet > best.dNet) best = r;
      const fairP = pFair !== null ? pFair : (refRow ? refRow.refFair : null);
      const fairSrc = pFair !== null ? 'consensus' : (refRow ? 'exchange' : null);
      const edge = (fairP !== null && best) ? fairP - (1 / best.dNet) : null;
      const ev = (fairP !== null && best) ? fairP * best.dNet - 1 : null;
      const bet = set.find(r => r.verdict === 'BET');
      return { side, pFair: fairP, fairSrc, best, edge, ev, bet,
               nVenues: new Set(set.map(r => r.venueId)).size,
               clusters: withC ? withC.nClusters : (set[0] ? set[0].nClusters : 0) };
    }).filter(Boolean);

    /* Average two-sided hold across venues quoting a complete book. */
    const byV = {};
    for (const r of rows) (byV[r.venueId] = byV[r.venueId] || []).push(r);
    let holdSum = 0, holdN = 0;
    for (const vid in byV) {
      const set = byV[vid];
      if (set.length !== outs.length) continue;
      const ds = outs.map(o => { const x = set.find(y => String(y.side) === String(o));
                                 return x ? x.dGross : null; });
      if (ds.some(x => x === null)) continue;
      holdSum += O.hold(ds); holdN++;
    }
    const bestBook = outs.map((o, i) => per[i] && per[i].best ? 1 / per[i].best.dNet : null);
    const bestSum = bestBook.every(x => x !== null)
      ? bestBook.reduce((a, b) => a + b, 0) : null;
    return { per, avgHold: holdN ? holdSum / holdN : null,
             nVenues: Object.keys(byV).length,
             bestSum, bestHold: bestSum !== null ? 1 - 1 / bestSum : null };
  }

  function tile(market, rows, settings) {
    const s = summarise(market, rows);
    const winner = s.per.find(p => p.bet);
    const box = h('div', { class:'answer' + (winner ? ' yes' : '') });

    /* --- the headline --- */
    const head = h('div', { class:'ahead' });
    if (winner) {
      head.appendChild(h('span', { class:'averdict yes' }, 'BET'));
      head.appendChild(h('span', { class:'aline' },
        String(winner.side) + ' ' + price(winner.bet.dGross) + ' at ' + winner.bet.venueName));
    } else {
      head.appendChild(h('span', { class:'averdict no' }, 'NO BET'));
      /* Name the closest miss and exactly what price would change the answer.
         "No bet" alone is useless; "no bet, and here is the number you need"
         is a shopping instruction. */
      const cand = s.per.filter(p => p.edge !== null)
        .sort((a, b) => (b.edge || -9) - (a.edge || -9))[0];
      if (cand && cand.best) {
        const needD = 1 / cand.pFair;
        head.appendChild(h('span', { class:'aline' },
          String(cand.side) + ' is worth ' + price(needD) + '; best available is ' +
          price(cand.best.dNet) + ' at ' + cand.best.venueName));
      } else {
        head.appendChild(h('span', { class:'aline' },
          'no fair price — ' + (s.per[0] ? s.per[0].clusters : 0) +
          ' independent book cluster(s), 3 needed'));
      }
    }
    box.appendChild(head);

    /* --- one plain sentence --- */
    const cand = s.per.filter(p => p.edge !== null)
      .sort((a, b) => (b.edge || -9) - (a.edge || -9))[0];
    let sentence;
    if (winner) {
      sentence = 'Consensus fair is ' + price(1 / winner.pFair) + ' and you can get ' +
        price(winner.bet.dGross) + ' — an edge of ' + sgn(winner.edge * 100, 2) +
        'pp, EV ' + sgn(winner.ev * 100, 2) + '%. Recommended stake ' +
        (winner.bet.rung || 0).toFixed(2) + 'u' +
        (winner.bet.amount ? ' (' + money(winner.bet.amount, 2) + ')' : '') + '.';
    } else if (cand && cand.best && cand.pFair !== null) {
      const gapPP = Math.abs(cand.edge * 100);
      const need = price(1 / cand.pFair);
      sentence = 'The ' + s.nVenues + ' books quoting this market agree closely. The nearest ' +
        'thing to value is ' + String(cand.side) + ' at ' + price(cand.best.dNet) + ' (' +
        cand.best.venueName + '), which is ' + gapPP.toFixed(2) + 'pp ' +
        (cand.edge >= 0 ? 'better than' : 'short of') + ' the ' + cand.fairSrc +
        ' fair price of ' + need + '. You would need ' + need + ' or better to have an edge.';
    } else {
      sentence = 'Not enough independent books quote this market to build a fair price, so ' +
        'no edge can be measured. Every price below is real; none of them can be judged.';
    }
    box.appendChild(h('div', { class:'asent' }, sentence));

    /* --- per-side grid: fair vs best available, side by side --- */
    const grid = h('div', { class:'agrid' });
    grid.appendChild(h('div', { class:'ah' }, ''));
    grid.appendChild(h('div', { class:'ah' }, 'Fair'));
    grid.appendChild(h('div', { class:'ah' }, 'Best available'));
    grid.appendChild(h('div', { class:'ah' }, 'Edge'));
    for (const p of s.per) {
      grid.appendChild(h('div', { class:'an' }, String(p.side)));
      grid.appendChild(h('div', { class:'av' },
        p.pFair !== null ? price(1 / p.pFair) : '—'));
      const bcell = h('div', { class:'av' });
      if (p.best) {
        bcell.appendChild(h('span', { class:'oddspill' + (p.bet ? ' bet' : '') },
          price(p.best.dNet)));
        bcell.appendChild(h('span', { class:'abook' },
          [VB.dom.venueChip(p.best.venueId, 18), h('span', {}, p.best.venueName)]));
      } else bcell.textContent = '—';
      grid.appendChild(bcell);
      grid.appendChild(h('div', { class:'av ' + (p.edge === null ? 'muted' : cls(p.edge)) },
        p.edge === null ? '—' : sgn(p.edge * 100, 2) + 'pp'));
    }
    box.appendChild(grid);

    /* --- market footer: what shopping the best price is worth --- */
    const foot = [];
    foot.push(s.nVenues + ' books');
    if (s.avgHold !== null) foot.push('average hold ' + (s.avgHold * 100).toFixed(2) + '%');
    if (s.bestHold !== null) foot.push('best-price hold ' + (s.bestHold * 100).toFixed(2) + '%');
    if (s.avgHold !== null && s.bestHold !== null) {
      foot.push('shopping saves ' + ((s.avgHold - s.bestHold) * 100).toFixed(2) + 'pp');
    }
    const ages = rows.map(r => r.ageSec).filter(isFinite);
    if (ages.length) foot.push('prices ' + ago(Math.min.apply(null, ages)) + ' old');
    box.appendChild(h('div', { class:'afoot' }, foot.join('  ·  ')));
    return box;
  }
  return { tile, summarise };
})();
