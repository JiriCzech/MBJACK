/* MB Jack – table controls, chip tray, betting hotspots and keyboard shortcuts.
   Never mutates state directly: every user intent goes through BlackjackEngine. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});
  const U = MBJ.utils;

  class TableUI {
    /**
     * @param {{
     *   engine: MBJ.BlackjackEngine,
     *   scene: MBJ.TableScene,
     *   elements: Record<string, HTMLElement>,
     *   audio?: MBJ.SoundEffects
     * }} options
     */
    constructor(options) {
      this.engine = options.engine;
      this.scene = options.scene;
      this.el = options.elements;
      this.audio = options.audio || null;

      this.selectedChip = this.engine.rules.chipValues[1] || this.engine.rules.chipValues[0];
      this.chipButtons = [];
      this.seatHotspots = [];
      this.seatBetsEl = [];
      this._bubbleTimer = null;
      this._onKeyDown = this._onKeyDown.bind(this);
    }

    init() {
      this._buildChipRack();
      this._bindControls();
      this.showDealerLine("Hoď žetony do kruhu a klikni na zásobník.", "friendly");
      this.sync();
      return this;
    }

    destroy() {
      global.removeEventListener("keydown", this._onKeyDown);
      clearTimeout(this._bubbleTimer);
    }

    /* ============================== setup ============================== */

    _buildChipRack() {
      const rack = this.el.chipRack;
      rack.innerHTML = "";
      this.chipButtons = [];
      for (const value of this.engine.rules.chipValues) {
        const btn = MBJ.chips.makeTrayChip(value);
        btn.addEventListener("click", () => {
          this._unlockAudio();
          this.selectedChip = value;
          if (this.audio) this.audio.chip();
          this.sync();
        });
        rack.appendChild(btn);
        this.chipButtons.push(btn);
      }
    }

    _bindControls() {
      // Unlock Web Audio on first user gesture anywhere on the table.
      this.el.stage.addEventListener("pointerdown", () => this._unlockAudio(), { passive: true });

      // 3 gold betting circles
      this.seatHotspots = Array.from(this.el.stage.querySelectorAll(".seat-hotspot"));
      this.seatBetsEl = Array.from(this.el.stage.querySelectorAll(".seat-bet-pill"));

      this.seatHotspots.forEach((btn) => {
        const seat = Number(btn.dataset.seat);
        btn.addEventListener("click", () => {
          this._unlockAudio();
          if (this.scene.isBusy || this.engine.phase !== MBJ.PHASE.BETTING) return;
          this._placeSelectedOn(seat);
        });
        btn.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          this._unlockAudio();
          if (this.scene.isBusy || this.engine.phase !== MBJ.PHASE.BETTING) return;
          this.engine.removeBet(seat);
        });
      });

      this.seatBetsEl.forEach((pill) => {
        const seat = Number(pill.dataset.seat);
        const clearBtn = pill.querySelector(".seat-bet-pill__clear");
        if (clearBtn) {
          clearBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            this._unlockAudio();
            if (this.scene.isBusy || this.engine.phase !== MBJ.PHASE.BETTING) return;
            this.engine.removeBet(seat);
          });
        }
      });

      // Wooden shoe on the right: Deal in betting, Hit during playerTurn.
      this.el.shoeHotspot.addEventListener("click", () => {
        this._unlockAudio();
        if (this.scene.isBusy) return;
        const actions = this.engine.getAvailableActions();
        if (actions.deal) this.engine.deal();
        else if (actions.hit) this.engine.hit();
      });

      // Rail action buttons
      this.el.dealBtn.addEventListener("click", () => this._act(() => this.engine.deal()));
      this.el.rebetBtn.addEventListener("click", () => this._act(() => this.engine.rebet()));
      this.el.clearBtn.addEventListener("click", () => this._act(() => this.engine.clearBets()));
      this.el.rebuyBtn.addEventListener("click", () => this._act(() => this.engine.rebuy()));

      this.el.insYesBtn.addEventListener("click", () => this._act(() => this.engine.insurance(true)));
      this.el.insNoBtn.addEventListener("click", () => this._act(() => this.engine.insurance(false)));

      this.el.hitBtn.addEventListener("click", () => this._act(() => this.engine.hit()));
      this.el.standBtn.addEventListener("click", () => this._act(() => this.engine.stand()));
      this.el.doubleBtn.addEventListener("click", () => this._act(() => this.engine.double()));
      this.el.splitBtn.addEventListener("click", () => this._act(() => this.engine.split()));
      this.el.surrenderBtn.addEventListener("click", () => this._act(() => this.engine.surrender()));

      this.el.newRoundBtn.addEventListener("click", () => this._act(() => this.engine.newRound()));
      this.el.rebetRoundBtn.addEventListener("click", () =>
        this._act(() => {
          const res = this.engine.newRound();
          if (res.ok) this.engine.rebet();
        })
      );

      // Rules & Sound controls
      this.el.soundBtn.addEventListener("click", () => {
        this._unlockAudio();
        if (!this.audio) return;
        const muted = this.audio.toggleMute();
        this.el.soundBtn.classList.toggle("is-muted", muted);
        this.el.soundBtn.setAttribute("aria-pressed", String(muted));
        this.el.soundBtn.title = muted ? "Zapnout zvuk" : "Vypnout zvuk";
      });

      this.el.rulesBtn.addEventListener("click", () => this._toggleRules(true));
      this.el.rulesCloseBtn.addEventListener("click", () => this._toggleRules(false));
      this.el.rulesModal.addEventListener("click", (event) => {
        if (event.target === this.el.rulesModal) this._toggleRules(false);
      });

      global.addEventListener("keydown", this._onKeyDown);
    }

    _unlockAudio() {
      if (this.audio) this.audio.unlock();
    }

    _act(fn) {
      this._unlockAudio();
      if (this.scene.isBusy) return;
      fn();
    }

    _placeSelectedOn(seat) {
      const bank = this.engine.bankroll;
      const current = this.engine.state.seatBets[seat];
      const maxAdd = this.engine.rules.maxBet - current;
      if (maxAdd <= 0) {
        this.showDealerLine(`Maximální sázka na kruh je ${U.formatMoney(this.engine.rules.maxBet)}.`, "grumpy");
        this._nudgeElement(this.seatHotspots[seat]);
        return;
      }
      let chip = this.selectedChip;
      if (chip > bank || chip > maxAdd) {
        // Step down cleanly to the largest legal chip that still fits.
        const affordable = this.engine.rules.chipValues
          .slice()
          .reverse()
          .find((v) => v <= bank && v <= maxAdd);
        if (!affordable) {
          this.showDealerLine("Nemáš dost žetonů na tuhle sázku.", "grumpy");
          this._nudgeElement(this.seatHotspots[seat]);
          return;
        }
        chip = affordable;
        this.selectedChip = chip;
      }
      this.engine.placeBet(seat, chip);
    }

    _nudgeElement(node) {
      if (!node) return;
      node.classList.remove("is-nudged");
      requestAnimationFrame(() => node.classList.add("is-nudged"));
      setTimeout(() => node.classList.remove("is-nudged"), 320);
    }

    _toggleRules(open) {
      this.el.rulesModal.hidden = !open;
    }

    /* =========================== rendering UI ========================== */

    showDealerLine(text, mood) {
      const b = this.el.dealerBubble;
      if (!b || !text) return;
      this.el.dealerBubbleText.textContent = text;
      b.dataset.mood = mood || "neutral";
      b.classList.add("is-visible");
    }

    sync() {
      const e = this.engine;
      const busy = this.scene.isBusy;
      const actions = e.getAvailableActions();
      const phase = e.phase;
      const betTotal = e.moneyOnTable();
      this.el.stage.dataset.phase = phase;

      // Bankroll & active bet plaque
      this.el.bankrollValue.textContent = U.formatMoney(e.bankroll);
      this.el.betValue.textContent = U.formatMoney(betTotal);

      // Chip selection: keep selected chip valid or highlight best affordable.
      const chips = this.engine.rules.chipValues;
      if (this.selectedChip > e.bankroll) {
        const fallback = chips.slice().reverse().find((v) => v <= e.bankroll);
        if (fallback) this.selectedChip = fallback;
      }
      this.chipButtons.forEach((btn) => {
        const val = Number(btn.dataset.value);
        const canUse = !busy && actions.bet && val <= e.bankroll;
        btn.disabled = !canUse;
        btn.classList.toggle("is-selected", val === this.selectedChip && actions.bet);
      });
      this.el.chipRack.classList.toggle("is-inactive", !actions.bet || busy);

      // 3 Gold Betting Circles
      const hasAnyBet = e.totalSeatBets() > 0;
      this.seatHotspots.forEach((spot, idx) => {
        const bet = e.state.seatBets[idx] || 0;
        const active = !busy && actions.bet;
        spot.disabled = !active;
        spot.classList.toggle("is-betting", active);
        spot.classList.toggle("has-bet", bet > 0);
        spot.classList.toggle("is-invite", active && !hasAnyBet && idx === 1);

        const pill = this.seatBetsEl[idx];
        if (pill) {
          pill.hidden = !(phase === MBJ.PHASE.BETTING && bet > 0);
          const valSpan = pill.querySelector(".seat-bet-pill__amount");
          if (valSpan) valSpan.textContent = U.formatMoney(bet);
        }
      });

      // Shoe hotspot & cut card badge
      const shoeCanClick = !busy && (actions.deal || actions.hit);
      this.el.shoeHotspot.disabled = !shoeCanClick;
      this.el.shoeHotspot.classList.toggle("is-ready", shoeCanClick);
      this.el.shoeHotspot.setAttribute(
        "aria-label",
        actions.deal ? "Zásobník karet – klikni pro rozdání" : actions.hit ? "Zásobník karet – klikni pro další kartu" : "Zásobník karet"
      );
      if (this.el.shoeShuffleTag) {
        this.el.shoeShuffleTag.hidden = !e.shoe.needsShuffle();
      }

      // Action rail groups (only current phase group is visible)
      this.el.groupBetting.hidden = phase !== MBJ.PHASE.BETTING;
      this.el.groupInsurance.hidden = phase !== MBJ.PHASE.INSURANCE;
      this.el.groupPlayer.hidden = phase !== MBJ.PHASE.PLAYER;
      this.el.groupRoundOver.hidden = phase !== MBJ.PHASE.ROUND_OVER;

      // Betting buttons
      this.el.dealBtn.disabled = busy || !actions.deal;
      this.el.clearBtn.hidden = !actions.clearBets;
      this.el.clearBtn.disabled = busy || !actions.clearBets;
      this.el.rebetBtn.hidden = !actions.rebet;
      this.el.rebetBtn.disabled = busy || !actions.rebet;
      this.el.rebuyBtn.hidden = !actions.rebuy;
      this.el.rebuyBtn.disabled = busy || !actions.rebuy;

      // Insurance buttons
      if (phase === MBJ.PHASE.INSURANCE && e.activeHand) {
        const cost = Math.floor(e.activeHand.bet / 2);
        this.el.insCost.textContent = U.formatMoney(cost);
        this.el.insYesBtn.disabled = busy || !actions.insuranceAffordable;
        this.el.insNoBtn.disabled = busy;
      }

      // Player turn buttons
      this.el.hitBtn.disabled = busy || !actions.hit;
      this.el.standBtn.disabled = busy || !actions.stand;
      this.el.doubleBtn.hidden = !actions.double;
      this.el.doubleBtn.disabled = busy || !actions.double;
      this.el.splitBtn.hidden = !actions.split;
      this.el.splitBtn.disabled = busy || !actions.split;
      this.el.surrenderBtn.hidden = !actions.surrender;
      this.el.surrenderBtn.disabled = busy || !actions.surrender;

      // Round over buttons
      const lastSum = e.state.lastBets.reduce((sum, b) => sum + b, 0);
      const canQuickRebet = phase === MBJ.PHASE.ROUND_OVER && lastSum > 0 && lastSum <= e.bankroll;
      this.el.newRoundBtn.disabled = busy || !actions.newRound;
      this.el.rebetRoundBtn.hidden = !canQuickRebet;
      this.el.rebetRoundBtn.disabled = busy || !canQuickRebet;
    }

    /* ============================ keyboard ============================= */

    _onKeyDown(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();

      if (key === "escape" && !this.el.rulesModal.hidden) {
        event.preventDefault();
        this._toggleRules(false);
        return;
      }
      if (!this.el.rulesModal.hidden) return;
      if (this.scene.isBusy) return;

      this._unlockAudio();
      const a = this.engine.getAvailableActions();

      // Number keys 1..4 pick a chip denomination during betting.
      if (a.bet && key >= "1" && key <= "4") {
        const idx = Number(key) - 1;
        const val = this.engine.rules.chipValues[idx];
        if (val && val <= this.engine.bankroll) {
          this.selectedChip = val;
          if (this.audio) this.audio.chip();
          this.sync();
        }
        return;
      }

      if (key === "enter" || key === " ") {
        if (a.deal) {
          event.preventDefault();
          this.engine.deal();
        } else if (a.newRound) {
          event.preventDefault();
          this.engine.newRound();
        } else if (a.rebet && this.engine.totalSeatBets() === 0) {
          event.preventDefault();
          this.engine.rebet();
        }
        return;
      }

      if (this.engine.phase === MBJ.PHASE.PLAYER) {
        if (key === "h" && a.hit) this.engine.hit();
        else if (key === "s" && a.stand) this.engine.stand();
        else if (key === "d" && a.double) this.engine.double();
        else if (key === "p" && a.split) this.engine.split();
        else if (key === "r" && a.surrender) this.engine.surrender();
        return;
      }

      if (this.engine.phase === MBJ.PHASE.INSURANCE) {
        if (key === "y" && a.insuranceAffordable) this.engine.insurance(true);
        else if (key === "n") this.engine.insurance(false);
      }
    }
  }

  MBJ.TableUI = TableUI;
})(typeof window !== "undefined" ? window : globalThis);
