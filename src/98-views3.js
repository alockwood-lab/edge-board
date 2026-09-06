/* ============ L4  review, slip, settings, ask, modal, router =========== */
VB.views3 = (function () {
  const { h, clear, sgn, cls, money, ago, until, glyph } = VB.dom;
  const K = VB.stake, V = VB.views, price = V.price, trunc = V.trunc;

  /* ------------------------------------------------------------- review */
  function review() {
    const M = VB.model.get(), wrap = h('div');
    wrap.appendChild(h('h1', {}, 'Review queue'));
    wrap.appendChild(h('div', { class:'sub' },
      'Everything the engine refused to price or refused to trust. Nothing here can be staked.'));

    const pend = M.slate.markets.filter(m => m.pairConfidence < 1);
    wrap.appendChild(h('h2', {}, 'Unconfirmed pairings (' + pend.length + ')'));
    if (!pend.length) wrap.appendChild(h('div', { class:'small muted' }, 'None.'));
    else {
      const tb = h('tbody');
      for (const m of pend) {
        const rows = M.byMarket[m.id] ? M.byMarket[m.id].rows : [];
        const bestEp = Math.max.apply(null, rows.map(r => isFinite(r.ep) ? r.ep : -9).concat([-9]));
        tb.appendChild(h('tr', {}, [
          h('td', { class:'k' }, m.eventLabel),
          h('td', {}, m.cat), h('td', {}, m.marketLabel),
          h('td', { class:'r warn' }, m.pairConfidence.toFixed(2)),
          h('td', { class:'r ' + cls(bestEp) }, bestEp > -9 ? sgn(bestEp * 100, 2) + 'pp' : '--'),
          h('td', { class:'small' }, m.mismapNote || 'below 0.90 auto-link threshold'),
          h('td', { class:'vd vd-SUSPECT' }, 'EXCLUDED')
        ]));
      }
      wrap.appendChild(h('table', {}, [
        h('caption', {}, 'A confident-looking edge that depends on a fuzzy match is a bug report waiting to happen'),
        h('thead', {}, h('tr', {}, ['EVENT','CAT','MARKET','CONF','APPARENT EDGE','NOTE','STATUS']
          .map((c, i) => h('th', { class: i === 3 || i === 4 ? 'r' : '' }, c)))), tb]));
      wrap.appendChild(h('div', { class:'note c' },
        'These carry real apparent edge and are excluded anyway. Hard gates have no numeric tolerance: ' +
        'exact league, exact line, exact period, exact overtime treatment. Only confidence 1.00 is ' +
        'eligible for staking or arbitrage.'));
    }

    const susp = M.rows.filter(r => r.verdict === 'SUSPECT');
    const arbs = [];
    for (const id in M.byMarket) {
      const b = M.byMarket[id];
      if (b.arb && b.arb.det.isArb) arbs.push({ m:b.market, a:b.arb });
    }
    wrap.appendChild(h('h2', {}, 'Arbitrages and quarantined quotes'));
    const tb2 = h('tbody');
    for (const x of arbs) {
      tb2.appendChild(h('tr', {}, [
        h('td', { class:'k' }, x.m.eventLabel),
        h('td', {}, x.m.marketLabel),
        h('td', { class:'r' }, x.a.det.S.toFixed(6)),
        h('td', { class:'r ' + (x.a.suspect ? 'neg' : 'pos') }, sgn(x.a.det.roi * 100, 3) + '%'),
        h('td', { class:'small' }, x.a.best.map(b => '~' + b.venueName + ' ' + price(b.dNet)).join('  +  ')),
        h('td', { class:'vd ' + (x.a.suspect ? 'vd-SUSPECT' : 'vd-BET') }, x.a.suspect ? 'SUSPECT' : 'ARB'),
        h('td', { class:'small muted' }, x.a.suspect
          ? 'ROI ≥ 4% — implausible, check pairing'
          : 'survives fees and commission')
      ]));
    }
    if (!arbs.length) tb2.appendChild(h('tr', {}, h('td', { colspan:7, class:'muted' }, 'No arbitrages on this slate.')));
    wrap.appendChild(h('table', {}, [
      h('caption', {}, 'Best NET price per outcome, fees and commission applied before detection'),
      h('thead', {}, h('tr', {}, ['EVENT','MARKET','BOOK SUM','ROI','LEGS','STATUS','NOTE']
        .map((c, i) => h('th', { class: i === 2 || i === 3 ? 'r' : '' }, c)))), tb2]));
    if (M.manifest.fakeArb) {
      const f = M.manifest.fakeArb;
      wrap.appendChild(h('div', { class:'note w' },
        'Fee-dispatch regression case is live on this slate: market ' + f.marketId +
        ' has a gross book sum of ' + f.grossSum.toFixed(6) + ', which looks like a ' +
        (f.arbIfFeeIgnored * 100).toFixed(2) + '% arbitrage if the Kalshi per-contract fee is ignored. ' +
        'Net of the fee the book sum is ' + f.netSum.toFixed(6) + ', i.e. ' +
        (f.arbWithFee * 100).toFixed(2) + '% — not an arbitrage. It is correctly absent above.'));
    }
    wrap.appendChild(h('h2', {}, 'Quote outliers quarantined (' + susp.length + ')'));
    wrap.appendChild(h('div', { class:'small muted' },
      'Threshold is 4 standard deviations of each venue’s OWN measured deviation, floored at 6pp. ' +
      'A flat threshold cannot tell a data error from a soft price: 7.5pp from a sharp book is an ' +
      'error, 7.5pp from a soft book is Tuesday.'));
    return wrap;
  }

  /* --------------------------------------------------------------- slip */
  function slip() {
    const M = VB.model.get(), S = VB.store.get(), st = S.settings, wrap = h('div');
    wrap.appendChild(h('h1', {}, 'Bet slip and exposure'));
    if (!st.bankroll) { wrap.appendChild(h('div', { class:'note w' }, 'Set bankroll and unit first.')); return wrap; }

    const bets = M.rows.filter(r => r.verdict === 'BET').sort((a, b) => b.t - a.t);
    const caps = st.caps;
    const perEvent = {}, admitted = [], blocked = [];
    let openU = 0;
    for (const r of bets) {
      const ev = r.eventId;
      const e = perEvent[ev] || 0;
      if (openU + r.rung > caps.maxOpenUnits + 1e-9) { blocked.push([r, 'total open ' + caps.maxOpenUnits + 'u']); continue; }
      if (e + r.rung > caps.maxPerEventUnits + 1e-9) { blocked.push([r, 'per-event ' + caps.maxPerEventUnits + 'u']); continue; }
      perEvent[ev] = e + r.rung; openU += r.rung; admitted.push(r);
    }
    const totalStake = admitted.reduce((s, r) => s + (r.amountCapped !== undefined ? r.amountCapped : r.amount), 0);
    const totalEv = admitted.reduce((s, r) => s + (r.evUsd || 0), 0);

    const meter = (label, cur, max) => h('div', { class:'row', style:'gap:8px' }, [
      h('div', { style:'width:150px' }, label),
      h('div', { class:'bar', style:'flex:1;max-width:220px' },
        h('i', { style:'width:' + Math.min(100, cur / max * 100).toFixed(1) + '%;background:' +
          (cur / max > 0.9 ? 'var(--warn)' : 'var(--accent)') })),
      h('div', { class:'num' }, cur.toFixed(2) + 'u / ' + max.toFixed(1) + 'u')
    ]);
    const sum = h('div', { class:'panel' }, [
      h('h2', {}, 'Exposure'),
      meter('Total open', openU, caps.maxOpenUnits),
      meter('Largest single event', Math.max.apply(null, Object.keys(perEvent).map(k => perEvent[k]).concat([0])), caps.maxPerEventUnits),
      h('dl', { class:'kv', style:'margin-top:8px' }, [
        h('dt', {}, 'Admitted'), h('dd', {}, admitted.length + ' of ' + bets.length + ' BET rows'),
        h('dt', {}, 'Total stake'), h('dd', {}, money(totalStake, 2)),
        h('dt', {}, 'Modelled EV'), h('dd', { class: cls(totalEv) }, sgn(totalEv, 2)),
        h('dt', {}, 'Blocked by caps'), h('dd', {}, String(blocked.length))
      ])
    ]);
    if (openU >= caps.maxOpenUnits - 1e-9) sum.appendChild(h('div', { class:'note c' },
      'NO NEW BETS. Total open exposure is at the ' + caps.maxOpenUnits +
      'u cap. New rows are refused outright rather than silently sized to zero.'));

    /* Variance panel. Both figures, always, never the first alone. */
    const avgP = admitted.length ? admitted.reduce((s, r) => s + r.pFair, 0) / admitted.length : 0.5;
    const avgD = admitted.length ? admitted.reduce((s, r) => s + r.dNet, 0) / admitted.length : 2;
    const lamEff = K.lambdaEff(st.lambda, st.R, K.R_SENSITIVITY);
    const risk = h('div', { class:'panel' }, [
      h('h2', {}, 'Variance and drawdown'),
      h('div', {}, 'At risk level ' + st.lambda.toFixed(2) + ', chance of the bankroll ever falling 50%: ' +
        (K.pEverDrawdown(0.5, st.lambda) * 100).toFixed(2) + '%.'),
      h('div', { class:'small', style:'margin-top:4px;color:var(--warn)' },
        'If edge reliability is really ' + K.R_SENSITIVITY + ' rather than the ' + st.R +
        ' prior, that becomes ' + (K.pEverDrawdown(0.5, lamEff) * 100).toFixed(1) +
        '%, and you retain ' + (K.growthRetained(lamEff) * 100).toFixed(0) + '% of maximum growth.'),
      h('dl', { class:'kv', style:'margin-top:8px' }, [
        h('dt', {}, 'P(ever −75%)'), h('dd', {}, (K.pEverDrawdown(0.25, st.lambda) * 100).toFixed(3) + '%'),
        h('dt', {}, 'Growth retained'), h('dd', {}, (K.growthRetained(st.lambda) * 100).toFixed(1) + '%'),
        h('dt', {}, 'P(down after 100 bets)'), h('dd', {}, (K.pDownAfterN(avgP, avgD, 100) * 100).toFixed(1) + '%'),
        h('dt', {}, 'P(down after 1,000)'), h('dd', {}, (K.pDownAfterN(avgP, avgD, 1000) * 100).toFixed(1) + '%'),
        h('dt', {}, 'P(down after 5,000)'), h('dd', {}, (K.pDownAfterN(avgP, avgD, 5000) * 100).toFixed(1) + '%')
      ]),
      h('div', { class:'small muted', style:'margin-top:6px' },
        'Drawdown figures use the closed-form log-growth result. Down-after-N uses the exact binomial ' +
        'below 200 bets, because the normal approximation understates the risk on long prices.')
    ]);
    wrap.appendChild(h('div', { class:'cols' }, [sum, risk]));

    const tb = h('tbody');
    for (const r of admitted) {
      tb.appendChild(h('tr', { class:'v-BET' }, [
        h('td', {}, r.cat), h('td', { class:'k' }, trunc(r.eventLabel, 26)),
        h('td', {}, r.marketLabel), h('td', {}, trunc(String(r.side), 12)),
        h('td', {}, '~' + r.venueName),
        h('td', { class:'r k' }, price(r.dGross)),
        h('td', { class:'r pos' }, sgn(r.evNet * 100, 2) + '%'),
        h('td', { class:'r k' }, r.rung.toFixed(2) + 'u'),
        h('td', { class:'r k' }, money(r.amountCapped !== undefined ? r.amountCapped : r.amount, 2)),
        h('td', { class:'r ' + cls(r.evUsd) }, sgn(r.evUsd, 2)),
        h('td', { class:'small muted' }, r.cappedBy && r.cappedBy !== 'none' ? 'capped: ' + r.cappedBy : '')
      ]));
    }
    wrap.appendChild(h('h2', {}, 'Admitted (' + admitted.length + ')'));
    wrap.appendChild(h('table', {}, [
      h('caption', {}, 'DEMO · this app places no bets'),
      h('thead', {}, h('tr', {}, ['CAT','EVENT','MARKET','SIDE','VENUE','PRICE','EV%','STAKE','AMOUNT','EV $','CAP']
        .map((c, i) => h('th', { class: i >= 5 && i <= 9 ? 'r' : '' }, c)))), tb]));
    if (blocked.length) {
      wrap.appendChild(h('h2', {}, 'Blocked by caps (' + blocked.length + ')'));
      const tb3 = h('tbody');
      for (const [r, why] of blocked.slice(0, 25)) {
        tb3.appendChild(h('tr', { class:'v-PASS' }, [
          h('td', {}, r.cat), h('td', {}, trunc(r.eventLabel, 26)),
          h('td', {}, '~' + r.venueName),
          h('td', { class:'r pos' }, sgn(r.evNet * 100, 2) + '%'),
          h('td', { class:'r k' }, '0.00u'), h('td', { class:'r' }, '—'),
          h('td', { class:'small warn' }, 'capped: ' + why)
        ]));
      }
      wrap.appendChild(h('table', {}, [h('thead', {}, h('tr', {},
        ['CAT','EVENT','VENUE','EV%','STAKE','AMOUNT','REASON'].map((c, i) => h('th', { class: i >= 3 && i <= 5 ? 'r' : '' }, c)))), tb3]));
    }
    wrap.appendChild(h('div', { class:'note' },
      'This app places no bets and has no venue connectivity. If you place one, record the price you ' +
      'actually got — not the price displayed — because that is what closing-line value is measured against.'));
    return wrap;
  }
  return { review, slip };
})();
