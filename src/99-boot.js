/* ============ L4  settings, ask, first-run modal, router, boot ========= */
VB.views4 = (function () {
  const { h, clear, sgn, cls, money, ago, until } = VB.dom;
  const K = VB.stake, V = VB.views, price = V.price, trunc = V.trunc;

  /* ------------------------------------------------------------ settings */
  function settings() {
    const S = VB.store.get(), st = S.settings, M = VB.model.get(), wrap = h('div');
    wrap.appendChild(h('h1', {}, 'Settings'));

    const commit = () => { VB.store.save(); VB.model.compute(); VB.router.render(); };
    const numField = (label, key, step, min, max, fmt, note) => {
      const inp = h('input', { type:'number', value:st[key], step, min, max, style:'width:92px',
        onchange:(e) => { const v = Number(e.target.value);
          if (isFinite(v)) { st[key] = v; commit(); } } });
      return h('div', { class:'row', style:'margin:4px 0' }, [
        h('div', { style:'width:210px' }, label), inp,
        note ? h('div', { class:'small muted' }, note) : null]);
    };

    /* Bankroll and unit. The implied relationship is always printed. */
    const bank = h('div', { class:'panel' });
    bank.appendChild(h('h2', {}, 'Bankroll and unit'));
    bank.appendChild(numField('Bankroll ($)', 'bankroll', 100, 0));
    bank.appendChild(numField('1 unit ($)', 'unitUsd', 5, 0));
    if (st.bankroll > 0 && st.unitUsd > 0) {
      const typical = st.R * st.lambda * 0.03;
      bank.appendChild(h('div', { class:'note' }, [
        h('div', {}, '1u = ' + money(st.unitUsd) + ' = ' + (st.unitUsd / st.bankroll * 100).toFixed(2) +
          '% of a ' + money(st.bankroll) + ' bankroll.'),
        h('div', { class:'small muted' }, 'At risk level ' + st.lambda + ', a typical qualifying bet is about ' +
          (typical * 100).toFixed(2) + '% of bankroll — around ' + money(typical * st.bankroll) + ', i.e. ' +
          (typical * st.bankroll / st.unitUsd).toFixed(2) + 'u. Most recommendations will round to 0.25u.'),
        h('div', { class:'small muted' }, 'For 1.0u to be a typical bet, your bankroll would need to be about ' +
          money(Math.round(K.impliedBankrollFor1u(typical, st.unitUsd) / 1000) * 1000) + ', or your unit about ' +
          money(Math.round(K.suggestedUnitFor1u(typical, st.bankroll) / 5) * 5) + '.')
      ]));
    }
    /* Risk level. ONE control. R is read-only. */
    const risk = h('div', { class:'panel' });
    risk.appendChild(h('h2', {}, 'Risk level (λ)'));
    const presets = h('div', { class:'row' }, [0.10, 0.25, 0.50].map(l =>
      h('button', { class: Math.abs(st.lambda - l) < 1e-9 ? 'pri' : '',
        onclick:() => { st.lambda = l; commit(); } },
        l.toFixed(2) + (l === 0.25 ? ' (default)' : ''))));
    risk.appendChild(presets);
    const lamEff = K.lambdaEff(st.lambda, st.R, K.R_SENSITIVITY);
    risk.appendChild(h('div', { class:'note', style:'margin-top:8px' }, [
      h('div', {}, 'At risk level ' + st.lambda.toFixed(2) + ', chance of the bankroll ever falling 50%: ' +
        (K.pEverDrawdown(0.5, st.lambda) * 100).toFixed(2) + '%.'),
      h('div', { class:'small', style:'color:var(--warn)' },
        'If edge reliability is really ' + K.R_SENSITIVITY + ' rather than the ' + st.R + ' prior, that becomes ' +
        (K.pEverDrawdown(0.5, lamEff) * 100).toFixed(1) + '%, and you retain ' +
        (K.growthRetained(lamEff) * 100).toFixed(0) + '% of maximum growth.')
    ]));
    risk.appendChild(h('div', { class:'row', style:'margin-top:6px' }, [
      h('div', { style:'width:210px' }, 'Edge reliability (R)'),
      /* Read-only by design. An editable R is a control that switches off the
         bias correction while wearing the costume of a risk preference. */
      h('span', { class:'num', 'data-r-readonly':'1' }, st.R.toFixed(2)),
      h('span', { class:'small muted' }, 'prior · ' + S.betlog.length + ' of ' + K.R_MIN_OBS +
        ' observations · not adjustable')
    ]));
    risk.appendChild(h('div', { class:'small muted', style:'margin-top:4px' },
      'R de-biases the edge estimate; λ controls drawdown. Both are required. R becomes the regression ' +
      'coefficient of realised closing-line value on predicted edge once 200 observations exist.'));

    /* Gates, with loosening tracked. */
    const gates = h('div', { class:'panel' });
    gates.appendChild(h('h2', {}, 'Gates'));
    gates.appendChild(numField('Min EV% (net of fees)', 'minEVPct', 0.005, 0, 1));
    gates.appendChild(numField('Min edge (probability)', 'minEdgePP', 0.002, 0, 1));
    gates.appendChild(numField('Min t (significance)', 'minT', 0.5, 0, 10));
    gates.appendChild(numField('Min independent clusters', 'minClusters', 1, 1, 10));
    gates.appendChild(numField('Max quote age (min)', 'maxAgeMin', 1, 1, 240));
    const tog = (label, key, note) => h('div', { class:'row', style:'margin:4px 0' }, [
      h('div', { style:'width:210px' }, label),
      h('input', { type:'checkbox', checked: st[key] ? 'checked' : null,
        onchange:(e) => { st[key] = e.target.checked; commit(); } }),
      note ? h('div', { class:'small muted' }, note) : null]);
    gates.appendChild(tog('Require a sharp venue', 'requireTier1'));
    gates.appendChild(tog('Accessible venues only', 'accessibleOnly', 'nothing is claimed on your behalf'));
    gates.appendChild(h('div', { class:'row', style:'margin:4px 0' }, [
      h('div', { style:'width:210px' }, 'Multiplicity correction'),
      h('span', { class:'num pos' }, 'ON'),
      h('span', { class:'small muted' }, 'no toggle — the top row of a large scan is otherwise noise')
    ]));
    const loose = VB.store.loosenedGates();
    if (loose.length) gates.appendChild(h('div', { class:'note c' },
      'You have loosened ' + loose.length + ' gate' + (loose.length > 1 ? 's' : '') + ': ' +
      loose.map(l => l.label + ' ' + l.from + ' → ' + l.to).join('; ') +
      '. Bets taken under loosened gates are badged OFF-SPEC and excluded from the R regression.'));

    /* Accounts. Default all off. */
    const acct = h('div', { class:'panel' });
    acct.appendChild(h('h2', {}, 'My accounts'));
    acct.appendChild(h('div', { class:'small muted', style:'margin-bottom:6px' },
      'Default is off for every venue. The best price is routinely at a venue you cannot use, so the ' +
      'board defaults to accessible-only and claims nothing on your behalf.'));
    const grid = h('div', { class:'row' });
    for (const v of VB.seed.VENUES) {
      const on = S.venues[v.id] && S.venues[v.id].accessible;
      grid.appendChild(h('button', { class: on ? 'pri' : '',
        onclick:() => { S.venues[v.id].accessible = !on;
          if (!S.__acc) S.__acc = {}; S.__acc[v.id] = S.venues[v.id].accessible; commit(); } },
        (on ? '✓ ' : '') + v.name));
    }
    acct.appendChild(grid);

    const disp = h('div', { class:'panel' });
    disp.appendChild(h('h2', {}, 'Display and data'));
    disp.appendChild(h('div', { class:'row', style:'margin:4px 0' }, [
      h('div', { style:'width:210px' }, 'No-colour mode'),
      h('input', { type:'checkbox', checked: st.noColour ? 'checked' : null,
        onchange:(e) => { st.noColour = e.target.checked;
          document.documentElement.dataset.nocolour = st.noColour ? '1' : '0'; commit(); } }),
      h('div', { class:'small muted' }, 'positive/negative green–red fails colourblind separation at deutan ΔE 4.1')
    ]));
    disp.appendChild(h('dl', { class:'kv', style:'margin-top:6px' }, [
      h('dt', {}, 'Data mode'), h('dd', { class:'warn' },
        S.dataset.mode === 'mixed' ? 'MIXED (synthetic + live)' : 'SEED (synthetic)'),
      h('dt', {}, 'Seed'), h('dd', {}, String(VB.seed.MASTER)),
      h('dt', {}, 'Venues'), h('dd', {}, String(VB.seed.VENUES.length)),
      h('dt', {}, 'Markets'), h('dd', {}, String(M.slate.markets.length)),
      h('dt', {}, 'Offer rows'), h('dd', {}, M.nEval.toLocaleString()),
      h('dt', {}, 'localStorage'), h('dd', {}, S.runtime.storage.local ? 'available' : 'UNAVAILABLE — in-memory only'),
      h('dt', {}, 'Live adapters'), h('dd', {}, (function(){
        const k = Object.keys(VB.model.liveStats());
        return k.length ? k.join(', ') + ' loaded' : 'none loaded';
      })())
    ]));
    disp.appendChild(h('div', { class:'row', style:'margin-top:8px' }, [
      h('button', { onclick:exportCsv }, 'Export board CSV'),
      h('button', { onclick:() => { if (S.runtime.storage.local) { for (const k in VB.store.KEY) localStorage.removeItem(VB.store.KEY[k]); }
        location.reload(); } }, 'Reset everything')
    ]));
    disp.appendChild(h('div', { class:'note w' },
      'Live data: only The Odds API and Polymarket are provably callable from a browser (both send ' +
      'permissive CORS headers). Every US retail book is unreachable directly — WAF-blocked, ' +
      'geo-gated, or contractually off-limits — so book-level granularity requires a paid aggregator. ' +
      'Kalshi returned a bare 403 when probed and is unresolved; test it from your own devtools before ' +
      'assuming it works. Adapters are not wired in this build.'));

    wrap.appendChild(h('div', { class:'cols' }, [bank, risk]));
    wrap.appendChild(h('div', { class:'cols' }, [gates, acct]));
    wrap.appendChild(budgetPanel(commit));
    wrap.appendChild(livePanel(commit));
    wrap.appendChild(disp);
    return wrap;
  }

  /* ----------------------------------------------------------- budget panel */
  function budgetPanel(commit) {
    const S = VB.store.get(), M = VB.model.get();
    const B = VB.budget;
    const st = B.status(M && M.oddsQuota && M.oddsQuota.remaining);
    const au = VB.model.autoStatus();
    const box = h('div', { class:'panel' });
    box.appendChild(h('h2', {}, 'Credit budget'));

    const bar = h('div', { class:'bar', style:'min-width:220px;max-width:340px' },
      h('i', { style:'width:' + Math.min(100, st.spent / st.monthly * 100).toFixed(1) + '%;' +
        'background:' + (st.pace > 80 ? 'var(--warn)' : 'var(--brand)') }));
    box.appendChild(h('div', { class:'row', style:'gap:10px' }, [
      bar, h('span', { class:'num', style:'font-weight:700' },
        st.spent + ' / ' + st.monthly + ' used'),
      h('span', { class:'small muted' }, st.remaining + ' left · ' + st.daysLeft + ' days to reset')
    ]));
    box.appendChild(h('dl', { class:'kv', style:'margin-top:8px' }, [
      h('dt', {}, 'pace vs even burn'),
      h('dd', { class: st.pace > 80 ? 'warn' : st.pace < -40 ? 'pos' : '' },
        (st.pace >= 0 ? '+' : '−') + Math.abs(Math.round(st.pace)) + ' credits'),
      h('dt', {}, 'spendable per remaining day'), h('dd', {}, st.budgetPerDayLeft.toFixed(1)),
      h('dt', {}, 'held in reserve'), h('dd', {}, String(st.reserve)),
      h('dt', {}, 'paid pulls this month'), h('dd', {}, String(st.pulls))
    ]));

    /* Region strategy is the single biggest lever, so it is a first-class
       control with its cost stated. */
    const cur = S.settings.oddsRegions || 'eu';
    box.appendChild(h('h2', { style:'margin-top:14px' }, 'Region strategy'));
    box.appendChild(h('div', { class:'row' }, [
      h('button', { class: cur === 'eu' ? 'pri' : '', onclick:() => {
        S.settings.oddsRegions = 'eu'; commit(); } }, 'EU only · 3 cr'),
      h('button', { class: cur === 'us,eu' ? 'pri' : '', onclick:() => {
        S.settings.oddsRegions = 'us,eu'; commit(); } }, 'US + EU · 6 cr')
    ]));
    box.appendChild(h('div', { class:'small muted', style:'margin-top:5px' },
      'EU alone returns 21 books including Pinnacle, Betfair and Matchbook — every sharp ' +
      'anchor the consensus needs — for half the credits. Adding US mostly duplicates ' +
      'DraftKings, FanDuel and BetMGM, and DraftKings already arrives free from ESPN. ' +
      'At 3 credits a pull the month buys 166 league-pulls instead of 83.'));

    box.appendChild(h('h2', { style:'margin-top:14px' }, 'How credits are allocated'));
    box.appendChild(h('div', { class:'small muted' },
      '500 credits against 730 hours is 0.68 an hour, which is both unspendable and ' +
      'useless — odds only matter near kickoff and there are no games at 4am. So the ' +
      'policy is an allocation, not a rate limit:'));
    const ul = h('div', { class:'small', style:'margin-top:6px;line-height:1.7' });
    [['Scout free first', 'ESPN and Polymarket cost nothing and refresh every 3 minutes. They answer whether games exist and when they start — the only thing that decides if a paid pull is worth it.'],
     ['Spend inside the window', 'Paid pulls only fire when a game starts within ' + B.VALUE_WINDOW_H + 'h. A pull 30 hours out buys a line that will move before it matters.'],
     ['Buy the reference, not retail', 'EU region for the sharp anchor; the bettable book comes free.'],
     ['Hold a reserve', B.RESERVE + ' credits are never auto-spent, so one busy Saturday cannot empty the month.'],
     ['Cooldown', 'No two paid pulls within ' + B.MIN_GAP_MIN + ' minutes.']
    ].forEach(([k, v]) => {
      ul.appendChild(h('div', {}, [h('b', {}, k + ' — '), h('span', { class:'muted' }, v)]));
    });
    box.appendChild(ul);

    if (au && au.decision) {
      box.appendChild(h('div', { class: au.decision.spend ? 'note' : 'note w',
        style:'margin-top:10px' }, [
        h('b', {}, au.decision.spend ? 'Last decision: SPEND. ' : 'Last decision: SKIP. '),
        h('span', {}, au.decision.why),
        au.scout && au.scout.gamesSoon !== null
          ? h('div', { class:'small muted', style:'margin-top:4px' },
              'Free scout found ' + au.scout.gamesSoon + ' game(s) starting within ' +
              B.VALUE_WINDOW_H + 'h.')
          : null
      ]));
    }
    return box;
  }

  /* ------------------------------------------------------- live data panel */
  function livePanel(commit) {
    const S = VB.store.get(), M = VB.model.get();
    const stats = VB.model.liveStats();
    const box = h('div', { class:'panel' });
    box.appendChild(h('h2', {}, 'Live data'));
    const status = h('div', { class:'small', style:'margin-bottom:8px' });
    const setStatus = (msg, cls) => { clear(status);
      status.appendChild(h('span', { class: cls || 'muted' }, msg)); };

    /* The honest framing, stated before either button is pressed. */
    box.appendChild(h('div', { class:'note' },
      'Probed live: The Odds API and Polymarket both send a wildcard CORS header, so this page can ' +
      'call them directly from file://. Kalshi returns 403 with no CORS headers and is not callable. ' +
      'Every US retail book is unreachable directly, so book-level prices come through the aggregator ' +
      'or not at all.'));

    /* --- ESPN: real games + real DraftKings prices, no key, no signup --- */
    const es = h('div', { style:'margin:10px 0 14px;padding-bottom:12px;border-bottom:1px solid var(--rule)' });
    const leagueSel = h('select', {}, ['NFL','NCAAF','MLB','NBA','NHL','NCAAB','SOC']
      .map(k => h('option', { value:k }, k)));
    /* "Today" and "this week" are different questions and ESPN answers the
       second one by default, which is why a Sunday looked empty: the week
       view was dominated by Saturday's finished games. */
    const whenSel = h('select', {}, [
      h('option', { value:'today' }, 'today'),
      h('option', { value:'tomorrow' }, 'tomorrow'),
      h('option', { value:'week' }, 'current week')]);
    es.appendChild(h('div', { class:'row' }, [
      h('div', { style:'width:150px;font-weight:700' }, 'ESPN'),
      h('span', { class:'tag' }, 'no key needed'),
      leagueSel,
      whenSel,
      h('button', { class:'pri', onclick: async () => {
        const ad = VB.adapters.espn;
        let dk = null;
        if (whenSel.value === 'today') dk = ad.dateKey(new Date());
        else if (whenSel.value === 'tomorrow') {
          const t = new Date(); t.setDate(t.getDate() + 1); dk = ad.dateKey(t);
        }
        setStatus('fetching real ' + leagueSel.value + ' odds…');
        const r = await VB.model.loadLive('espn', { cat: leagueSel.value, dateKey: dk });
        if (!r.ok) { setStatus('failed: ' + r.error + (r.classify ? ' [' + r.classify + ']' : ''), 'neg'); return; }
        setStatus('loaded ' + r.markets + ' real markets from ' + r.quotes + ' games. ' +
          'Single venue, so they read NO PRICE — open them in "show everything".', 'pos');
        VB.store.save(); VB.router.render();
      } }, 'Load real odds'),
      stats.espn ? h('button', { onclick:() => { VB.model.clearLive('espn'); VB.router.render(); } }, 'Clear') : null
    ]));
    es.appendChild(h('div', { class:'small muted', style:'margin-top:5px' },
      'Real games, real teams, real start times, and real DraftKings prices on the moneyline, ' +
      'spread and total — including a working bet-slip link per outcome. Free, no signup, and it ' +
      'is CORS-open so the page can call it directly. The catch is that ESPN publishes exactly ' +
      'ONE book, so these markets will read NO PRICE: a fair line needs 3 independent clusters ' +
      'plus a sharp anchor, and one venue cannot be its own consensus. This makes the prices ' +
      'real; it does not make it a value board.'));
    es.appendChild(h('div', { class:'small muted', style:'margin-top:4px' },
      'A thin result is usually the calendar, not a failure. Finished games carry no odds and are ' +
      'skipped, and ESPN only prices games near kickoff — so a Sunday in football season shows a ' +
      'handful of games while the Saturday slate is already final. The load summary breaks down ' +
      'exactly how many were returned, priced, final, or not yet priced.'));
    if (stats.espn) {
      const st = stats.espn;
      es.appendChild(h('div', { class:'small', style:'margin-top:4px' },
        h('span', { class:'pos' }, '● live'), ' ' + st.markets + ' markets from ' + st.quotes + ' games'));
      (st.warnings || []).forEach(w => es.appendChild(h('div', { class:'small muted' }, '· ' + w)));
    }
    box.appendChild(es);

    /* --- Polymarket: no key, but one venue cannot make a consensus --- */
    const pm = h('div', { style:'margin:10px 0' });
    pm.appendChild(h('div', { class:'row' }, [
      h('div', { style:'width:150px;font-weight:600' }, 'Polymarket'),
      h('span', { class:'tag' }, 'no key needed'),
      h('button', { onclick: async () => {
        setStatus('fetching Polymarket…');
        const r = await VB.model.loadLive('polymarket', {});
        if (!r.ok) { setStatus('failed: ' + r.error + (r.classify ? ' [' + r.classify + ']' : ''), 'neg'); return; }
        setStatus('loaded ' + r.markets + ' markets from ' + r.quotes + ' contracts' +
          (r.rejected ? ', ' + r.rejected + ' rejected' : ''), 'pos');
        VB.store.save(); VB.router.render();
      } }, 'Load live'),
      stats.polymarket ? h('button', { onclick:() => { VB.model.clearLive('polymarket');
        VB.router.render(); } }, 'Clear') : null
    ]));
    pm.appendChild(h('div', { class:'small muted' },
      'Loads real prediction-market contracts. Note what this can and cannot do: Polymarket is ONE ' +
      'venue, so every contract it returns is a single-venue market and the breadth gate will report ' +
      'NO PRICE rather than invent a fair line from one opinion. Its contracts are also not ' +
      'auto-matched to sportsbook markets — two contracts can read identically and settle on ' +
      'different criteria, and auto-linking on the question text eventually prints a fake edge.'));
    if (stats.polymarket) {
      const st = stats.polymarket;
      pm.appendChild(h('div', { class:'small', style:'margin-top:4px' },
        h('span', { class:'pos' }, '● live'), ' ' + st.markets + ' markets · ' +
        st.quotes + ' contracts · ' + st.rejected + ' rejected'));
      (st.warnings || []).forEach(w => pm.appendChild(h('div', { class:'small warn' }, '⚠ ' + w)));
    }
    box.appendChild(pm);

    /* --- The Odds API: needs a key, and it is the one that makes value work --- */
    const oa = h('div', { style:'margin:14px 0 0;padding-top:10px;border-top:1px solid var(--rule)' });
    const keyIn = h('input', { type:'password', value: (S.keys && S.keys.oddsapi) || '',
      placeholder:'paste API key', style:'width:230px',
      onchange:(e) => { S.keys = S.keys || {}; S.keys.oddsapi = e.target.value.trim(); VB.store.save(); } });
    const sportSel = h('select', {}, [
      ['americanfootball_nfl','NFL'], ['americanfootball_ncaaf','NCAAF'],
      ['baseball_mlb','MLB'], ['basketball_nba','NBA'], ['icehockey_nhl','NHL'],
      ['soccer_epl','EPL'], ['mma_mixed_martial_arts','MMA']
    ].map(([v, l]) => h('option', { value:v }, l)));
    oa.appendChild(h('div', { class:'row' }, [
      h('div', { style:'width:150px;font-weight:600' }, 'The Odds API'),
      keyIn, sportSel,
      h('span', { class:'tag' }, '3 credits'),
      h('button', { onclick: async () => {
        const key = (S.keys && S.keys.oddsapi) || keyIn.value.trim();
        if (!key) { setStatus('paste an API key first', 'warn'); return; }
        setStatus('fetching ' + sportSel.value + '… (3 credits)');
        const r = await VB.model.loadLive('oddsapi',
          { key, sportKey: sportSel.value, markets:'h2h,spreads,totals' });
        if (!r.ok) { setStatus('failed: ' + r.error + (r.classify ? ' [' + r.classify + ']' : ''), 'neg'); return; }
        const q = r.quota && r.quota.remaining ? ' · ' + r.quota.remaining + ' credits left' : '';
        setStatus('loaded ' + r.markets + ' markets from ' + r.quotes + ' book-markets' + q, 'pos');
        VB.store.save(); VB.router.render();
      } }, 'Load live'),
      stats.oddsapi ? h('button', { onclick:() => { VB.model.clearLive('oddsapi');
        VB.router.render(); } }, 'Clear') : null
    ]));
    oa.appendChild(h('div', { class:'row', style:'margin-top:6px' }, [
      h('div', { style:'width:150px' }, ''),
      /* Validate for free FIRST. /sports does not consume a credit, so a bad
         key is caught before any quota is spent. */
      h('button', { onclick: async () => {
        const key = (S.keys && S.keys.oddsapi) || keyIn.value.trim();
        if (!key) { setStatus('paste a key first', 'warn'); return; }
        setStatus('validating (free, costs no credits)…');
        const v = await VB.model.validateKey(key);
        if (!v.ok) { setStatus('key check failed: ' + v.error + ' [' + v.classify + ']', 'neg'); return; }
        S.keys = S.keys || {}; S.keys.oddsapi = key; VB.store.save();
        setStatus('key is valid · ' + v.sports + ' active sports · ' +
          (v.remaining ? v.remaining + ' credits remaining' : 'quota header not exposed') +
          (v.used ? ' · ' + v.used + ' used' : ''), 'pos');
      } }, 'Validate key (free)')
    ]));
    oa.appendChild(h('div', { class:'small muted', style:'margin-top:5px' },
      'This is the source that makes the value board actually work, because it returns 10–20 books ' +
      'in one call — and a fair price needs at least 3 independent clusters plus a sharp anchor ' +
      'before it will price anything at all.'));
    oa.appendChild(h('div', { class:'small muted', style:'margin-top:4px' },
      'Free tier: 500 credits/month, no card. Sign up at the-odds-api.com and copy the key from ' +
      'the dashboard. 1 credit = 1 sport × 1 market × 1 region, so a moneyline+spread+total pull ' +
      'on one league costs 3 — about 160 pulls a month. Validate first; that call is free.'));
    oa.appendChild(h('div', { class:'small muted', style:'margin-top:4px' },
      'The key is stored in plaintext in this browser\'s localStorage and travels in the query ' +
      'string, not a header — a custom header would trigger a CORS preflight these endpoints do ' +
      'not answer from a file:// origin. If that matters to you, use the paste box below instead ' +
      'and the key never touches this app.'));
    if (stats.oddsapi) {
      const st = stats.oddsapi;
      oa.appendChild(h('div', { class:'small', style:'margin-top:4px' },
        h('span', { class:'pos' }, '● live'), ' ' + st.markets + ' markets · ' +
        st.quotes + ' book-markets · ' + st.rejected + ' rejected'));
      if (st.discovered && st.discovered.length) oa.appendChild(h('div', { class:'small warn' },
        '⚠ ' + st.discovered.length + ' unrecognised book' + (st.discovered.length > 1 ? 's' : '') + ': ' +
        st.discovered.map(d => d.key).join(', ') +
        ' — registered but held OUT of the consensus, because a source we have never measured must ' +
        'not move the fair line on its first appearance. Enable in the venue list once you trust it.'));
      (st.warnings || []).forEach(w => oa.appendChild(h('div', { class:'small warn' }, '⚠ ' + w)));
    }
    box.appendChild(oa);
    box.appendChild(status);

    /* Paste path: identical code, different transport. */
    const ta = h('textarea', { rows:3, placeholder:'…or paste a JSON response here',
      style:'width:100%;font-family:var(--mono);font-size:10.5px;border:1px solid var(--border-strong);background:transparent;color:inherit;padding:5px' });
    const pasteSel = h('select', {}, [h('option', { value:'espn' }, 'ESPN'),
                                      h('option', { value:'oddsapi' }, 'The Odds API'),
                                      h('option', { value:'polymarket' }, 'Polymarket')]);
    box.appendChild(h('div', { style:'margin-top:12px;padding-top:10px;border-top:1px solid var(--rule)' }, [
      h('div', { class:'small muted', style:'margin-bottom:5px' },
        'Manual import — always works, zero setup. Runs through the SAME normalizer as a live fetch, ' +
        'so a pasted payload produces identical rows. Useful when CORS or a rate limit blocks the ' +
        'direct call.'),
      ta,
      h('div', { class:'row', style:'margin-top:5px' }, [pasteSel,
        h('button', { onclick:() => {
          let raw;
          try { raw = JSON.parse(ta.value); }
          catch (e) { setStatus('not valid JSON: ' + e.message, 'neg'); return; }
          const r = VB.model.ingest(pasteSel.value, raw, {});
          setStatus('imported ' + r.markets + ' markets from ' + r.quotes + ' rows' +
            (r.rejected ? ', ' + r.rejected + ' rejected' : ''), 'pos');
          VB.router.render();
        } }, 'Import')])
    ]));
    return box;
  }

  function exportCsv() {
    const M = VB.model.get();
    const head = ['PROVENANCE','cat','event','market','side','line','venue','price_american',
                  'price_decimal','net_decimal','q_o','p_fair_loco','edge_pp','edge_adj_pp','ev_pct',
                  't','se_pp','clusters','age_sec','stake_units','amount_usd','verdict','why'];
    const lines = [head.join(',')];
    for (const r of M.rows) {
      /* SYNTHETIC in column 1 of EVERY row, so provenance survives the file
         leaving the app. */
      lines.push(['SYNTHETIC', r.cat, q(r.eventLabel), r.marketLabel, q(String(r.side)),
        r.line === null || r.line === undefined ? '' : r.line, q(r.venueName),
        VB.odds.decimalToAmerican(r.dGross).toFixed(0), r.dGross.toFixed(6), r.dNet.toFixed(6),
        f(r.qo, 6), f(r.pFair, 6), f(r.ep * 100, 4), f(r.eAdj * 100, 4), f(r.evNet * 100, 4),
        f(r.t, 3), f(r.seTotal * 100, 4), r.nClusters || '', r.ageSec,
        r.rung === null || r.rung === undefined ? '' : r.rung.toFixed(2),
        r.rung ? (r.amountCapped !== undefined ? r.amountCapped : r.amount).toFixed(2) : '',
        r.verdict, q(r.why || '')].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type:'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'edge-board-SYNTHETIC-seed' + VB.seed.MASTER + '.csv';
    a.click();
  }
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const f = (x, d) => (isFinite(x) ? Number(x).toFixed(d) : '');

  /* ----------------------------------------------------------------- ask */
  function ask(query) {
    const M = VB.model.get(), wrap = h('div');
    wrap.appendChild(h('h1', {}, 'Ask'));
    const inp = h('input', { type:'text', value:query || '', placeholder:'team, player, event, venue or question',
      style:'width:100%;max-width:520px;padding:6px 9px;font-size:13px',
      onkeydown:(e) => { if (e.key === 'Enter') location.hash = '#/ask?q=' + encodeURIComponent(e.target.value); } });
    wrap.appendChild(h('div', { style:'margin:6px 0 10px' }, inp));

    if (!query) {
      wrap.appendChild(h('div', { class:'empty' }, [
        h('b', {}, 'Type a team, player, event, venue or question.'),
        'Every market that matches will be listed with a verdict and a stake.',
        h('div', { class:'small muted', style:'margin-top:8px' },
          'Indexed: ' + M.slate.markets.length + ' markets, ' + M.nEval.toLocaleString() +
          ' offer rows, across ' + VB.seed.CATS.length + ' categories and ' +
          VB.seed.VENUES.length + ' venues.'),
        h('div', { style:'margin-top:8px' }, ['chiefs', 'dodgers', 'alcaraz', 'fed', 'pinnacle'].map(s =>
          h('a', { class:'chip', href:'#/ask?q=' + s, style:'margin-right:6px' }, s)))
      ]));
      return wrap;
    }
    const ql = query.toLowerCase().trim();
    let rows = M.rows.filter(r =>
      r.eventLabel.toLowerCase().indexOf(ql) >= 0 ||
      String(r.side).toLowerCase().indexOf(ql) >= 0 ||
      r.venueName.toLowerCase().indexOf(ql) >= 0 ||
      r.cat.toLowerCase() === ql ||
      (r.playerKey || '').toLowerCase().indexOf(ql) >= 0);

    if (!rows.length) {
      wrap.appendChild(h('div', { class:'empty' }, [
        h('b', {}, 'No market matches “' + query + '”.'),
        'The dataset covers ' + M.slate.markets.length + ' markets loaded from seed ' + VB.seed.MASTER + '.'
      ]));
      return wrap;
    }
    const census = {};
    for (const r of rows) census[r.verdict] = (census[r.verdict] || 0) + 1;
    const best = rows.filter(r => r.verdict === 'BET').sort((a, b) => b.t - a.t)[0];
    const nearest = rows.filter(r => isFinite(r.ep)).sort((a, b) => b.ep - a.ep)[0];

    /* Question-shaped queries get ONE plain declarative sentence. */
    if (best) {
      wrap.appendChild(h('div', { class:'note' },
        'Best value on “' + query + '”: ' + String(best.side) + ' in ' + best.eventLabel +
        ' at ~' + best.venueName + ' ' + price(best.dGross) + '. Fair is ' + price(1 / best.pFair) +
        ', edge ' + sgn(best.ep * 100, 2) + 'pp, EV ' + sgn(best.evNet * 100, 2) + '%, stake ' +
        best.rung.toFixed(2) + 'u (' + money(best.amount, 2) + '). ' +
        (census['BET'] || 0) + ' of ' + rows.length + ' rows clear the bar.'));
    } else {
      wrap.appendChild(h('div', { class:'note w' }, [
        h('div', {}, 'No bet here.'),
        h('div', { class:'small' }, rows.length + ' rows matched. The best edge is ' +
          (nearest ? sgn(nearest.ep * 100, 2) + 'pp on ' + String(nearest.side) + ' at ~' + nearest.venueName : 'n/a') +
          (nearest ? ', which ' + (nearest.why || 'does not clear the gates') : '') +
          '. All ' + rows.length + ' are listed below with their verdicts.')
      ]));
    }
    /* Group by market type, with a verdict census on collapsed groups, so
       "everything is available" is visible without expanding anything. */
    const groups = {};
    for (const r of rows) (groups[r.marketLabel] = groups[r.marketLabel] || []).push(r);
    const order = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
    for (const g of order) {
      const gr = groups[g].sort((a, b) => (b.t || -99) - (a.t || -99));
      const cen = {}; for (const r of gr) cen[r.verdict] = (cen[r.verdict] || 0) + 1;
      const label = g + '  ·  ' + gr.length + ' rows  ·  ' +
        ['BET','THIN','LIMITED','AGED','SUSPECT','PASS','NO PRICE']
          .filter(k => cen[k]).map(k => cen[k] + ' ' + k).join('  ');
      const det = h('details', { open: (cen['BET'] ? 'open' : null), style:'margin:8px 0' });
      det.appendChild(h('summary', { style:'cursor:pointer;font-weight:600;font-size:12px' }, label));
      const tb = h('tbody');
      for (const r of gr.slice(0, 60)) tb.appendChild(V.boardRow(r,
        [['g','',0],['cat','CAT',0],['event','EVENT',0],['side','SIDE',0],['venue','VENUE',0],
         ['dGross','PRICE',1],['pFair','FAIR',1],['ep','EDGE pp',1],['evNet','EV%',1],['t','t',1],
         ['rung','STAKE',1],['amount','AMT',1],['verdict','VERDICT',0],['why','WHY',0]],
        VB.store.get().settings));
      det.appendChild(h('table', {}, [h('thead', {}, h('tr', {},
        ['','CAT','EVENT','SIDE','VENUE','PRICE','FAIR','EDGE pp','EV%','t','STAKE','AMT','VERDICT','WHY']
          .map((c, i) => h('th', { class: i >= 5 && i <= 11 ? 'r' : '' }, c)))), tb]));
      wrap.appendChild(det);
    }
    wrap.appendChild(h('div', { class:'small muted', style:'padding:8px 2px' },
      rows.length + ' rows · ' + ['BET','THIN','PASS','NO PRICE','AGED','SUSPECT','LIMITED']
        .filter(k => census[k]).map(k => census[k] + ' ' + k).join(' · ') + '. Nothing is hidden on this page.'));
    return wrap;
  }

  /* ------------------------------------------------------ first-run modal */
  function firstRun() {
    const S = VB.store.get(), st = S.settings;
    const box = document.getElementById('scrimbox');
    clear(box);
    let bank = 5000, unit = 50;
    const out = h('div', { class:'note', style:'margin-top:10px' });
    const recalc = () => {
      clear(out);
      if (!(bank > 0) || !(unit > 0)) { out.appendChild(h('div', { class:'warn' }, 'Enter both a bankroll and a unit.')); return; }
      if (unit > bank * 0.05) {
        out.appendChild(h('div', { class:'neg' }, 'A unit above 5% of bankroll is rejected: the 2u ' +
          'per-bet cap would put 10% of your bankroll on a single bet, and Kelly cannot serve that.'));
        return;
      }
      const typical = st.R * st.lambda * 0.03;
      out.appendChild(h('div', {}, '1u = ' + money(unit) + ' = ' + (unit / bank * 100).toFixed(2) +
        '% of a ' + money(bank) + ' bankroll.'));
      out.appendChild(h('div', { class:'small muted' }, 'At risk level ' + st.lambda +
        ', a typical qualifying bet is ' + (typical * 100).toFixed(2) + '% of bankroll, about ' +
        money(typical * bank) + ', i.e. ' + (typical * bank / unit).toFixed(2) +
        'u. Most recommendations will round to 0.25u.'));
      const impB = Math.round(K.impliedBankrollFor1u(typical, unit) / 1000) * 1000;
      const impU = Math.round(K.suggestedUnitFor1u(typical, bank) / 5) * 5;
      out.appendChild(h('div', { class:'small muted' }, 'For 1.0u to be a typical bet, your bankroll ' +
        'would need to be about ' + money(impB) + ', or your unit about ' + money(impU) + '.'));
      /* Offer to change the UNIT only. Never the bankroll — that is his
         money, not a setting. */
      out.appendChild(h('div', { style:'margin-top:6px' },
        h('button', { onclick:() => { unit = impU; uIn.value = impU; recalc(); } },
          'Set unit to ' + money(impU))));
    };
    const bIn = h('input', { type:'number', value:bank, step:100, style:'width:110px',
      onchange:(e) => { bank = Number(e.target.value); recalc(); } });
    const uIn = h('input', { type:'number', value:unit, step:5, style:'width:110px',
      onchange:(e) => { unit = Number(e.target.value); recalc(); } });

    box.appendChild(h('h1', {}, 'Before the board will size anything'));
    box.appendChild(h('div', { class:'sub' },
      'Every stake, cap and risk figure is downstream of these two numbers, so the board will not ' +
      'invent them.'));
    box.appendChild(h('div', { class:'note w' },
      'This build runs entirely on SYNTHETIC data. The venues are real names but every price is ' +
      'generated from a fixed seed. Nothing here is a real market and no edge on this screen exists.'));
    box.appendChild(h('div', { class:'row', style:'margin:10px 0' }, [
      h('div', { style:'width:110px' }, 'Bankroll ($)'), bIn,
      h('div', { style:'width:110px;margin-left:16px' }, '1 unit ($)'), uIn]));
    box.appendChild(out);
    box.appendChild(h('div', { class:'small muted', style:'margin-top:10px' },
      'What this app will not do: it places no bets, it has no venue connectivity, it never calls a ' +
      'stake an amount you “should” bet, and it never describes anything as guaranteed or risk-free. ' +
      'EV is modelled, not realised.'));
    box.appendChild(h('div', { class:'row', style:'margin-top:12px' }, [
      h('button', { class:'pri', onclick:() => {
        if (!(bank > 0) || !(unit > 0) || unit > bank * 0.05) { recalc(); return; }
        st.bankroll = bank; st.unitUsd = unit; S.ui.firstRunSeen = true;
        VB.store.save(); document.getElementById('scrim').classList.remove('on');
        VB.model.compute(); VB.router.render();
      } }, 'Start'),
      h('button', { onclick:() => { S.ui.firstRunSeen = true; VB.store.save();
        document.getElementById('scrim').classList.remove('on'); VB.router.render(); } },
        'Browse without sizing')
    ]));
    recalc();
    document.getElementById('scrim').classList.add('on');
  }
  return { settings, ask, firstRun, exportCsv };
})();
