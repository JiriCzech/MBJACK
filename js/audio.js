/* Optional synthesized saloon foley using Web Audio API.
   Zero external audio files; lazily unlocked on first user gesture and safe in
   headless environments. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});

  class SoundEffects {
    constructor() {
      this.muted = false;
      this._ctx = null;
      this._noiseBuffer = null;
    }

    unlock() {
      if (this.muted || this._ctx) return;
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      try {
        this._ctx = new Ctx();
        if (this._ctx.state === "suspended") this._ctx.resume().catch(() => {});
      } catch (_) {
        this._ctx = null;
      }
    }

    toggleMute() {
      this.muted = !this.muted;
      return this.muted;
    }

    _ready() {
      if (this.muted || !this._ctx) return null;
      if (this._ctx.state === "suspended") {
        this._ctx.resume().catch(() => {});
      }
      return this._ctx;
    }

    _noise(ctx) {
      if (this._noiseBuffer) return this._noiseBuffer;
      const len = Math.floor(ctx.sampleRate * 0.14);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
      this._noiseBuffer = buf;
      return buf;
    }

    card() {
      const ctx = this._ready();
      if (!ctx) return;
      try {
        const now = ctx.currentTime;
        const src = ctx.createBufferSource();
        src.buffer = this._noise(ctx);
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.setValueAtTime(1600, now);
        filter.frequency.exponentialRampToValueAtTime(900, now + 0.08);
        filter.Q.value = 1.4;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.09, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        src.connect(filter).connect(gain).connect(ctx.destination);
        src.start(now);
        src.stop(now + 0.1);
      } catch (_) {}
    }

    chip() {
      const ctx = this._ready();
      if (!ctx) return;
      try {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc2.type = "sine";
        osc.frequency.setValueAtTime(2450, now);
        osc.frequency.exponentialRampToValueAtTime(1800, now + 0.035);
        osc2.frequency.setValueAtTime(3650, now);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
        osc.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc2.start(now);
        osc.stop(now + 0.05);
        osc2.stop(now + 0.05);
      } catch (_) {}
    }

    win(blackjack) {
      const ctx = this._ready();
      if (!ctx) return;
      try {
        const notes = blackjack ? [523.25, 659.25, 783.99, 1046.5] : [523.25, 659.25, 783.99];
        const now = ctx.currentTime;
        notes.forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "triangle";
          const t = now + i * 0.065;
          osc.frequency.setValueAtTime(freq, t);
          gain.gain.setValueAtTime(0.001, t);
          gain.gain.linearRampToValueAtTime(0.065, t + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 0.26);
        });
      } catch (_) {}
    }

    bust() {
      const ctx = this._ready();
      if (!ctx) return;
      try {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(185, now);
        osc.frequency.exponentialRampToValueAtTime(98, now + 0.16);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.19);
      } catch (_) {}
    }
  }

  MBJ.SoundEffects = SoundEffects;
})(typeof window !== "undefined" ? window : globalThis);
