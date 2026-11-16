/* Tiny synchronous event bus. The Blackjack engine broadcasts every state
   change without knowing anything about the scene, sounds or UI. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});

  class EventBus {
    constructor() {
      this._listeners = new Map();
    }

    on(eventName, handler) {
      if (!this._listeners.has(eventName)) this._listeners.set(eventName, new Set());
      this._listeners.get(eventName).add(handler);
      return () => this.off(eventName, handler);
    }

    once(eventName, handler) {
      const unsubscribe = this.on(eventName, (payload) => {
        unsubscribe();
        handler(payload);
      });
      return unsubscribe;
    }

    off(eventName, handler) {
      const listeners = this._listeners.get(eventName);
      if (!listeners) return;
      listeners.delete(handler);
      if (listeners.size === 0) this._listeners.delete(eventName);
    }

    emit(eventName, payload) {
      const deliver = (set) => {
        if (!set) return;
        for (const handler of Array.from(set)) {
          try {
            handler(payload, eventName);
          } catch (error) {
            // A broken listener must never corrupt the game state.
            console.error("[MBJack event]", eventName, error);
          }
        }
      };
      deliver(this._listeners.get(eventName));
      deliver(this._listeners.get("*"));
    }
  }

  MBJ.EventBus = EventBus;
})(typeof window !== "undefined" ? window : globalThis);
