/* A single RAF-driven tween registry. Every sprite (card, chip stack, …) has
   at most one active tween, so competing animations can never fight over the
   same transform. Kept from the original engine, trimmed to 2D poses. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});
  const U = MBJ.utils;

  class Animator {
    constructor() {
      this.tweens = new Map();
      this._frame = null;
    }

    get size() {
      return this.tweens.size;
    }

    /**
     * Tween a sprite's pose ({x, y, rotation, scale, opacity, z}).
     * Resolves true when finished, false if cancelled.
     */
    tweenTo(sprite, target, options) {
      const opts = options || {};
      const duration = U.motionDuration(opts.duration == null ? 300 : opts.duration);
      const delay = U.prefersReducedMotion() ? 0 : opts.delay || 0;
      const from = Object.assign({}, sprite.pose, opts.from || {});
      const to = Object.assign({}, sprite.pose, target);

      this.cancel(sprite);
      if (opts.from) sprite.setPose(from);

      if (duration <= 1 && delay <= 0) {
        sprite.setPose(to);
        if (opts.onUpdate) opts.onUpdate(1, 1);
        return Promise.resolve(true);
      }

      return new Promise((resolve) => {
        this.tweens.set(sprite, {
          from,
          to,
          duration: Math.max(1, duration),
          ease: opts.ease || U.easeOutCubic,
          arc: U.prefersReducedMotion() ? 0 : opts.arc || 0,
          onUpdate: opts.onUpdate || null,
          start: performance.now() + delay,
          resolve,
        });
        this._ensureFrame();
      });
    }

    cancel(sprite) {
      const tween = this.tweens.get(sprite);
      if (!tween) return false;
      this.tweens.delete(sprite);
      tween.resolve(false);
      return true;
    }

    cancelAll() {
      for (const tween of this.tweens.values()) tween.resolve(false);
      this.tweens.clear();
      if (this._frame != null) {
        cancelAnimationFrame(this._frame);
        this._frame = null;
      }
    }

    _ensureFrame() {
      if (this._frame == null) this._frame = requestAnimationFrame(this._tick);
    }

    _tick = (now) => {
      this._frame = null;
      for (const [sprite, t] of this.tweens) {
        if (now < t.start) continue;
        const raw = U.clamp((now - t.start) / t.duration, 0, 1);
        const e = t.ease(raw);
        const f = t.from;
        const to = t.to;
        let y = f.y + (to.y - f.y) * e;
        if (t.arc) y -= Math.sin(Math.PI * raw) * t.arc;
        sprite.setPose({
          x: f.x + (to.x - f.x) * e,
          y,
          rotation: f.rotation + (to.rotation - f.rotation) * e,
          scale: f.scale + (to.scale - f.scale) * e,
          opacity: f.opacity + (to.opacity - f.opacity) * e,
          z: to.z,
        });
        if (t.onUpdate) t.onUpdate(raw, e);
        if (raw >= 1) {
          sprite.setPose(to);
          this.tweens.delete(sprite);
          t.resolve(true);
        }
      }
      if (this.tweens.size > 0) this._ensureFrame();
    };
  }

  MBJ.Animator = Animator;
})(typeof window !== "undefined" ? window : globalThis);
