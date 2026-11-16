/* Small dependency-free helpers shared by the engine and the scene. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});
  const U = (MBJ.utils = {});

  U.clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
  U.lerp = (a, b, t) => a + (b - a) * t;

  U.easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  U.easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  U.easeOutBack = (t) => {
    const c1 = 1.4;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  };

  U.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  U.prefersReducedMotion = function prefersReducedMotion() {
    return Boolean(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
  };

  U.motionDuration = (ms) => (U.prefersReducedMotion() ? Math.min(ms, 80) : ms);

  /** Deterministic PRNG – used by tests and for reproducible shoes. */
  U.mulberry32 = function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /** Cryptographically strong, unbiased random in [0, 1) when available. */
  U.secureRandom = function secureRandom() {
    const c = global.crypto;
    if (c && typeof c.getRandomValues === "function") {
      const buf = new Uint32Array(1);
      c.getRandomValues(buf);
      return buf[0] / 4294967296;
    }
    return Math.random();
  };

  /** In-place Fisher–Yates shuffle. */
  U.shuffle = function shuffle(array, random) {
    const rnd = random || U.secureRandom;
    for (let i = array.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = array[i];
      array[i] = array[j];
      array[j] = tmp;
    }
    return array;
  };

  /** Money is stored as integer cents to keep 3:2 payouts exact. */
  U.formatMoney = function formatMoney(cents) {
    const negative = cents < 0;
    const abs = Math.abs(Math.round(cents));
    const dollars = Math.floor(abs / 100);
    const rest = abs % 100;
    const whole = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    const text = rest ? `${whole},${String(rest).padStart(2, "0")}` : whole;
    return (negative ? "-" : "") + "$" + text;
  };
})(typeof window !== "undefined" ? window : globalThis);
