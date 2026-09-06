/* ------------------------------------------------------- L2 credit budget */
VB.budget = (function () {
  /* 500 credits a month against 730 hours. Spread uniformly that is 0.68
     credits an hour, which is both unspendable and useless -- odds only
     matter near kickoff, and there are no games at 4am on a Tuesday. So the
     policy is not a rate limit, it is an ALLOCATION:

       1. Scout with free sources first. ESPN costs nothing and answers the
          only question that decides whether a paid pull is worth it: are
          there games, and when do they start?
       2. Spend only inside the value window. A pull 30 hours before kickoff
          buys a line that will move; a pull inside a few hours buys the line
          you can actually bet, at the point soft books lag the sharps.
       3. Buy the reference, not the retail. `regions=eu` carries Pinnacle,
          Betfair and Matchbook for 3 credits; the US region costs another 3
          and mostly duplicates books ESPN already gives away. Measured:
          eu alone returns 21 books with all three sharp anchors.
       4. Keep a hard reserve so the month cannot be emptied by a bad day. */

  const KEY = 'vb.budget';
  const MONTHLY = 500;
  const RESERVE = 60;              /* never spend below this */
  const VALUE_WINDOW_H = 14;       /* only pay for games inside this horizon */
  const MIN_GAP_MIN = 12;          /* never two paid pulls closer than this */

  const monthKey = (d) => {
    const t = d || new Date();
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0');
  };
  function read() {
    let o = {};
    try { o = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { o = {}; }
    const k = monthKey();
    if (!o[k]) o[k] = { spent: 0, pulls: 0, lastAt: 0, log: [] };
    return o;
  }
  function write(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }

  function record(credits, note) {
    const o = read(), k = monthKey();
    o[k].spent += credits; o[k].pulls++; o[k].lastAt = Date.now();
    o[k].log.push({ at: Date.now(), credits, note });
    if (o[k].log.length > 200) o[k].log = o[k].log.slice(-200);
    write(o);
    return o[k];
  }

  function status(remainingHeader) {
    const o = read(), k = monthKey(), m = o[k];
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const frac = dayOfMonth / daysInMonth;
    /* Trust the API's own counter over the local ledger when we have it --
       the server is authoritative and the local ledger can drift. */
    const remaining = (remainingHeader !== null && remainingHeader !== undefined
                       && isFinite(Number(remainingHeader)))
      ? Number(remainingHeader) : Math.max(0, MONTHLY - m.spent);
    const spent = MONTHLY - remaining;
    const onPaceSpend = MONTHLY * frac;
    return {
      month: k, spent, remaining, pulls: m.pulls, lastAt: m.lastAt,
      daysLeft: daysInMonth - dayOfMonth,
      pace: spent - onPaceSpend,                 /* positive = ahead of budget */
      budgetPerDayLeft: (daysInMonth - dayOfMonth) > 0
        ? (remaining - RESERVE) / (daysInMonth - dayOfMonth) : (remaining - RESERVE),
      reserve: RESERVE, monthly: MONTHLY
    };
  }

  /* Should a paid pull happen right now? Returns a decision plus the reason,
     so the UI can explain a skip instead of looking broken. */
  function decide(opts) {
    const o = opts || {};
    const st = status(o.remainingHeader);
    const cost = o.cost || 3;
    if (st.remaining - cost < RESERVE) {
      return { spend:false, reason:'reserve', st,
        why: 'only ' + st.remaining + ' credits left and ' + RESERVE +
             ' are held in reserve — paid pulls paused until the month rolls over' };
    }
    /* Cooldown, like the other guards, throttles refreshes -- it must not
       block a cold start either. All three guards share one rule: they may
       stop the app spending money it does not need, never stop it working. */
    if (st.lastAt && (Date.now() - st.lastAt) < MIN_GAP_MIN * 60000 && o.haveUsableData) {
      return { spend:false, reason:'cooldown', st,
        why: 'a paid pull ran ' + Math.round((Date.now() - st.lastAt) / 60000) +
             'm ago and a usable pull is loaded; minimum gap is ' + MIN_GAP_MIN + 'm' };
    }
    /* The free scout decides. No games in the window, no spend. */
    const soon = o.gamesWithinH;
    if (soon !== undefined && soon !== null && soon <= 0 && o.haveUsableData) {
      return { spend:false, reason:'no_games', st,
        why: 'no games start within ' + VALUE_WINDOW_H + 'h (checked free via ESPN) and a ' +
             'usable pull is already loaded, so a paid pull would buy lines that move ' +
             'before they matter' };
    }
    /* The pace guard suppresses REFRESHES, never a first fetch.
       Applied unconditionally it starved the board: with nothing cached and
       the month running hot, the app fell back to a single free book and
       could not build a consensus at all -- a budget guard that breaks the
       product is worse than the overspend it prevents. So it only bites when
       usable data is already on screen. */
    if (st.pace > 80 && o.haveUsableData) {
      return { spend:false, reason:'ahead_of_pace', st,
        why: 'running ' + Math.round(st.pace) + ' credits ahead of an even monthly ' +
             'pace and a usable pull is already loaded; use Refresh odds to override' };
    }
    return { spend:true, reason:'ok', st,
      why: soon ? soon + ' game(s) inside the ' + VALUE_WINDOW_H + 'h window · ' +
                  st.remaining + ' credits left' : st.remaining + ' credits left' };
  }
  return { MONTHLY, RESERVE, VALUE_WINDOW_H, MIN_GAP_MIN,
           monthKey, read, record, status, decide };
})();
