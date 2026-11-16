/* Application bootstrap: connects BlackjackEngine, TableScene, TableUI and SoundEffects. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});
  const byId = (id) => document.getElementById(id);

  function boot() {
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
    };

    const bus = new MBJ.EventBus();
    const audio = new MBJ.SoundEffects();
    const engine = new MBJ.BlackjackEngine({ bus, rules: MBJ.RULES });

    let ui = null;
    const scene = new MBJ.TableScene({
      engine,
      elements,
      audio,
      onStateSynced: () => {
        if (ui) ui.sync();
      },
      onDealerLine: (text, mood) => {
        if (ui) ui.showDealerLine(text, mood);
      },
    }).init();

    ui = new MBJ.TableUI({ engine, scene, elements, audio }).init();

    global.MBJack = { engine, scene, ui, bus, audio, rules: MBJ.RULES };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})(window);
