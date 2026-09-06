/* ---------------------------------------------- L4  game-grouped board view */
VB.games = (function () {
  const { h, sgn, cls, money, ago, until } = VB.dom;
  const O = VB.odds;
  const price = (d) => O.fmtAmerican(O.decimalToAmerican(d));

  /* One row per OUTCOME is the analyst's view and it is unreadable as a
     board: a single game becomes six rows (ML home, ML away, spread home,
     spread away, total over, total under) and the three markets you actually
     compare sit stacked instead of side by side.
     Every real sportsbook solves this the same way -- one line per TEAM,
     with spread / total / moneyline as columns -- so that is what this does.
     The per-outcome table is still available as the "Rows" layout, because
     that is where the error budget and the consensus internals live. */

  function splitTeams(label) {
    for (const sep of [' @ ', ' v ', ' vs ', ' VS ']) {
      const i = label.indexOf(sep);
      if (i > 0) return { away: label.slice(0, i), home: label.slice(i + sep.length), sep };
    }
    return { away: label, home: '', sep: null };
  }

  /* Collapse the offer rows for one event into a per-team, per-market grid.
     Where several venues quote the same outcome we keep the BEST net price,
     which is the number a bettor would actually take. */
  function groupByEvent(rows) {
    const games = {};
    for (const r of rows) {
      let g = games[r.eventId];
      if (!g) {
        const t = splitTeams(r.eventLabel);
        g = games[r.eventId] = {
          eventId: r.eventId, cat: r.cat, label: r.eventLabel,
          away: t.away, home: t.home, startSec: r.startSec,
          srcId: r.srcId, isLive: r.isLive,
          ml: {}, spread: {}, total: {}, other: [],
          bestEdge: -Infinity, bestRow: null, nVenues: {}, verdicts: {}
        };
      }
      g.nVenues[r.venueId] = 1;
      g.verdicts[r.verdict] = (g.verdicts[r.verdict] || 0) + 1;
      if (isFinite(r.ep) && r.ep > g.bestEdge && r.verdict === 'BET') {
        g.bestEdge = r.ep; g.bestRow = r;
      }
      const keep = (slot, key) => {
        const cur = slot[key];
        if (!cur || r.dNet > cur.dNet) slot[key] = r;
      };
      const lab = r.marketLabel;
      if (lab === 'MONEYLINE' || lab === '1X2') keep(g.ml, String(r.side));
      else if (lab === 'SPREAD') { g.spread.line = r.line; keep(g.spread, String(r.side)); }
      else if (lab === 'TOTAL') { g.total.line = r.line; keep(g.total, String(r.side)); }
      else g.other.push(r);
    }
    return Object.keys(games).map(k => games[k]);
  }

  /* A price cell: the pill, plus the line it applies to, plus the edge when a
     consensus exists. Empty is rendered as a dash, never as a blank, so a
     missing market is distinguishable from a broken one. */
  function priceCell(r, lineText) {
    if (!r) return h('td', { class:'gcell' }, h('span', { class:'muted' }, '—'));
    const td = h('td', { class:'gcell' });
    const box = h('div', { class:'gprice' });
    if (lineText) box.appendChild(h('span', { class:'gline' }, lineText));
    const pill = h('span', { class:'oddspill' + (r.verdict === 'BET' ? ' bet' : '') },
                   price(r.dGross));
    box.appendChild(pill);
    td.appendChild(box);
    /* Consensus edge if three clusters exist; otherwise the two-venue
       REFERENCE edge, which is a weaker but real claim and is labelled as
       such rather than dressed up as a consensus. */
    if (isFinite(r.ep) && r.nClusters >= 3) {
      box.appendChild(h('span', { class:'gedge ' + cls(r.ep) },
        sgn(r.ep * 100, 1) + 'pp'));
    } else if (r.refEV !== null && r.refEV !== undefined && isFinite(r.refEV)) {
      const good = r.refEV > 0;
      const tip = 'Reference comparison, not a consensus. Fair ' +
        (r.refFair * 100).toFixed(1) + '% from the Polymarket exchange (' +
        r.refNote + '). Offered ' + (r.qo * 100).toFixed(1) + '%. ' +
        (r.refPush ? 'Push probability ' + (r.refPush * 100).toFixed(1) + '%. ' : '') +
        'EV ' + (r.refEV * 100).toFixed(2) + '% per unit staked.';
      box.appendChild(h('span', {
        class: 'gedge gref ' + (good ? 'pos' : 'neg'), 'data-tip': tip },
        (good ? '▲ ' : '▼ ') + sgn(r.refEV * 100, 1) + '%'));
    }
    return td;
  }

  function board(cat, rowsIn) {
    const S = VB.store.get(), M = VB.model.get(), st = S.settings;
    const wrap = h('div');
    const allGames = groupByEvent(rowsIn)
      .sort((a, b) => (a.startSec || 0) - (b.startSec || 0));
    if (!allGames.length) return null;
    /* Cap GAMES, not rows. 60 matchups is a full slate and stays responsive;
       anything dropped is reported rather than silently cut. */
    const GAME_CAP = 60;
    const games = allGames.slice(0, GAME_CAP);
    const dropped = allGames.length - games.length;

    const anyConsensus = rowsIn.some(r => r.nClusters >= 3);
    const nRef = rowsIn.filter(r => isFinite(r.refEV)).length;
    const nVen = Object.keys(games.reduce((a, g) => Object.assign(a, g.nVenues), {})).length;
    const M2 = VB.model.get();
    const hdr = h('div', { class:'small', style:'padding:2px 2px 8px;color:var(--text-secondary)' });
    hdr.appendChild(h('span', {}, allGames.length + ' games · ' + nVen + ' book' +
      (nVen === 1 ? '' : 's') + ' quoting'));
    if (nRef) {
      hdr.appendChild(h('span', { class:'refbadge' }, nRef + ' priced vs exchange'));
      hdr.appendChild(h('span', { class:'muted' },
        ' — ▲/▼ is EV against the Polymarket order book, a two-venue reference ' +
        'comparison rather than a consensus. Hover any figure for the derivation.'));
    } else if (!anyConsensus) {
      hdr.appendChild(h('span', { class:'muted' },
        ' — no edge yet: a consensus needs 3 independent books, and the exchange ' +
        'reference has no matching line on these markets' +
        (M2 && M2.refMeta ? ' (' + M2.refMeta.totals + ' exchange markets loaded)' : '') + '.'));
    }
    if (dropped > 0) hdr.appendChild(h('span', { class:'muted' },
      ' · showing the ' + GAME_CAP + ' soonest of ' + allGames.length +
      ' games; ' + dropped + ' further out are not shown'));
    wrap.appendChild(hdr);

    const tb = h('tbody');
    for (const g of games) {
      /* Game header: one band per matchup, so two team lines below it read as
         a unit rather than as four unrelated rows. */
      const hdr = h('tr', { class:'ghead' });
      const hcell = h('td', { colspan: 5 });
      hcell.appendChild(h('span', { class:'gcat' }, g.cat));
      hcell.appendChild(h('span', { class:'gstart' }, until(g.startSec)));
      hcell.appendChild(h('span', { class:'gname' }, g.label));
      if (g.srcId !== 'demo') hcell.appendChild(h('span', { class:'tag live' }, 'LIVE'));
      else hcell.appendChild(h('span', { class:'tag' }, 'demo'));
      if (g.bestRow) {
        /* rung is null until a bankroll exists, so it cannot be formatted
           unconditionally -- that threw and took the whole board down. */
        const rg = g.bestRow.rung;
        hcell.appendChild(h('span', { class:'tag bet' },
          'BET ' + sgn(g.bestRow.ep * 100, 2) + 'pp' +
          (rg === null || rg === undefined ? ' · set bankroll' : ' · ' + rg.toFixed(2) + 'u')));
      }
      hdr.appendChild(hcell);
      tb.appendChild(hdr);

      const sLine = g.spread.line;
      const tLine = g.total.line;
      const rowFor = (teamName, mlKey, spKey, toKey, spLineTxt, toLineTxt) => {
        const tr = h('tr', { class:'grow',
          onclick: () => { const any = g.ml[mlKey] || g.spread[spKey] || g.total[toKey];
                           if (any) location.hash = '#/market/' + any.marketId; } });
        const tdName = h('td', { class:'gteam' });
        const vr = g.ml[mlKey] || g.spread[spKey] || g.total[toKey];
        const inner = h('div', { class:'gteamin' });
        if (vr) inner.appendChild(VB.dom.venueChip(vr.venueId, 18));
        inner.appendChild(h('span', {}, teamName || '—'));
        tdName.appendChild(inner);
        tr.appendChild(tdName);
        tr.appendChild(priceCell(g.spread[spKey], spLineTxt));
        tr.appendChild(priceCell(g.total[toKey], toLineTxt));
        tr.appendChild(priceCell(g.ml[mlKey], null));
        const vd = vr ? vr.verdict : null;
        const tdv = h('td', { class:'gcell' });
        if (vd) tdv.appendChild(h('span', { class:'vd vd-' + vd.replace(' ', '') }, vd));
        tr.appendChild(tdv);
        return tr;
      };
      const fmtSp = (v) => (v === null || v === undefined || !isFinite(v)) ? null
        : (v > 0 ? '+' + v : String(v));
      /* Away first, then home -- the order every book prints. */
      tb.appendChild(rowFor(g.away, 'away', 'away', 'over',
        fmtSp(isFinite(sLine) ? -sLine : null), isFinite(tLine) ? 'O ' + tLine : null));
      tb.appendChild(rowFor(g.home, 'home', 'home', 'under',
        fmtSp(sLine), isFinite(tLine) ? 'U ' + tLine : null));

      if (g.ml.draw) {
        tb.appendChild(rowFor('Draw', 'draw', '__none', '__none', null, null));
      }
    }
    const table = h('table', { class:'gtable' }, [
      h('thead', {}, h('tr', {}, [
        h('th', {}, 'Team'),
        h('th', { 'data-tip':'Point spread and the price on it. The line shown is that team\'s handicap.' },
          h('span', { class:'gl' }, 'Spread')),
        h('th', { 'data-tip':'Game total, over on the away line and under on the home line, with the price.' },
          h('span', { class:'gl' }, 'Total')),
        h('th', { 'data-tip':'Moneyline: the price on that team to win outright.' },
          h('span', { class:'gl' }, 'Moneyline')),
        h('th', { 'data-tip':'Verdict for this team\'s markets. NO PRICE means fewer than 3 independent books quote it, so no fair price can be built.' },
          h('span', { class:'gl' }, 'Verdict'))
      ])), tb]);
    wrap.appendChild(table);
    return wrap;
  }
  return { board, groupByEvent, splitTeams };
})();
