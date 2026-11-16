/* MB Jack – visual table scene (1376 × 768 logical stage).
   Listens to synchronous BlackjackEngine events and replays them sequentially
   as smooth cartoon animations without ever mutating game state. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});
  const U = MBJ.utils;

  const STAGE_W = 1376;
  const STAGE_H = 768;

  // Coordinates measured against assets/table-empty.jpg (1376 × 768)
  const SHOE_POSE = Object.freeze({ x: 1094, y: 342, rotation: -22, scale: 0.44, opacity: 1, z: 45 });
  const DISCARD_POSE = Object.freeze({ x: 355, y: 348, rotation: 6, scale: 0.46, opacity: 0.92, z: 35 });
  const HOUSE_CHIP_POSE = Object.freeze({ x: 688, y: 324, rotation: 0, scale: 0.82, opacity: 0, z: 340 });

  const DEALER = Object.freeze({ x: 688, y: 394, rotation: 0, scale: 0.62 });

  const SEATS = Object.freeze([
    { x: 237, y: 575, handX: 248, handY: 492, rotation: 7, scale: 0.68 },
    { x: 688, y: 670, handX: 688, handY: 578, rotation: 0, scale: 0.72 },
    { x: 1138, y: 575, handX: 1127, handY: 492, rotation: -7, scale: 0.68 },
  ]);

  const RESULT_META = Object.freeze({
    blackjack: { text: "BLACKJACK!", tone: "blackjack" },
    win: { text: "VÝHRA", tone: "win" },
    push: { text: "REMÍZA", tone: "push" },
    lose: { text: "PROHRA", tone: "lose" },
    bust: { text: "TROP", tone: "lose" },
    surrender: { text: "VZDÁNO", tone: "push" },
  });

  class TableScene {
    /**
     * @param {{
     *   engine: MBJ.BlackjackEngine,
     *   elements: Record<string, HTMLElement>,
     *   audio?: MBJ.SoundEffects,
     *   onStateSynced?: () => void,
     *   onDealerLine?: (text: string, mood?: string) => void
     * }} options
     */
    constructor(options) {
      this.engine = options.engine;
      this.el = options.elements;
      this.audio = options.audio || null;
      this.onStateSynced = options.onStateSynced || (() => {});
      this.onDealerLine = options.onDealerLine || (() => {});

      this.animator = new MBJ.Animator();
      this._queue = [];
      this._draining = false;
      this._unsubs = [];

      this.seatStacks = [];
      this.hands = new Map();
      this.dealer = { cards: [], badgeEl: null };
      this._activeHandId = null;
      this._shoeCards = this.engine.shoe.remaining;
    }

    init() {
      MBJ.cardArt.ensureDefs();
      this._fitStage();
      this._resizeHandler = () => this._fitStage();
      global.addEventListener("resize", this._resizeHandler);

      // Build the 3 permanent chip stacks centered in each gold betting circle.
      for (let i = 0; i < SEATS.length; i += 1) {
        const seat = SEATS[i];
        const stack = new MBJ.ChipStack({
          x: seat.x,
          y: seat.y + 4,
          rotation: 0,
          scale: i === 1 ? 0.96 : 0.88,
          opacity: 1,
          z: 90 + i,
        });
        this.el.chipLayer.appendChild(stack.el);
        stack.setAmount(this.engine.state.seatBets[i] || 0);
        this.seatStacks.push(stack);
      }

      this.dealer.badgeEl = this._makeBadge("dealer-badge");
      this.el.overlayLayer.appendChild(this.dealer.badgeEl);

      this._bindEngine();
      this._updateShoeLabel();
      return this;
    }

    destroy() {
      for (const unsub of this._unsubs) unsub();
      this._unsubs = [];
      if (this._resizeHandler) global.removeEventListener("resize", this._resizeHandler);
      this.animator.cancelAll();
    }

    get isBusy() {
      return this._draining || this._queue.length > 0;
    }

    /* ============================ scaling ============================== */

    _fitStage() {
      const vw = global.innerWidth || STAGE_W;
      const vh = global.innerHeight || STAGE_H;
      const scale = Math.min(vw / STAGE_W, vh / STAGE_H);
      this.el.stage.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(5)})`;
    }

    /* ============================ layout =============================== */

    _seatHandAnchor(seat, splitIndex, splitCount) {
      const s = SEATS[seat];
      if (splitCount <= 1) {
        return { x: s.handX, y: s.handY, rotation: s.rotation, scale: s.scale };
      }
      const step =
        seat === 1
          ? splitCount === 2
            ? 136
            : splitCount === 3
              ? 116
              : 98
          : splitCount === 2
            ? 102
            : splitCount === 3
              ? 80
              : 64;
      const factor = splitCount === 2 ? 0.88 : splitCount === 3 ? 0.78 : 0.69;
      return {
        x: s.handX + (splitIndex - (splitCount - 1) / 2) * step,
        y: s.handY - (seat === 1 ? 10 : 6),
        rotation: s.rotation,
        scale: s.scale * factor,
      };
    }

    _playerCardPose(hand, cardIndex, cardCount) {
      const a = this._seatHandAnchor(hand.seat, hand.splitIndex, hand.splitCount);
      const stepX = cardCount <= 2 ? 28 : Math.min(25, 76 / (cardCount - 1));
      const stepY = -6.5;
      const center = (cardCount - 1) / 2;
      return {
        x: a.x + (cardIndex - center) * stepX,
        y: a.y + (cardIndex - center) * stepY,
        rotation: a.rotation + (cardIndex - center) * 3.1,
        scale: a.scale,
        opacity: 1,
        z: 120 + hand.seat * 20 + hand.splitIndex * 10 + cardIndex,
      };
    }

    _dealerCardPose(cardIndex, cardCount) {
      const stepX = cardCount <= 2 ? 52 : Math.min(46, 224 / (cardCount - 1));
      const center = (cardCount - 1) / 2;
      return {
        x: DEALER.x + (cardIndex - center) * stepX,
        y: DEALER.y,
        rotation: (cardIndex - center) * 1.6,
        scale: DEALER.scale,
        opacity: 1,
        z: 100 + cardIndex,
      };
    }

    _badgePos(hand) {
      const a = this._seatHandAnchor(hand.seat, hand.splitIndex, hand.splitCount);
      const offset = hand.seat === 1 && hand.splitCount === 1 ? 54 : 64;
      return { x: a.x, y: a.y - offset * (a.scale / 0.72) };
    }

    _stampPos(hand) {
      const a = this._seatHandAnchor(hand.seat, hand.splitIndex, hand.splitCount);
      return { x: a.x, y: a.y + 4 };
    }

    _splitStackPos(hand) {
      const s = SEATS[hand.seat];
      if (hand.splitCount <= 1) return { x: s.x, y: s.y + 4, scale: hand.seat === 1 ? 0.96 : 0.88 };
      const a = this._seatHandAnchor(hand.seat, hand.splitIndex, hand.splitCount);
      return { x: a.x, y: a.y + 68, scale: 0.72 };
    }

    /* =========================== DOM helpers =========================== */

    _makeBadge(extraClass) {
      const el = document.createElement("div");
      el.className = `score-badge ${extraClass || ""}`.trim();
      el.hidden = true;
      return el;
    }

    _setBadge(badgeEl, text, pos, tone) {
      if (!badgeEl) return;
      if (!text) {
        badgeEl.hidden = true;
        return;
      }
      badgeEl.hidden = false;
      badgeEl.textContent = text;
      badgeEl.style.left = pos.x.toFixed(1) + "px";
      badgeEl.style.top = pos.y.toFixed(1) + "px";
      badgeEl.dataset.tone = tone || "";
    }

    _makeStamp(meta, net, pos) {
      const el = document.createElement("div");
      el.className = `result-stamp result-stamp--${meta.tone}`;
      const netText = net > 0 ? `+${U.formatMoney(net)}` : net < 0 ? U.formatMoney(net) : "±$0";
      el.innerHTML = `<span class="result-stamp__title">${meta.text}</span><span class="result-stamp__net">${netText}</span>`;
      el.style.left = pos.x.toFixed(1) + "px";
      el.style.top = pos.y.toFixed(1) + "px";
      return el;
    }

    _updateShoeLabel() {
      if (!this.el.shoeCount) return;
      this.el.shoeCount.textContent = String(this._shoeCards);
    }

    _setActiveHandHighlight(handId) {
      this._activeHandId = handId || null;
      const ring = this.el.activeRing;
      if (!ring) return;
      if (!handId || !this.hands.has(handId)) {
        ring.hidden = true;
        return;
      }
      const hand = this.hands.get(handId);
      const a = this._seatHandAnchor(hand.seat, hand.splitIndex, hand.splitCount);
      ring.hidden = false;
      ring.style.left = a.x.toFixed(1) + "px";
      ring.style.top = a.y.toFixed(1) + "px";
      ring.style.transform = `translate(-50%, -50%) rotate(${a.rotation}deg) scale(${(a.scale / 0.72).toFixed(3)})`;
    }

    /* ========================== event queue ============================ */

    _enqueue(fn) {
      this._queue.push(fn);
      if (!this._draining) void this._drain();
    }

    async _drain() {
      this._draining = true;
      this.onStateSynced();
      while (this._queue.length > 0) {
        const task = this._queue.shift();
        try {
          await task();
        } catch (error) {
          console.error("[MBJack scene]", error);
        }
      }
      this._draining = false;
      this.onStateSynced();
    }

    _bindEngine() {
      const e = this.engine;

      this._unsubs.push(
        e.on("bet:changed", ({ seat, bet, delta }) => {
          const stack = this.seatStacks[seat];
          if (stack) stack.setAmount(bet, { pop: delta > 0 });
          if (delta > 0 && this.audio) this.audio.chip();
          this.onStateSynced();
        }),

        e.on("bankroll:rebuy", () => {
          if (this.audio) this.audio.chip();
          this.onDealerLine("Čerstvý štos žetonů na stole. Hodně štěstí!", "friendly");
          this.onStateSynced();
        }),

        e.on("shoe:shuffled", ({ remaining }) => {
          this._enqueue(async () => {
            this._shoeCards = remaining;
            this._updateShoeLabel();
            this.onDealerLine("Míchám čerstvý balíček karet…", "neutral");
            if (this.el.shoeHotspot) {
              this.el.shoeHotspot.classList.add("is-shuffling");
              await U.wait(U.motionDuration(340));
              this.el.shoeHotspot.classList.remove("is-shuffling");
            }
          });
        }),

        e.on("round:started", ({ hands }) => {
          this._enqueue(async () => {
            this.hands.clear();
            this.dealer.cards = [];
            this._setBadge(this.dealer.badgeEl, "");
            this._setActiveHandHighlight(null);
            this.onDealerLine("Rozdávám karty…", "neutral");

            for (const h of hands) {
              const badgeEl = this._makeBadge("hand-badge");
              this.el.overlayLayer.appendChild(badgeEl);
              const stack = this.seatStacks[h.seat];
              if (stack) stack.setAmount(h.bet);
              this.hands.set(h.id, {
                id: h.id,
                seat: h.seat,
                cards: [],
                badgeEl,
                resultEl: null,
                stack,
                insuranceStack: null,
                splitIndex: 0,
                splitCount: 1,
                bet: h.bet,
                doubled: false,
              });
            }
          });
        }),

        e.on("card:dealt", (payload) => {
          this._enqueue(() => this._animateDeal(payload));
        }),

        e.on("dealer:peek", ({ blackjack }) => {
          this._enqueue(async () => {
            if (!blackjack && this.dealer.cards[1]) {
              const hole = this.dealer.cards[1];
              const base = Object.assign({}, hole.pose);
              await this.animator.tweenTo(
                hole,
                { x: base.x + 6, y: base.y - 6, rotation: base.rotation + 5 },
                { duration: 110, ease: U.easeOutCubic }
              );
              await this.animator.tweenTo(hole, base, { duration: 110, ease: U.easeOutCubic });
              this.onDealerLine("Blackjack nemám. Jedeš, kovboji.", "neutral");
            }
          });
        }),

        e.on("insurance:offered", ({ handId, cost }) => {
          this._enqueue(async () => {
            this._setActiveHandHighlight(handId);
            this.onDealerLine(`Ukazuji eso. Chceš pojištění za ${U.formatMoney(cost)}?`, "neutral");
          });
        }),

        e.on("insurance:decided", ({ handId, seat, amount }) => {
          this._enqueue(async () => {
            const hand = this.hands.get(handId);
            if (!hand || amount <= 0) return;
            const s = SEATS[seat];
            const ins = new MBJ.ChipStack(
              { x: s.x - 66, y: s.y + 8, rotation: 0, scale: 0.72, opacity: 1, z: 98 },
              { prefix: "POJ " }
            );
            this.el.chipLayer.appendChild(ins.el);
            ins.setAmount(amount, { pop: true });
            hand.insuranceStack = ins;
            if (this.audio) this.audio.chip();
          });
        }),

        e.on("insurance:lost", ({ handId }) => {
          this._enqueue(async () => {
            const hand = this.hands.get(handId);
            if (!hand || !hand.insuranceStack) return;
            const ins = hand.insuranceStack;
            hand.insuranceStack = null;
            await this.animator.tweenTo(ins, HOUSE_CHIP_POSE, { duration: 240, ease: U.easeInOutCubic });
            ins.destroy();
          });
        }),

        e.on("hand:split", (payload) => {
          this._enqueue(() => this._animateSplit(payload));
        }),

        e.on("hand:doubled", ({ handId, bet }) => {
          this._enqueue(async () => {
            const hand = this.hands.get(handId);
            if (!hand) return;
            hand.bet = bet;
            hand.doubled = true;
            if (hand.stack) hand.stack.setAmount(bet, { pop: true });
            if (this.audio) this.audio.chip();
          });
        }),

        e.on("turn:changed", ({ handId, splitDraw }) => {
          this._enqueue(async () => {
            this._setActiveHandHighlight(handId);
            if (!splitDraw && handId) {
              const hand = this.hands.get(handId);
              if (hand && this.engine.phase === MBJ.PHASE.PLAYER) {
                this.onDealerLine("Tvůj tah. Líznout, nebo stát?", "neutral");
              }
            }
          });
        }),

        e.on("hand:blackjack", ({ handId }) => {
          this._enqueue(async () => {
            const hand = this.hands.get(handId);
            if (!hand) return;
            this._setBadge(hand.badgeEl, "BLACKJACK", this._badgePos(hand), "blackjack");
            if (this.audio) this.audio.win(true);
            this.onDealerLine("Blackjack! Pěkná trefa!", "impressed");
          });
        }),

        e.on("hand:bust", ({ handId }) => {
          this._enqueue(async () => {
            const hand = this.hands.get(handId);
            if (!hand) return;
            hand.cards.forEach((c) => c.el.classList.add("is-muted"));
            this._setBadge(hand.badgeEl, "TROP", this._badgePos(hand), "bust");
            if (this.audio) this.audio.bust();
          });
        }),

        e.on("hand:surrendered", ({ handId, summary }) => {
          this._enqueue(async () => {
            const hand = this.hands.get(handId);
            if (!hand) return;
            hand.cards.forEach((c) => c.el.classList.add("is-muted"));
            this._setBadge(hand.badgeEl, summary.label, this._badgePos(hand), "push");
            if (hand.stack) hand.stack.setAmount(Math.floor(hand.bet / 2));
            this.onDealerLine("Rozumný ústup. Půlka sázky je zpět.", "neutral");
          });
        }),

        e.on("dealer:reveal", ({ card, summary }) => {
          this._enqueue(async () => {
            this._setActiveHandHighlight(null);
            const hole = this.dealer.cards[1];
            if (!hole) return;
            hole.setCard(card);
            if (this.audio) this.audio.card();
            const base = Object.assign({}, hole.pose);
            await this.animator.tweenTo(hole, { y: base.y - 10, scale: base.scale * 1.07 }, { duration: 110 });
            hole.setFaceUp(true);
            await this.animator.tweenTo(hole, base, { duration: 140 });
            this._setBadge(
              this.dealer.badgeEl,
              summary.label,
              { x: DEALER.x, y: DEALER.y + 52 },
              summary.label === "BJ" ? "blackjack" : "dealer"
            );
          });
        }),

        e.on("dealer:done", ({ total, bust }) => {
          this._enqueue(async () => {
            this._setBadge(
              this.dealer.badgeEl,
              bust ? `TROP (${total})` : String(total),
              { x: DEALER.x, y: DEALER.y + 52 },
              bust ? "bust" : "dealer"
            );
            if (bust) this.onDealerLine("Přetáhl jsem! Všechny živé ruce berou.", "grumpy");
          });
        }),

        e.on("round:settled", (res) => {
          this._enqueue(() => this._animateSettlement(res));
        }),

        e.on("round:cleared", () => {
          this._enqueue(() => this._animateClear());
        })
      );
    }

    /* =========================== animations ============================ */

    async _animateDeal(payload) {
      this._shoeCards = Math.max(0, this._shoeCards - 1);
      this._updateShoeLabel();

      const sprite = new MBJ.CardSprite("card-" + Math.random().toString(36).slice(2, 9), SHOE_POSE);
      if (payload.faceUp && payload.card) sprite.setCard(payload.card);
      this.el.cardLayer.appendChild(sprite.el);
      if (this.audio) this.audio.card();

      if (payload.target === "dealer") {
        this.dealer.cards.push(sprite);
        const total = this.dealer.cards.length;
        const reflows = [];
        for (let i = 0; i < total - 1; i += 1) {
          reflows.push(
            this.animator.tweenTo(this.dealer.cards[i], this._dealerCardPose(i, total), {
              duration: 180,
              ease: U.easeOutCubic,
            })
          );
        }
        const target = this._dealerCardPose(total - 1, total);
        let flipped = false;
        const flight = this.animator.tweenTo(sprite, target, {
          duration: 240,
          arc: 30,
          ease: U.easeOutCubic,
          onUpdate: (raw) => {
            if (payload.faceUp && !flipped && raw >= 0.28) {
              flipped = true;
              sprite.setFaceUp(true);
            }
          },
        });
        await Promise.all([...reflows, flight]);
        this._setBadge(
          this.dealer.badgeEl,
          payload.summary.label,
          { x: DEALER.x, y: DEALER.y + 52 },
          "dealer"
        );
        return;
      }

      const hand = this.hands.get(payload.handId);
      if (!hand) {
        sprite.destroy();
        return;
      }
      hand.cards.push(sprite);
      const total = hand.cards.length;
      const reflows = [];
      for (let i = 0; i < total - 1; i += 1) {
        reflows.push(
          this.animator.tweenTo(hand.cards[i], this._playerCardPose(hand, i, total), {
            duration: 180,
            ease: U.easeOutCubic,
          })
        );
      }
      const target = this._playerCardPose(hand, total - 1, total);
      let flipped = false;
      const flight = this.animator.tweenTo(sprite, target, {
        duration: 240,
        arc: 34,
        ease: U.easeOutCubic,
        onUpdate: (raw) => {
          if (payload.faceUp && !flipped && raw >= 0.28) {
            flipped = true;
            sprite.setFaceUp(true);
          }
        },
      });
      await Promise.all([...reflows, flight]);
      const tone = payload.summary.bust
        ? "bust"
        : payload.summary.blackjack
          ? "blackjack"
          : hand.doubled
            ? "doubled"
            : "";
      const prefix = hand.doubled ? "2× · " : "";
      this._setBadge(hand.badgeEl, prefix + payload.summary.label, this._badgePos(hand), tone);
    }

    async _animateSplit(payload) {
      const origin = this.hands.get(payload.handId);
      if (!origin) return;
      const movedSprite = origin.cards.pop();

      const badgeEl = this._makeBadge("hand-badge");
      this.el.overlayLayer.appendChild(badgeEl);

      const sibling = {
        id: payload.newHandId,
        seat: payload.seat,
        cards: movedSprite ? [movedSprite] : [],
        badgeEl,
        resultEl: null,
        stack: null,
        insuranceStack: null,
        splitIndex: 0,
        splitCount: payload.seatHandIds.length,
        bet: payload.bet,
        doubled: false,
      };
      this.hands.set(sibling.id, sibling);

      // Update split indices for every hand sitting on this seat.
      const count = payload.seatHandIds.length;
      payload.seatHandIds.forEach((id, idx) => {
        const h = this.hands.get(id);
        if (h) {
          h.splitIndex = idx;
          h.splitCount = count;
        }
      });

      // Spawn sibling's chip stack from origin's stack position.
      const startPos = origin.stack ? origin.stack.pose : { x: SEATS[payload.seat].x, y: SEATS[payload.seat].y };
      const sibStack = new MBJ.ChipStack({
        x: startPos.x,
        y: startPos.y,
        rotation: 0,
        scale: 0.72,
        opacity: 1,
        z: 96,
      });
      this.el.chipLayer.appendChild(sibStack.el);
      sibStack.setAmount(payload.bet, { pop: true });
      sibling.stack = sibStack;
      if (this.audio) this.audio.chip();

      const tasks = [];
      for (const id of payload.seatHandIds) {
        const h = this.hands.get(id);
        if (!h) continue;
        h.cards.forEach((c, idx) => {
          tasks.push(this.animator.tweenTo(c, this._playerCardPose(h, idx, h.cards.length), { duration: 220 }));
        });
        if (h.stack) {
          const sp = this._splitStackPos(h);
          tasks.push(this.animator.tweenTo(h.stack, { x: sp.x, y: sp.y, scale: sp.scale }, { duration: 220 }));
        }
      }
      await Promise.all(tasks);
      this._setBadge(origin.badgeEl, payload.summary.label, this._badgePos(origin), "");
      this._setBadge(sibling.badgeEl, payload.newSummary.label, this._badgePos(sibling), "");
    }

    async _animateSettlement(res) {
      this._setActiveHandHighlight(null);
      const chipTasks = [];
      let anyWin = false;
      let anyBJ = false;

      for (const r of res.results) {
        const hand = this.hands.get(r.handId);
        if (!hand) continue;
        const meta = RESULT_META[r.result] || RESULT_META.lose;
        const stamp = this._makeStamp(meta, r.net, this._stampPos(hand));
        this.el.overlayLayer.appendChild(stamp);
        hand.resultEl = stamp;

        if (r.result === "blackjack") {
          anyWin = true;
          anyBJ = true;
        } else if (r.result === "win") {
          anyWin = true;
        }

        if (hand.stack) {
          if (r.result === "win" || r.result === "blackjack") {
            const winBonus = new MBJ.ChipStack(HOUSE_CHIP_POSE, { noTag: true });
            this.el.chipLayer.appendChild(winBonus.el);
            winBonus.setAmount(r.payout - r.bet);
            const target = { x: hand.stack.pose.x + 18, y: hand.stack.pose.y, scale: hand.stack.pose.scale, opacity: 1 };
            chipTasks.push(
              this.animator.tweenTo(winBonus, target, { duration: 280, ease: U.easeOutCubic }).then(() => {
                winBonus.destroy();
                hand.stack.setAmount(r.payout, { pop: true });
              })
            );
          } else if (r.result === "lose" || r.result === "bust") {
            chipTasks.push(
              this.animator.tweenTo(hand.stack, HOUSE_CHIP_POSE, { duration: 260, ease: U.easeInOutCubic }).then(() => {
                hand.stack.setAmount(0);
              })
            );
          } else if (r.result === "surrender") {
            hand.stack.setAmount(r.payout);
          }
        }

        if (hand.insuranceStack) {
          const ins = hand.insuranceStack;
          if (r.insurancePayout > 0) {
            ins.setAmount(r.insurancePayout, { pop: true });
          } else {
            hand.insuranceStack = null;
            chipTasks.push(
              this.animator.tweenTo(ins, HOUSE_CHIP_POSE, { duration: 240 }).then(() => ins.destroy())
            );
          }
        }
      }

      if (anyWin && this.audio) this.audio.win(anyBJ);

      if (res.dealerBlackjack) {
        this.onDealerLine("Blackjack krupiéra! Bohužel, kovboji.", "grumpy");
      } else if (res.net > 0) {
        this.onDealerLine(`Pěkná ruka! Bereš ${U.formatMoney(res.net)} čistého.`, "impressed");
      } else if (res.net === 0) {
        this.onDealerLine("Remíza. Sázky se vracejí zpět.", "neutral");
      } else if (!res.dealerBust) {
        this.onDealerLine("Dnes bere saloon. Zkus další kolo!", "grumpy");
      }

      await Promise.all(chipTasks);
    }

    async _animateClear() {
      this._setActiveHandHighlight(null);
      this._setBadge(this.dealer.badgeEl, "");

      const allCards = [];
      for (const c of this.dealer.cards) allCards.push(c);
      for (const h of this.hands.values()) {
        for (const c of h.cards) allCards.push(c);
        if (h.badgeEl) h.badgeEl.remove();
        if (h.resultEl) h.resultEl.remove();
        if (h.insuranceStack) h.insuranceStack.destroy();
        // Destroy temporary split stacks; permanent seatStacks are reset below.
        if (h.stack && !this.seatStacks.includes(h.stack)) h.stack.destroy();
      }
      this.hands.clear();
      this.dealer.cards = [];

      // Restore permanent seat stacks to their gold circles, matching live bets.
      for (let i = 0; i < this.seatStacks.length; i += 1) {
        const stack = this.seatStacks[i];
        const s = SEATS[i];
        this.animator.cancel(stack);
        stack.setPose({
          x: s.x,
          y: s.y + 4,
          rotation: 0,
          scale: i === 1 ? 0.96 : 0.88,
          opacity: 1,
          z: 90 + i,
        });
        stack.setAmount(this.engine.state.seatBets[i] || 0);
      }

      if (allCards.length > 0 && this.audio) this.audio.card();
      const sweeps = allCards.map((card, i) => {
        card.setFaceUp(false);
        return this.animator
          .tweenTo(
            card,
            Object.assign({}, DISCARD_POSE, { opacity: 0, z: 40 + i }),
            { duration: 240, delay: i * 24, ease: U.easeInOutCubic }
          )
          .then(() => card.destroy());
      });
      await Promise.all(sweeps);
      this.onDealerLine("Hoď žetony do kruhu a klikni na zásobník.", "friendly");
    }
  }

  MBJ.TableScene = TableScene;
  MBJ.STAGE_METRICS = Object.freeze({ STAGE_W, STAGE_H, SEATS, SHOE_POSE, DISCARD_POSE });
})(typeof window !== "undefined" ? window : globalThis);
