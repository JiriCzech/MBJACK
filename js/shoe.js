/* Playing cards and the multi-deck shoe. Pure data, no DOM. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});
  const U = MBJ.utils;

  const SUITS = Object.freeze(["S", "H", "D", "C"]);
  const RANKS = Object.freeze(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]);

  class Shoe {
    /**
     * @param {{decks?: number, penetration?: number, random?: () => number}} options
     */
    constructor(options) {
      const opts = options || {};
      this.decks = Math.max(1, opts.decks | 0 || 6);
      this.penetration = U.clamp(opts.penetration || 0.75, 0.2, 0.95);
      this.random = opts.random || U.secureRandom;
      this.cards = [];
      this.discards = [];
      this.total = this.decks * 52;
      this.cutIndex = 0;
      this.dealt = 0;
      this.shuffles = 0;
      this._serial = 1;
      this._build();
      this.shuffle();
    }

    _build() {
      this.cards = [];
      for (let d = 0; d < this.decks; d += 1) {
        for (const suit of SUITS) {
          for (const rank of RANKS) {
            this.cards.push(Object.freeze({ id: "c" + this._serial++, rank, suit }));
          }
        }
      }
    }

    /** Collect every card that is not on the table and shuffle a fresh shoe. */
    shuffle() {
      if (this.discards.length) {
        this.cards.push(...this.discards);
        this.discards = [];
      }
      U.shuffle(this.cards, this.random);
      this.dealt = 0;
      // Cut card position measured from the top of the shoe; a small random
      // jitter mimics a human placing the plastic cut card.
      const jitter = Math.floor(this.random() * Math.max(1, this.decks * 4)) - this.decks * 2;
      this.cutIndex = U.clamp(Math.floor(this.cards.length * this.penetration) + jitter, 10, this.cards.length - 1);
      this.shuffles += 1;
    }

    /** True once the cut card has come out – reshuffle before the next round. */
    needsShuffle() {
      return this.dealt >= this.cutIndex;
    }

    get remaining() {
      return this.cards.length;
    }

    /** Draw the next card. Never fails: an exhausted shoe recycles its discards. */
    draw() {
      if (this.cards.length === 0) {
        if (this.discards.length === 0) throw new Error("Shoe is completely empty");
        this.shuffle();
        this.reshuffledMidRound = true;
      }
      this.dealt += 1;
      return this.cards.pop();
    }

    discard(cards) {
      for (const card of cards) this.discards.push(card);
    }
  }

  MBJ.SUITS = SUITS;
  MBJ.RANKS = RANKS;
  MBJ.Shoe = Shoe;
})(typeof window !== "undefined" ? window : globalThis);
