/* Real-time multiplayer controller backed by Firebase Realtime Database.
   Implements an engine-compatible facade for TableUI + TableScene:
   - Auto-matchmaking into 3-seat tables (P1, P2, P3) without room codes
   - Authoritative host execution with automatic host election/migration
   - Per-seat betting & bankrolls, real-time card/chip event replay
   - Mid-round join hydration (join next round seamlessly)
   - Ephemeral comic-bubble chat (no history)
   - Stress-free Sheriff AFK warnings & polite removal + onDisconnect() cleanup
*/
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});
  const U = MBJ.utils;

  const AFK_WARN_MS = 25000;
  const AFK_KICK_MS = 40000;
  const ROOM_STALE_MS = 50000;
  const NEW_ROUND_AUTO_MS = 6000;

  class MultiplayerTable {
    /**
     * @param {{
     *   firebase: MBJ.FirebaseBridge,
     *   profileStore: MBJ.ProfileStore,
     *   rules: object,
     *   audio?: MBJ.SoundEffects,
     *   onStateChange?: () => void,
     *   onDealerLine?: (text: string, mood?: string) => void,
     *   onChatMessage?: (msg: { seat: number, text: string, name: string }) => void,
     *   onKicked?: (reason: string) => void,
     *   onSeatRender?: () => void,
     *   onHydrateScene?: (snapshot: object) => void
     * }} options
     */
    constructor(options) {
      this.fb = options.firebase;
      this.store = options.profileStore;
      this.rules = Object.assign({}, MBJ.RULES, options.rules || {});
      this.audio = options.audio || null;

      this.onStateChange = options.onStateChange || (() => {});
      this.onDealerLine = options.onDealerLine || (() => {});
      this.onChatMessage = options.onChatMessage || (() => {});
      this.onKicked = options.onKicked || (() => {});
      this.onSeatRender = options.onSeatRender || (() => {});
      this.onHydrateScene = options.onHydrateScene || (() => {});

      this.bus = new MBJ.EventBus();
      this.roomId = null;
      this.mySeat = -1;
      this.isHost = false;
      this.offlineMode = false;

      // Mirror state rendered by TableUI / TableScene
      this.mirror = {
        phase: MBJ.PHASE.BETTING,
        round: 0,
        seatBankrolls: [0, 0, 0],
        seatBets: [0, 0, 0],
        lastBets: [0, 0, 0],
        hands: [],
        activeIndex: -1,
        activeHandId: null,
        dealer: { cards: [], holeRevealed: false },
        shoe: { remaining: this.rules.decks * 52, needsShuffle: false },
        lastResult: null,
      };

      this.seats = [null, null, null];
      this.presence = {};
      this.meta = null;

      // Authoritative host engine (used on Host OR offline fallback)
      this.hostEngine = null;
      this._hostBus = null;
      this._capturedEvents = null;
      this._eventsSeq = 0;
      this._lastAppliedSeq = 0;
      this._lastNoticeId = null;
      this._processedActions = new Set();
      this._settledRounds = new Set();

      this._myPendingNewRound = false;
      this._myQueuedAutoRebet = false;
      this._roundReadySeats = {};
      this._autoRebetSeats = {};
      this._newRoundTimer = null;

      // AFK tracking
      this._turnWatchKey = "";
      this._turnWatchSince = 0;
      this._turnWarnedKey = "";
      this._betWatchSince = 0;
      this._betWarnedSeats = new Set();

      this._roomListeners = [];
      this._heartbeatTimer = null;
      this._watchdogTimer = null;
      this._connUnsub = null;
      this._chatJoinCutoff = Date.now();
      this._leaving = false;
      this._joining = false;
      this._hydratedOnce = false;
    }

    /* ==================== BlackjackEngine-compatible getters ==================== */

    on(eventName, handler) {
      return this.bus.on(eventName, handler);
    }

    get phase() {
      return this.mirror.phase;
    }

    get state() {
      return this.mirror;
    }

    get bankroll() {
      if (this.mySeat >= 0) {
        return this.mirror.seatBankrolls[this.mySeat] ?? (this.store.current ? this.store.current.bankroll : 0);
      }
      return this.store.current ? this.store.current.bankroll : 0;
    }

    get shoe() {
      return this.mirror.shoe;
    }

    get activeHand() {
      const i = this.mirror.activeIndex;
      return i >= 0 ? this.mirror.hands[i] || null : null;
    }

    totalSeatBets() {
      return this.mySeat >= 0 ? this.mirror.seatBets[this.mySeat] || 0 : 0;
    }

    moneyOnTable() {
      if (this.mySeat < 0) return 0;
      if (this.mirror.phase === MBJ.PHASE.BETTING) return this.mirror.seatBets[this.mySeat] || 0;
      if (this.mirror.phase === MBJ.PHASE.ROUND_OVER) return 0;
      return (this.mirror.hands || [])
        .filter((h) => h.seat === this.mySeat)
        .reduce((sum, h) => sum + h.bet + (h.insurance || 0), 0);
    }

    isBroke() {
      if (this.mySeat < 0) return false;
      return (
        this.mirror.phase === MBJ.PHASE.BETTING &&
        (this.mirror.seatBets[this.mySeat] || 0) === 0 &&
        this.bankroll < this.rules.minBet
      );
    }

    canBet(seat, amount) {
      if (this.mySeat < 0 || seat !== this.mySeat) return { ok: false, reason: "not-your-seat" };
      if (this.mirror.phase !== MBJ.PHASE.BETTING) return { ok: false, reason: "not-betting" };
      if (this.seats[this.mySeat]?.ready && this.seats[this.mySeat]?.readyRound === this.mirror.round) {
        return { ok: false, reason: "already-ready" };
      }
      if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: "bad-amount" };
      if (amount > this.bankroll) return { ok: false, reason: "insufficient-funds" };
      if ((this.mirror.seatBets[seat] || 0) + amount > this.rules.maxBet) return { ok: false, reason: "max-bet" };
      return { ok: true };
    }

    canDeal() {
      if (this.mySeat < 0 || this.mirror.phase !== MBJ.PHASE.BETTING) return false;
      const myBet = this.mirror.seatBets[this.mySeat] || 0;
      const mySeatData = this.seats[this.mySeat];
      if (mySeatData && mySeatData.ready && mySeatData.readyRound === this.mirror.round) return false;
      return myBet >= this.rules.minBet && myBet <= this.rules.maxBet;
    }

    canRebet() {
      if (this.mySeat < 0 || this.mirror.phase !== MBJ.PHASE.BETTING) return false;
      if (this.seats[this.mySeat]?.ready && this.seats[this.mySeat]?.readyRound === this.mirror.round) return false;
      const last = this.mirror.lastBets[this.mySeat] || 0;
      return last > 0 && last <= this.bankroll + (this.mirror.seatBets[this.mySeat] || 0);
    }

    getAvailableActions() {
      const m = this.mirror;
      const seat = this.mySeat;
      const mySeatData = seat >= 0 ? this.seats[seat] : null;
      const myReady = Boolean(mySeatData && mySeatData.ready && mySeatData.readyRound === m.round);
      const myBet = seat >= 0 ? m.seatBets[seat] || 0 : 0;

      const a = {
        bet: m.phase === MBJ.PHASE.BETTING && seat >= 0 && !myReady,
        clearBets: m.phase === MBJ.PHASE.BETTING && seat >= 0 && myBet > 0 && !myReady,
        rebet: this.canRebet() && myBet === 0,
        deal: this.canDeal(),
        waitingForOthers: m.phase === MBJ.PHASE.BETTING && myReady,
        rebuy: this.isBroke(),
        insurance: false,
        insuranceAffordable: false,
        hit: false,
        stand: false,
        double: false,
        split: false,
        surrender: false,
        newRound: m.phase === MBJ.PHASE.ROUND_OVER && seat >= 0 && !this._myPendingNewRound,
        waitingNextRound: m.phase === MBJ.PHASE.ROUND_OVER && this._myPendingNewRound,
      };

      const hand = this.activeHand;
      if (hand && hand.seat === seat) {
        if (m.phase === MBJ.PHASE.INSURANCE) {
          a.insurance = true;
          a.insuranceAffordable = this.bankroll >= Math.floor(hand.bet / 2);
        } else if (m.phase === MBJ.PHASE.PLAYER && hand.status === "playing") {
          const H = MBJ.Hand;
          const lockedAces = hand.splitAces && this.rules.splitAcesOneCard;
          a.hit = !lockedAces;
          a.stand = true;
          a.double =
            !lockedAces &&
            hand.cards.length === 2 &&
            !hand.splitAces &&
            (!hand.fromSplit || this.rules.doubleAfterSplit) &&
            this.bankroll >= hand.bet &&
            (this.rules.doubleOnAnyTwo || (!H.evaluate(hand.cards).soft && H.evaluate(hand.cards).total >= 9 && H.evaluate(hand.cards).total <= 11));
          const seatHandsCount = m.hands.filter((h) => h.seat === seat).length;
          a.split =
            hand.cards.length === 2 &&
            H.isPair(hand.cards, this.rules.splitByValue) &&
            this.bankroll >= hand.bet &&
            seatHandsCount < this.rules.maxHandsPerSeat &&
            (!hand.splitAces || this.rules.resplitAces);
          a.surrender = !lockedAces && this.rules.surrender && hand.cards.length === 2 && !hand.fromSplit;
        }
      }
      return a;
    }

    /* ========================== Join / Leave Room ========================== */

    async joinTable() {
      if (this._joining) return;
      this._joining = true;
      this._leaving = false;
      this._hydratedOnce = false;
      this._settledRounds.clear();
      this._processedActions.clear();

      try {
        const profile = this.store.current;
        if (!profile) return;

        if (!this.fb || !this.fb.isAvailable()) {
          this._startOfflineFallback(profile);
          return;
        }

        // Ensure we have an auth UID (Google or anonymous guest session)
        let uid = this.fb.auth.currentUser ? this.fb.auth.currentUser.uid : null;
        if (!uid) {
          const u = await this.fb.ensureGuestSession();
          uid = u ? u.uid : null;
        }
        if (!uid) {
          this._startOfflineFallback(profile);
          return;
        }
        profile.uid = uid;
        this.fb.attachPresence(uid);

        const joined = await this._matchmakeAndSit(uid, profile);
        if (!joined) {
          this._startOfflineFallback(profile);
          return;
        }
      } catch (err) {
        console.error("[MBJack multiplayer join]", err);
        if (this.store.current) this._startOfflineFallback(this.store.current);
      } finally {
        this._joining = false;
      }
    }

    _startOfflineFallback(profile) {
      this.offlineMode = true;
      this.roomId = "offline-saloon";
      this.mySeat = 0;
      this.isHost = true;
      this.seats = [
        {
          uid: "local",
          firstName: profile.firstName,
          lastName: profile.lastName,
          avatarId: profile.avatarId,
          bankroll: profile.bankroll,
          bet: 0,
          betRound: 0,
          ready: false,
          readyRound: 0,
          lastActiveAt: Date.now(),
        },
        null,
        null,
      ];
      this.presence = { local: { online: true } };
      this.hostEngine = this._buildEngineInstance([profile.bankroll, 0, 0]);
      this._syncMirrorFromHostEngine();
      this.onSeatRender();
      this.onStateChange();
      this.onDealerLine("Offline mód — hraješ u stolu sám se šerifem.", "friendly");
    }

    async leaveTable() {
      this._leaving = true;
      clearInterval(this._heartbeatTimer);
      clearInterval(this._watchdogTimer);
      clearTimeout(this._newRoundTimer);
      this._heartbeatTimer = null;
      this._watchdogTimer = null;
      this._newRoundTimer = null;

      if (this._connUnsub) {
        this._connUnsub();
        this._connUnsub = null;
      }
      for (const unsub of this._roomListeners) {
        try {
          unsub();
        } catch (_) {}
      }
      this._roomListeners = [];

      if (!this.offlineMode && this.fb && this.fb.isAvailable() && this.roomId && this.fb.auth.currentUser) {
        const uid = this.fb.auth.currentUser.uid;
        const rRef = this.fb.db.ref(`rooms/${this.roomId}`);
        const tasks = [];
        if (this.mySeat >= 0) {
          tasks.push(rRef.child(`seats/${this.mySeat}`).remove().catch(() => {}));
        }
        tasks.push(rRef.child(`presence/${uid}`).remove().catch(() => {}));
        await Promise.all(tasks);
      }

      this.roomId = null;
      this.mySeat = -1;
      this.isHost = false;
      this.offlineMode = false;
      this.hostEngine = null;
      this.seats = [null, null, null];
      this.presence = {};
      this.meta = null;
    }

    _buildSeatPayload(uid, profile, round) {
      return {
        uid,
        firstName: profile.firstName,
        lastName: profile.lastName,
        avatarId: profile.avatarId,
        bankroll: profile.bankroll,
        bet: 0,
        betRound: round || 0,
        ready: false,
        readyRound: round || 0,
        lastBet: 0,
        joinedAt: Date.now(),
        lastActiveAt: Date.now(),
      };
    }

    async _matchmakeAndSit(uid, profile) {
      const db = this.fb.db;
      const roomsRef = db.ref("rooms");
      const snap = await roomsRef.orderByChild("meta/updatedAt").limitToLast(20).once("value");
      const allRooms = snap.val() || {};
      const now = Date.now();

      const candidates = Object.entries(allRooms)
        .filter(([, room]) => {
          if (!room || !room.meta) return false;
          const updatedAt = Number(room.meta.updatedAt || 0);
          if (now - updatedAt > ROOM_STALE_MS) return false;
          const pres = room.presence || {};
          const seatsObj = room.seats || {};
          const activeSeats = [0, 1, 2].filter((s) => seatsObj[s] && pres[seatsObj[s].uid]);
          // If this same uid is already seated in a fresh room, prefer freeing or avoiding duplicates
          return activeSeats.length > 0 && activeSeats.length < this.rules.seats;
        })
        .sort((a, b) => Number(b[1].meta.updatedAt || 0) - Number(a[1].meta.updatedAt || 0));

      for (const [roomId, roomData] of candidates) {
        const currentRound = Number(roomData.game?.round || 0);
        const seatsObj = roomData.seats || {};
        // First check if our uid already occupies a seat (e.g., rapid refresh before onDisconnect fired)
        const existingSeat = [0, 1, 2].find((s) => seatsObj[s] && seatsObj[s].uid === uid);
        const preferredOrder = existingSeat != null ? [existingSeat] : [0, 1, 2];
        for (const seatIdx of preferredOrder) {
          if (existingSeat == null && seatsObj[seatIdx]) continue;
          const seatRef = db.ref(`rooms/${roomId}/seats/${seatIdx}`);
          const payload = this._buildSeatPayload(uid, profile, currentRound);
          const tx = await seatRef.transaction((curr) => {
            if (curr && curr.uid !== uid) return; // abort: taken
            return payload;
          });
          if (tx.committed) {
            await this._attachToRoom(roomId, seatIdx, uid, false);
            return true;
          }
        }
      }

      // No open room had a free seat -> create a fresh room as Host on Seat 0
      const newRoomRef = roomsRef.push();
      const newRoomId = newRoomRef.key;
      const tempEngine = this._buildEngineInstance([profile.bankroll, 0, 0]);
      const seat0 = this._buildSeatPayload(uid, profile, 0);
      await newRoomRef.child("meta").set({
        hostUid: uid,
        createdAt: this.fb.serverTimestamp,
        updatedAt: this.fb.serverTimestamp,
      });
      await Promise.all([
        newRoomRef.child(`presence/${uid}`).set({ uid, seat: 0, online: true, ts: this.fb.serverTimestamp }),
        newRoomRef.child("seats/0").set(seat0),
        newRoomRef.child("game").set({
          seq: 0,
          round: 0,
          phase: tempEngine.phase,
          snapshot: tempEngine.getSnapshot(),
          sheriffNotice: null,
        }),
        newRoomRef.child("engineSnapshot").set(tempEngine.exportEngineState()),
      ]);
      await this._attachToRoom(newRoomId, 0, uid, true, tempEngine);
      return true;
    }

    async _attachToRoom(roomId, seatIdx, uid, asCreator, prebuiltEngine) {
      this.offlineMode = false;
      this.roomId = roomId;
      this.mySeat = seatIdx;
      this._chatJoinCutoff = Date.now() - 1500;
      const db = this.fb.db;
      const roomRef = db.ref(`rooms/${roomId}`);

      const registerOnDisconnect = () => {
        if (this._leaving || !this.roomId) return;
        const pRef = roomRef.child(`presence/${uid}`);
        const sRef = roomRef.child(`seats/${seatIdx}`);
        pRef.onDisconnect().remove().catch(() => {});
        sRef.onDisconnect().remove().catch(() => {});
        pRef.set({ uid, seat: seatIdx, online: true, ts: this.fb.serverTimestamp }).catch(() => {});
      };

      registerOnDisconnect();
      this._connUnsub = this.fb.onConnectionChange((online) => {
        if (online) registerOnDisconnect();
      });

      // Clear stale kicked notice for self if re-joining
      roomRef.child(`kicked/${uid}`).remove().catch(() => {});

      const metaRef = roomRef.child("meta");
      const seatsRef = roomRef.child("seats");
      const presRef = roomRef.child("presence");
      const gameRef = roomRef.child("game");
      const chatRef = roomRef.child("chat");
      const kickedRef = roomRef.child(`kicked/${uid}`);

      const onMeta = (snap) => {
        this.meta = snap.val();
        this._evaluateHostRole();
      };
      const onSeats = (snap) => {
        const val = snap.val() || {};
        const prevSeats = this.seats;
        this.seats = [val[0] || null, val[1] || null, val[2] || null];
        this._handleSeatsUpdated(prevSeats, this.seats);
      };
      const onPres = (snap) => {
        this.presence = snap.val() || {};
        this._evaluateHostRole();
        this.onSeatRender();
      };
      const onGame = (snap) => {
        const g = snap.val();
        if (!g) return;
        this._handleGameUpdate(g);
      };
      const onChatAdded = (snap) => {
        const msg = snap.val();
        if (!msg || !msg.text) return;
        if (msg.ts && msg.ts < this._chatJoinCutoff) return;
        if (!Number.isInteger(msg.seat) || msg.seat < 0 || msg.seat > 2) return;
        this.onChatMessage({ seat: msg.seat, text: msg.text, name: msg.name || "" });
      };
      const onKicked = (snap) => {
        const k = snap.val();
        if (!k) return;
        kickedRef.remove().catch(() => {});
        const reason = k.reason || "Šerif tě vyprovodil od stolu kvůli neaktivitě.";
        void this.leaveTable().then(() => this.onKicked(reason));
      };

      metaRef.on("value", onMeta);
      seatsRef.on("value", onSeats);
      presRef.on("value", onPres);
      gameRef.on("value", onGame);
      chatRef.limitToLast(6).on("child_added", onChatAdded);
      kickedRef.on("value", onKicked);

      this._roomListeners.push(
        () => metaRef.off("value", onMeta),
        () => seatsRef.off("value", onSeats),
        () => presRef.off("value", onPres),
        () => gameRef.off("value", onGame),
        () => chatRef.off("child_added", onChatAdded),
        () => kickedRef.off("value", onKicked)
      );

      if (asCreator && prebuiltEngine) {
        await this._becomeHost(prebuiltEngine);
      }

      // Heartbeat keeps meta.updatedAt fresh while Host
      this._heartbeatTimer = setInterval(() => {
        if (this.isHost && this.roomId && !this._leaving) {
          metaRef.update({ updatedAt: this.fb.serverTimestamp }).catch(() => {});
        }
      }, 12000);

      this._watchdogTimer = setInterval(() => {
        if (this.isHost && !this._leaving) {
          this._runWatchdog();
        }
      }, 2000);
    }

    /* ============================ Host Logic ============================ */

    _buildEngineInstance(seatBankrolls) {
      const bus = new MBJ.EventBus();
      const eng = new MBJ.BlackjackEngine({
        bus,
        rules: this.rules,
        seatBankrolls: seatBankrolls || [0, 0, 0],
      });
      this._hostBus = bus;
      bus.on("*", (payload, name) => {
        if (this._capturedEvents) {
          this._capturedEvents.push({ name, payload: JSON.parse(JSON.stringify(payload || {})) });
        }
      });
      return eng;
    }

    async _evaluateHostRole() {
      if (this.offlineMode || this._leaving || !this.meta || !this.fb.auth.currentUser) return;
      const myUid = this.fb.auth.currentUser.uid;
      const hostUid = this.meta.hostUid;

      if (hostUid === myUid) {
        if (!this.isHost) await this._becomeHost();
        return;
      }

      const hostPresent = Boolean(hostUid && this.presence[hostUid]);
      if (hostPresent) return;

      // Elect lowest online seated player
      const onlineSeat = [0, 1, 2].find((s) => this.seats[s] && this.presence[this.seats[s].uid]);
      if (onlineSeat !== this.mySeat) return;

      const metaRef = this.fb.db.ref(`rooms/${this.roomId}/meta`);
      const tx = await metaRef.transaction((curr) => {
        if (!curr) return curr;
        if (curr.hostUid && this.presence[curr.hostUid]) return; // someone else already took over
        return Object.assign({}, curr, { hostUid: myUid, updatedAt: Date.now() });
      });
      if (tx.committed && !this.isHost) {
        await this._becomeHost();
      }
    }

    async _becomeHost(prebuiltEngine) {
      if (this.isHost || this._leaving || !this.roomId) return;
      this.isHost = true;

      const roomRef = this.fb.db.ref(`rooms/${this.roomId}`);
      if (prebuiltEngine) {
        this.hostEngine = prebuiltEngine;
        this._eventsSeq = 0;
        this._lastAppliedSeq = 0;
      } else {
        const [engSnap, gameSnap] = await Promise.all([
          roomRef.child("engineSnapshot").once("value"),
          roomRef.child("game").once("value"),
        ]);
        const engData = engSnap.val();
        const gData = gameSnap.val();
        this.hostEngine = this._buildEngineInstance([0, 0, 0]);
        if (engData) this.hostEngine.importEngineState(engData);
        this._eventsSeq = gData && Number.isFinite(gData.seq) ? gData.seq : 0;
        this._lastAppliedSeq = Math.max(this._lastAppliedSeq, this._eventsSeq);
      }

      // Listen for incoming player actions
      const actionsRef = roomRef.child("actions");
      const onActionAdded = (snap) => {
        const action = snap.val();
        const key = snap.key;
        if (!action || this._processedActions.has(key)) return;
        this._processedActions.add(key);
        this._processHostAction(key, action);
      };
      actionsRef.on("child_added", onActionAdded);
      this._roomListeners.push(() => actionsRef.off("child_added", onActionAdded));

      // Check immediately if a vanished seat stalled the current round or if betting is already ready
      this._syncSeatsToHostEngine();
      this._checkMissingSeatProgress();
      this._checkBettingReadyToDeal();
    }

    _executeHostAction(fn) {
      if (!this.hostEngine) return { ok: false, reason: "no-engine" };
      this._capturedEvents = [];
      let res;
      try {
        res = fn();
      } finally {
        const batch = this._capturedEvents;
        this._capturedEvents = null;
        if (batch && batch.length > 0) {
          this._syncMirrorFromHostEngine();
          // Emit locally on Host's sceneBus immediately (skipping duplicate replay when RTDB echoes)
          for (const ev of batch) {
            this.bus.emit(ev.name, ev.payload);
          }
          if (!this.offlineMode && this.roomId) {
            this._eventsSeq += 1;
            const seq = this._eventsSeq;
            this._lastAppliedSeq = seq;
            const snap = this.hostEngine.getSnapshot();
            const engSnap = this.hostEngine.exportEngineState();
            const roomRef = this.fb.db.ref(`rooms/${this.roomId}`);
            const startedRound = batch.some((e) => e.name === "round:started");

            const updates = {
              "game/seq": seq,
              "game/round": snap.round,
              "game/phase": snap.phase,
              "game/snapshot": snap,
              engineSnapshot: engSnap,
              "meta/updatedAt": this.fb.serverTimestamp,
            };
            if (startedRound) {
              // Keep RTDB payload small by replacing batches when a new round deals
              updates["game/batches"] = { [seq]: batch };
            } else {
              updates[`game/batches/${seq}`] = batch;
            }
            roomRef.update(updates).catch((err) => console.warn("[MBJack host write]", err));
          }
        }
      }
      return res;
    }

    _processHostAction(actionKey, action) {
      if (!this.isHost || !this.hostEngine || this._leaving) return;
      const roomRef = this.fb.db.ref(`rooms/${this.roomId}`);
      const removeAction = () => roomRef.child(`actions/${actionKey}`).remove().catch(() => {});

      const seat = Number(action.seat);
      const seatData = this.seats[seat];
      if (!seatData || seatData.uid !== action.uid) {
        removeAction();
        return;
      }

      if (action.type === "newRound") {
        if (this.hostEngine.phase !== MBJ.PHASE.ROUND_OVER || action.round !== this.hostEngine.state.round) {
          removeAction();
          return;
        }
        this._roundReadySeats[seat] = true;
        if (action.autoRebet) this._autoRebetSeats[seat] = true;
        removeAction();
        this._checkRoundOverAdvance();
        return;
      }

      const active = this.hostEngine.activeHand;
      if (!active || active.seat !== seat) {
        removeAction();
        return;
      }

      const type = action.type;
      if (type === "insurance") {
        this._executeHostAction(() => this.hostEngine.insurance(Boolean(action.take)));
      } else if (["hit", "stand", "double", "split", "surrender"].includes(type)) {
        this._executeHostAction(() => this.hostEngine[type]());
      }
      removeAction();
    }

    _checkRoundOverAdvance() {
      if (!this.isHost || !this.hostEngine || this.hostEngine.phase !== MBJ.PHASE.ROUND_OVER) return;
      const activeRoundSeats = new Set((this.hostEngine.state.hands || []).map((h) => h.seat));
      const onlineRoundSeats = [0, 1, 2].filter(
        (s) => activeRoundSeats.has(s) && this.seats[s] && (this.offlineMode || this.presence[this.seats[s].uid])
      );

      const allClicked =
        onlineRoundSeats.length === 0 || onlineRoundSeats.every((s) => Boolean(this._roundReadySeats[s]));

      const advanceNow = () => {
        clearTimeout(this._newRoundTimer);
        this._newRoundTimer = null;
        if (!this.hostEngine || this.hostEngine.phase !== MBJ.PHASE.ROUND_OVER) return;
        this._roundReadySeats = {};
        this._autoRebetSeats = {};
        this._executeHostAction(() => this.hostEngine.newRound());
      };

      if (allClicked) {
        advanceNow();
      } else if (!this._newRoundTimer) {
        // Gentle automatic advance after 6s once the first player clicked "Nové kolo"
        this._newRoundTimer = setTimeout(advanceNow, NEW_ROUND_AUTO_MS);
      }
    }

    _syncSeatsToHostEngine() {
      if (!this.isHost || !this.hostEngine) return;
      const eng = this.hostEngine;
      if (eng.phase !== MBJ.PHASE.BETTING) return;

      const r = eng.state.round;
      for (let s = 0; s < this.rules.seats; s += 1) {
        const seatData = this.seats[s];
        if (!seatData) {
          eng.state.seatBets[s] = 0;
          if (eng.state.seatBankrolls) eng.state.seatBankrolls[s] = 0;
          continue;
        }
        const validForRound = Number(seatData.betRound) === r;
        eng.state.seatBets[s] = validForRound ? Math.max(0, Math.round(Number(seatData.bet) || 0)) : 0;
        if (eng.state.seatBankrolls) {
          eng.state.seatBankrolls[s] = Math.max(0, Math.round(Number(seatData.bankroll) || 0));
        }
      }
      if (eng.state.seatBankrolls) {
        eng.state.bankroll = eng.state.seatBankrolls.reduce((a, b) => a + b, 0);
      }
    }

    _checkBettingReadyToDeal() {
      if (!this.isHost || !this.hostEngine || this.hostEngine.phase !== MBJ.PHASE.BETTING) return;
      const r = this.hostEngine.state.round;
      const occupied = [0, 1, 2].filter((s) => Boolean(this.seats[s]));
      if (occupied.length === 0) return;

      const allReady = occupied.every((s) => {
        const sd = this.seats[s];
        const bet = Number(sd.betRound) === r ? Number(sd.bet) || 0 : 0;
        return Boolean(sd.ready && Number(sd.readyRound) === r && bet >= this.rules.minBet);
      });

      if (allReady) {
        this._syncSeatsToHostEngine();
        if (this.hostEngine.canDeal()) {
          this._roundReadySeats = {};
          this._autoRebetSeats = {};
          clearTimeout(this._newRoundTimer);
          this._newRoundTimer = null;
          this._betWarnedSeats.clear();
          this._betWatchSince = 0;
          this._executeHostAction(() => this.hostEngine.deal());
        }
      }
    }

    _checkMissingSeatProgress() {
      if (!this.isHost || !this.hostEngine) return;
      const eng = this.hostEngine;
      if (eng.phase !== MBJ.PHASE.PLAYER && eng.phase !== MBJ.PHASE.INSURANCE) return;

      let guard = 0;
      while (guard < 12 && (eng.phase === MBJ.PHASE.PLAYER || eng.phase === MBJ.PHASE.INSURANCE)) {
        const active = eng.activeHand;
        if (!active) break;
        const occupant = this.seats[active.seat];
        if (occupant) break;
        guard += 1;
        if (eng.phase === MBJ.PHASE.INSURANCE) {
          this._executeHostAction(() => eng.insurance(false));
        } else {
          this._executeHostAction(() => eng.stand());
        }
      }
    }

    _publishSheriffNotice(text, mood, targetSeat) {
      if (this.offlineMode) {
        this.onDealerLine(text, mood);
        return;
      }
      if (!this.isHost || !this.roomId) return;
      const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      this._lastNoticeId = id;
      this.onDealerLine(text, mood);
      this.fb.db
        .ref(`rooms/${this.roomId}/game/sheriffNotice`)
        .set({ id, text, mood: mood || "neutral", targetSeat: targetSeat ?? -1, ts: this.fb.serverTimestamp })
        .catch(() => {});
    }

    _runWatchdog() {
      if (!this.isHost || !this.hostEngine || this.offlineMode) return;
      const eng = this.hostEngine;
      const now = Date.now();
      const occupied = [0, 1, 2].filter((s) => Boolean(this.seats[s]));
      const multiPlayer = occupied.length >= 2;

      // 1) Turn / Insurance AFK
      if (eng.phase === MBJ.PHASE.PLAYER || eng.phase === MBJ.PHASE.INSURANCE) {
        const active = eng.activeHand;
        if (!active) return;
        const seat = active.seat;
        const occupant = this.seats[seat];
        if (!occupant) {
          this._checkMissingSeatProgress();
          return;
        }
        const key = `${eng.state.round}:${eng.phase}:${active.id}`;
        const seatActiveTs = Number(occupant.lastActiveAt || 0);
        if (key !== this._turnWatchKey) {
          this._turnWatchKey = key;
          this._turnWatchSince = Math.max(now, seatActiveTs);
          this._turnWarnedKey = "";
        } else if (seatActiveTs > this._turnWatchSince) {
          this._turnWatchSince = seatActiveTs;
          this._turnWarnedKey = "";
        }
        const idle = now - this._turnWatchSince;
        if (idle >= AFK_WARN_MS && this._turnWarnedKey !== key) {
          this._turnWarnedKey = key;
          this._publishSheriffNotice(`Hej kovboji ${occupant.firstName}, hraješ nebo u toho stolu usínáš?`, "grumpy", seat);
        } else if (multiPlayer && idle >= AFK_KICK_MS) {
          this._kickIdleSeat(seat, occupant, `${occupant.firstName} usnul nad kartami. Vyprovodil jsem ho ze stolu!`);
        }
        return;
      }

      // Reset turn watch outside turn phases
      this._turnWatchKey = "";
      this._turnWarnedKey = "";

      // 2) Betting AFK when 2+ players are seated and at least one is ready
      if (eng.phase === MBJ.PHASE.BETTING && multiPlayer) {
        const r = eng.state.round;
        const anyReady = occupied.some((s) => this.seats[s].ready && Number(this.seats[s].readyRound) === r);
        if (!anyReady) {
          this._betWatchSince = 0;
          this._betWarnedSeats.clear();
          return;
        }
        if (!this._betWatchSince) this._betWatchSince = now;
        for (const s of occupied) {
          const sd = this.seats[s];
          if (sd.ready && Number(sd.readyRound) === r) {
            this._betWarnedSeats.delete(s);
            continue;
          }
          const lastAct = Math.max(this._betWatchSince, Number(sd.lastActiveAt || 0));
          const idle = now - lastAct;
          if (idle >= AFK_WARN_MS && !this._betWarnedSeats.has(s)) {
            this._betWarnedSeats.add(s);
            this._publishSheriffNotice(`Hej kovboji ${sd.firstName}, sázíš nebo u toho stolu usínáš?`, "grumpy", s);
          } else if (idle >= AFK_KICK_MS) {
            this._kickIdleSeat(s, sd, `${sd.firstName} se neozýval, tak jsem mu uvolnil židli.`);
          }
        }
      } else {
        this._betWatchSince = 0;
        this._betWarnedSeats.clear();
      }
    }

    _kickIdleSeat(seat, seatData, line) {
      if (!this.isHost || !this.roomId || !seatData) return;
      const roomRef = this.fb.db.ref(`rooms/${this.roomId}`);
      this._publishSheriffNotice(line, "grumpy", seat);
      roomRef.child(`kicked/${seatData.uid}`).set({
        reason: "Šerif tě slušně vyprovodil od stolu kvůli neaktivitě.",
        ts: this.fb.serverTimestamp,
      }).catch(() => {});
      roomRef.child(`seats/${seat}`).remove().catch(() => {});
      this.seats[seat] = null;
      this._checkMissingSeatProgress();
      this._checkBettingReadyToDeal();
    }

    /* ========================== Client Sync & Replay ========================== */

    _handleSeatsUpdated(prevSeats, nextSeats) {
      const round = this.mirror.round;
      const inBetting = this.mirror.phase === MBJ.PHASE.BETTING;

      for (let s = 0; s < this.rules.seats; s += 1) {
        const prev = prevSeats[s];
        const curr = nextSeats[s];

        if (prev && !curr && s !== this.mySeat) {
          if (this.mirror.phase === MBJ.PHASE.PLAYER || this.mirror.phase === MBJ.PHASE.INSURANCE) {
            if (this.isHost) {
              this._publishSheriffNotice(`${prev.firstName} odjel ze města. Pokračujeme dál!`, "neutral", s);
            }
          }
        }

        if (inBetting) {
          const prevBet = prev && Number(prev.betRound) === round ? Number(prev.bet) || 0 : 0;
          const nextBet = curr && Number(curr.betRound) === round ? Number(curr.bet) || 0 : 0;
          this.mirror.seatBets[s] = nextBet;
          this.mirror.seatBankrolls[s] = curr ? Number(curr.bankroll) || 0 : 0;
          if (prevBet !== nextBet) {
            this.bus.emit("bet:changed", {
              seat: s,
              bet: nextBet,
              delta: nextBet - prevBet,
              bankroll: this.mirror.seatBankrolls[s],
            });
          }
        } else if (curr) {
          this.mirror.seatBankrolls[s] = Number(curr.bankroll) || 0;
        }
      }

      if (this.isHost) {
        this._syncSeatsToHostEngine();
        this._checkMissingSeatProgress();
        this._checkBettingReadyToDeal();
      }

      this.onSeatRender();
      this.onStateChange();
    }

    _handleGameUpdate(g) {
      const snap = g.snapshot;
      if (!snap) return;

      // Check Sheriff AFK / system notices
      if (g.sheriffNotice && g.sheriffNotice.id && g.sheriffNotice.id !== this._lastNoticeId) {
        this._lastNoticeId = g.sheriffNotice.id;
        this.onDealerLine(g.sheriffNotice.text, g.sheriffNotice.mood);
      }

      // First join when a round is already underway -> hydrate visually without replaying old flights
      if (!this._hydratedOnce) {
        this._hydratedOnce = true;
        this._lastAppliedSeq = Number(g.seq || 0);
        this._applySnapshotToMirror(snap);
        if (snap.phase !== MBJ.PHASE.BETTING) {
          this.onHydrateScene(snap);
          const me = this.seats[this.mySeat];
          if (me) {
            this.onDealerLine(`Vítej u stolu, ${me.firstName}! Další kolo hraješ s námi.`, "friendly");
          }
        } else {
          // Ensure our own seat betRound matches current round
          this._syncMySeatForNewBettingRound(snap.round);
        }
        this.onSeatRender();
        this.onStateChange();
        return;
      }

      const prevPhase = this.mirror.phase;
      this._applySnapshotToMirror(snap);

      // Non-host clients replay ordered event batches
      if (!this.isHost) {
        const batches = g.batches || {};
        const seqs = Object.keys(batches)
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > this._lastAppliedSeq)
          .sort((a, b) => a - b);

        for (const seq of seqs) {
          const list = batches[seq];
          if (Array.isArray(list)) {
            for (const ev of list) {
              this.bus.emit(ev.name, ev.payload);
              this._onLocalObservedEvent(ev.name, ev.payload);
            }
          }
          this._lastAppliedSeq = seq;
        }
      } else {
        // Host already emitted events synchronously in _executeHostAction; still check local settlement/achievements
        if (prevPhase !== snap.phase && snap.phase === MBJ.PHASE.ROUND_OVER && snap.lastResult) {
          this._processMyRoundOutcome(snap.lastResult);
        }
      }

      // When transitioning INTO round:started (bet -> hands), clear our own seat bet & ready flag
      if (prevPhase === MBJ.PHASE.BETTING && snap.phase !== MBJ.PHASE.BETTING) {
        this._myPendingNewRound = false;
        this._clearMySeatBetFlags(snap.round);
      }

      // When transitioning INTO betting from roundOver (newRound), apply queued autoRebet or reset betRound
      if (prevPhase === MBJ.PHASE.ROUND_OVER && snap.phase === MBJ.PHASE.BETTING) {
        this._myPendingNewRound = false;
        this._syncMySeatForNewBettingRound(snap.round);
      }

      this.onSeatRender();
      this.onStateChange();
    }

    _onLocalObservedEvent(name, payload) {
      if (name === "round:settled" && payload) {
        this._processMyRoundOutcome(payload);
      }
    }

    _syncMirrorFromHostEngine() {
      if (!this.hostEngine) return;
      this._applySnapshotToMirror(this.hostEngine.getSnapshot());
      if (this.mirror.phase === MBJ.PHASE.ROUND_OVER && this.mirror.lastResult) {
        this._processMyRoundOutcome(this.mirror.lastResult);
      }
    }

    _applySnapshotToMirror(snap) {
      const m = this.mirror;
      m.phase = snap.phase;
      m.round = snap.round || 0;
      if (Array.isArray(snap.seatBankrolls)) {
        m.seatBankrolls = snap.seatBankrolls.slice();
      }
      if (Array.isArray(snap.seatBets)) {
        if (m.phase !== MBJ.PHASE.BETTING) {
          m.seatBets = snap.seatBets.slice();
        }
      }
      if (Array.isArray(snap.lastBets)) {
        m.lastBets = snap.lastBets.slice();
      }
      m.hands = Array.isArray(snap.hands) ? snap.hands : [];
      m.activeIndex = Number.isInteger(snap.activeIndex) ? snap.activeIndex : -1;
      m.activeHandId = snap.activeHandId || null;
      m.dealer = snap.dealer || { cards: [], holeRevealed: false };
      m.shoe = snap.shoe || m.shoe;
      m.lastResult = snap.lastResult || null;
    }

    _processMyRoundOutcome(lastResult) {
      if (!lastResult || this.mySeat < 0) return;
      if (this._settledRounds.has(lastResult.round)) return;

      const mySeatRes = Array.isArray(lastResult.seatResults)
        ? lastResult.seatResults.find((sr) => sr.seat === this.mySeat)
        : null;
      if (!mySeatRes || !mySeatRes.results || mySeatRes.results.length === 0) return;

      this._settledRounds.add(lastResult.round);
      const finalBankroll = Number(mySeatRes.bankroll);
      this.mirror.seatBankrolls[this.mySeat] = finalBankroll;
      this.store.recordRoundResults(mySeatRes.results, finalBankroll);

      // Update my own RTDB seat bankroll
      if (!this.offlineMode && this.roomId) {
        this.fb.db
          .ref(`rooms/${this.roomId}/seats/${this.mySeat}`)
          .update({ bankroll: finalBankroll })
          .catch(() => {});
      }

      // Check secret achievement: natural Blackjack on any hand at my seat
      if (mySeatRes.results.some((r) => r.naturalBlackjack)) {
        const res = this.store.unlockAchievement("first_blackjack");
        if (res.newlyUnlocked && this.onAchievementUnlocked) {
          this.onAchievementUnlocked(res.achievement);
        }
      }
    }

    _clearMySeatBetFlags(newRound) {
      if (this.mySeat < 0) return;
      const myBankroll = this.mirror.seatBankrolls[this.mySeat];
      if (Number.isFinite(myBankroll)) {
        this.store.setBankroll(myBankroll);
      }
      if (!this.offlineMode && this.roomId) {
        this.fb.db
          .ref(`rooms/${this.roomId}/seats/${this.mySeat}`)
          .update({
            bet: 0,
            betRound: newRound,
            ready: false,
            readyRound: newRound,
            bankroll: this.bankroll,
          })
          .catch(() => {});
      }
    }

    _syncMySeatForNewBettingRound(round) {
      if (this.mySeat < 0) return;
      const last = this.mirror.lastBets[this.mySeat] || 0;
      const bank = this.store.current ? this.store.current.bankroll : this.bankroll;
      let nextBet = 0;
      let nextBank = bank;

      if (this._myQueuedAutoRebet && last > 0 && last <= bank) {
        nextBet = last;
        nextBank = bank - last;
      }
      this._myQueuedAutoRebet = false;

      this.mirror.seatBets[this.mySeat] = nextBet;
      this.mirror.seatBankrolls[this.mySeat] = nextBank;
      if (nextBet > 0) {
        this.bus.emit("bet:changed", { seat: this.mySeat, bet: nextBet, delta: nextBet, bankroll: nextBank });
      }
      if (this.offlineMode && this.hostEngine) {
        this.hostEngine.setSeatBankroll(this.mySeat, nextBank);
        if (nextBet > 0) {
          this.hostEngine.state.seatBets[this.mySeat] = nextBet;
        }
        return;
      }
      if (this.roomId) {
        this.fb.db
          .ref(`rooms/${this.roomId}/seats/${this.mySeat}`)
          .update({
            bet: nextBet,
            betRound: round,
            ready: false,
            readyRound: round,
            bankroll: nextBank,
            lastActiveAt: Date.now(),
          })
          .catch(() => {});
      }
    }

    /* ========================== Player Intents ========================== */

    _updateMySeat(patch) {
      if (this.mySeat < 0) return;
      const curr = this.seats[this.mySeat] || {};
      Object.assign(curr, patch);
      this.seats[this.mySeat] = curr;
      if (this.offlineMode) {
        this.onSeatRender();
        this.onStateChange();
        return;
      }
      if (this.roomId) {
        this.fb.db.ref(`rooms/${this.roomId}/seats/${this.mySeat}`).update(patch).catch(() => {});
      }
    }

    placeBet(seat, amount) {
      const check = this.canBet(seat, amount);
      if (!check.ok) return check;
      const nextBet = (this.mirror.seatBets[seat] || 0) + amount;
      const nextBank = this.bankroll - amount;
      this.mirror.seatBets[seat] = nextBet;
      this.mirror.seatBankrolls[seat] = nextBank;

      if (this.offlineMode && this.hostEngine) {
        const res = this.hostEngine.placeBet(seat, amount);
        if (res.ok) {
          this._syncMirrorFromHostEngine();
          this.bus.emit("bet:changed", { seat, bet: nextBet, delta: amount, bankroll: nextBank });
          this.onStateChange();
        }
        return res;
      }

      this._updateMySeat({
        bet: nextBet,
        betRound: this.mirror.round,
        bankroll: nextBank,
        ready: false,
        readyRound: this.mirror.round,
        lastActiveAt: Date.now(),
      });
      this.bus.emit("bet:changed", { seat, bet: nextBet, delta: amount, bankroll: nextBank });
      return { ok: true, bet: nextBet };
    }

    removeBet(seat, amount) {
      if (seat !== this.mySeat || this.mirror.phase !== MBJ.PHASE.BETTING) return { ok: false };
      if (this.seats[seat]?.ready && this.seats[seat]?.readyRound === this.mirror.round) return { ok: false };
      const curr = this.mirror.seatBets[seat] || 0;
      if (curr <= 0) return { ok: false };
      const take = Number.isInteger(amount) && amount > 0 ? Math.min(amount, curr) : curr;
      const nextBet = curr - take;
      const nextBank = this.bankroll + take;
      this.mirror.seatBets[seat] = nextBet;
      this.mirror.seatBankrolls[seat] = nextBank;

      if (this.offlineMode && this.hostEngine) {
        const res = this.hostEngine.removeBet(seat, amount);
        if (res.ok) {
          this._syncMirrorFromHostEngine();
          this.bus.emit("bet:changed", { seat, bet: nextBet, delta: -take, bankroll: nextBank });
          this.onStateChange();
        }
        return res;
      }

      this._updateMySeat({
        bet: nextBet,
        betRound: this.mirror.round,
        bankroll: nextBank,
        ready: false,
        readyRound: this.mirror.round,
        lastActiveAt: Date.now(),
      });
      this.bus.emit("bet:changed", { seat, bet: nextBet, delta: -take, bankroll: nextBank });
      return { ok: true, bet: nextBet };
    }

    clearBets() {
      return this.removeBet(this.mySeat);
    }

    rebet() {
      if (!this.canRebet()) return { ok: false };
      const target = this.mirror.lastBets[this.mySeat] || 0;
      const delta = target - (this.mirror.seatBets[this.mySeat] || 0);
      if (delta <= 0) return { ok: false };
      return this.placeBet(this.mySeat, delta);
    }

    rebuy() {
      if (!this.isBroke()) return { ok: false };
      const fresh = this.rules.startingBankroll;
      this.mirror.seatBankrolls[this.mySeat] = fresh;
      this.store.setBankroll(fresh);
      if (this.offlineMode && this.hostEngine) {
        this.hostEngine.rebuy(this.mySeat);
        this._syncMirrorFromHostEngine();
      } else {
        this._updateMySeat({ bankroll: fresh, lastActiveAt: Date.now() });
      }
      this.bus.emit("bankroll:rebuy", { seat: this.mySeat, bankroll: fresh });
      this.onStateChange();
      return { ok: true };
    }

    deal() {
      if (!this.canDeal()) return { ok: false };
      if (this.offlineMode && this.hostEngine) {
        const res = this._executeHostAction(() => this.hostEngine.deal());
        this.onStateChange();
        return res;
      }
      this._updateMySeat({
        ready: true,
        readyRound: this.mirror.round,
        betRound: this.mirror.round,
        lastActiveAt: Date.now(),
      });
      const occupiedCount = this.seats.filter(Boolean).length;
      if (occupiedCount > 1) {
        this.onDealerLine("Sázka na stole! Čekáme na ostatní kovboje…", "friendly");
      }
      return { ok: true };
    }

    _sendTurnAction(type, extra) {
      if (this.mySeat < 0) return { ok: false };
      if (this.offlineMode && this.hostEngine) {
        const res = this._executeHostAction(() => {
          if (type === "insurance") return this.hostEngine.insurance(Boolean(extra?.take));
          return this.hostEngine[type]();
        });
        this.onStateChange();
        return res;
      }
      const uid = this.fb.auth.currentUser ? this.fb.auth.currentUser.uid : null;
      if (!uid || !this.roomId) return { ok: false };

      this._updateMySeat({ lastActiveAt: Date.now() });
      const payload = Object.assign(
        {
          uid,
          seat: this.mySeat,
          type,
          round: this.mirror.round,
          ts: this.fb.serverTimestamp,
        },
        extra || {}
      );
      this.fb.db.ref(`rooms/${this.roomId}/actions`).push(payload).catch(() => {});
      return { ok: true };
    }

    insurance(take) {
      if (!this.getAvailableActions().insurance) return { ok: false };
      if (take && !this.getAvailableActions().insuranceAffordable) return { ok: false };
      return this._sendTurnAction("insurance", { take: Boolean(take) });
    }

    hit() {
      if (!this.getAvailableActions().hit) return { ok: false };
      return this._sendTurnAction("hit");
    }

    stand() {
      if (!this.getAvailableActions().stand) return { ok: false };
      return this._sendTurnAction("stand");
    }

    double() {
      if (!this.getAvailableActions().double) return { ok: false };
      return this._sendTurnAction("double");
    }

    split() {
      if (!this.getAvailableActions().split) return { ok: false };
      return this._sendTurnAction("split");
    }

    surrender() {
      if (!this.getAvailableActions().surrender) return { ok: false };
      return this._sendTurnAction("surrender");
    }

    newRound(options) {
      if (this.mirror.phase !== MBJ.PHASE.ROUND_OVER || this._myPendingNewRound) return { ok: false };
      const autoRebet = Boolean(options && options.autoRebet);
      this._myQueuedAutoRebet = autoRebet;

      if (this.offlineMode && this.hostEngine) {
        const res = this._executeHostAction(() => this.hostEngine.newRound());
        if (res.ok) {
          this._syncMySeatForNewBettingRound(this.mirror.round);
        }
        this.onStateChange();
        return res;
      }

      this._myPendingNewRound = true;
      this.onStateChange();
      return this._sendTurnAction("newRound", { autoRebet });
    }

    sendChatMessage(rawText) {
      const text = String(rawText || "").trim().slice(0, 120);
      if (!text || this.mySeat < 0) return false;

      if (this.offlineMode) {
        this.onChatMessage({ seat: this.mySeat, text, name: this.store.getFullName() });
        return true;
      }

      const uid = this.fb.auth.currentUser ? this.fb.auth.currentUser.uid : null;
      if (!uid || !this.roomId) return false;
      this._updateMySeat({ lastActiveAt: Date.now() });
      this.fb.db
        .ref(`rooms/${this.roomId}/chat`)
        .push({
          uid,
          seat: this.mySeat,
          name: this.store.getFullName(),
          text,
          ts: this.fb.serverTimestamp,
        })
        .catch(() => {});
      return true;
    }

    getSeatCount() {
      return this.seats.filter(Boolean).length;
    }

    syncProfileIdentity(profile) {
      if (!profile || this.mySeat < 0) return;
      this._updateMySeat({
        firstName: profile.firstName,
        lastName: profile.lastName,
        avatarId: profile.avatarId,
        bankroll: profile.bankroll,
      });
    }
  }

  MBJ.MultiplayerTable = MultiplayerTable;
})(window);
