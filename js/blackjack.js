/* MB Jack – authoritative Blackjack engine.
   Synchronous, DOM-free state machine. Every public action is validated,
   mutates the state atomically and broadcasts events on the bus. The scene
   replays those events with animations; it never mutates game state.

   Phases:  betting → (insurance) → playerTurn → dealerTurn → roundOver → betting
*/
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});
  const H = MBJ.Hand;

  const PHASE = Object.freeze({
    BETTING: "betting",
    INSURANCE: "insurance",
    PLAYER: "playerTurn",
    DEALER: "dealerTurn",
    ROUND_OVER: "roundOver",
  });

  /** Allowed phase transitions – anything else is a bug and throws. */
  const TRANSITIONS = Object.freeze({
    betting: ["insurance", "playerTurn", "roundOver"],
    insurance: ["playerTurn", "roundOver"],
    playerTurn: ["dealerTurn"],
    dealerTurn: ["roundOver"],
    roundOver: ["betting"],
  });

  const isTenValue = (card) => H.cardValue(card) === 10;

  class BlackjackEngine {
    /**
     * @param {{rules?: object, bus?: MBJ.EventBus, random?: () => number, bankroll?: number}} options
     */
    constructor(options) {
      const opts = options || {};
      this.rules = Object.assign({}, MBJ.RULES, opts.rules || {});
      this.bus = opts.bus || new MBJ.EventBus();
      this.shoe = new MBJ.Shoe({
        decks: this.rules.decks,
        penetration: this.rules.penetration,
        random: opts.random,
      });
      const seatBankrolls = Array.isArray(opts.seatBankrolls)
        ? opts.seatBankrolls.slice(0, this.rules.seats).map((b) => Math.max(0, Math.round(b || 0)))
        : null;
      const initialBankroll = seatBankrolls
        ? seatBankrolls.reduce((sum, b) => sum + b, 0)
        : Number.isFinite(opts.bankroll)
          ? Math.max(0, Math.round(opts.bankroll))
          : this.rules.startingBankroll;

      this._busy = false;
      this._handSerial = 0;
      this.state = {
        phase: PHASE.BETTING,
        round: 0,
        bankroll: initialBankroll,
        seatBankrolls,
        seatBets: new Array(this.rules.seats).fill(0),
        lastBets: new Array(this.rules.seats).fill(0),
        hands: [],
        activeIndex: -1,
        dealer: { cards: [], holeRevealed: false },
        lastResult: null,
      };
    }

    on(eventName, handler) {
      return this.bus.on(eventName, handler);
    }

    /* ============================ queries ============================== */

    get phase() {
      return this.state.phase;
    }

    get bankroll() {
      return this.state.bankroll;
    }

    bankrollForSeat(seat) {
      const s = this.state;
      if (s.seatBankrolls && Number.isInteger(seat) && seat >= 0 && seat < s.seatBankrolls.length) {
        return s.seatBankrolls[seat];
      }
      return s.bankroll;
    }

    setSeatBankroll(seat, amount) {
      return this._run("setSeatBankroll", () => {
        const s = this.state;
        if (!s.seatBankrolls) return this._reject("setSeatBankroll", "single-bankroll");
        if (!Number.isInteger(seat) || seat < 0 || seat >= this.rules.seats) return this._reject("setSeatBankroll", "bad-seat");
        s.seatBankrolls[seat] = Math.max(0, Math.round(amount || 0));
        s.bankroll = s.seatBankrolls.reduce((sum, b) => sum + b, 0);
        return { ok: true, bankroll: s.seatBankrolls[seat] };
      });
    }

    _addBankroll(seat, delta) {
      const s = this.state;
      if (s.seatBankrolls) {
        s.seatBankrolls[seat] = Math.max(0, Math.round((s.seatBankrolls[seat] || 0) + delta));
        s.bankroll = s.seatBankrolls.reduce((sum, b) => sum + b, 0);
      } else {
        s.bankroll += delta;
      }
    }

    get activeHand() {
      const s = this.state;
      return s.activeIndex >= 0 ? s.hands[s.activeIndex] || null : null;
    }

    totalSeatBets() {
      return this.state.seatBets.reduce((sum, bet) => sum + bet, 0);
    }

    /** Money currently committed on the table (bets + doubles + insurance). */
    moneyOnTable() {
      const s = this.state;
      if (s.phase === PHASE.BETTING) return this.totalSeatBets();
      if (s.phase === PHASE.ROUND_OVER) return 0;
      return s.hands.reduce((sum, hand) => sum + hand.bet + hand.insurance, 0);
    }

    isBroke(seat) {
      const s = this.state;
      if (s.seatBankrolls && Number.isInteger(seat)) {
        return s.phase === PHASE.BETTING && (s.seatBets[seat] || 0) === 0 && this.bankrollForSeat(seat) < this.rules.minBet;
      }
      return (
        s.phase === PHASE.BETTING &&
        this.totalSeatBets() === 0 &&
        s.bankroll < this.rules.minBet
      );
    }

    canBet(seat, amount) {
      const s = this.state;
      if (s.phase !== PHASE.BETTING) return { ok: false, reason: "not-betting" };
      if (!Number.isInteger(seat) || seat < 0 || seat >= this.rules.seats) return { ok: false, reason: "bad-seat" };
      if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: "bad-amount" };
      if (amount > this.bankrollForSeat(seat)) return { ok: false, reason: "insufficient-funds" };
      if (s.seatBets[seat] + amount > this.rules.maxBet) return { ok: false, reason: "max-bet" };
      return { ok: true };
    }

    canDeal() {
      const bets = this.state.seatBets;
      return (
        this.state.phase === PHASE.BETTING &&
        bets.some((bet) => bet > 0) &&
        bets.every((bet) => bet === 0 || (bet >= this.rules.minBet && bet <= this.rules.maxBet))
      );
    }

    canRebet(seat) {
      const s = this.state;
      if (s.seatBankrolls && Number.isInteger(seat)) {
        const last = s.lastBets[seat] || 0;
        return s.phase === PHASE.BETTING && last > 0 && last <= this.bankrollForSeat(seat) + (s.seatBets[seat] || 0);
      }
      const total = s.lastBets.reduce((sum, bet) => sum + bet, 0);
      return s.phase === PHASE.BETTING && total > 0 && total <= s.bankroll + this.totalSeatBets();
    }

    _canDouble(hand) {
      const r = this.rules;
      if (!hand || hand.status !== "playing" || hand.cards.length !== 2) return false;
      if (hand.splitAces) return false;
      if (hand.fromSplit && !r.doubleAfterSplit) return false;
      if (this.bankrollForSeat(hand.seat) < hand.bet) return false;
      if (!r.doubleOnAnyTwo) {
        const ev = H.evaluate(hand.cards);
        if (ev.soft || ev.total < 9 || ev.total > 11) return false;
      }
      return true;
    }

    _canSplit(hand) {
      const r = this.rules;
      if (!hand || hand.status !== "playing" || hand.cards.length !== 2) return false;
      if (!H.isPair(hand.cards, r.splitByValue)) return false;
      if (this.bankrollForSeat(hand.seat) < hand.bet) return false;
      const seatHands = this.state.hands.filter((h) => h.seat === hand.seat).length;
      if (seatHands >= r.maxHandsPerSeat) return false;
      if (hand.splitAces && !r.resplitAces) return false;
      return true;
    }

    _canSurrender(hand) {
      if (!this.rules.surrender) return false;
      if (!hand || hand.status !== "playing" || hand.cards.length !== 2) return false;
      if (hand.fromSplit) return false;
      return true;
    }

    /** Everything the UI is allowed to offer right now (optionally scoped to `forSeat`). */
    getAvailableActions(forSeat) {
      const s = this.state;
      const hand = this.activeHand;
      const scoped = Number.isInteger(forSeat);
      const a = {
        bet: s.phase === PHASE.BETTING,
        clearBets: s.phase === PHASE.BETTING && (scoped ? (s.seatBets[forSeat] || 0) > 0 : this.totalSeatBets() > 0),
        rebet: (scoped ? this.canRebet(forSeat) && (s.seatBets[forSeat] || 0) === 0 : this.canRebet() && this.totalSeatBets() === 0),
        deal: this.canDeal(),
        rebuy: scoped ? this.isBroke(forSeat) : this.isBroke(),
        insurance: false,
        hit: false,
        stand: false,
        double: false,
        split: false,
        surrender: false,
        newRound: s.phase === PHASE.ROUND_OVER,
      };
      const isMyHand = !scoped || (hand && hand.seat === forSeat);
      if (s.phase === PHASE.INSURANCE && hand && isMyHand) {
        a.insurance = true;
        a.insuranceAffordable = this.bankrollForSeat(hand.seat) >= this._insuranceCost(hand);
      }
      if (s.phase === PHASE.PLAYER && hand && hand.status === "playing" && isMyHand) {
        const lockedAces = hand.splitAces && this.rules.splitAcesOneCard;
        a.hit = !lockedAces;
        a.stand = true;
        a.double = !lockedAces && this._canDouble(hand);
        a.split = this._canSplit(hand);
        a.surrender = !lockedAces && this._canSurrender(hand);
      }
      return a;
    }

    /** Plain JSON copy of the state, safe to hand to the UI or tests. */
    getSnapshot() {
      const s = this.state;
      return JSON.parse(
        JSON.stringify({
          phase: s.phase,
          round: s.round,
          bankroll: s.bankroll,
          seatBankrolls: s.seatBankrolls,
          seatBets: s.seatBets,
          lastBets: s.lastBets,
          activeIndex: s.activeIndex,
          activeHandId: this.activeHand ? this.activeHand.id : null,
          hands: s.hands,
          dealer: {
            holeRevealed: s.dealer.holeRevealed,
            cards: s.dealer.cards.map((card, i) => (i === 1 && !s.dealer.holeRevealed ? null : card)),
          },
          shoe: { remaining: this.shoe.remaining, needsShuffle: this.shoe.needsShuffle() },
          lastResult: s.lastResult,
        })
      );
    }

    exportEngineState() {
      const s = this.state;
      return JSON.parse(
        JSON.stringify({
          handSerial: this._handSerial,
          state: {
            phase: s.phase,
            round: s.round,
            bankroll: s.bankroll,
            seatBankrolls: s.seatBankrolls,
            seatBets: s.seatBets,
            lastBets: s.lastBets,
            hands: s.hands,
            activeIndex: s.activeIndex,
            dealer: s.dealer,
            lastResult: s.lastResult,
          },
          shoe: this.shoe.exportState(),
        })
      );
    }

    importEngineState(snap) {
      if (!snap || !snap.state) return;
      this._handSerial = snap.handSerial || 0;
      const st = snap.state;
      this.state = {
        phase: st.phase || PHASE.BETTING,
        round: st.round || 0,
        bankroll: st.bankroll || 0,
        seatBankrolls: Array.isArray(st.seatBankrolls) ? st.seatBankrolls.slice() : null,
        seatBets: Array.isArray(st.seatBets) ? st.seatBets.slice() : new Array(this.rules.seats).fill(0),
        lastBets: Array.isArray(st.lastBets) ? st.lastBets.slice() : new Array(this.rules.seats).fill(0),
        hands: Array.isArray(st.hands) ? JSON.parse(JSON.stringify(st.hands)) : [],
        activeIndex: Number.isInteger(st.activeIndex) ? st.activeIndex : -1,
        dealer: st.dealer ? JSON.parse(JSON.stringify(st.dealer)) : { cards: [], holeRevealed: false },
        lastResult: st.lastResult ? JSON.parse(JSON.stringify(st.lastResult)) : null,
      };
      if (snap.shoe) this.shoe.importState(snap.shoe);
    }

    /* ============================ internals ============================ */

    _emit(name, payload) {
      this.bus.emit(name, payload || {});
    }

    _reject(action, reason) {
      this._emit("action:rejected", { action, reason });
      return { ok: false, reason };
    }

    _setPhase(next) {
      const prev = this.state.phase;
      if (prev === next) return;
      if (!TRANSITIONS[prev] || !TRANSITIONS[prev].includes(next)) {
        throw new Error(`Illegal phase transition ${prev} → ${next}`);
      }
      this.state.phase = next;
      this._emit("phase:changed", { from: prev, to: next });
    }

    /** Run a mutating action atomically and refuse re-entrant calls from listeners. */
    _run(action, fn) {
      if (this._busy) return this._reject(action, "busy");
      this._busy = true;
      try {
        const result = fn();
        return result || { ok: true };
      } finally {
        this._busy = false;
      }
    }

    _handSummary(hand) {
      const ev = H.evaluate(hand.cards);
      return {
        total: ev.total,
        soft: ev.soft,
        bust: ev.bust,
        blackjack: ev.natural && !hand.fromSplit,
        label: ev.natural && hand.fromSplit ? "21" : H.label(hand.cards),
      };
    }

    _dealerVisibleCards() {
      const d = this.state.dealer;
      return d.holeRevealed ? d.cards : d.cards.slice(0, 1);
    }

    _dealToHand(hand) {
      const card = this.shoe.draw();
      hand.cards.push(card);
      this._emit("card:dealt", {
        target: "player",
        handId: hand.id,
        seat: hand.seat,
        card,
        faceUp: true,
        cardIndex: hand.cards.length - 1,
        summary: this._handSummary(hand),
      });
      return card;
    }

    _dealToDealer(faceUp) {
      const d = this.state.dealer;
      const card = this.shoe.draw();
      d.cards.push(card);
      const visible = this._dealerVisibleCards();
      this._emit("card:dealt", {
        target: "dealer",
        card: faceUp ? card : null,
        faceUp,
        cardIndex: d.cards.length - 1,
        summary: { total: H.evaluate(visible).total, label: H.label(visible) },
      });
      return card;
    }

    _insuranceCost(hand) {
      return Math.floor(hand.bet / 2);
    }

    /* ============================= betting ============================= */

    placeBet(seat, amount) {
      return this._run("bet", () => {
        const check = this.canBet(seat, amount);
        if (!check.ok) return this._reject("bet", check.reason);
        const s = this.state;
        this._addBankroll(seat, -amount);
        s.seatBets[seat] += amount;
        this._emit("bet:changed", {
          seat,
          bet: s.seatBets[seat],
          delta: amount,
          bankroll: this.bankrollForSeat(seat),
          seatBankrolls: s.seatBankrolls ? s.seatBankrolls.slice() : null,
        });
        return { ok: true, bet: s.seatBets[seat] };
      });
    }

    /** Take every chip off one seat (or the last chip value if `amount` given). */
    removeBet(seat, amount) {
      return this._run("removeBet", () => {
        const s = this.state;
        if (s.phase !== PHASE.BETTING) return this._reject("removeBet", "not-betting");
        if (!Number.isInteger(seat) || seat < 0 || seat >= this.rules.seats) return this._reject("removeBet", "bad-seat");
        const current = s.seatBets[seat];
        if (current <= 0) return this._reject("removeBet", "no-bet");
        const take = Number.isInteger(amount) && amount > 0 ? Math.min(amount, current) : current;
        s.seatBets[seat] -= take;
        this._addBankroll(seat, take);
        this._emit("bet:changed", {
          seat,
          bet: s.seatBets[seat],
          delta: -take,
          bankroll: this.bankrollForSeat(seat),
          seatBankrolls: s.seatBankrolls ? s.seatBankrolls.slice() : null,
        });
        return { ok: true, bet: s.seatBets[seat] };
      });
    }

    clearBets(onlySeat) {
      return this._run("clearBets", () => {
        const s = this.state;
        if (s.phase !== PHASE.BETTING) return this._reject("clearBets", "not-betting");
        const scoped = Number.isInteger(onlySeat);
        for (let seat = 0; seat < s.seatBets.length; seat += 1) {
          if (scoped && seat !== onlySeat) continue;
          const bet = s.seatBets[seat];
          if (!bet) continue;
          s.seatBets[seat] = 0;
          this._addBankroll(seat, bet);
          this._emit("bet:changed", {
            seat,
            bet: 0,
            delta: -bet,
            bankroll: this.bankrollForSeat(seat),
            seatBankrolls: s.seatBankrolls ? s.seatBankrolls.slice() : null,
          });
        }
        return { ok: true };
      });
    }

    /** Repeat the previous round's bets on the same seats. */
    rebet(onlySeat) {
      return this._run("rebet", () => {
        const s = this.state;
        const scoped = Number.isInteger(onlySeat);
        if (!this.canRebet(scoped ? onlySeat : undefined)) return this._reject("rebet", "cannot-rebet");
        for (let seat = 0; seat < s.seatBets.length; seat += 1) {
          if (scoped && seat !== onlySeat) continue;
          const target = s.lastBets[seat];
          const delta = target - s.seatBets[seat];
          if (delta === 0) continue;
          s.seatBets[seat] = target;
          this._addBankroll(seat, -delta);
          this._emit("bet:changed", {
            seat,
            bet: target,
            delta,
            bankroll: this.bankrollForSeat(seat),
            seatBankrolls: s.seatBankrolls ? s.seatBankrolls.slice() : null,
          });
        }
        return { ok: true };
      });
    }

    /** Fresh bankroll for a player who has run out of chips. */
    rebuy(seat) {
      return this._run("rebuy", () => {
        const s = this.state;
        if (s.seatBankrolls && Number.isInteger(seat)) {
          if (!this.isBroke(seat)) return this._reject("rebuy", "not-broke");
          s.seatBankrolls[seat] = this.rules.startingBankroll;
          s.bankroll = s.seatBankrolls.reduce((sum, b) => sum + b, 0);
          this._emit("bankroll:rebuy", {
            seat,
            bankroll: s.seatBankrolls[seat],
            seatBankrolls: s.seatBankrolls.slice(),
          });
          return { ok: true };
        }
        if (!this.isBroke()) return this._reject("rebuy", "not-broke");
        s.bankroll = this.rules.startingBankroll;
        this._emit("bankroll:rebuy", { bankroll: s.bankroll });
        return { ok: true };
      });
    }

    /* ============================== deal =============================== */

    deal() {
      return this._run("deal", () => {
        if (!this.canDeal()) return this._reject("deal", this.state.phase !== PHASE.BETTING ? "not-betting" : "no-bets");
        const s = this.state;

        if (this.shoe.needsShuffle()) {
          this.shoe.shuffle();
          this._emit("shoe:shuffled", { remaining: this.shoe.remaining });
        }

        s.round += 1;
        s.lastBets = s.seatBets.slice();
        s.hands = [];
        s.dealer = { cards: [], holeRevealed: false };
        s.activeIndex = -1;
        s.lastResult = null;
        this.shoe.reshuffledMidRound = false;

        for (let seat = 0; seat < s.seatBets.length; seat += 1) {
          if (s.seatBets[seat] > 0) s.hands.push(this._newHand(seat, s.seatBets[seat], []));
        }
        s.seatBets = s.seatBets.map(() => 0);

        this._emit("round:started", {
          round: s.round,
          hands: s.hands.map((h) => ({ id: h.id, seat: h.seat, bet: h.bet })),
          bankroll: s.bankroll,
          seatBankrolls: s.seatBankrolls ? s.seatBankrolls.slice() : null,
        });

        // Two passes, left to right, dealer last; dealer's second card face down.
        for (let pass = 0; pass < 2; pass += 1) {
          for (const hand of s.hands) this._dealToHand(hand);
          this._dealToDealer(pass === 0);
        }

        const up = s.dealer.cards[0];
        if (this.rules.insurance && up.rank === "A") {
          this._setPhase(PHASE.INSURANCE);
          s.activeIndex = 0;
          this._emit("insurance:offered", { handId: s.hands[0].id, cost: this._insuranceCost(s.hands[0]) });
          return { ok: true };
        }
        this._afterInsurance();
        return { ok: true };
      });
    }

    _newHand(seat, bet, cards) {
      this._handSerial += 1;
      return {
        id: `R${this.state.round}-H${this._handSerial}`,
        seat,
        cards,
        bet,
        insurance: 0,
        doubled: false,
        fromSplit: false,
        splitAces: false,
        status: "playing", // playing | stood | bust | blackjack
        result: null, // blackjack | win | push | lose | bust
        payout: 0,
      };
    }

    /* ============================ insurance ============================ */

    insurance(take) {
      return this._run("insurance", () => {
        const s = this.state;
        if (s.phase !== PHASE.INSURANCE) return this._reject("insurance", "not-offered");
        const hand = this.activeHand;
        if (!hand) return this._reject("insurance", "no-hand");
        if (take) {
          const cost = this._insuranceCost(hand);
          if (cost <= 0 || this.bankrollForSeat(hand.seat) < cost) return this._reject("insurance", "insufficient-funds");
          this._addBankroll(hand.seat, -cost);
          hand.insurance = cost;
        }
        this._emit("insurance:decided", {
          handId: hand.id,
          seat: hand.seat,
          amount: hand.insurance,
          bankroll: this.bankrollForSeat(hand.seat),
          seatBankrolls: s.seatBankrolls ? s.seatBankrolls.slice() : null,
        });

        if (s.activeIndex < s.hands.length - 1) {
          s.activeIndex += 1;
          const next = this.activeHand;
          this._emit("insurance:offered", { handId: next.id, cost: this._insuranceCost(next) });
        } else {
          s.activeIndex = -1;
          this._afterInsurance();
        }
        return { ok: true };
      });
    }

    /** Dealer peek, then hand the turn to the first player hand. */
    _afterInsurance() {
      const s = this.state;
      const up = s.dealer.cards[0];
      const canPeek = this.rules.dealerPeeks && (up.rank === "A" || isTenValue(up));
      if (canPeek) {
        const dealerBJ = H.evaluate(s.dealer.cards).natural;
        this._emit("dealer:peek", { blackjack: dealerBJ });
        if (dealerBJ) {
          this._revealHole();
          this._settle();
          return;
        }
        for (const hand of s.hands) {
          if (hand.insurance > 0) {
            this._emit("insurance:lost", { handId: hand.id, seat: hand.seat, amount: hand.insurance });
          }
        }
      }
      this._setPhase(PHASE.PLAYER);
      this._continueFrom(0);
    }

    /* =========================== player turn =========================== */

    /**
     * Find the next hand that needs a decision, starting at `index`.
     * Split hands receive their second card here; naturals, split Aces and
     * 21s resolve automatically. When nobody is left, the dealer plays.
     */
    _continueFrom(index) {
      const s = this.state;
      for (let i = index; i < s.hands.length; i += 1) {
        const hand = s.hands[i];
        if (hand.status !== "playing") continue;
        s.activeIndex = i;

        if (hand.cards.length === 1) {
          this._emit("turn:changed", { handId: hand.id, seat: hand.seat, index: i, splitDraw: true });
          this._dealToHand(hand);
        }

        const ev = H.evaluate(hand.cards);
        if (ev.natural && !hand.fromSplit) {
          hand.status = "blackjack";
          this._emit("hand:blackjack", { handId: hand.id, seat: hand.seat });
          continue;
        }
        if (hand.splitAces && this.rules.splitAcesOneCard) {
          const mayResplit = this._canSplit(hand);
          if (!mayResplit) {
            hand.status = "stood";
            this._emit("hand:stood", { handId: hand.id, seat: hand.seat, auto: true, summary: this._handSummary(hand) });
            continue;
          }
        }
        if (ev.total === 21 && this.rules.autoStandOn21) {
          hand.status = "stood";
          this._emit("hand:stood", { handId: hand.id, seat: hand.seat, auto: true, summary: this._handSummary(hand) });
          continue;
        }
        this._emit("turn:changed", { handId: hand.id, seat: hand.seat, index: i, actions: this.getAvailableActions() });
        return;
      }
      s.activeIndex = -1;
      this._dealerTurn();
    }

    _requireTurn(action) {
      const s = this.state;
      if (s.phase !== PHASE.PLAYER) return { error: this._reject(action, "not-player-turn") };
      const hand = this.activeHand;
      if (!hand || hand.status !== "playing") return { error: this._reject(action, "no-active-hand") };
      return { hand };
    }

    hit() {
      return this._run("hit", () => {
        const { hand, error } = this._requireTurn("hit");
        if (error) return error;
        if (!this.getAvailableActions().hit) return this._reject("hit", "not-allowed");
        this._dealToHand(hand);
        const ev = H.evaluate(hand.cards);
        if (ev.bust) {
          hand.status = "bust";
          this._emit("hand:bust", { handId: hand.id, seat: hand.seat, summary: this._handSummary(hand) });
          this._continueFrom(this.state.activeIndex + 1);
        } else if (ev.total === 21 && this.rules.autoStandOn21) {
          hand.status = "stood";
          this._emit("hand:stood", { handId: hand.id, seat: hand.seat, auto: true, summary: this._handSummary(hand) });
          this._continueFrom(this.state.activeIndex + 1);
        } else {
          this._emit("turn:changed", { handId: hand.id, seat: hand.seat, index: this.state.activeIndex, actions: this.getAvailableActions() });
        }
        return { ok: true };
      });
    }

    stand() {
      return this._run("stand", () => {
        const { hand, error } = this._requireTurn("stand");
        if (error) return error;
        hand.status = "stood";
        this._emit("hand:stood", { handId: hand.id, seat: hand.seat, auto: false, summary: this._handSummary(hand) });
        this._continueFrom(this.state.activeIndex + 1);
        return { ok: true };
      });
    }

    double() {
      return this._run("double", () => {
        const { hand, error } = this._requireTurn("double");
        if (error) return error;
        if (!this._canDouble(hand)) return this._reject("double", "not-allowed");
        const s = this.state;
        this._addBankroll(hand.seat, -hand.bet);
        const extra = hand.bet;
        hand.bet *= 2;
        hand.doubled = true;
        this._emit("hand:doubled", {
          handId: hand.id,
          seat: hand.seat,
          extra,
          bet: hand.bet,
          bankroll: this.bankrollForSeat(hand.seat),
          seatBankrolls: s.seatBankrolls ? s.seatBankrolls.slice() : null,
        });
        this._dealToHand(hand);
        const ev = H.evaluate(hand.cards);
        if (ev.bust) {
          hand.status = "bust";
          this._emit("hand:bust", { handId: hand.id, seat: hand.seat, summary: this._handSummary(hand) });
        } else {
          hand.status = "stood";
          this._emit("hand:stood", { handId: hand.id, seat: hand.seat, auto: true, summary: this._handSummary(hand) });
        }
        this._continueFrom(s.activeIndex + 1);
        return { ok: true };
      });
    }

    split() {
      return this._run("split", () => {
        const { hand, error } = this._requireTurn("split");
        if (error) return error;
        if (!this._canSplit(hand)) return this._reject("split", "not-allowed");
        const s = this.state;
        const aces = hand.cards[0].rank === "A";
        const moved = hand.cards.pop();
        const sibling = this._newHand(hand.seat, hand.bet, [moved]);
        sibling.fromSplit = true;
        sibling.splitAces = aces;
        hand.fromSplit = true;
        hand.splitAces = aces;
        this._addBankroll(hand.seat, -hand.bet);
        const index = s.activeIndex;
        s.hands.splice(index + 1, 0, sibling);
        this._emit("hand:split", {
          handId: hand.id,
          newHandId: sibling.id,
          seat: hand.seat,
          movedCard: moved,
          bet: sibling.bet,
          bankroll: this.bankrollForSeat(hand.seat),
          seatBankrolls: s.seatBankrolls ? s.seatBankrolls.slice() : null,
          seatHandIds: s.hands.filter((h) => h.seat === hand.seat).map((h) => h.id),
          summary: this._handSummary(hand),
          newSummary: this._handSummary(sibling),
        });
        this._continueFrom(index);
        return { ok: true };
      });
    }

    surrender() {
      return this._run("surrender", () => {
        const { hand, error } = this._requireTurn("surrender");
        if (error) return error;
        if (!this._canSurrender(hand)) return this._reject("surrender", "not-allowed");
        hand.status = "surrender";
        const refund = Math.floor(hand.bet / 2);
        this._emit("hand:surrendered", {
          handId: hand.id,
          seat: hand.seat,
          refund,
          summary: this._handSummary(hand),
        });
        this._continueFrom(this.state.activeIndex + 1);
        return { ok: true, refund };
      });
    }

    /* =========================== dealer turn =========================== */

    _revealHole() {
      const d = this.state.dealer;
      if (d.holeRevealed) return;
      d.holeRevealed = true;
      this._emit("dealer:reveal", {
        card: d.cards[1],
        summary: { total: H.evaluate(d.cards).total, label: H.label(d.cards) },
      });
    }

    _dealerShouldHit() {
      const ev = H.evaluate(this.state.dealer.cards);
      if (ev.total < 17) return true;
      return ev.total === 17 && ev.soft && this.rules.dealerHitsSoft17;
    }

    _dealerTurn() {
      const s = this.state;
      this._setPhase(PHASE.DEALER);
      this._revealHole();
      // The dealer only draws if at least one hand can still be beaten.
      const live = s.hands.some((h) => h.status === "stood");
      if (live) {
        let guard = 0;
        while (this._dealerShouldHit() && guard < 20) {
          this._dealToDealer(true);
          guard += 1;
        }
      }
      const ev = H.evaluate(s.dealer.cards);
      this._emit("dealer:done", { total: ev.total, bust: ev.bust, label: H.label(s.dealer.cards), drew: live });
      this._settle();
    }

    /* ============================ settlement =========================== */

    _settle() {
      const s = this.state;
      const r = this.rules;
      const dealer = H.evaluate(s.dealer.cards);
      const dealerBJ = dealer.natural;
      let totalReturn = 0;
      let totalStake = 0;
      const results = [];

      const seatTotals = Array.from({ length: r.seats }, (_, seat) => ({
        seat,
        stake: 0,
        returned: 0,
        net: 0,
        bankroll: this.bankrollForSeat(seat),
        results: [],
      }));

      for (const hand of s.hands) {
        const ev = H.evaluate(hand.cards);
        const natural = ev.natural && !hand.fromSplit;
        let result;
        let payout;
        if (hand.status === "surrender") {
          result = "surrender";
          payout = Math.floor(hand.bet / 2);
        } else if (ev.bust) {
          result = "bust";
          payout = 0;
        } else if (natural && dealerBJ) {
          result = "push";
          payout = hand.bet;
        } else if (natural) {
          result = "blackjack";
          payout = hand.bet + Math.floor(hand.bet * r.blackjackPays);
        } else if (dealerBJ) {
          result = "lose";
          payout = 0;
        } else if (dealer.bust || ev.total > dealer.total) {
          result = "win";
          payout = hand.bet + Math.floor(hand.bet * r.winPays);
        } else if (ev.total === dealer.total) {
          result = "push";
          payout = hand.bet;
        } else {
          result = "lose";
          payout = 0;
        }

        const insurancePayout = hand.insurance > 0 && dealerBJ ? hand.insurance * (1 + r.insurancePays) : 0;
        hand.result = result;
        hand.payout = payout;
        hand.insurancePayout = insurancePayout;
        const stake = hand.bet + hand.insurance;
        const returned = payout + insurancePayout;
        totalStake += stake;
        totalReturn += returned;
        if (s.seatBankrolls) {
          this._addBankroll(hand.seat, returned);
        }
        const entry = {
          handId: hand.id,
          seat: hand.seat,
          result,
          naturalBlackjack: natural,
          bet: hand.bet,
          payout,
          insurance: hand.insurance,
          insurancePayout,
          net: returned - stake,
          total: ev.total,
        };
        results.push(entry);
        const st = seatTotals[hand.seat];
        if (st) {
          st.stake += stake;
          st.returned += returned;
          st.net += returned - stake;
          st.results.push(entry);
        }
      }

      if (!s.seatBankrolls) {
        s.bankroll += totalReturn;
      }
      for (const st of seatTotals) {
        st.bankroll = this.bankrollForSeat(st.seat);
      }
      s.activeIndex = -1;
      s.lastResult = {
        round: s.round,
        dealerTotal: dealer.total,
        dealerBust: dealer.bust,
        dealerBlackjack: dealerBJ,
        results,
        seatResults: seatTotals,
        net: totalReturn - totalStake,
        bankroll: s.bankroll,
        seatBankrolls: s.seatBankrolls ? s.seatBankrolls.slice() : null,
      };
      this._setPhase(PHASE.ROUND_OVER);
      this._emit("round:settled", s.lastResult);
    }

    /* ============================ new round ============================ */

    newRound() {
      return this._run("newRound", () => {
        const s = this.state;
        if (s.phase !== PHASE.ROUND_OVER) return this._reject("newRound", "round-in-progress");
        const used = [];
        for (const hand of s.hands) used.push(...hand.cards);
        used.push(...s.dealer.cards);
        this.shoe.discard(used);
        s.hands = [];
        s.dealer = { cards: [], holeRevealed: false };
        s.activeIndex = -1;
        this._setPhase(PHASE.BETTING);
        const shuffle = this.shoe.needsShuffle();
        this._emit("round:cleared", { discarded: used.length, shuffleNext: shuffle, bankroll: s.bankroll });
        return { ok: true };
      });
    }
  }

  MBJ.PHASE = PHASE;
  MBJ.BlackjackEngine = BlackjackEngine;
})(typeof window !== "undefined" ? window : globalThis);
