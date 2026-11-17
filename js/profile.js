/* Player profile, stats, western name generator & secret achievements.
   Supports local-only ("Jedu jen kolem") via localStorage and cloud-synced
   ("Jsem z města") via Firebase Realtime Database + Google Auth. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});

  const STORAGE_KEY = "mbjack_profile_v1";

  const WESTERN_NAMES = Object.freeze([
    ["Divoký", "Bill"],
    ["Banánový", "Joe"],
    ["Calamity", "Jane"],
    ["Jesse", "James"],
    ["Šerif", "Sam"],
    ["Lucky", "Luke"],
    ["Černý", "Jack"],
    ["Kit", "Carson"],
    ["Luke", "Duke"],
    ["Wyatt", "Earp"],
    ["Doc", "Holliday"],
    ["Belle", "Starr"],
    ["Annie", "Oakley"],
    ["Butch", "Cassidy"],
    ["Sundance", "Kid"],
    ["Jednooký", "Joe"],
    ["Kojot", "Jack"],
    ["Zlatozubý", "Pete"],
    ["Rychlý", "Gonzales"],
    ["Bleskový", "Ben"],
    ["Krvavá", "Mary"],
    ["Červený", "Jestřáb"],
    ["Stříbrný", "Jim"],
    ["Prachový", "Dan"],
    ["Železný", "Pete"],
    ["Hromový", "Bill"],
    ["Kouřový", "Joe"],
    ["Falešný", "Frank"],
    ["Dáma", "Ruby"],
    ["Pokerový", "Pete"],
    ["Tichý", "Bob"],
    ["Žíznivý", "Hank"],
    ["Mazaný", "Fox"],
    ["Mexický", "Pablo"],
    ["Zlatá", "Lil"],
    ["Věčný", "Charlie"],
    ["Divoká", "Rose"],
    ["Ocelový", "Joe"],
    ["Černý", "Bart"],
    ["Buffalo", "Bill"],
    ["Mladý", "Billy"],
    ["Kaktusový", "Carl"],
  ]);

  const AVATARS = Object.freeze([
    { id: 1, unlocked: true, src: "assets/avatar-1.jpg", label: "Pistolník" },
    { id: 2, unlocked: true, src: "assets/avatar-2.jpg", label: "Střelkyně" },
    { id: 3, unlocked: true, src: "assets/avatar-3.jpg", label: "Karetní vlk" },
    { id: 4, unlocked: false, src: "", label: "Tajemný cizinec" },
    { id: 5, unlocked: false, src: "", label: "Zlatokop" },
    { id: 6, unlocked: false, src: "", label: "Saloonová hvězda" },
  ]);

  const ACHIEVEMENTS_CATALOG = Object.freeze({
    first_blackjack: Object.freeze({
      id: "first_blackjack",
      title: "První Blackjack!",
      subtitle: "Eso z rukávu",
      description: "Získej čistý Blackjack (Eso + karta hodnoty 10 na první dvě karty).",
    }),
  });

  function sanitizeName(str) {
    return String(str || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 24);
  }

  function defaultProfile(opts) {
    const o = opts || {};
    return {
      mode: o.mode === "google" ? "google" : "local",
      uid: o.uid || null,
      firstName: sanitizeName(o.firstName) || "Luke",
      lastName: sanitizeName(o.lastName) || "Duke",
      avatarId: [1, 2, 3].includes(Number(o.avatarId)) ? Number(o.avatarId) : 1,
      bankroll: Number.isFinite(Number(o.bankroll))
        ? Math.max(0, Math.round(Number(o.bankroll)))
        : MBJ.RULES.startingBankroll,
      stats: {
        gamesPlayed: Math.max(0, Math.round(Number(o.stats?.gamesPlayed) || 0)),
        wins: Math.max(0, Math.round(Number(o.stats?.wins) || 0)),
        losses: Math.max(0, Math.round(Number(o.stats?.losses) || 0)),
      },
      achievements: o.achievements && typeof o.achievements === "object" ? Object.assign({}, o.achievements) : {},
    };
  }

  class ProfileStore {
    constructor(firebaseBridge) {
      this.fb = firebaseBridge;
      this.current = null;
      this._listeners = new Set();
    }

    onChange(fn) {
      this._listeners.add(fn);
      return () => this._listeners.delete(fn);
    }

    _notify() {
      for (const fn of this._listeners) {
        try {
          fn(this.current);
        } catch (_) {}
      }
    }

    pickRandomName(previousFirst, previousLast) {
      let pool = WESTERN_NAMES;
      if (previousFirst && previousLast && pool.length > 1) {
        const filtered = pool.filter(([f, l]) => f !== previousFirst || l !== previousLast);
        if (filtered.length) pool = filtered;
      }
      const [first, last] = pool[Math.floor(Math.random() * pool.length)];
      return { firstName: first, lastName: last };
    }

    getAvatarSrc(avatarId) {
      const found = AVATARS.find((a) => a.id === Number(avatarId) && a.unlocked);
      return found ? found.src : AVATARS[0].src;
    }

    getFullName(profile = this.current) {
      if (!profile) return "";
      return `${profile.firstName} ${profile.lastName}`.trim();
    }

    loadLocalRaw() {
      try {
        const raw = global.localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.firstName || !parsed.lastName) return null;
        return defaultProfile(Object.assign({}, parsed, { mode: "local" }));
      } catch (_) {
        return null;
      }
    }

    saveLocal(profile) {
      try {
        const clean = defaultProfile(Object.assign({}, profile, { mode: "local", uid: null }));
        global.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
      } catch (_) {}
    }

    clearLocal() {
      try {
        global.localStorage.removeItem(STORAGE_KEY);
      } catch (_) {}
    }

    async resolveInitialProfile() {
      const fbReady = this.fb && this.fb.isAvailable();
      if (fbReady) {
        const user = await this.fb.waitForInitialAuth();
        if (user && !user.isAnonymous) {
          try {
            const remote = await this.fb.loadUserProfile(user.uid);
            if (remote && remote.firstName && remote.lastName) {
              this.current = defaultProfile(Object.assign({}, remote, { mode: "google", uid: user.uid }));
              this.fb.attachPresence(user.uid);
              this._notify();
              return this.current;
            }
          } catch (err) {
            console.warn("[MBJack] Nepodařilo se načíst profil z Firebase:", err);
          }
        }
      }

      const local = this.loadLocalRaw();
      if (local) {
        if (fbReady) {
          try {
            const guestUser = await this.fb.ensureGuestSession();
            if (guestUser) {
              local.uid = guestUser.uid;
              this.fb.attachPresence(guestUser.uid);
            }
          } catch (err) {
            console.warn("[MBJack] Guest auth se nezdařila:", err);
          }
        }
        this.current = local;
        this._notify();
        return this.current;
      }

      this.current = null;
      this._notify();
      return null;
    }

    async createLocalProfile({ firstName, lastName, avatarId }) {
      const profile = defaultProfile({
        mode: "local",
        firstName,
        lastName,
        avatarId,
        bankroll: MBJ.RULES.startingBankroll,
      });
      this.saveLocal(profile);
      if (this.fb && this.fb.isAvailable()) {
        try {
          // If signed in as Google previously, make sure we don't overwrite a Google user session.
          if (this.fb.auth.currentUser && !this.fb.auth.currentUser.isAnonymous) {
            await this.fb.signOut();
          }
          const guestUser = await this.fb.ensureGuestSession();
          if (guestUser) {
            profile.uid = guestUser.uid;
            this.fb.attachPresence(guestUser.uid);
          }
        } catch (err) {
          console.warn("[MBJack] Guest auth chyba:", err);
        }
      }
      this.current = profile;
      this._notify();
      return profile;
    }

    async signInWithGoogleProfile({ firstName, lastName, avatarId, hasFormValues }) {
      if (!this.fb || !this.fb.isAvailable()) {
        throw new Error("Firebase není připojeno.");
      }
      const user = await this.fb.signInWithGoogle();
      const existing = await this.fb.loadUserProfile(user.uid);
      let profile;
      if (existing && existing.firstName && existing.lastName) {
        profile = defaultProfile(
          Object.assign({}, existing, {
            mode: "google",
            uid: user.uid,
            firstName: hasFormValues && sanitizeName(firstName) ? firstName : existing.firstName,
            lastName: hasFormValues && sanitizeName(lastName) ? lastName : existing.lastName,
            avatarId: hasFormValues ? avatarId : existing.avatarId,
          })
        );
        if (hasFormValues) {
          await this.fb.saveUserProfile(user.uid, profile);
        }
      } else {
        const cleanFirst = sanitizeName(firstName);
        const cleanLast = sanitizeName(lastName);
        if (!cleanFirst || !cleanLast) {
          // Use Google display name fallback if user had an empty form on brand-new account
          const parts = String(user.displayName || "").trim().split(/\s+/);
          const fallbackFirst = cleanFirst || parts[0] || "";
          const fallbackLast = cleanLast || parts.slice(1).join(" ") || "";
          if (!fallbackFirst || !fallbackLast) {
            await this.fb.signOut();
            const err = new Error("NEED_NAME");
            err.code = "NEED_NAME";
            throw err;
          }
          profile = defaultProfile({
            mode: "google",
            uid: user.uid,
            firstName: fallbackFirst,
            lastName: fallbackLast,
            avatarId,
            bankroll: MBJ.RULES.startingBankroll,
          });
        } else {
          profile = defaultProfile({
            mode: "google",
            uid: user.uid,
            firstName: cleanFirst,
            lastName: cleanLast,
            avatarId,
            bankroll: MBJ.RULES.startingBankroll,
          });
        }
        await this.fb.saveUserProfile(user.uid, profile);
      }

      this.clearLocal();
      this.fb.attachPresence(user.uid);
      this.current = profile;
      this._notify();
      return profile;
    }

    async upgradeLocalToGoogle() {
      if (!this.current || this.current.mode !== "local") return this.current;
      if (!this.fb || !this.fb.isAvailable()) throw new Error("Firebase není připojeno.");
      const prev = Object.assign({}, this.current);
      const user = await this.fb.signInWithGoogle();
      const existing = await this.fb.loadUserProfile(user.uid);
      let merged;
      if (existing && existing.firstName && existing.lastName) {
        merged = defaultProfile({
          mode: "google",
          uid: user.uid,
          firstName: existing.firstName,
          lastName: existing.lastName,
          avatarId: existing.avatarId,
          bankroll: existing.bankroll,
          stats: existing.stats,
          achievements: Object.assign({}, existing.achievements || {}, prev.achievements || {}),
        });
      } else {
        merged = defaultProfile(Object.assign({}, prev, { mode: "google", uid: user.uid }));
      }
      await this.fb.saveUserProfile(user.uid, merged);
      this.clearLocal();
      this.fb.attachPresence(user.uid);
      this.current = merged;
      this._notify();
      return merged;
    }

    async persistCurrent() {
      if (!this.current) return;
      if (this.current.mode === "google" && this.current.uid && this.fb && this.fb.isAvailable()) {
        try {
          await this.fb.saveUserProfile(this.current.uid, this.current);
        } catch (err) {
          console.warn("[MBJack] Nepodařilo se uložit profil do Firebase:", err);
        }
      } else {
        this.saveLocal(this.current);
      }
    }

    setBankroll(amount) {
      if (!this.current) return;
      const next = Math.max(0, Math.round(Number(amount) || 0));
      if (this.current.bankroll === next) return;
      this.current.bankroll = next;
      this._notify();
      void this.persistCurrent();
    }

    recordRoundResults(handResults, finalBankroll) {
      if (!this.current) return;
      let played = 0;
      let wins = 0;
      let losses = 0;
      for (const r of handResults || []) {
        played += 1;
        if (r.result === "win" || r.result === "blackjack") wins += 1;
        else if (r.result === "lose" || r.result === "bust" || r.result === "surrender") losses += 1;
      }
      this.current.stats.gamesPlayed += played;
      this.current.stats.wins += wins;
      this.current.stats.losses += losses;
      if (Number.isFinite(finalBankroll)) {
        this.current.bankroll = Math.max(0, Math.round(finalBankroll));
      }
      this._notify();
      void this.persistCurrent();
    }

    unlockAchievement(id) {
      if (!this.current || !ACHIEVEMENTS_CATALOG[id]) return { newlyUnlocked: false, achievement: null };
      if (this.current.achievements && this.current.achievements[id]) {
        return { newlyUnlocked: false, achievement: null };
      }
      const unlockedAt = Date.now();
      this.current.achievements = Object.assign({}, this.current.achievements, {
        [id]: { unlockedAt },
      });
      this._notify();
      void this.persistCurrent();
      return {
        newlyUnlocked: true,
        achievement: Object.assign({}, ACHIEVEMENTS_CATALOG[id], { unlockedAt }),
      };
    }

    getUnlockedAchievements() {
      if (!this.current || !this.current.achievements) return [];
      const list = [];
      for (const [id, meta] of Object.entries(this.current.achievements)) {
        const def = ACHIEVEMENTS_CATALOG[id];
        if (!def || !meta) continue;
        list.push(Object.assign({}, def, { unlockedAt: meta.unlockedAt || Date.now() }));
      }
      return list;
    }

    async logout() {
      const wasGoogle = this.current && this.current.mode === "google";
      this.clearLocal();
      this.current = null;
      if (wasGoogle && this.fb && this.fb.isAvailable()) {
        try {
          await this.fb.signOut();
        } catch (_) {}
      } else if (this.fb && this.fb.isAvailable()) {
        this.fb.detachPresence();
      }
      this._notify();
    }
  }

  MBJ.WESTERN_NAMES = WESTERN_NAMES;
  MBJ.AVATARS = AVATARS;
  MBJ.ACHIEVEMENTS_CATALOG = ACHIEVEMENTS_CATALOG;
  MBJ.ProfileStore = ProfileStore;
})(window);
