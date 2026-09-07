/* ---------------------------------------------------------- L1 consensus */
VB.consensus = (function () {
  const { clamp, logit, sig } = VB.util;

  const BETA = 0.6;            /* softmax temperature: a 20pt sharpness gap = 3.32x weight */
  const CLUSTER_CAP = 0.35;    /* no pricing vendor / parent may exceed this share */
  const TAU_PREGAME = 600;     /* staleness decay, seconds */
  const TAU_INPLAY = 20;
  const TRIM_Z = 3.5;          /* Iglewicz-Hoaglin */
  const MIN_VEFF = 3;

  /* Liquidity factor. Exchanges and PMs are judged on spread, books on
     posted limit. A PM wider than 6c is excluded outright, not downweighted:
     a 7c spread is not an opinion about probability. */
  function liquidityFactor(v) {
    if (v.model === 'order_book') {
      if (!(v.spreadCents >= 0)) return 0;
      if (v.spreadCents > 6) return 0;
      const h = v.spreadCents / 2;
      return 1 / (1 + h * h);
    }
    const lim = v.limitUsd;
    if (!(lim > 0)) return 0.4;
    return lim >= 500 ? 1 : lim >= 100 ? 0.7 : 0.4;
  }

  /* Staleness decay, and a hard exclusion at 5 tau. A stale venue must not
     be allowed to drag the consensus toward its own stale opinion, which
     would make the whole market look like edge. Note the two separate
     budgets: consensus membership is TIGHTER than display. */
  function stalenessFactor(ageSec, isLive) {
    const tau = isLive ? TAU_INPLAY : TAU_PREGAME;
    if (!(ageSec >= 0)) return 0;
    if (ageSec > 5 * tau) return 0;
    return Math.exp(-ageSec / tau);
  }

  /* Raw weights from the SHARPNESS sub-index -- never the composite score.
     For a reference venue you do not care about its limits or breadth, only
     whether its price is right. Using the composite here would downweight a
     sharp low-limit book for a reason irrelevant to its role. */
  function rawWeights(venues, isLive) {
    return venues.map(v => {
      const z = ((v.sharp === undefined ? 50 : v.sharp) - 50) / 10;
      const L = liquidityFactor(v);
      const R = stalenessFactor(v.ageSec, isLive);
      return Math.exp(BETA * z) * L * R;
    });
  }

  /* Cluster caps. Five venues on one pricing feed are ONE opinion counted
     five times, and sum(w)=1 does nothing to stop it. Cap per cluster,
     redistribute the excess proportionally, iterate. Without this the
     consensus is overconfident and manufactures edge at the one venue with
     an independent view -- frequently the sharpest one, so the board would
     recommend betting AGAINST the best-informed venue. */
  function normalizeWithCaps(venues, raw) {
    const T0 = raw.reduce((a, b) => a + b, 0);
    if (!(T0 > 0)) return { w: raw.map(() => 0), clusters: {}, vEff: 0, effCap: CLUSTER_CAP };

    /* Aggregate to cluster level first. */
    const cRaw = {}, cMembers = {};
    venues.forEach((v, i) => {
      const c = v.cluster || v.id;
      if (!(raw[i] > 0)) return;
      cRaw[c] = (cRaw[c] || 0) + raw[i];
      (cMembers[c] = cMembers[c] || []).push(i);
    });
    const names = Object.keys(cRaw);
    const nC = names.length;
    if (!nC) return { w: raw.map(() => 0), clusters: {}, vEff: 0, effCap: CLUSTER_CAP };

    /* A 0.35 cap needs at least 3 clusters to be satisfiable. With two
       clusters it is arithmetically impossible, so the cap relaxes to
       1/nClusters rather than silently failing to sum to 1. */
    const effCap = Math.max(CLUSTER_CAP, 1 / nC);

    /* Water-filling: pin any cluster over the cap, redistribute the balance
       proportionally among the unpinned. The pinned set only grows, so this
       terminates -- unlike proportional redistribution, which oscillates
       when two clusters both breach. */
    const share = {};
    let active = names.slice(), remaining = 1;
    for (let guard = 0; guard <= nC; guard++) {
      const actRaw = active.reduce((s, c) => s + cRaw[c], 0);
      if (!(actRaw > 0)) break;
      const over = [];
      for (const c of active) {
        if (remaining * cRaw[c] / actRaw > effCap + 1e-12) over.push(c);
      }
      if (!over.length) {
        for (const c of active) share[c] = remaining * cRaw[c] / actRaw;
        break;
      }
      for (const c of over) { share[c] = effCap; remaining -= effCap; }
      active = active.filter(c => over.indexOf(c) === -1);
      if (!active.length) break;
    }

    /* Push each cluster's share down to its members, pro rata within cluster. */
    const w = raw.map(() => 0);
    for (const c of names) {
      const mem = cMembers[c], tot = mem.reduce((s, i) => s + raw[i], 0);
      if (!(tot > 0)) continue;
      for (const i of mem) w[i] = (share[c] || 0) * (raw[i] / tot);
    }
    /* Effective sample size at CLUSTER level, not venue level. */
    const vEff = 1 / names.reduce((s, c) => s + (share[c] || 0) * (share[c] || 0), 0);
    return { w, clusters: share, vEff, effCap };
  }

  /* Weighted median and MAD in logit space. */
  function weightedQuantile(vals, wts, q) {
    const ix = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    const T = wts.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (const i of ix) { acc += wts[i]; if (acc >= q * T) return vals[i]; }
    return vals[ix[ix.length - 1]];
  }

  /* An outlier is EXACTLY what we are hunting, so trimming is dangerous.
     Resolution: trim the consensus, never the offer being evaluated (which
     is excluded by construction anyway, so it can never be trimmed away).
     Below 5 venues there is no power to identify an outlier and MAD is
     degenerate, so winsorize instead of trimming. */
  function trimLogits(ells, wts) {
    const n = ells.length;
    if (n < 5) {
      const lo = weightedQuantile(ells, wts, 0.10);
      const hi = weightedQuantile(ells, wts, 0.90);
      return { ells: ells.map(x => clamp(x, lo, hi)), dropped: [], mode: 'winsorized' };
    }
    const m = weightedQuantile(ells, wts, 0.5);
    const devs = ells.map(x => Math.abs(x - m));
    const mad = weightedQuantile(devs, wts, 0.5);
    if (!(mad > 0)) return { ells, dropped: [], mode: 'no-dispersion' };
    const dropped = [];
    ells.forEach((x, i) => {
      if (Math.abs(x - m) / (1.4826 * mad) > TRIM_Z) dropped.push(i);
    });
    return { ells, dropped, mode: 'trimmed' };
  }

  /* Weighted LOG-LINEAR (geometric) pool. For n=2 this is exactly logit
     averaging, so one rule covers both cases. sum(w)=1 is required, not
     cosmetic: it is the idempotence condition, so a unanimous market is
     reported unchanged.
     Logit pooling is SHARPER than arithmetic averaging -- venues at 0.20 and
     0.40 pool to 0.28993, not 0.30000. On a longshot that means a lower
     consensus probability, a smaller measured edge, and fewer false
     positives on dogs. Jensen guarantees the sign. */
  function pool(perVenueProbs, weights) {
    const nOut = perVenueProbs[0].length;
    const lnp = new Array(nOut).fill(0);
    let W = 0;
    for (let v = 0; v < perVenueProbs.length; v++) {
      const w = weights[v];
      if (!(w > 0)) continue;
      W += w;
      for (let i = 0; i < nOut; i++) {
        lnp[i] += w * Math.log(clamp(perVenueProbs[v][i], 1e-9, 1 - 1e-9));
      }
    }
    if (!(W > 0)) return null;
    const raw = lnp.map(x => Math.exp(x / W));
    const Z = raw.reduce((a, b) => a + b, 0);
    return raw.map(x => x / Z);
  }

  /* Build a fair line, optionally excluding an entire correlated CLUSTER.
     Leave-one-CLUSTER-out, not leave-one-venue-out: if the offer is one of
     five venues on the same feed, removing it alone leaves its price in the
     consensus four more times. */
  function build(venues, perVenueProbs, opts) {
    const o = opts || {};
    const excludeCluster = o.excludeCluster || null;
    const keep = [];
    let unusable = 0;
    venues.forEach((v, i) => {
      if (excludeCluster && (v.cluster || v.id) === excludeCluster) return;
      if (!v.includeInConsensus) return;
      /* A logit pool has no immunity to one bad member: a single non-finite
         probability propagates through the weighted mean and every outcome
         comes back NaN, with ok:true, so the caller reports a fair price of
         "--" on every row instead of a failure. Screen the members here, at
         the point where the invariant is cheap to state: a voter must carry
         a finite probability strictly inside (0,1) for every outcome. */
      const pv = perVenueProbs[i];
      if (!pv || pv.length !== (perVenueProbs[0] || []).length) { unusable++; return; }
      for (let k = 0; k < pv.length; k++) {
        if (!(Number.isFinite(pv[k]) && pv[k] > 0 && pv[k] < 1)) { unusable++; return; }
      }
      keep.push(i);
    });
    if (!keep.length) {
      return { ok: false, reason: unusable ? 'no_usable_probs' : 'no_voters', unusable };
    }

    const kv = keep.map(i => venues[i]);
    const raw = rawWeights(kv, o.isLive);
    if (!raw.some(x => x > 0)) return { ok: false, reason: 'all_excluded_stale_or_wide' };

    /* Trim in logit space on the FAVOURITE outcome as the dispersion proxy,
       then drop those venues from the pool entirely. */
    const norm0 = normalizeWithCaps(kv, raw);
    const ell0 = keep.map(i => logit(clamp(perVenueProbs[i][0], 1e-6, 1 - 1e-6)));
    const tr = trimLogits(ell0, norm0.w);
    const kept2 = keep.filter((_, j) => tr.dropped.indexOf(j) === -1);
    if (!kept2.length) return { ok: false, reason: 'all_trimmed' };

    const kv2 = kept2.map(i => venues[i]);
    const raw2 = rawWeights(kv2, o.isLive);
    const norm = normalizeWithCaps(kv2, raw2);
    const probs = kept2.map(i => perVenueProbs[i]);
    const p = pool(probs, norm.w);
    if (!p) return { ok: false, reason: 'no_weight' };

    /* Hard rule: with no tier-1 venue present there is no fair line for
       value purposes. A consensus of five retail books that all buy the
       same feed is not a fair line, it is one soft line with error bars. */
    const hasT1 = kv2.some(v => v.tier === 1);

    /* Dispersion must be computed PER OUTCOME. Using outcome 0's dispersion
       for every row understates the SE on all other outcomes and inflates
       t -- which drives both the default sort and the significance gate, so
       the error would put the least reliable rows at the top of the board.
       It matters most on multi-outcome markets, where a tight favourite and
       a widely-disagreed longshot are in the same market. */
    const wbar = norm.w;
    const sumW2 = wbar.reduce((s, x) => s + x * x, 0);
    const nOut = perVenueProbs[kept2[0]].length;
    const seLogitByOutcome = [], sLogitByOutcome = [];
    for (let k = 0; k < nOut; k++) {
      const ellK = kept2.map(i => logit(clamp(perVenueProbs[i][k], 1e-6, 1 - 1e-6)));
      const muK = ellK.reduce((s, x, j) => s + wbar[j] * x, 0);
      const varK = ellK.reduce((s, x, j) => s + wbar[j] * (x - muK) * (x - muK), 0);
      sLogitByOutcome.push(Math.sqrt(varK));
      seLogitByOutcome.push(Math.sqrt(varK * sumW2));
    }
    const seLogit = seLogitByOutcome[0];
    const varL = sLogitByOutcome[0] * sLogitByOutcome[0];

    return { ok: true, p, weights: wbar, venueIx: kept2, clusters: norm.clusters,
             vEff: norm.vEff, hasT1, seLogit, sLogit: Math.sqrt(varL),
             seLogitByOutcome, sLogitByOutcome,
             dropped: tr.dropped.map(j => keep[j]), trimMode: tr.mode,
             nVoters: kept2.length, nClusters: Object.keys(norm.clusters).length };
  }

  /* SE of the consensus probability. Sampling error shrinks with more
     venues; the devig and staleness terms are BIAS and do not shrink. In a
     realistic three-sharp-venue case SE_total is 41% of the signal, and
     that is a GOOD case. */
  const B_DEVIG = 0.004, B_STALE = 0.003;
  function seTotal(p, seLogit) {
    const seSamp = p * (1 - p) * seLogit;
    return { seSamp, seTotal: Math.sqrt(seSamp * seSamp + B_DEVIG * B_DEVIG + B_STALE * B_STALE) };
  }

  /* The algebraic LOO shortcut is exact ONLY if the weights are unchanged by
     removing the offer -- and with cluster caps they are not, because
     removing a venue frees cap headroom that gets reallocated. Measured
     discrepancy 0.014pp in the reference case, larger when the offer sits
     inside a capped cluster. So the full pipeline is re-run per offer;
     it is O(V^2 n) floating-point ops, which is nothing in a browser. */
  const looShortcut = (lbar, wo, lo) => (lbar - wo * lo) / (1 - wo);

  return { build, pool, rawWeights, normalizeWithCaps, trimLogits, weightedQuantile,
           liquidityFactor, stalenessFactor, seTotal, looShortcut,
           BETA, CLUSTER_CAP, MIN_VEFF, TRIM_Z, B_DEVIG, B_STALE };
})();
