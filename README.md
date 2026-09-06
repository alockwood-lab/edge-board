# Edge Board

A live sports-betting value board. One self-contained HTML file, opened from
`file://`. No build step, no server, no external requests at runtime.

    open edge-board.html

## What it does

Pulls live odds from multiple sportsbooks, builds a de-vigged consensus fair
price anchored on sharp references, and answers one question per market: is
there a bet here, and if not, what price would make it one.

Click a game and you get the answer first:

    NO BET   away is worth -165; best available is -164 at Matchbook

    The 20 books quoting this market agree closely. The nearest thing to value
    is away at -164 (Matchbook), 0.16pp better than the consensus fair price of
    -165. You would need -165 or better to have an edge.

               FAIR    BEST AVAILABLE        EDGE
    away       -165    -164  Matchbook       +0.16pp
    home       +165    +160  Unibet SE       -0.74pp

    20 books · average hold 4.42% · best-price hold 0.57% · shopping saves 3.85pp

The evidence — all 20 book prices, the four de-vig methods, the error budget,
the sizing chain — collapses behind that. Available, not in the way.

## Data sources

Probed from a real browser, not inferred from response headers. `curl` does not
enforce CORS, so a permissive header proves nothing about what a page can read.

| Source | Key | Reachable from `file://` | Notes |
|---|---|---|---|
| The Odds API | yes, free tier | yes | 20+ books incl. Pinnacle, Betfair, Matchbook. The only source that can build a consensus. |
| ESPN (`cdn.espn.com`) | no | yes | Real games and real DraftKings prices, free. `site.api.espn.com` looks callable and is NOT — it fails in-browser from both `file://` and `localhost`. |
| Polymarket | no | yes | Order book used as a fair-value reference. |
| Kalshi | — | **no** | 403 with zero CORS headers. |
| Retail books direct | — | **no** | WAF-blocked (DraftKings 403, FanDuel 500, BetMGM 301). |
| Pinnacle direct | — | **no** | HTTP 451 from a US IP. Reachable only through the aggregator. |

## Credit strategy

The free tier is 500 credits a month against 730 hours. Spread evenly that is
0.68 an hour, which is both unspendable and useless — odds only matter near
kickoff and there are no games at 4am. So the policy is an allocation:

- **Scout free first.** ESPN and Polymarket cost nothing and refresh every 3
  minutes. They answer whether games exist and when they start, which is the
  only thing that decides whether a paid pull is worth it.
- **Buy the reference, not retail.** `regions=eu` returns 21 books including
  Pinnacle, Betfair and Matchbook for **3 credits**. Adding `us` costs another
  3 and mostly duplicates DraftKings, which ESPN gives away. 166 league-pulls a
  month instead of 83.
- **Spend inside a 14h window**, hold 60 credits in reserve, 12-minute cooldown.
- **Guards throttle refreshes, never a cold start.** A budget guard that stops
  the product working is worse than the overspend it prevents.

## The method

| | |
|---|---|
| De-vig | median of multiplicative / additive / power / Shin, per venue per market |
| Consensus | weighted log-linear pool in logit space, leave-one-**cluster**-out |
| Clusters | corporate and feed lineage share one vote — Flutter owns FanDuel and Betfair |
| Edge | consensus fair minus the **raw offered** implied probability |
| Error budget | sampling SE + de-vig bias floor + staleness term |
| Multiplicity | `e_crit = SE · a(M)`, no toggle |
| Stake | `λ · R · Kelly`, R = 0.35 read-only, λ = 0.25 |

13 gates must pass for a BET. Verdict precedence:
`NO PRICE → SUSPECT → AGED → LIMITED → PASS → THIN → BET`.

## Setup

The API key is **not** in this repo. Paste it once in **Settings → Live data →
The Odds API** and hit **Validate key** first — that call costs zero credits.
It persists in browser localStorage under `vb.keys`.

Free key: <https://the-odds-api.com> → "Get API Key".

## Development

    node selftest.mjs     # 29 assertions, static lints, and a real browser boot
    ./build.sh            # concatenate src/ into edge-board.html

The suite parses every shipped script region and boots the file in headless
Chrome, requiring `data-vb-boot="ok"`. It also fails if any module under `src/`
defining a `VB.*` namespace is missing from the build — both checks exist
because real bugs shipped past a green suite without them.

## Honest limitations

- It contains no information about the games. Every edge is a claim that one
  book has not caught up to the market — a latency claim, not knowledge.
- EV is modelled, never realised.
- Measured on a full NFL + CFB slate across 20+ books with Pinnacle anchoring:
  the best edge was **0.53pp against a 1.85pp noise line**, and 5 of 782
  sharp-anchored rows had positive EV. Main markets are efficient. The app
  working correctly usually means it says "no bet".
- No same-game-parlay or parlay EV, ever. There is no cross-venue consensus on
  a joint distribution, so there is no fair line to compare against.
- Limits and bans are the real constraint, not the math.
