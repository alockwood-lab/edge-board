/* --------------------------------------------------------------- L2 seed */
VB.seed = (function () {
  const U = VB.util, O = VB.odds, D = VB.devig, C = VB.consensus, A = VB.arb;
  const { clamp, logit, sig, gauss } = U;

  const MASTER = 20260905;
  const rngFor = (stage) => U.mulberry32(U.xmur3(MASTER + ':' + stage)());

  /* 19 real venues. Names are real because "which book is most successful"
     is half of what was asked and a leaderboard of Venue A / Exchange B
     answers it for nobody. The SYNTHETIC PRICES get labelled, not the
     venues: a '~' prefix while seeded, an undismissable banner, DEMO in the
     title, and SYNTHETIC in column 1 of every export row.
     `cluster` is static ownership / feed lineage. Flutter owning both
     FanDuel and Betfair is a real lineage fact and it is exactly why
     leave-one-CLUSTER-out matters: without it, removing FanDuel would leave
     its corporate sibling voting in the consensus that judges it.
     `sigma` is the designed ground truth -- the injected logit noise the
     leaderboard must RECOVER. Nothing about the ranking is hardcoded. */
  const VENUES = [
    /* id, name, cluster, tier, kind, sigma, vig, favBias, limitTier, cov, updSec, fee */
    ['pinnacle','Pinnacle','pinnacle',1,'book',       0.022,1.020,0.00,5,0.92, 20,null],
    ['circa','Circa Sports','circa',1,'book',         0.026,1.026,0.01,5,0.55, 30,null],
    ['betfair','Betfair Exchange','flutter',1,'exch', 0.028,1.000,0.00,4,0.62,  8,{type:'commission',rate:0.02}],
    ['kalshi','Kalshi','kalshi',1,'pmkt',             0.034,1.000,0.00,3,0.34,  6,{type:'kalshi',k:0.07}],
    ['polymarket','Polymarket','polymarket',1,'pmkt', 0.038,1.000,0.00,3,0.30,  5,{type:'none'}],
    ['smarkets','Smarkets','smarkets',2,'exch',       0.036,1.000,0.00,3,0.48, 12,{type:'commission',rate:0.02}],
    ['bet365','bet365','bet365',2,'book',             0.044,1.044,0.02,4,0.88, 60,null],
    ['draftkings','DraftKings','draftkings',2,'book', 0.052,1.050,0.03,3,0.95, 75,null],
    ['fanduel','FanDuel','flutter',2,'book',          0.056,1.052,0.03,3,0.94, 80,null],
    ['betmgm','BetMGM','betmgm',2,'book',             0.060,1.054,0.04,3,0.90, 90,null],
    ['caesars','Caesars','caesars',2,'book',          0.064,1.052,0.04,3,0.87, 95,null],
    ['espnbet','ESPN Bet','penn','2','book',          0.070,1.060,0.05,2,0.82,120,null],
    ['betrivers','BetRivers','betrivers',2,'book',    0.074,1.060,0.05,2,0.78,130,null],
    ['fanatics','Fanatics','fanatics',3,'book',       0.080,1.066,0.06,2,0.74,150,null],
    ['novig','Novig','novig',2,'p2p',                 0.054,1.006,0.01,2,0.41, 25,{type:'commission',rate:0.01}],
    ['sporttrade','Sporttrade','sporttrade',2,'exch', 0.058,1.000,0.01,2,0.33, 18,{type:'commission',rate:0.02}],
    ['prophetx','ProphetX','prophetx',3,'p2p',        0.078,1.004,0.02,1,0.22, 40,{type:'commission',rate:0.015}],
    ['betonline','BetOnline','offshore',3,'book',     0.088,1.074,0.07,2,0.66,240,null],
    ['bovada','Bovada','offshore',3,'book',           0.098,1.090,0.09,1,0.58,420,null]
  ].map(v => ({ id:v[0], name:v[1], cluster:v[2], tier:Number(v[3]), kind:v[4],
                sigma:v[5], vig:v[6], favBias:v[7], depthTier:v[8], cov:v[9],
                updSec:v[10], fee:v[11],
                model: (v[4]==='exch'||v[4]==='pmkt'||v[4]==='p2p') ? 'order_book' : 'fixed_odds',
                publishesProbability: (v[4]==='pmkt'||v[4]==='exch'),
                limitUsd: [0,120,320,800,2500,9000][v[8]],
                accessible: false,          /* NOTHING is claimed on the user's behalf */
                includeInConsensus: true, enabled: true }));

  const CATS = [
    ['NFL','americanfootball_nfl','NFL',16,true,false],
    ['NCAAF','americanfootball_ncaaf','NCAA Football',18,true,false],
    ['MLB','baseball_mlb','MLB',14,true,false],
    ['NBA','basketball_nba','NBA',0,true,true],
    ['NHL','icehockey_nhl','NHL',0,true,true],
    ['NCAAB','basketball_ncaab','NCAA Basketball',0,true,true],
    ['SOC','soccer_epl','Soccer',10,true,false],
    ['TEN','tennis_atp','Tennis',8,false,false],
    ['MMA','mma_ufc','MMA',11,false,false],
    ['GOLF','golf_pga','Golf',0,false,true],
    ['POL','nonsport_politics','Politics',0,false,true],
    ['ECON','nonsport_economics','Economics',0,false,true],
    ['AWD','nonsport_entertainment','Entertainment',0,false,true],
    ['TECH','nonsport_tech','Tech & AI',0,false,true]
  ].map(c => ({ key:c[0], sportKey:c[1], label:c[2], nGames:c[3],
                hasGames:c[3]>0, futuresOnly:c[5] }));

  /* Teams / entities per category. Deliberately includes the NCAA name
     collisions (Miami FL vs Miami OH, the Saint Mary's family, three
     Loyolas) because that is where naive matchers fail most expensively. */
  const T = {
    NFL:['Chiefs','Bills','Ravens','49ers','Eagles','Lions','Bengals','Cowboys','Dolphins','Packers','Jets','Chargers','Texans','Rams','Vikings','Steelers','Browns','Buccaneers','Jaguars','Seahawks','Falcons','Colts','Saints','Broncos','Cardinals','Raiders','Titans','Commanders','Bears','Giants','Panthers','Patriots'],
    NCAAF:['Ohio State','Georgia','Texas','Alabama','Oregon','Penn State','Notre Dame','Michigan','LSU','Tennessee','Miami (FL)','Miami (OH)','Saint Mary’s','Utah','Clemson','Florida State','Oklahoma','USC','South Carolina','Texas A&M','Washington','Missouri','Ole Miss','Kansas State'],
    MLB:['Dodgers','Yankees','Braves','Orioles','Phillies','Astros','Guardians','Brewers','Padres','Mariners','Diamondbacks','Cubs','Red Sox','Twins','Rays','Royals','Mets','Giants','Tigers','Cardinals','Reds','Pirates','Nationals','Marlins','Rangers','Blue Jays','Angels','Athletics'],
    NBA:['Celtics','Thunder','Nuggets','Timberwolves','Knicks','Mavericks','Bucks','Suns','76ers','Cavaliers','Pacers','Clippers','Magic','Lakers','Heat','Warriors','Kings','Pelicans','Rockets','Hawks'],
    NHL:['Panthers','Oilers','Rangers','Stars','Hurricanes','Avalanche','Bruins','Maple Leafs','Jets','Lightning','Golden Knights','Kraken','Devils','Predators','Canucks','Wild'],
    NCAAB:['Connecticut','Purdue','Houston','Arizona','Duke','North Carolina','Kansas','Baylor','Loyola (Chicago)','Loyola (MD)','Tennessee','Marquette','Kentucky','Auburn','Gonzaga'],
    SOC:['Arsenal','Manchester City','Liverpool','Chelsea','Tottenham','Manchester United','Newcastle','Aston Villa','Brighton','West Ham','Everton','Crystal Palace'],
    TEN:['Sinner','Alcaraz','Djokovic','Medvedev','Zverev','Rublev','Fritz','De Minaur','Ruud','Hurkacz','Tsitsipas','Shelton','Paul','Dimitrov','Rune','Musetti'],
    MMA:['Makhachev','Topuria','O’Malley','Pereira','Edwards','Du Plessis','Volkanovski','Ankalaev','Aspinall','Gaethje','Tsarukyan','Chimaev','Sterling','Moreno','Pantoja','Yan','Holloway','Poirier','Oliveira','Dvalishvili','Nurmagomedov','Hooker'],
    GOLF:['Scheffler','McIlroy','Schauffele','Aberg','Hovland','Morikawa','Rahm','Koepka','Cantlay','Homa','Fleetwood','Lowry','Fitzpatrick','Zalatoris','Burns','Straka','Field'],
    POL:['GOP Senate control','Democratic House control','Fed Chair confirmed 2027','Governor race NV','Governor race AZ','Governor race GA','Senate seat count 51-53','Senate seat count 54+','Cabinet change by Dec','Third-party ballot access'],
    ECON:['No change','Cut 25bp','Cut 50bp','Hike 25bp','CPI below 2.5%','CPI 2.5-3.0%','CPI above 3.0%','Recession declared by 2027','Unemployment above 5%','Year-end rate below 3%'],
    AWD:['Drama Series A','Drama Series B','Comedy Series A','Comedy Series B','Limited Series A','Lead Actor A','Lead Actress A','Box office above 400M','Album at number one'],
    TECH:['Model release by Dec 31','Chip export rule change','IPO priced above range','Antitrust ruling by Q2','Datacenter capex above 400B','Open-weights model tops leaderboard']
  };

  const MKT = {
    moneyline: { label:'MONEYLINE', sides:['home','away'], push:false },
    spread:    { label:'SPREAD',    sides:['home','away'], push:true  },
    total:     { label:'TOTAL',     sides:['over','under'],push:true  },
    ml3:       { label:'1X2',       sides:['home','draw','away'], push:false },
    outright:  { label:'OUTRIGHT',  sides:null, push:false },
    binary:    { label:'BINARY',    sides:['yes','no'], push:false },
    prop:      { label:'PLAYER',    sides:['over','under'], push:true }
  };

  /* Per-venue quote derivation from a single latent truth. Six things make
     this read as real rather than random:
       1. noise in LOGIT space, so it never leaves (0,1) and scales sensibly
          at long odds;
       2. favBias COMPRESSES toward 50/50, reproducing the actual
          favourite-longshot bias -- soft books overprice underdogs;
       3. the venue's OPINION is renormalized to a proper distribution before
          vig is applied, so the devig engine can genuinely recover it;
       4. vig is weighted toward longshots, which is what books do and what
          makes Shin visibly differ from multiplicative in the UI;
       5. prices SNAP to the real grid before the board sees them, because
          snapping is where genuine arbitrage comes from;
       6. staleness is an exponential draw scaled by the venue's own update
          cadence, so the age chips and the staleness bias have something
          honest to act on. */
  function venueQuote(pTrue, v, rng) {
    const n = pTrue.length, ph = [];
    for (const p of pTrue) {
      let z = logit(clamp(p, 1e-4, 1 - 1e-4));
      z *= (1 - v.favBias);
      z += v.sigma * gauss(rng);
      ph.push(sig(z));
    }
    const s0 = ph.reduce((a, b) => a + b, 0);
    const opinion = ph.map(x => x / s0);
    if (v.model === 'order_book') {
      /* Exchanges/PMs quote a two-sided book: a spread around the opinion,
         not a vig loading. Mid is the signal, ask is the execution. */
      const spread = (v.vig - 1) + 0.004 + 0.010 * rng();
      return { opinion, ask: opinion.map(p => clamp(p + spread / 2, 0.005, 0.995)),
               bid: opinion.map(p => clamp(p - spread / 2, 0.005, 0.995)),
               spreadCents: spread * 100 };
    }
    /* Allocate the margin EXPLICITLY so the book sum equals vig by
       construction at any skew and any n. Weighting the allocation toward
       longshots (gamma 0.45) reproduces the favourite-longshot loading books
       actually apply -- a 10% shot carries ~36% relative markup where a 90%
       favourite carries ~1.5% -- and it is what makes Shin and power devig
       visibly differ from multiplicative in the UI.
       A formula that merely SCALES the opinion cannot do this: it lets the
       book sum drift with skew, and at extreme skew it drifts below 1, which
       is a free-money book. That produced both sides of a market showing as
       positive-EV bets. */
    const margin = v.vig - 1;
    const u = opinion.map(p => Math.pow(1 / Math.max(p, 0.02), 0.45));
    const uS = u.reduce((a, b) => a + b, 0);
    const q = opinion.map((p, i) => p + margin * u[i] / uS);
    return { opinion, q };
  }

  function priceRows(pTrue, market, nowSec) {
    const rng = rngFor('quotes:' + market.id);
    const rows = [];
    for (const v of VENUES) {
      if (rng() > v.cov) continue;
      const qd = venueQuote(pTrue, v, rng);
      const stale = rng() < 0.06 ? 10 : 1;
      const age = Math.round(-Math.log(1 - rng()) * v.updSec * stale);
      for (let i = 0; i < pTrue.length; i++) {
        let dGross, bidP = null, askP = null, spreadCents = null;
        if (qd.q) dGross = O.snapToGrid(1 / qd.q[i], 'american');
        else {
          askP = qd.ask[i]; bidP = qd.bid[i]; spreadCents = qd.spreadCents;
          dGross = O.snapToGrid(1 / askP, 'cents');
        }
        rows.push({ venueId: v.id, outcomeIx: i, dGross,
                    bidProb: bidP, askProb: askP, spreadCents,
                    ageSec: age, ts: nowSec - age });
      }
    }
    return rows;
  }

  /* Fee-adjusted net price. This is the ONLY input to EV. A fee-blind
     detector prints arbitrages that do not exist, and one planted test
     depends on exactly that. */
  function netDecimal(dGross, venue) {
    const f = venue.fee;
    if (!f || f.type === 'none') return dGross;
    if (f.type === 'commission') return O.commissionAdjusted(dGross, f.rate);
    if (f.type === 'kalshi') return O.pmFeeAdjusted(dGross, f.k);
    return dGross;
  }
  return { MASTER, rngFor, VENUES, CATS, TEAMS: T, MKT,
           venueQuote, priceRows, netDecimal };
})();

/* ------------------------------------------------- L2 seed: history + slate */
VB.seedGen = (function () {
  const U = VB.util, O = VB.odds, D = VB.devig, C = VB.consensus, S = VB.seed;
  const { clamp, logit, sig, gauss } = U;

  /* Settled history is stored as SUFFICIENT STATISTICS, never as rows:
     ~35 numbers per venue recovers every metric AND its standard error, in
     under 5KB, where the equivalent rows would double the arena.
     CLA is computed LEAVE-ONE-CLUSTER-OUT. This is not a detail: scoring a
     venue against a closing consensus built partly from its own corporate
     siblings and feed-mates rewards CONFORMITY, so the sharpest independent
     venue -- the one whose price disagrees -- would score worst. */
  function history(nEvents) {
    const rng = S.rngFor('history');
    const stats = {};
    for (const v of S.VENUES) {
      stats[v.id] = { n:0, claSum:0, claSumSq:0, nSettled:0, brierSum:0,
                      brierSumSq:0, logSum:0, holdSum:0, nHold:0, nBest:0,
                      bins: Array.from({length:10}, () => ({n:0,pSum:0,oSum:0})) };
    }
    for (let e = 0; e < nEvents; e++) {
      const zT = gauss(rng) * 1.1;
      const pT = sig(zT);
      const pTrue = [pT, 1 - pT];
      const y = rng() < pT ? 1 : 0;      /* outcome drawn from TRUTH */

      /* Each venue forms an opinion at its own designed sigma. */
      const op = [], present = [];
      for (const v of S.VENUES) {
        if (rng() > v.cov) continue;
        const q = S.venueQuote(pTrue, v, rng);
        op.push(q.opinion); present.push(v);
      }
      if (present.length < 4) continue;

      /* Closing consensus, then per-venue LOCO closing consensus. */
      for (let i = 0; i < present.length; i++) {
        const v = present[i];
        const others = [], oProbs = [];
        for (let j = 0; j < present.length; j++) {
          if (present[j].cluster === v.cluster) continue;
          others.push(present[j]); oProbs.push(op[j]);
        }
        if (others.length < 3) continue;
        const built = C.build(others.map(x => Object.assign({}, x, { ageSec: 5 })),
                              oProbs, {});
        if (!built.ok) continue;
        const pClose = built.p[0];
        const ph = clamp(op[i][0], 1e-4, 1 - 1e-4);
        const st = stats[v.id];
        const cla = (ph - pClose) * (ph - pClose);
        st.n++; st.claSum += cla; st.claSumSq += cla * cla;
        const br = (ph - y) * (ph - y);
        st.nSettled++; st.brierSum += br; st.brierSumSq += br * br;
        st.logSum -= y ? Math.log(ph) : Math.log(1 - ph);
        const b = Math.min(9, Math.floor(ph * 10));
        st.bins[b].n++; st.bins[b].pSum += ph; st.bins[b].oSum += y;
        /* Hold is a single-snapshot measurement: cheap, precise, immediate. */
        if (v.model === 'fixed_odds') {
          const q2 = S.venueQuote(pTrue, v, rng);
          if (q2.q) { st.holdSum += 1 - 1 / (q2.q[0] + q2.q[1]); st.nHold++; }
        } else { st.holdSum += (v.vig - 1) + 0.006; st.nHold++; }
      }
    }
    /* Finish the calibration bins into the shape the scorer expects. */
    for (const id in stats) {
      const st = stats[id];
      st.bins = st.bins.filter(b => b.n > 0)
                       .map(b => ({ n:b.n, pMean:b.pSum/b.n, oMean:b.oSum/b.n }));
      const v = S.VENUES.find(x => x.id === id);
      st.breadth = v.cov; st.depthTier = v.depthTier;
      st.publishesProbability = v.publishesProbability;
    }
    return stats;
  }

  function leaderboard(stats) {
    const rows = [];
    for (const v of S.VENUES) {
      const c = VB.score.components(stats[v.id]);
      if (c) c.publishesProbability = v.publishesProbability;
      rows.push({ venue: v, comp: c });
    }
    const cohort = { cla: rows.map(r => r.comp && r.comp.cla).filter(isFinite),
                     calib: rows.map(r => r.comp && r.comp.ece).filter(isFinite),
                     logLoss: rows.map(r => r.comp && r.comp.logLoss).filter(isFinite),
                     brier: rows.map(r => r.comp && r.comp.brier).filter(isFinite) };
    for (const r of rows) {
      r.sharp = VB.score.sharp(r.comp, cohort, r.venue.tier);
      r.use = VB.score.use(r.comp, cohort);
    }
    const ranked = VB.score.rank(rows);
    return { rows, ranked, cohort };
  }
  return { history, leaderboard };
})();
