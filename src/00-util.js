/* ---------------------------------------------------------------- L0 util */
VB.util = (function () {
  const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x;

  /* Every float comparison in this codebase goes through here. A raw ===
     on a computed float is a lint target: EV(0.55,2.00) is 0.10000000000000009,
     not 0.1, and kelly(0.70,2.00) is 0.3999999999999999, not 0.4. */
  const tolerantEq = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-12 : tol);

  /* mulberry32: 32-bit state, deterministic across V8 and browsers.
     Math.random is banned everywhere in this app -- reproducibility is a
     requirement, not a nicety, because the demo leaderboard must be stable. */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* xmur3: string -> uint32 seed, so each generation stage gets an
     independent stream. Keying a stream on a market id means regenerating
     one market does not shift every subsequent draw. */
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = h << 13 | h >>> 19;
    }
    return function () {
      h = Math.imul(h ^ h >>> 16, 2246822507);
      h = Math.imul(h ^ h >>> 13, 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }

  const gauss = (rng) => {                       /* Box-Muller */
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const logit = (p) => Math.log(p / (1 - p));
  const sig = (z) => 1 / (1 + Math.exp(-z));

  /* Abramowitz & Stegun 7.1.26 -- adequate for a risk display. */
  function erf(x) {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
                    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

  function cyrb53(str, seed) {
    let h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
    h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  return { clamp, tolerantEq, mulberry32, xmur3, gauss, logit, sig, erf, Phi, cyrb53 };
})();
