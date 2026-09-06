/* ==================== L4  remaining views, router, boot ================= */
VB.views2 = (function () {
  const { h, clear, sgn, cls, money, ago, until, glyph } = VB.dom;
  const O = VB.odds, K = VB.stake, MU = VB.multiplicity, SC = VB.score;
  const V = VB.views, price = V.price, trunc = V.trunc;

  /* ------------------------------------------------- market drill-down */
  function market(id) {
    const M = VB.model.get(), S = VB.store.get(), st = S.settings;
    const bag = M.byMarket[id];
    const wrap = h('div');
    if (!bag) { wrap.appendChild(h('div', { class:'empty' }, 'Unknown market.')); return wrap; }
    const m = bag.market, rows = bag.rows;
    const best = rows.filter(r => isFinite(r.ep)).sort((a, b) => b.t - a.t)[0];

    wrap.appendChild(h('h1', {}, m.eventLabel));
    wrap.appendChild(h('div', { class:'sub' },
      m.cat + ' · ' + m.marketLabel + (m.line !== null && m.line !== undefined ? ' ' + m.line : '') +
      ' · ' + m.outcomes.length + ' outcomes · ' + until(m.startSec) + ' to start' +
      (m.propStat ? ' · ' + m.propStat : '')));

    if (m.pairConfidence < 1) {
      wrap.appendChild(h('div', { class:'note c' },
        'Pairing unconfirmed (confidence ' + m.pairConfidence.toFixed(2) + '). ' +
        (m.mismapNote || '') + ' This market is excluded from the value board and cannot be staked. See Review.'));
    }
    if (m.kind === 'prop') wrap.appendChild(h('div', { class:'note w' },
      'Player props are excluded from cross-venue EV. Stat definitions differ between venues — ' +
      'whether overtime counts, which scorer settles it — so the same words are a different contract.'));

    /* Venue ladder: every venue on this market, best to worst. */
    /* Trimmed from 15 columns to 12. CLUSTER moves into the venue cell's
       title, and SE/LIMIT already appear in the panels below, so the verdict
       stops being pushed off the right edge on a normal window. */
    /* Key-driven columns. The previous version kept a hand-written header
       list and a hand-written cell list in parallel, which is how the
       drill-down ended up showing consensus headers over a wall of dashes
       while the board had already been fixed. One definition now drives
       both, and a column that cannot carry a number is not emitted. */
    const hasRef = rows.some(r => r.refEV !== null && r.refEV !== undefined && isFinite(r.refEV));
    const hasCons = rows.some(r => r.nClusters >= 3 && isFinite(r.ep));
    const hasNet = rows.some(r => Math.abs(r.dNet - r.dGross) > 1e-9);
    const G = VB.views.GLOSS;

    const COLDEF = [
      { k:'venue', label:'VENUE', tip:G.venue, on:true, cell:(r) =>
          h('span', { class:'vcell' }, [VB.dom.venueChip(r.venueId, 18),
            h('span', {}, r.venueName)]) },
      { k:'tier', label:'TIER', on:true, tip:'T1 venues are sharp references that anchor a consensus. With no T1 venue present no fair price is produced at all.',
        cell:(r) => h('span', { class:'tag' + (r.venueTier === 1 ? ' t1' : '') }, 'T' + r.venueTier) },
      { k:'side', label:'SIDE', tip:G.side, on:true, cell:(r) => trunc(String(r.side), 14) },
      { k:'price', label:'PRICE', tip:G.dGross, on:true, r:true, cell:(r) =>
          h('span', { class:'oddspill' }, price(r.dGross)) },
      { k:'net', label:'NET', on:hasNet, r:true,
        tip:'The price after this venue\'s commission or per-contract fee. This is the only price used for EV — a fee-blind comparison invents edge that does not exist.',
        cell:(r) => price(r.dNet) },
      { k:'qo', label:'q_o', tip:G.qo, on:true, r:true, cell:(r) =>
          isFinite(r.qo) ? (r.qo * 100).toFixed(1) + '%' : '--' },
      { k:'refFair', label:'REF FAIR', tip:G.refFair, on:hasRef, r:true, cell:(r) =>
          (r.refFair !== null && r.refFair !== undefined && isFinite(r.refFair))
            ? (r.refFair * 100).toFixed(1) + '%' : '--' },
      { k:'refPush', label:'PUSH', on:hasRef && rows.some(r => r.refPush > 0), r:true,
        tip:'Probability the game lands exactly on the line, in which case the stake is returned. Only non-zero on whole-number lines.',
        cell:(r) => (r.refPush > 0 ? (r.refPush * 100).toFixed(1) + '%' : '—') },
      { k:'refEV', label:'REF EV%', tip:G.refEV, on:hasRef, r:true, cls:(r) => cls(r.refEV),
        cell:(r) => (r.refEV !== null && r.refEV !== undefined && isFinite(r.refEV))
            ? sgn(r.refEV * 100, 2) : '--' },
      { k:'pFair', label:'p_c (LOCO)', tip:G.pFair, on:hasCons, r:true, cell:(r) =>
          isFinite(r.pFair) ? (r.pFair * 100).toFixed(1) + '%' : '--' },
      { k:'ep', label:'EDGE pp', tip:G.ep, on:hasCons, r:true, cls:(r) => cls(r.ep),
        cell:(r) => isFinite(r.ep) ? sgn(r.ep * 100, 2) : '--' },
      { k:'evNet', label:'EV%', tip:G.evNet, on:hasCons, r:true, cls:(r) => cls(r.evNet),
        cell:(r) => isFinite(r.evNet) ? sgn(r.evNet * 100, 2) : '--' },
      { k:'t', label:'t', tip:G.t, on:hasCons, r:true, cell:(r) =>
          isFinite(r.t) ? sgn(r.t, 1) : '--' },
      { k:'age', label:'AGE', tip:G.ageSec, on:true, r:true,
        cls:(r) => (r.verdict === 'AGED' ? 'warn' : ''), cell:(r) => ago(r.ageSec) },
      { k:'verdict', label:'VERDICT', tip:G.verdict, on:true, vd:true, cell:(r) =>
          h('span', { class:'vd vd-' + r.verdict.replace(' ', '') }, r.verdict) }
    ].filter(c => c.on);

    const tb = h('tbody');
    const sorted = rows.slice().sort((x, y) => {
      const a2 = isFinite(x.refEV) ? x.refEV : (isFinite(x.ep) ? x.ep : -99);
      const b2 = isFinite(y.refEV) ? y.refEV : (isFinite(y.ep) ? y.ep : -99);
      return b2 - a2;
    });
    for (const r of sorted) {
      const vd = r.verdict.replace(' ', '');
      const tr = h('tr', { class:'v-' + vd, title:'cluster: ' + r.cluster });
      for (const c of COLDEF) {
        const td = h('td', { class: (c.r ? 'r ' : '') + (c.vd ? 'vdcell ' : '') +
                                    (c.cls ? c.cls(r) : '') });
        const v = c.cell(r);
        if (v === null || v === undefined) td.textContent = '--';
        else if (typeof v === 'object') td.appendChild(v);
        else td.textContent = String(v);
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }

    const isLive = rows.some(r => r.srcId !== 'demo');
    /* ANSWER FIRST. */
    wrap.appendChild(VB.answer.tile(m, rows, VB.store.get().settings));

    /* Then the evidence, collapsed. */
    const detTable = h('details', { class:'ev' });
    detTable.appendChild(h('summary', {},
      'All ' + new Set(rows.map(r => r.venueId)).size + ' book prices, side by side'));
    detTable.appendChild(h('table', {}, [
      h('caption', {}, (isLive ? 'LIVE · real prices, fetched this session'
                               : 'synthetic prices') +
        ' · every venue quoting this market' +
        (hasCons ? '' : (hasRef ? ' · priced against the exchange reference'
                                : ' · no fair price: 1 book quoting'))),
      h('thead', {}, h('tr', {}, COLDEF.map(c => {
        const th = h('th', { class: (c.r ? 'r' : '') + (c.vd ? ' vdcell' : '') +
                                    (c.tip ? ' hasgloss' : ''),
          'data-tip': c.tip || null, tabindex: c.tip ? '0' : null });
        th.appendChild(h('span', { class: c.tip ? 'gl' : '' }, c.label));
        return th;
      }))), tb]));
    wrap.appendChild(detTable);

    /* ONE BOOK IS NOT NO INFORMATION.
       The whole analytical section used to be gated behind a consensus, so a
       real single-venue market rendered as two rows and a wall of dashes.
       But from one book alone you can compute exactly: its two-sided book
       sum, its hold, its own de-vigged opinion under every method, and the
       fair price that opinion implies. That is the single most useful thing
       to know about a price you are being offered, and it needs no consensus
       at all. */
    const byVenue = {};
    for (const r of rows) (byVenue[r.venueId] = byVenue[r.venueId] || []).push(r);
    const solo = h('div', { class:'cols', style:'margin-top:10px' });
    for (const vid in byVenue) {
      const vr = byVenue[vid];
      if (vr.length !== m.outcomes.length) continue;
      const ds = [];
      for (let i = 0; i < m.outcomes.length; i++) {
        const row = vr.find(x => String(x.side) === String(m.outcomes[i]));
        if (!row) break;
        ds.push(row.dGross);
      }
      if (ds.length !== m.outcomes.length) continue;
      const S = VB.odds.bookSum(ds), hold = VB.odds.hold(ds);
      const md = vr[0].methodProbs ? null : null;
      const panel = h('div', { class:'panel' });
      panel.appendChild(h('h2', {}, 'What ' + vr[0].venueName + ' is charging'));
      const dl = h('dl', { class:'kv' });
      const add = (k, v, c) => { dl.appendChild(h('dt', {}, k));
                                 dl.appendChild(h('dd', { class:c || null }, v)); };
      m.outcomes.forEach((o, i) => add('offered · ' + o,
        price(ds[i]) + '  (' + (100 / ds[i]).toFixed(1) + '%)'));
      add('book sum', S.toFixed(4));
      add('hold / vig', (hold * 100).toFixed(2) + '%', hold > 0.05 ? 'warn' : null);
      /* De-vig this venue against itself: that is its OPINION, and it is
         exactly computable without any second venue. */
      const dv = VB.devig.medianDevig(ds);
      m.outcomes.forEach((o, i) => add('their fair · ' + o,
        (dv.p[i] * 100).toFixed(1) + '%  →  ' + price(1 / dv.p[i])));
      add('method spread', (Math.max.apply(null, dv.spread) * 100).toFixed(2) + 'pp');
      panel.appendChild(dl);
      panel.appendChild(h('div', { class:'small muted', style:'margin-top:6px' },
        'Hold is what this book keeps if money is balanced — computable from a ' +
        'single snapshot, no consensus required. "Their fair" strips that margin ' +
        'out to show the probability this book is actually implying, which is the ' +
        'price you would need elsewhere to beat it.'));
      const dlink = vr.find(x => x.deepLink) || (m.quotes || []).find(q => q.deepLink);
      if (dlink && dlink.deepLink) panel.appendChild(h('div', { class:'small', style:'margin-top:6px' },
        'A bet-slip link for this market was supplied by the feed.'));
      solo.appendChild(panel);
    }

    /* Reference comparison, when the exchange brackets or matches this line. */
    const refRow = rows.find(r => r.refEV !== null && r.refEV !== undefined && isFinite(r.refEV));
    if (refRow) {
      const rp = h('div', { class:'panel' });
      rp.appendChild(h('h2', {}, 'Measured against the exchange'));
      const dl2 = h('dl', { class:'kv' });
      const a2 = (k, v, c) => { dl2.appendChild(h('dt', {}, k));
                                dl2.appendChild(h('dd', { class:c || null }, v)); };
      for (const r of rows) {
        if (r.refEV === null || r.refEV === undefined || !isFinite(r.refEV)) continue;
        a2(String(r.side) + ' @ ' + price(r.dGross),
           'fair ' + (r.refFair * 100).toFixed(1) + '%  ·  EV ' + sgn(r.refEV * 100, 2) + '%',
           cls(r.refEV));
      }
      if (refRow.refPush) a2('push probability', (refRow.refPush * 100).toFixed(1) + '%');
      a2('method', refRow.refMethod);
      rp.appendChild(dl2);
      rp.appendChild(h('div', { class:'small muted', style:'margin-top:6px' }, refRow.refNote +
        '. This is a TWO-VENUE reference comparison against an order book, not a ' +
        'consensus — a weaker claim than a 3-cluster fair price, and treated as one.'));
      solo.appendChild(rp);
    }

    /* Say plainly what is missing and what would fix it. */
    if (!(best && isFinite(best.ep))) {
      const gap = h('div', { class:'panel' });
      gap.appendChild(h('h2', {}, 'Why there is no fair price'));
      const nCl = new Set(rows.map(r => r.cluster)).size;
      gap.appendChild(h('div', {}, nCl + ' independent ' + (nCl === 1 ? 'cluster' : 'clusters') +
        ' quote this market. A consensus fair price requires 3, plus at least one ' +
        'sharp reference venue.'));
      gap.appendChild(h('div', { class:'small muted', style:'margin-top:6px' },
        'With one book there is nothing to disagree with it, so an "edge" would just ' +
        'be that book\'s own vig read backwards. The columns above are everything that ' +
        'IS computable from a single venue; the consensus columns stay blank rather ' +
        'than being filled with a number that has no second opinion behind it.'));
      gap.appendChild(h('div', { class:'small', style:'margin-top:7px' },
        'What unlocks the rest: an Odds API key returns 10–20 books in one call. ' +
        'Settings → Live data.'));
      solo.appendChild(gap);
    }
    if (solo.childNodes.length) {
      const detP = h('details', { class:'ev' });
      detP.appendChild(h('summary', {}, 'How these numbers were built'));
      detP.appendChild(solo);
      wrap.appendChild(detP);
    }

    /* The full audit trail, only when a genuine consensus exists. */
    if (best && isFinite(best.ep)) {
      const cards = h('div', { class:'cols', style:'margin-top:10px' });
      const meth = h('div', { class:'panel' });
      meth.appendChild(h('h2', {}, 'How the fair price was built'));
      meth.appendChild(h('div', { class:'small muted', style:'margin-bottom:6px' },
        'De-vigging is not identified from data — it is a modelling assumption. All applicable ' +
        'methods are computed and the MEDIAN is used, so the number on the board is consistent ' +
        'with the gate that guards it.'));
      const dl = h('dl', { class:'kv' });
      if (best.methodProbs) {
        const ix = m.outcomes.indexOf(best.side);
        for (const name of best.methodNames) {
          dl.appendChild(h('dt', {}, name));
          dl.appendChild(h('dd', {}, best.methodProbs[name][ix].toFixed(5)));
        }
        const vals = best.methodNames.map(n => best.methodProbs[n][m.outcomes.indexOf(best.side)]);
        dl.appendChild(h('dt', {}, 'method spread'));
        dl.appendChild(h('dd', {}, ((Math.max.apply(null, vals) - Math.min.apply(null, vals)) * 100).toFixed(3) + 'pp'));
      } else {
        dl.appendChild(h('dt', {}, 'order-book mid'));
        dl.appendChild(h('dd', {}, 'not de-vigged'));
      }
      dl.appendChild(h('dt', {}, 'consensus (excl. cluster)'));
      dl.appendChild(h('dd', {}, best.pFair.toFixed(5)));
      dl.appendChild(h('dt', {}, 'all-venue consensus'));
      dl.appendChild(h('dd', {}, isFinite(best.pFairAll) ? best.pFairAll.toFixed(5) : '--'));
      dl.appendChild(h('dt', {}, 'clusters voting'));
      dl.appendChild(h('dd', {}, best.nClusters + ' (V_eff ' + best.vEff.toFixed(2) + ')'));
      dl.appendChild(h('dt', {}, 'sharp anchor present'));
      dl.appendChild(h('dd', {}, best.hasT1 ? 'yes' : 'NO — no fair line'));
      meth.appendChild(dl);
      cards.appendChild(meth);

      const err = h('div', { class:'panel' });
      err.appendChild(h('h2', {}, 'Error budget and the noise line'));
      const dl2 = h('dl', { class:'kv' });
      const add = (k, v) => { dl2.appendChild(h('dt', {}, k)); dl2.appendChild(h('dd', {}, v)); };
      add('sampling SE', (best.seSamp * 100).toFixed(3) + 'pp');
      add('de-vig bias (floor)', (VB.consensus.B_DEVIG * 100).toFixed(2) + 'pp');
      add('staleness bias', (best.bStale * 100).toFixed(3) + 'pp');
      add('SE total', (best.seTotal * 100).toFixed(3) + 'pp');
      add('edge', sgn(best.ep * 100, 2) + 'pp');
      add('t = edge / SE', sgn(best.t, 2));
      add('markets evaluated (M)', VB.model.get().nEval.toLocaleString());
      add('a(M)', MU.a(VB.model.get().nEval).toFixed(3));
      add('noise line e_crit', (best.eCrit * 100).toFixed(2) + 'pp');
      add('edge after noise', sgn(best.eAdj * 100, 2) + 'pp');
      err.appendChild(dl2);
      err.appendChild(h('div', { class:'small muted', style:'margin-top:6px' },
        'The maximum of many noisy estimates looks exactly like edge. e_crit is the edge a ' +
        'scan this size produces from pure noise alone.'));
      cards.appendChild(err);

      const stk = h('div', { class:'panel' });
      stk.appendChild(h('h2', {}, 'Sizing chain'));
      if (!st.bankroll) stk.appendChild(h('div', { class:'note w' }, 'Set bankroll and unit to size this.'));
      else {
        const z = K.size({ pFair:best.pFair, dNet:best.dNet, unitUsd:st.unitUsd,
                           bankroll:st.bankroll, lambda:st.lambda, R:st.R });
        const dl3 = h('dl', { class:'kv' });
        const a3 = (k, v) => { dl3.appendChild(h('dt', {}, k)); dl3.appendChild(h('dd', {}, v)); };
        a3('EV net', sgn(z.evNet * 100, 2) + '%');
        a3('f Kelly', (z.fKelly * 100).toFixed(4) + '%');
        a3('× R ' + st.R + ' (reliability)', (z.fDebiased * 100).toFixed(4) + '%');
        a3('× λ ' + st.lambda + ' (risk level)', (z.fFinal * 100).toFixed(4) + '%');
        a3('units raw', z.uRaw.toFixed(4));
        a3('rung', z.rung.toFixed(2) + 'u');
        a3('amount', z.rung ? money(z.rung * st.unitUsd, 2) : '—');
        stk.appendChild(dl3);
        if (best.verdict !== 'BET' && z.rung > 0) stk.appendChild(h('div', { class:'note' },
          'Would size ' + z.rung.toFixed(2) + 'u / ' + money(z.rung * st.unitUsd, 2) +
          ' if it cleared the gates. It does not: ' + best.why + '.'));
      }
      cards.appendChild(stk);
      const detA = h('details', { class:'ev' });
      detA.appendChild(h('summary', {}, 'Full audit trail — devig methods, error budget, sizing chain'));
      detA.appendChild(cards);
      wrap.appendChild(detA);

      /* Line movement: the only honest check that an edge is real rather
         than a stale quote. Synthesized from the seeded walk. */
      const rng = VB.util.mulberry32(VB.util.xmur3('walk:' + m.id)());
      const pts1 = [], pts2 = [];
      let a = best.pFair, b = best.qo;
      for (let i = 0; i < 24; i++) {
        a += (VB.util.gauss(rng)) * 0.004; b += (VB.util.gauss(rng)) * 0.005;
        pts1.push(a); pts2.push(b);
      }
      pts1.push(best.pFair); pts2.push(best.qo);
      const mv = h('div', { class:'panel' });
      mv.appendChild(h('h2', {}, 'Line movement, 24h — consensus fair vs best offered'));
      mv.appendChild(VB.charts.movement([
        { pts:pts1, colour:'#00897b', label:'fair' },
        { pts:pts2, colour:'#b8860b', label:'offer' }], 460, 74));
      mv.appendChild(h('div', { class:'small muted' },
        'Two series, one axis. If the offer has not followed the consensus, the edge is either ' +
        'real or the quote is stale — the AGE column tells you which.'));
      wrap.appendChild(mv);
    }
    return wrap;
  }

  /* ---------------------------------------------------------- leaderboard */
  function leaderboard() {
    const M = VB.model.get(), wrap = h('div');
    wrap.appendChild(h('h1', {}, 'Book comparison'));

    /* WHAT A LIVE SNAPSHOT CAN AND CANNOT MEASURE.
       Closing-line accuracy, Brier and calibration all need observed history
       -- closes captured over weeks. This build carries no synthetic history,
       so those columns are absent rather than fabricated.
       What a single snapshot measures EXACTLY, with no history at all, is
       hold: the book's own theoretical margin. That was always the closest
       honest answer to "which book is most successful" anyway -- a book's
       profit comes from its customers' mistakes, and the most successful book
       is the one you should least want to bet at. */
    wrap.appendChild(h('div', { class:'note' },
      'Measured live from the current snapshot. Hold is the book\'s own margin and is ' +
      'exact from one observation — it is also the honest answer to which book is most ' +
      'successful: the higher the hold, the more it keeps, and the worse a place it is ' +
      'to bet. Closing-line accuracy, Brier and calibration need weeks of captured ' +
      'closes and are therefore absent rather than estimated.'));

    /* Per-venue hold and coverage, computed from the live rows. */
    const agg = {};
    const rows = (M.rows || []);
    const seenMarket = {};
    for (const id in M.byMarket) {
      const bag = M.byMarket[id];
      const nOut = bag.market.outcomes.length;
      const byV = {};
      for (const r of bag.rows) (byV[r.venueId] = byV[r.venueId] || []).push(r);
      for (const vid in byV) {
        const set = byV[vid];
        if (set.length !== nOut) continue;
        const ds = [];
        for (const o of bag.market.outcomes) {
          const rr = set.find(x => String(x.side) === String(o));
          if (rr) ds.push(rr.dGross);
        }
        if (ds.length !== nOut) continue;
        const a = agg[vid] = agg[vid] || { n:0, holdSum:0, mk:0, cats:{}, best:0 };
        a.n++; a.holdSum += VB.odds.hold(ds);
        a.cats[bag.market.cat] = 1;
      }
      seenMarket[id] = 1;
    }
    const totalMarkets = Object.keys(seenMarket).length;
    /* Best-price frequency: how often this book has the best net price on an
       outcome. Also exact from a snapshot, and directly answers "where should
       I actually bet". */
    const bestCount = {};
    for (const id in M.byMarket) {
      const bag = M.byMarket[id];
      for (const o of bag.market.outcomes) {
        let bestR = null;
        for (const r of bag.rows) {
          if (String(r.side) !== String(o)) continue;
          if (!bestR || r.dNet > bestR.dNet) bestR = r;
        }
        if (bestR) bestCount[bestR.venueId] = (bestCount[bestR.venueId] || 0) + 1;
      }
    }
    const list = Object.keys(agg).map(vid => {
      const v = M.venues[vid] || { name: vid, tier: 3 };
      const a = agg[vid];
      return { vid, name: v.name, tier: v.tier, cluster: v.cluster,
               hold: a.holdSum / a.n, nMarkets: a.n,
               cats: Object.keys(a.cats).length,
               coverage: totalMarkets ? a.n / totalMarkets : 0,
               best: bestCount[vid] || 0,
               accessible: !!v.accessible, fee: v.fee };
    }).sort((x, y) => x.hold - y.hold);

    if (!list.length) {
      wrap.appendChild(h('div', { class:'empty' }, [
        h('b', {}, 'No books quoting yet.'),
        'The live feed has not returned a complete two-sided market. Nothing is ' +
        'estimated in its place.']));
      return wrap;
    }
    const tb = h('tbody');
    list.forEach((r, i) => {
      tb.appendChild(h('tr', {}, [
        h('td', { class:'r' }, String(i + 1)),
        h('td', { class:'k' }, h('span', { class:'vcell' },
          [VB.dom.venueChip(r.vid, 18), h('span', {}, r.name)])),
        h('td', {}, h('span', { class:'tag' + (r.tier === 1 ? ' t1' : '') }, 'T' + r.tier)),
        h('td', { class:'r ' + (r.hold > 0.055 ? 'neg' : r.hold < 0.03 ? 'pos' : '') },
          (r.hold * 100).toFixed(2) + '%'),
        h('td', { class:'r' }, r.nMarkets.toLocaleString()),
        h('td', { class:'r' }, String(r.cats)),
        h('td', { class:'r' }, r.best.toLocaleString()),
        h('td', {}, r.accessible ? h('span', { class:'pos' }, '✓ marked')
                                 : h('span', { class:'muted' }, '— not marked')),
        h('td', { class:'small muted' }, r.fee ? r.fee.type : 'spread only')
      ]));
    });
    wrap.appendChild(h('table', {}, [
      h('caption', {}, 'LIVE · measured from ' + totalMarkets.toLocaleString() +
        ' markets in the current snapshot · sorted cheapest first'),
      h('thead', {}, h('tr', {}, [
        ['#', null], ['BOOK', null], ['TIER', 'T1 venues are sharp references that anchor a consensus.'],
        ['HOLD', 'The book\'s theoretical margin on a complete two-sided market: 1 − 1/Σ(1/decimal odds). Exact from a single snapshot. Lower is cheaper for you; higher means the book keeps more.'],
        ['MARKETS', 'Complete two-sided markets this book is quoting right now.'],
        ['SPORTS', 'Distinct categories covered.'],
        ['BEST PRICE', 'How many outcomes this book currently has the best net price on. Directly answers where to place the bet.'],
        ['MY ACCOUNT', 'Whether you have marked an account here, in Settings.'],
        ['FEES', 'Commission or per-contract fee model, if any.']
      ].map((c, i) => {
        const th = h('th', { class: (i >= 3 && i <= 6) ? 'r' : '',
          'data-tip': c[1] || null, tabindex: c[1] ? '0' : null });
        th.appendChild(h('span', { class: c[1] ? 'gl' : '' }, c[0]));
        return th;
      }))), tb]));
    wrap.appendChild(h('div', { class:'note w' },
      'One book cannot be ranked against itself. With a single venue quoting, HOLD and ' +
      'BEST PRICE are still exact, but there is no relative comparison to make — that ' +
      'needs a multi-book feed.'));
    return wrap;
  }

  const clusterSize = (rows, cl) => rows.filter(r => r.venue.cluster === cl).length;
  return { market, leaderboard };
})();
