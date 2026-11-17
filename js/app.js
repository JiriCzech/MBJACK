/* Application bootstrap: connects Firebase, ProfileStore, SaloonUI, MultiplayerTable,
   TableScene, TableUI and SoundEffects. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});
  const byId = (id) => document.getElementById(id);

  async function boot() {
    const elements = {
      viewport: byId("viewport"),
      stage: byId("stage"),
      cardLayer: byId("cardLayer"),
      chipLayer: byId("chipLayer"),
      overlayLayer: byId("overlayLayer"),
      activeRing: byId("activeRing"),

      dealerBubble: byId("dealerBubble"),
      dealerBubbleText: byId("dealerBubbleText"),

      shoeHotspot: byId("shoeHotspot"),
      shoeCount: byId("shoeCount"),
      shoeShuffleTag: byId("shoeShuffleTag"),

      bankrollValue: byId("bankrollValue"),
      betValue: byId("betValue"),
      chipRack: byId("chipRack"),

      groupBetting: byId("groupBetting"),
      clearBtn: byId("clearBtn"),
      rebetBtn: byId("rebetBtn"),
      dealBtn: byId("dealBtn"),
      rebuyBtn: byId("rebuyBtn"),

      groupInsurance: byId("groupInsurance"),
      insYesBtn: byId("insYesBtn"),
      insCost: byId("insCost"),
      insNoBtn: byId("insNoBtn"),

      groupPlayer: byId("groupPlayer"),
      hitBtn: byId("hitBtn"),
      standBtn: byId("standBtn"),
      doubleBtn: byId("doubleBtn"),
      splitBtn: byId("splitBtn"),
      surrenderBtn: byId("surrenderBtn"),

      groupRoundOver: byId("groupRoundOver"),
      newRoundBtn: byId("newRoundBtn"),
      rebetRoundBtn: byId("rebetRoundBtn"),

      soundBtn: byId("soundBtn"),
      rulesBtn: byId("rulesBtn"),
      rulesModal: byId("rulesModal"),
      rulesCloseBtn: byId("rulesCloseBtn"),

      // Quick chat
      quickChatBar: byId("quickChatBar"),
      quickChatForm: byId("quickChatForm"),
      quickChatInput: byId("quickChatInput"),
      quickChatCloseBtn: byId("quickChatCloseBtn"),

      // Saloon entry screen
      saloonScreen: byId("saloonScreen"),
      saloonSheriffBubble: byId("saloonSheriffBubble"),
      saloonSheriffText: byId("saloonSheriffText"),
      saloonFirstName: byId("saloonFirstName"),
      saloonLastName: byId("saloonLastName"),
      saloonRandomBtn: byId("saloonRandomBtn"),
      saloonAvatarGrid: byId("saloonAvatarGrid"),
      saloonGuestBtn: byId("saloonGuestBtn"),
      saloonGoogleBtn: byId("saloonGoogleBtn"),
      saloonStatusText: byId("saloonStatusText"),

      // Profile HUD & modal
      profileCorner: byId("profileCorner"),
      profileTrigger: byId("profileTrigger"),
      profileConnDot: byId("profileConnDot"),
      profileMiniAvatar: byId("profileMiniAvatar"),
      profileMiniName: byId("profileMiniName"),
      profileMiniBank: byId("profileMiniBank"),
      profileMiniMode: byId("profileMiniMode"),

      profileModal: byId("profileModal"),
      profileCloseBtn: byId("profileCloseBtn"),
      profileAvatar: byId("profileAvatar"),
      profileName: byId("profileName"),
      profileModeTag: byId("profileModeTag"),
      profileRoomInfo: byId("profileRoomInfo"),
      profileStatBank: byId("profileStatBank"),
      profileStatGames: byId("profileStatGames"),
      profileStatWins: byId("profileStatWins"),
      profileStatLosses: byId("profileStatLosses"),
      profileAchievementsSection: byId("profileAchievementsSection"),
      profileAchievementsList: byId("profileAchievementsList"),
      profileUpgradeBtn: byId("profileUpgradeBtn"),
      profileLogoutBtn: byId("profileLogoutBtn"),

      // Achievement celebration & AFK notice
      achievementToast: byId("achievementToast"),
      achievementToastIcon: byId("achievementToastIcon"),
      achievementToastTitle: byId("achievementToastTitle"),
      achievementToastDesc: byId("achievementToastDesc"),

      kickedModal: byId("kickedModal"),
      kickedReasonText: byId("kickedReasonText"),
      kickedRejoinBtn: byId("kickedRejoinBtn"),
      kickedSaloonBtn: byId("kickedSaloonBtn"),
    };

    const audio = new MBJ.SoundEffects();
    const fb = MBJ.firebase;
    fb.init();

    const profileStore = new MBJ.ProfileStore(fb);

    let scene = null;
    let ui = null;
    let saloon = null;

    const table = new MBJ.MultiplayerTable({
      firebase: fb,
      profileStore,
      rules: MBJ.RULES,
      audio,
      onStateChange: () => {
        if (ui) ui.sync();
        if (saloon) {
          const count = table.getSeatCount();
          saloon.setRoomSummary(table.roomId ? `Stůl u šerifa · ${count}/3 kovbojů` : "");
        }
      },
      onSeatRender: () => {
        if (ui) {
          ui.renderSeats(table.seats, table.mySeat, table.phase, table.activeHand, table.mirror.round);
        }
      },
      onDealerLine: (text, mood) => {
        if (ui) ui.showDealerLine(text, mood);
      },
      onChatMessage: ({ seat, text }) => {
        if (ui) ui.showPlayerChatBubble(seat, text);
      },
      onHydrateScene: (snapshot) => {
        if (scene) scene.hydrateFromSnapshot(snapshot);
      },
      onKicked: (reason) => {
        if (scene) scene.hydrateFromSnapshot({ phase: MBJ.PHASE.BETTING, seatBets: [0, 0, 0] });
        if (elements.kickedModal && elements.kickedReasonText) {
          elements.kickedReasonText.textContent = reason;
          elements.kickedModal.hidden = false;
        }
      },
    });

    scene = new MBJ.TableScene({
      engine: table,
      elements,
      audio,
      onStateSynced: () => {
        if (ui) ui.sync();
      },
      onDealerLine: (text, mood) => {
        if (ui) ui.showDealerLine(text, mood);
      },
    }).init();

    ui = new MBJ.TableUI({ engine: table, scene, elements, audio }).init();

    const enterTableFlow = async (profile) => {
      if (elements.kickedModal) elements.kickedModal.hidden = true;
      saloon.hideSaloon();
      saloon.syncProfileViews(profile);
      await table.joinTable();
      ui.renderSeats(table.seats, table.mySeat, table.phase, table.activeHand, table.mirror.round);
      ui.sync();
    };

    saloon = new MBJ.SaloonUI({
      profileStore,
      firebase: fb,
      audio,
      elements,
      onEnterTable: (profile) => {
        void enterTableFlow(profile);
      },
      onLogout: async () => {
        await table.leaveTable();
        scene.hydrateFromSnapshot({ phase: MBJ.PHASE.BETTING, seatBets: [0, 0, 0] });
        ui.renderSeats([null, null, null], -1, MBJ.PHASE.BETTING, null, 0);
        await profileStore.logout();
        saloon.showSaloon();
      },
      onProfileUpdated: (profile) => {
        table.syncProfileIdentity(profile);
      },
    }).init();

    table.onAchievementUnlocked = (ach) => {
      saloon.showAchievementCelebration(ach);
    };

    if (elements.kickedRejoinBtn) {
      elements.kickedRejoinBtn.addEventListener("click", () => {
        if (profileStore.current) void enterTableFlow(profileStore.current);
      });
    }
    if (elements.kickedSaloonBtn) {
      elements.kickedSaloonBtn.addEventListener("click", async () => {
        if (elements.kickedModal) elements.kickedModal.hidden = true;
        await profileStore.logout();
        saloon.showSaloon();
      });
    }

    global.addEventListener("beforeunload", () => {
      void table.leaveTable();
    });

    // Resolve initial auto-login or show Saloon screen
    const existing = await profileStore.resolveInitialProfile();
    if (existing) {
      await enterTableFlow(existing);
    } else {
      saloon.showSaloon();
    }

    global.MBJack = { table, engine: table, scene, ui, saloon, profileStore, firebase: fb, audio, rules: MBJ.RULES };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
  } else {
    void boot();
  }
})(window);
