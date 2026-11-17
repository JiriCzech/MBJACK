/* Saloon entry screen (smart returning-player view + character creator),
   player profile HUD + modal (with avatar switcher & account deletion),
   and secret achievement celebration overlay. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});
  const U = MBJ.utils;

  const RANDOM_LINES = [
    (n) => `${n}? To zní jako někdo, kdo umí blafovat!`,
    (n) => `${n}… o tobě už se v saloonu šeptalo.`,
    (n) => `Výborně, ${n}! Sedlo je volné a karty jsou zamíchané.`,
    (n) => `Aha, ${n}! Tak ukaž, co umíš proti šerifovi.`,
  ];

  const LOCK_SVG = `
    <svg class="avatar-lock-svg" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="24" r="11" fill="#4e311d" stroke="#2b1a0e" stroke-width="2.5" opacity="0.45"/>
      <path d="M16 54c2-11 9-16 16-16s14 5 16 16" fill="#4e311d" stroke="#2b1a0e" stroke-width="2.5" opacity="0.45"/>
      <rect x="20" y="29" width="24" height="20" rx="4" fill="#d9b259" stroke="#2b1a0e" stroke-width="3"/>
      <path d="M25 29v-6a7 7 0 0 1 14 0v6" fill="none" stroke="#2b1a0e" stroke-width="3.2" stroke-linecap="round"/>
      <circle cx="32" cy="38" r="2.8" fill="#2b1a0e"/>
      <path d="M32 40v4" stroke="#2b1a0e" stroke-width="2.6" stroke-linecap="round"/>
    </svg>`;

  const ACHIEVEMENT_BADGE_SVG = `
    <svg class="ach-badge-svg" viewBox="0 0 72 72" aria-hidden="true">
      <circle cx="36" cy="36" r="31" fill="#f3cc63" stroke="#2b1a0e" stroke-width="3.5"/>
      <circle cx="36" cy="36" r="25" fill="#703616" stroke="#2b1a0e" stroke-width="2.2"/>
      <rect x="19" y="19" width="20" height="28" rx="3" transform="rotate(-12 29 33)" fill="#f6ead0" stroke="#2b1a0e" stroke-width="2.4"/>
      <text x="27" y="34" transform="rotate(-12 29 33)" font-family="Georgia,serif" font-weight="800" font-size="13" fill="#2b1a0e" text-anchor="middle">A</text>
      <rect x="33" y="21" width="20" height="28" rx="3" transform="rotate(11 43 35)" fill="#f6ead0" stroke="#2b1a0e" stroke-width="2.4"/>
      <text x="43" y="37" transform="rotate(11 43 35)" font-family="Georgia,serif" font-weight="800" font-size="13" fill="#b92d26" text-anchor="middle">K</text>
      <polygon points="36,41 39,47 46,48 41,53 42,60 36,56 30,60 31,53 26,48 33,47" fill="#ffe174" stroke="#2b1a0e" stroke-width="2"/>
    </svg>`;

  class SaloonUI {
    /**
     * @param {{
     *   profileStore: MBJ.ProfileStore,
     *   firebase: MBJ.FirebaseBridge,
     *   audio?: MBJ.SoundEffects,
     *   elements: Record<string, HTMLElement>,
     *   onEnterTable: (profile: object) => void,
     *   onLogout: () => Promise<void>,
     *   onReturnToSaloon?: () => Promise<void>,
     *   onDeleteAccount?: () => Promise<void>,
     *   onProfileUpdated?: (profile: object) => void
     * }} options
     */
    constructor(options) {
      this.store = options.profileStore;
      this.fb = options.firebase;
      this.audio = options.audio || null;
      this.el = options.elements;
      this.onEnterTable = options.onEnterTable;
      this.onLogout = options.onLogout;
      this.onReturnToSaloon = options.onReturnToSaloon || options.onLogout;
      this.onDeleteAccount = options.onDeleteAccount || options.onLogout;
      this.onProfileUpdated = options.onProfileUpdated || (() => {});

      this.selectedAvatarId = 1;
      this._busy = false;
      this._toastTimer = null;
      this._roomSummary = "";
    }

    init() {
      this._renderSaloonAvatarGrid();
      this._bindEvents();
      this.store.onChange((profile) => this.syncProfileViews(profile));
      if (this.fb) {
        this.fb.onConnectionChange((online) => this._updateConnectionIndicator(online));
      }
      return this;
    }

    _renderAvatarGridInto(grid, selectedId, profile, onSelect, onLockedClick) {
      if (!grid) return;
      grid.innerHTML = "";
      for (const av of MBJ.AVATARS) {
        const unlocked = this.store.isAvatarUnlocked(av.id, profile);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = unlocked ? "avatar-slot is-unlocked" : "avatar-slot is-locked";
        btn.dataset.avatarId = String(av.id);
        if (unlocked) {
          const active = av.id === Number(selectedId);
          btn.classList.toggle("is-selected", active);
          btn.setAttribute("aria-pressed", String(active));
          btn.setAttribute("aria-label", `Vybrat portrét: ${av.label}`);
          btn.innerHTML = `
            <img class="avatar-slot__img" src="${av.src}" alt="${av.label}" draggable="false">
            <span class="avatar-slot__check" aria-hidden="true">✓</span>`;
          btn.addEventListener("click", () => {
            if (this.audio) {
              this.audio.unlock();
              this.audio.chip();
            }
            onSelect(av.id);
          });
        } else {
          btn.setAttribute("aria-label", "Zamčený avatar — tajná odměna");
          btn.title = "Tajná odměna — zatím zamčeno";
          btn.innerHTML = `${LOCK_SVG}<span class="avatar-slot__lock-tag">Zamčeno</span>`;
          btn.addEventListener("click", () => {
            btn.classList.remove("is-nudged");
            requestAnimationFrame(() => btn.classList.add("is-nudged"));
            setTimeout(() => btn.classList.remove("is-nudged"), 320);
            if (onLockedClick) onLockedClick();
          });
        }
        grid.appendChild(btn);
      }
    }

    _renderSaloonAvatarGrid() {
      this._renderAvatarGridInto(
        this.el.saloonAvatarGrid,
        this.selectedAvatarId,
        null,
        (id) => {
          this.selectedAvatarId = id;
          this._syncSaloonAvatarSelection();
        },
        () => {
          this.setSheriffLine("Tenhle kovboj je zatím pod zámkem. Vyber si ze základních tří!", "neutral");
        }
      );
    }

    _syncSaloonAvatarSelection() {
      const grid = this.el.saloonAvatarGrid;
      if (!grid) return;
      for (const btn of grid.querySelectorAll(".avatar-slot.is-unlocked")) {
        const active = Number(btn.dataset.avatarId) === this.selectedAvatarId;
        btn.classList.toggle("is-selected", active);
        btn.setAttribute("aria-pressed", String(active));
      }
    }

    _renderProfileAvatarGrid(profile) {
      if (!this.el.profileAvatarGrid || !profile) return;
      this._renderAvatarGridInto(
        this.el.profileAvatarGrid,
        profile.avatarId,
        profile,
        async (id) => {
          const updated = await this.store.setAvatar(id);
          if (updated) {
            this.syncProfileViews(updated);
            this.onProfileUpdated(updated);
          }
        },
        null
      );
    }

    _bindEvents() {
      if (this.el.saloonContinueBtn) {
        this.el.saloonContinueBtn.addEventListener("click", () => {
          if (this.audio) this.audio.unlock();
          if (this.store.current) {
            this.hideSaloon();
            this.onEnterTable(this.store.current);
          }
        });
      }

      if (this.el.saloonSwitchAccountBtn) {
        this.el.saloonSwitchAccountBtn.addEventListener("click", async () => {
          if (this._busy) return;
          this._busy = true;
          try {
            await this.onLogout();
            this.selectedAvatarId = 1;
            if (this.el.saloonFirstName) this.el.saloonFirstName.value = "";
            if (this.el.saloonLastName) this.el.saloonLastName.value = "";
            this._renderSaloonAvatarGrid();
            this.showSaloon();
          } finally {
            this._busy = false;
          }
        });
      }

      this.el.saloonRandomBtn.addEventListener("click", () => {
        if (this.audio) {
          this.audio.unlock();
          this.audio.chip();
        }
        const { firstName, lastName } = this.store.pickRandomName(
          this.el.saloonFirstName.value.trim(),
          this.el.saloonLastName.value.trim()
        );
        this.el.saloonFirstName.value = firstName;
        this.el.saloonLastName.value = lastName;
        const lineFn = RANDOM_LINES[Math.floor(Math.random() * RANDOM_LINES.length)];
        this.setSheriffLine(lineFn(`${firstName} ${lastName}`), "impressed");
      });

      this.el.saloonGuestBtn.addEventListener("click", () => this._handleGuestEnter());
      this.el.saloonGoogleBtn.addEventListener("click", () => this._handleGoogleEnter());

      const onInputKey = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this._handleGuestEnter();
        }
      };
      this.el.saloonFirstName.addEventListener("keydown", onInputKey);
      this.el.saloonLastName.addEventListener("keydown", onInputKey);

      // Profile HUD & Modal
      this.el.profileTrigger.addEventListener("click", () => this.toggleProfileModal(true));
      this.el.profileCloseBtn.addEventListener("click", () => this.toggleProfileModal(false));
      this.el.profileModal.addEventListener("click", (e) => {
        if (e.target === this.el.profileModal) this.toggleProfileModal(false);
      });

      this.el.profileUpgradeBtn.addEventListener("click", () => this._handleUpgradeGoogle());
      this.el.profileLogoutBtn.addEventListener("click", async () => {
        this.toggleProfileModal(false);
        await this.onReturnToSaloon();
      });

      if (this.el.profileDeleteBtn && this.el.deleteAccountConfirm) {
        this.el.profileDeleteBtn.addEventListener("click", () => {
          this.el.deleteAccountConfirm.hidden = false;
        });
      }
      if (this.el.profileDeleteConfirmNo && this.el.deleteAccountConfirm) {
        this.el.profileDeleteConfirmNo.addEventListener("click", () => {
          this.el.deleteAccountConfirm.hidden = true;
        });
      }
      if (this.el.profileDeleteConfirmYes) {
        this.el.profileDeleteConfirmYes.addEventListener("click", async () => {
          this.el.profileDeleteConfirmYes.disabled = true;
          try {
            this.toggleProfileModal(false);
            if (this.el.deleteAccountConfirm) this.el.deleteAccountConfirm.hidden = true;
            await this.onDeleteAccount();
          } finally {
            this.el.profileDeleteConfirmYes.disabled = false;
          }
        });
      }
    }

    setSheriffLine(text, mood) {
      if (!this.el.saloonSheriffBubble || !this.el.saloonSheriffText) return;
      this.el.saloonSheriffText.textContent = text;
      this.el.saloonSheriffBubble.dataset.mood = mood || "neutral";
    }

    _setFormBusy(busy, message) {
      this._busy = busy;
      this.el.saloonGuestBtn.disabled = busy;
      this.el.saloonGoogleBtn.disabled = busy;
      this.el.saloonRandomBtn.disabled = busy;
      if (this.el.saloonStatusText) {
        this.el.saloonStatusText.textContent = message || "";
        this.el.saloonStatusText.hidden = !message;
      }
    }

    _readFormName() {
      const firstName = this.el.saloonFirstName.value.trim().replace(/\s+/g, " ");
      const lastName = this.el.saloonLastName.value.trim().replace(/\s+/g, " ");
      return { firstName, lastName };
    }

    async _handleGuestEnter() {
      if (this._busy) return;
      if (this.audio) this.audio.unlock();
      const { firstName, lastName } = this._readFormName();
      if (!firstName || !lastName) {
        this.setSheriffLine("Napiš jméno i příjmení, kovboji — nebo klikni na Random!", "grumpy");
        (!firstName ? this.el.saloonFirstName : this.el.saloonLastName).focus();
        return;
      }
      this._setFormBusy(true, "Vstupuji do saloonu…");
      try {
        const profile = await this.store.createLocalProfile({
          firstName,
          lastName,
          avatarId: this.selectedAvatarId,
        });
        this.hideSaloon();
        this.onEnterTable(profile);
      } catch (err) {
        console.error(err);
        this.setSheriffLine("Něco se pokazilo při vstupu. Zkus to ještě jednou.", "grumpy");
      } finally {
        this._setFormBusy(false, "");
      }
    }

    async _handleGoogleEnter() {
      if (this._busy) return;
      if (this.audio) this.audio.unlock();
      if (!this.fb || !this.fb.isAvailable()) {
        this.setSheriffLine("Google přihlášení není bez internetu k dispozici. Zkus „Jedu jen kolem“.", "grumpy");
        return;
      }
      const { firstName, lastName } = this._readFormName();
      this._setFormBusy(true, "Otevírám přihlášení přes Google…");
      try {
        const profile = await this.store.signInWithGoogleProfile({
          firstName,
          lastName,
          avatarId: this.selectedAvatarId,
        });
        this.hideSaloon();
        this.onEnterTable(profile);
      } catch (err) {
        const code = err && err.code;
        if (code === "NEED_NAME") {
          this.setSheriffLine(
            "Pro novou postavu napiš nejprve herní jméno a příjmení (nebo klikni Random) a pak klikni na Google!",
            "neutral"
          );
          this.el.saloonFirstName.focus();
        } else if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
          this.setSheriffLine("Přihlášení jsi zavřel. Můžeš to zkusit znovu nebo jet jen kolem.", "neutral");
        } else if (code === "auth/unauthorized-domain") {
          this.setSheriffLine("Tahle doména ještě není povolená ve Firebase Auth (Authorized domains).", "grumpy");
        } else {
          console.error("[MBJack Google Auth]", err);
          this.setSheriffLine("Přihlášení přes Google se nepodařilo. Zkus to znovu.", "grumpy");
        }
      } finally {
        this._setFormBusy(false, "");
      }
    }

    async _handleUpgradeGoogle() {
      if (!this.fb || !this.fb.isAvailable()) return;
      this.el.profileUpgradeBtn.disabled = true;
      try {
        const upgraded = await this.store.upgradeLocalToGoogle();
        this.syncProfileViews(upgraded);
        this.onProfileUpdated(upgraded);
      } catch (err) {
        console.warn("[MBJack upgrade]", err);
      } finally {
        this.el.profileUpgradeBtn.disabled = false;
      }
    }

    showSaloon() {
      if (this.el.saloonScreen) this.el.saloonScreen.hidden = false;
      const profile = this.store.current;
      const hasProfile = Boolean(profile);

      if (this.el.saloonExistingView) this.el.saloonExistingView.hidden = !hasProfile;
      if (this.el.saloonCreateView) this.el.saloonCreateView.hidden = hasProfile;

      if (hasProfile) {
        this.syncProfileViews(profile);
        if (this.el.saloonPanelSub) {
          this.el.saloonPanelSub.textContent = "Vítej zpátky v saloonu!";
        }
        this.setSheriffLine(`Vítej zpátky ve městě, ${profile.firstName}! Jdeš rovnou ke stolu?`, "friendly");
      } else {
        this._renderSaloonAvatarGrid();
        if (this.el.saloonPanelSub) {
          this.el.saloonPanelSub.textContent = "Zapiš se do knihy hráčů a přisedni ke stolu";
        }
        this.setSheriffLine("Vítej ve městě kovboji, jak se jmenuješ?", "neutral");
      }
      this._syncProfileCornerVisibility();
    }

    hideSaloon() {
      if (this.el.saloonScreen) this.el.saloonScreen.hidden = true;
      this._syncProfileCornerVisibility();
    }

    isSaloonVisible() {
      return Boolean(this.el.saloonScreen && !this.el.saloonScreen.hidden);
    }

    setRoomSummary(text) {
      this._roomSummary = text || "";
      if (this.el.profileRoomInfo) {
        this.el.profileRoomInfo.textContent = this._roomSummary;
        this.el.profileRoomInfo.hidden = !this._roomSummary;
      }
    }

    _syncProfileCornerVisibility() {
      const hasProfile = Boolean(this.store.current);
      const onSaloon = this.isSaloonVisible();
      if (this.el.profileCorner) {
        this.el.profileCorner.hidden = !hasProfile || onSaloon;
      }
    }

    _updateConnectionIndicator(online) {
      if (!this.el.profileConnDot) return;
      this.el.profileConnDot.classList.toggle("is-online", Boolean(online));
      this.el.profileConnDot.title = online ? "Online (připojeno ke stolu)" : "Offline / připojuji se…";
    }

    syncProfileViews(profile) {
      this._syncProfileCornerVisibility();
      if (!profile) return;

      const fullName = this.store.getFullName(profile);
      const avatarSrc = this.store.getAvatarSrc(profile.avatarId, profile);
      const moneyText = U.formatMoney(profile.bankroll);
      const isGoogle = profile.mode === "google";

      // Returning view card on Saloon screen
      if (this.el.saloonExistingAvatar) this.el.saloonExistingAvatar.src = avatarSrc;
      if (this.el.saloonExistingName) this.el.saloonExistingName.textContent = fullName;
      if (this.el.saloonExistingMode) {
        this.el.saloonExistingMode.textContent = isGoogle ? "Jsem z města · Google účet" : "Jedu jen kolem · Lokální profil";
        this.el.saloonExistingMode.dataset.mode = profile.mode;
      }
      if (this.el.saloonExistingBank) this.el.saloonExistingBank.textContent = moneyText;
      if (this.el.saloonExistingStats) {
        this.el.saloonExistingStats.textContent = `Hry: ${profile.stats.gamesPlayed || 0} · Výhry: ${profile.stats.wins || 0}`;
      }

      // Top-left HUD badge
      if (this.el.profileMiniAvatar) this.el.profileMiniAvatar.src = avatarSrc;
      if (this.el.profileMiniName) this.el.profileMiniName.textContent = fullName;
      if (this.el.profileMiniBank) this.el.profileMiniBank.textContent = moneyText;
      if (this.el.profileMiniMode) {
        this.el.profileMiniMode.textContent = isGoogle ? "Měšťan" : "Poutník";
      }

      // Profile modal
      if (this.el.profileAvatar) this.el.profileAvatar.src = avatarSrc;
      if (this.el.profileName) this.el.profileName.textContent = fullName;
      if (this.el.profileModeTag) {
        this.el.profileModeTag.textContent = isGoogle ? "Jsem z města · Google účet" : "Jedu jen kolem · Lokální profil";
        this.el.profileModeTag.dataset.mode = profile.mode;
      }
      if (this.el.profileStatBank) this.el.profileStatBank.textContent = moneyText;
      if (this.el.profileStatGames) this.el.profileStatGames.textContent = String(profile.stats.gamesPlayed || 0);
      if (this.el.profileStatWins) this.el.profileStatWins.textContent = String(profile.stats.wins || 0);
      if (this.el.profileStatLosses) this.el.profileStatLosses.textContent = String(profile.stats.losses || 0);
      if (this.el.profileUpgradeBtn) {
        this.el.profileUpgradeBtn.hidden = isGoogle;
      }

      this._renderProfileAvatarGrid(profile);

      // Secret Achievements section: completely hidden until at least 1 achievement unlocked
      const unlocked = this.store.getUnlockedAchievements();
      if (this.el.profileAchievementsSection && this.el.profileAchievementsList) {
        this.el.profileAchievementsSection.hidden = unlocked.length === 0;
        if (unlocked.length > 0) {
          this.el.profileAchievementsList.innerHTML = unlocked
            .map((a) => {
              const dt = new Intl.DateTimeFormat("cs-CZ", {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(a.unlockedAt));
              return `
                <div class="achievement-card">
                  <div class="achievement-card__icon">${ACHIEVEMENT_BADGE_SVG}</div>
                  <div class="achievement-card__body">
                    <div class="achievement-card__title">${a.title}</div>
                    <div class="achievement-card__desc">${a.description}</div>
                    <div class="achievement-card__date">Získáno: ${dt}</div>
                  </div>
                </div>`;
            })
            .join("");
        } else {
          this.el.profileAchievementsList.innerHTML = "";
        }
      }
    }

    toggleProfileModal(open) {
      if (!this.el.profileModal) return;
      if (this.el.deleteAccountConfirm) this.el.deleteAccountConfirm.hidden = true;
      if (open && this.store.current) {
        this.syncProfileViews(this.store.current);
      }
      this.el.profileModal.hidden = !open;
    }

    isProfileModalOpen() {
      return Boolean(this.el.profileModal && !this.el.profileModal.hidden);
    }

    showAchievementCelebration(ach) {
      const toast = this.el.achievementToast;
      if (!toast || !ach) return;
      if (this.el.achievementToastIcon) {
        this.el.achievementToastIcon.innerHTML = ACHIEVEMENT_BADGE_SVG;
      }
      if (this.el.achievementToastTitle) {
        this.el.achievementToastTitle.textContent = ach.title;
      }
      if (this.el.achievementToastDesc) {
        this.el.achievementToastDesc.textContent =
          ach.id === "first_blackjack"
            ? `${ach.description} Odemkl se ti tajný 4. portrét kovboje!`
            : ach.description;
      }
      if (this.store.current) {
        this.syncProfileViews(this.store.current);
      }
      toast.hidden = false;
      toast.classList.remove("is-visible");
      requestAnimationFrame(() => toast.classList.add("is-visible"));
      if (this.audio) this.audio.win(true);
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        toast.classList.remove("is-visible");
        setTimeout(() => {
          if (!toast.classList.contains("is-visible")) toast.hidden = true;
        }, 320);
      }, 4800);
    }
  }

  MBJ.SaloonUI = SaloonUI;
})(window);
