/* Firebase integration layer (mbjack-saloon): Auth (Google + guest session),
   Realtime Database, and .info/connected + onDisconnect() presence tracking. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});

  const FIREBASE_CONFIG = Object.freeze({
    projectId: "mbjack-saloon",
    appId: "1:672540656305:web:078046f8d2d7f116451890",
    databaseURL: "https://mbjack-saloon-default-rtdb.europe-west1.firebasestorage.app".replace(
      ".firebasestorage.app",
      ".firebasedatabase.app"
    ),
    storageBucket: "mbjack-saloon.firebasestorage.app",
    apiKey: "AIzaSyBnLGFHFbDf4xERS9RQHAOMyWTWnv1RdGQ",
    authDomain: "mbjack-saloon.firebaseapp.com",
    messagingSenderId: "672540656305",
  });

  // Exact RTDB URL returned by Firebase provisioning
  const RTDB_URL = "https://mbjack-saloon-default-rtdb.europe-west1.firebasedatabase.app";

  class FirebaseBridge {
    constructor() {
      this.app = null;
      this.auth = null;
      this.db = null;
      this.connected = false;
      this._initDone = false;
      this._presenceUnsub = null;
      this._presenceUid = null;
      this._connectionListeners = new Set();
    }

    init() {
      if (this._initDone) return this.isAvailable();
      this._initDone = true;

      if (!global.firebase || typeof global.firebase.initializeApp !== "function") {
        console.warn("[MBJack] Firebase SDK není dostupné – běžím v offline režimu.");
        return false;
      }

      try {
        const config = Object.assign({}, FIREBASE_CONFIG, { databaseURL: RTDB_URL });
        this.app = global.firebase.apps.length ? global.firebase.app() : global.firebase.initializeApp(config);
        this.auth = global.firebase.auth();
        this.db = global.firebase.database();
        this._watchConnectedFlag();
        return true;
      } catch (err) {
        console.error("[MBJack] Nepodařilo se inicializovat Firebase:", err);
        this.app = null;
        this.auth = null;
        this.db = null;
        return false;
      }
    }

    isAvailable() {
      return Boolean(this.app && this.auth && this.db);
    }

    get serverTimestamp() {
      return global.firebase && global.firebase.database
        ? global.firebase.database.ServerValue.TIMESTAMP
        : Date.now();
    }

    _watchConnectedFlag() {
      if (!this.db) return;
      this.db.ref(".info/connected").on("value", (snap) => {
        this.connected = Boolean(snap.val());
        if (this.connected && this._presenceUid) {
          this._registerGlobalPresence(this._presenceUid);
        }
        for (const cb of this._connectionListeners) {
          try {
            cb(this.connected);
          } catch (_) {}
        }
      });
    }

    onConnectionChange(cb) {
      this._connectionListeners.add(cb);
      cb(this.connected);
      return () => this._connectionListeners.delete(cb);
    }

    _registerGlobalPresence(uid) {
      if (!this.db || !uid) return;
      const ref = this.db.ref(`presence/${uid}`);
      ref.onDisconnect().remove().catch(() => {});
      ref.set({
        online: true,
        ts: this.serverTimestamp,
      }).catch(() => {});
    }

    attachPresence(uid) {
      if (!this.isAvailable() || !uid) return;
      this._presenceUid = uid;
      if (this.connected) {
        this._registerGlobalPresence(uid);
      }
    }

    detachPresence() {
      const uid = this._presenceUid;
      this._presenceUid = null;
      if (this.db && uid) {
        this.db.ref(`presence/${uid}`).remove().catch(() => {});
      }
    }

    waitForInitialAuth(timeoutMs = 3500) {
      if (!this.isAvailable()) return Promise.resolve(null);
      if (this.auth.currentUser) return Promise.resolve(this.auth.currentUser);
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (unsub) unsub();
          resolve(this.auth.currentUser || null);
        }, timeoutMs);
        const unsub = this.auth.onAuthStateChanged((user) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsub();
          resolve(user || null);
        });
      });
    }

    onAuthChange(cb) {
      if (!this.isAvailable()) return () => {};
      return this.auth.onAuthStateChanged(cb);
    }

    async signInWithGoogle() {
      if (!this.isAvailable()) throw new Error("Firebase není připojeno.");
      const provider = new global.firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      const cred = await this.auth.signInWithPopup(provider);
      return cred.user;
    }

    async ensureGuestSession() {
      if (!this.isAvailable()) return null;
      if (this.auth.currentUser) return this.auth.currentUser;
      const cred = await this.auth.signInAnonymously();
      return cred.user;
    }

    async signOut() {
      this.detachPresence();
      if (!this.isAvailable()) return;
      await this.auth.signOut();
    }

    async loadUserProfile(uid) {
      if (!this.isAvailable() || !uid) return null;
      const snap = await this.db.ref(`users/${uid}`).once("value");
      return snap.exists() ? snap.val() : null;
    }

    async saveUserProfile(uid, profile) {
      if (!this.isAvailable() || !uid) return;
      const payload = {
        firstName: String(profile.firstName || "").trim(),
        lastName: String(profile.lastName || "").trim(),
        avatarId: Number(profile.avatarId) || 1,
        bankroll: Math.max(0, Math.round(Number(profile.bankroll) || 0)),
        stats: {
          gamesPlayed: Math.max(0, Math.round(Number(profile.stats?.gamesPlayed) || 0)),
          wins: Math.max(0, Math.round(Number(profile.stats?.wins) || 0)),
          losses: Math.max(0, Math.round(Number(profile.stats?.losses) || 0)),
        },
        achievements: profile.achievements || {},
        updatedAt: this.serverTimestamp,
      };
      await this.db.ref(`users/${uid}`).set(payload);
    }

    async patchUserProfile(uid, patch) {
      if (!this.isAvailable() || !uid) return;
      const payload = Object.assign({}, patch, { updatedAt: this.serverTimestamp });
      await this.db.ref(`users/${uid}`).update(payload);
    }
  }

  MBJ.firebase = new FirebaseBridge();
})(window);
