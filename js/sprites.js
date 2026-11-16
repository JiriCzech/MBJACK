/* Visual building blocks: a positioned Sprite, cartoon playing cards drawn in
   SVG (same hand-inked style as the saloon art) and poker-chip stacks. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});

  const INK = "#2b1a0e";
  const RED = "#c8312a";
  const BLACK = "#241f1b";
  const PAPER = "#f6ead0";
  const SVGNS = "http://www.w3.org/2000/svg";

  /* ------------------------------------------------------------------ */
  /* Sprite – a DOM element positioned by an animatable pose.            */
  /* ------------------------------------------------------------------ */

  class Sprite {
    constructor(el, pose) {
      this.el = el;
      this.pose = Object.assign({ x: 0, y: 0, rotation: 0, scale: 1, opacity: 1, z: 1 }, pose || {});
      this._t = "";
      this._o = "";
      this._z = "";
      this.apply();
    }

    setPose(next) {
      Object.assign(this.pose, next);
      this.apply();
    }

    apply() {
      if (!this.el) return;
      const p = this.pose;
      const t = `translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, 0) translate(-50%, -50%) rotate(${p.rotation.toFixed(2)}deg) scale(${p.scale.toFixed(4)})`;
      if (t !== this._t) {
        this.el.style.transform = t;
        this._t = t;
      }
      const o = p.opacity >= 0.999 ? "1" : p.opacity.toFixed(3);
      if (o !== this._o) {
        this.el.style.opacity = o;
        this._o = o;
      }
      const z = String(Math.round(p.z));
      if (z !== this._z) {
        this.el.style.zIndex = z;
        this._z = z;
      }
    }

    destroy() {
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
      this.el = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Shared SVG defs: suit shapes and the card back.                     */
  /* ------------------------------------------------------------------ */

  const SUIT_PATHS = {
    H: `<path d="M50 90C22 68 4 50 4 30 4 14 16 4 30 4c10 0 17 6 20 14C53 10 60 4 70 4c14 0 26 10 26 26 0 20-18 38-46 60Z"/>`,
    D: `<path d="M50 2Q68 28 90 50 68 72 50 98 32 72 10 50 32 28 50 2Z"/>`,
    S: `<path d="M50 3C62 22 96 40 96 62c0 16-12 24-24 24-9 0-15-4-18-10 1 9 5 16 13 21H33c8-5 12-12 13-21-3 6-9 10-18 10C16 86 4 78 4 62 4 40 38 22 50 3Z"/>`,
    C: `<circle cx="50" cy="27" r="21"/><circle cx="26" cy="58" r="21"/><circle cx="74" cy="58" r="21"/><circle cx="50" cy="52" r="12"/><path d="M46 56c0 18-5 30-14 41h36c-9-11-14-23-14-41Z"/>`,
  };

  function ensureDefs() {
    if (document.getElementById("mbj-defs")) return;
    const holder = document.createElement("div");
    holder.setAttribute("aria-hidden", "true");
    holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    const suits = Object.keys(SUIT_PATHS)
      .map((s) => `<symbol id="mbj-suit-${s}" viewBox="0 0 100 100">${SUIT_PATHS[s]}</symbol>`)
      .join("");
    holder.innerHTML = `
      <svg id="mbj-defs" xmlns="${SVGNS}">
        <defs>
          ${suits}
          <pattern id="mbj-lattice" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="16" height="16" fill="#7a4a22"/>
            <path d="M0 0H16M0 0V16" stroke="#965f2e" stroke-width="3"/>
            <circle cx="8" cy="8" r="1.6" fill="#b07a3e"/>
          </pattern>
          <symbol id="mbj-back" viewBox="0 0 200 280">
            <rect x="3" y="3" width="194" height="274" rx="16" fill="#efdfbb" stroke="${INK}" stroke-width="5"/>
            <rect x="17" y="17" width="166" height="246" rx="9" fill="url(#mbj-lattice)" stroke="${INK}" stroke-width="3.5"/>
            <rect x="25" y="25" width="150" height="230" rx="6" fill="none" stroke="#e9cf98" stroke-width="2" stroke-dasharray="6 5"/>
            <path d="M100 58 154 140 100 222 46 140Z" fill="#efdcb2" stroke="${INK}" stroke-width="4"/>
            <path d="M100 80 139 140 100 200 61 140Z" fill="#8a5427" stroke="${INK}" stroke-width="3"/>
            <path d="M100 104 121 140 100 176 79 140Z" fill="#efdcb2" stroke="${INK}" stroke-width="2.5"/>
            <circle cx="100" cy="140" r="7" fill="#c8312a" stroke="${INK}" stroke-width="2.5"/>
            <g fill="#efdcb2" stroke="${INK}" stroke-width="2.5">
              <circle cx="40" cy="40" r="7"/><circle cx="160" cy="40" r="7"/>
              <circle cx="40" cy="240" r="7"/><circle cx="160" cy="240" r="7"/>
            </g>
          </symbol>
        </defs>
      </svg>`;
    document.body.appendChild(holder);
  }

  /* ------------------------------------------------------------------ */
  /* Card faces                                                          */
  /* ------------------------------------------------------------------ */

  const suitColor = (suit) => (suit === "H" || suit === "D" ? RED : BLACK);
  const clothColor = (suit) => (suit === "H" || suit === "D" ? "#b8322a" : "#2f5163");

  /** A suit pip with a crisp cartoon outline (stroke pass under fill pass). */
  function pip(suit, cx, cy, size, flip) {
    const x = cx - size / 2;
    const y = cy - size / 2;
    const rot = flip ? ` transform="rotate(180 ${cx} ${cy})"` : "";
    const stroke = Math.max(2, 260 / size).toFixed(1);
    return `<g${rot}>
      <use href="#mbj-suit-${suit}" x="${x}" y="${y}" width="${size}" height="${size}" fill="${INK}" stroke="${INK}" stroke-width="${stroke}" stroke-linejoin="round"/>
      <use href="#mbj-suit-${suit}" x="${x}" y="${y}" width="${size}" height="${size}" fill="${suitColor(suit)}"/>
    </g>`;
  }

  // Pip coordinates in a 200×280 card. Lower half is drawn upside down.
  const L = 64;
  const C = 100;
  const R = 136;
  const PIP_LAYOUT = {
    2: [[C, 66], [C, 214]],
    3: [[C, 66], [C, 140], [C, 214]],
    4: [[L, 66], [R, 66], [L, 214], [R, 214]],
    5: [[L, 66], [R, 66], [C, 140], [L, 214], [R, 214]],
    6: [[L, 66], [R, 66], [L, 140], [R, 140], [L, 214], [R, 214]],
    7: [[L, 66], [R, 66], [C, 103], [L, 140], [R, 140], [L, 214], [R, 214]],
    8: [[L, 66], [R, 66], [C, 103], [L, 140], [R, 140], [C, 177], [L, 214], [R, 214]],
    9: [[L, 66], [R, 66], [L, 115], [R, 115], [C, 140], [L, 165], [R, 165], [L, 214], [R, 214]],
    10: [[L, 66], [R, 66], [C, 92], [L, 115], [R, 115], [L, 165], [R, 165], [C, 188], [L, 214], [R, 214]],
  };

  function corner(rank, suit) {
    const color = suitColor(suit);
    const ten = rank === "10";
    const text = `<text x="${ten ? 28 : 26}" y="48" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="${ten ? 32 : 38}" letter-spacing="${ten ? -1.5 : 0}" fill="${color}" stroke="${INK}" stroke-width="1.2" paint-order="stroke">${rank}</text>`;
    const small = pip(suit, 26, 71, 23, false);
    return `<g>${text}${small}</g><g transform="rotate(180 100 140)">${text}${small}</g>`;
  }

  function faceArt(rank, suit) {
    const cloth = clothColor(suit);
    const skin = "#f1c08f";
    const frame = `<rect x="42" y="38" width="116" height="204" rx="8" fill="#ecd9ae" stroke="${INK}" stroke-width="3.5"/>
      <rect x="49" y="45" width="102" height="190" rx="5" fill="none" stroke="${cloth}" stroke-width="2" opacity=".55"/>`;
    const eyes = `<g fill="${INK}"><circle cx="90" cy="134" r="3.6"/><circle cx="110" cy="134" r="3.6"/></g>`;
    let art = "";
    if (rank === "J") {
      // The Jack is a young cowboy with a bandana.
      art = `
        <path d="M54 236c3-36 22-52 46-52s43 16 46 52Z" fill="${cloth}" stroke="${INK}" stroke-width="3.5"/>
        <path d="M84 186h32l-16 26Z" fill="#e3b247" stroke="${INK}" stroke-width="3"/>
        <rect x="92" y="164" width="16" height="22" fill="${skin}" stroke="${INK}" stroke-width="3"/>
        <ellipse cx="100" cy="140" rx="25" ry="29" fill="${skin}" stroke="${INK}" stroke-width="3.5"/>
        ${eyes}
        <path d="M84 125l11 2M116 125l-11 2" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
        <path d="M91 156c6 4 12 4 18 0" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
        <ellipse cx="100" cy="114" rx="50" ry="9" fill="#8a5a2b" stroke="${INK}" stroke-width="3.5"/>
        <path d="M74 114c0-25 9-38 26-38s26 13 26 38Z" fill="#a06c36" stroke="${INK}" stroke-width="3.5"/>
        <path d="M75 104h50v7H75Z" fill="${cloth}" stroke="${INK}" stroke-width="2.5"/>
        <path d="M93 80c4 7 10 7 14 0" fill="none" stroke="${INK}" stroke-width="2.5"/>`;
    } else if (rank === "Q") {
      // The Queen is a saloon lady with a feather in her hair.
      art = `
        <path d="M60 236c-6-40 6-70 4-96 0-30 16-46 36-46s36 16 36 46c-2 26 10 56 4 96Z" fill="#a8521f" stroke="${INK}" stroke-width="3.5"/>
        <path d="M56 236c4-30 20-44 44-44s40 14 44 44Z" fill="${cloth}" stroke="${INK}" stroke-width="3.5"/>
        <path d="M80 194c6 14 34 14 40 0" fill="${skin}" stroke="${INK}" stroke-width="3"/>
        <g fill="#f3e6c4" stroke="${INK}" stroke-width="1.6"><circle cx="86" cy="200" r="3"/><circle cx="100" cy="205" r="3"/><circle cx="114" cy="200" r="3"/></g>
        <rect x="93" y="166" width="14" height="22" fill="${skin}" stroke="${INK}" stroke-width="3"/>
        <ellipse cx="100" cy="142" rx="24" ry="28" fill="${skin}" stroke="${INK}" stroke-width="3.5"/>
        <path d="M76 140c0-22 10-34 24-34s24 12 24 34c-8-10-16-18-24-18s-16 8-24 18Z" fill="#a8521f" stroke="${INK}" stroke-width="3"/>
        ${eyes}
        <path d="M85 129l-3-3M115 129l3-3" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>
        <ellipse cx="100" cy="157" rx="6" ry="3.5" fill="${RED}" stroke="${INK}" stroke-width="2"/>
        <g fill="#f19a86" opacity=".7"><circle cx="85" cy="148" r="4"/><circle cx="115" cy="148" r="4"/></g>
        <path d="M118 112c10-22 22-32 30-30-4 10-14 22-30 30Z" fill="${cloth}" stroke="${INK}" stroke-width="3"/>
        <circle cx="117" cy="112" r="6" fill="#e3b247" stroke="${INK}" stroke-width="2.5"/>`;
    } else {
      // The King wears a crown and an ermine collar, like the reference card.
      art = `
        <path d="M52 236c3-34 22-50 48-50s45 16 48 50Z" fill="${cloth}" stroke="${INK}" stroke-width="3.5"/>
        <path d="M68 200c10 10 54 10 64 0l6 14c-14 12-62 12-76 0Z" fill="#f4ecd8" stroke="${INK}" stroke-width="3"/>
        <g fill="${INK}"><circle cx="82" cy="210" r="1.8"/><circle cx="100" cy="213" r="1.8"/><circle cx="118" cy="210" r="1.8"/></g>
        <ellipse cx="100" cy="142" rx="25" ry="29" fill="${skin}" stroke="${INK}" stroke-width="3.5"/>
        <path d="M75 146c0 30 12 46 25 46s25-16 25-46c-6 8-14 10-25 10s-19-2-25-10Z" fill="#9a5e2c" stroke="${INK}" stroke-width="3"/>
        <path d="M86 155c6-5 10-4 14-1 4-3 8-4 14 1-6 3-10 3-14 1-4 2-8 2-14-1Z" fill="#7a4520" stroke="${INK}" stroke-width="2"/>
        ${eyes}
        <path d="M84 126l12 3M116 126l-12 3" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>
        <path d="M72 118l-4-34 16 14 16-22 16 22 16-14-4 34Z" fill="#e3b247" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>
        <g stroke="${INK}" stroke-width="2"><circle cx="100" cy="106" r="5" fill="${RED}"/><circle cx="82" cy="109" r="3.5" fill="#3f8f5a"/><circle cx="118" cy="109" r="3.5" fill="#3f8f5a"/></g>`;
    }
    return frame + art + pip(suit, 140, 58, 22, false) + pip(suit, 60, 222, 22, true);
  }

  const FACE_CACHE = new Map();

  function cardFaceSVG(card) {
    const key = card.rank + card.suit;
    if (FACE_CACHE.has(key)) return FACE_CACHE.get(key);
    const { rank, suit } = card;
    let center = "";
    if (rank === "A") {
      center = `<circle cx="100" cy="140" r="52" fill="none" stroke="${suitColor(suit)}" stroke-width="2" stroke-dasharray="3 6" opacity=".55"/>
        ${pip(suit, 100, 140, suit === "S" ? 92 : 78, false)}`;
    } else if (rank === "J" || rank === "Q" || rank === "K") {
      center = faceArt(rank, suit);
    } else {
      const size = rank === "10" || rank === "9" ? 34 : 38;
      center = PIP_LAYOUT[rank].map(([x, y]) => pip(suit, x, y, size, y > 140)).join("");
    }
    const svg = `<svg viewBox="0 0 200 280" xmlns="${SVGNS}" aria-hidden="true">
      <rect x="3" y="3" width="194" height="274" rx="16" fill="${PAPER}" stroke="${INK}" stroke-width="5"/>
      <rect x="10" y="10" width="180" height="260" rx="11" fill="none" stroke="#d9c49a" stroke-width="2"/>
      ${center}
      ${corner(rank, suit)}
    </svg>`;
    FACE_CACHE.set(key, svg);
    return svg;
  }

  const SUIT_NAMES = { S: "piky", H: "srdce", D: "káry", C: "kříže" };
  const RANK_NAMES = { A: "eso", J: "kluk", Q: "dáma", K: "král" };

  class CardSprite extends Sprite {
    constructor(cardId, pose) {
      const el = document.createElement("div");
      el.className = "card is-down";
      el.dataset.cardId = cardId;
      el.innerHTML = `
        <div class="card__flip">
          <div class="card__face card__front"></div>
          <div class="card__face card__back"><svg viewBox="0 0 200 280" aria-hidden="true"><use href="#mbj-back"/></svg></div>
        </div>`;
      super(el, pose);
      this.cardId = cardId;
      this.front = el.querySelector(".card__front");
      this.faceUp = false;
      this.card = null;
      el.setAttribute("role", "img");
      el.setAttribute("aria-label", "karta rubem nahoru");
    }

    setCard(card) {
      if (!card || (this.card && this.card.rank === card.rank && this.card.suit === card.suit)) return;
      this.card = card;
      this.front.innerHTML = cardFaceSVG(card);
    }

    setFaceUp(up) {
      this.faceUp = Boolean(up);
      if (!this.el) return;
      this.el.classList.toggle("is-down", !this.faceUp);
      if (this.faceUp && this.card) {
        this.el.setAttribute("aria-label", `${RANK_NAMES[this.card.rank] || this.card.rank} ${SUIT_NAMES[this.card.suit]}`);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Chips                                                               */
  /* ------------------------------------------------------------------ */

  // Display denominations (cents). $1 and 50¢ only appear in 3:2 payouts.
  const CHIP_STYLES = [
    { value: 50000, color: "#6d3fa3", edge: "#43246a", stripe: "#f2e3ff", label: "500" },
    { value: 10000, color: "#2a2622", edge: "#0f0d0b", stripe: "#e9d8a6", label: "100" },
    { value: 2500, color: "#2f8f3a", edge: "#1b5a22", stripe: "#f4f1e6", label: "25" },
    { value: 500, color: "#c62f28", edge: "#7d1813", stripe: "#f4f1e6", label: "5" },
    { value: 100, color: "#f1ede2", edge: "#b9b2a0", stripe: "#3a6fb5", label: "1" },
    { value: 50, color: "#e9a93a", edge: "#a26b14", stripe: "#fff4d6", label: "½" },
  ];

  function chipStyle(value) {
    return CHIP_STYLES.find((s) => s.value === value) || CHIP_STYLES[3];
  }

  /** Greedy decomposition of an amount into display chips (largest first). */
  function breakdown(amount) {
    const chips = [];
    let rest = Math.max(0, Math.round(amount));
    for (const style of CHIP_STYLES) {
      while (rest >= style.value) {
        chips.push(style.value);
        rest -= style.value;
      }
    }
    return chips;
  }

  function chipVars(el, value) {
    const s = chipStyle(value);
    el.style.setProperty("--chip", s.color);
    el.style.setProperty("--chip-edge", s.edge);
    el.style.setProperty("--chip-stripe", s.stripe);
  }

  /** Front-facing chip used in the chip tray. */
  function makeTrayChip(value) {
    const s = chipStyle(value);
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tray-chip";
    el.dataset.value = String(value);
    chipVars(el, value);
    el.innerHTML = `<span class="tray-chip__inner"><span class="tray-chip__label">$${s.label}</span></span>`;
    el.setAttribute("aria-label", `Žeton $${s.label}`);
    return el;
  }

  /** A stack of chips seen in perspective, like the stack in the reference. */
  class ChipStack extends Sprite {
    constructor(pose, options) {
      const el = document.createElement("div");
      el.className = "chip-stack";
      el.innerHTML = `<div class="chip-stack__chips"></div><div class="chip-stack__tag"></div>`;
      super(el, pose);
      this.chipsEl = el.querySelector(".chip-stack__chips");
      this.tagEl = el.querySelector(".chip-stack__tag");
      this.amount = 0;
      this.showTag = !(options && options.noTag);
      if (!this.showTag) this.tagEl.remove();
      this.prefix = (options && options.prefix) || "";
    }

    setAmount(amount, opts) {
      const prev = this.amount;
      this.amount = Math.max(0, Math.round(amount));
      const chips = breakdown(this.amount);
      const max = 14;
      const visible = chips.length > max ? chips.slice(0, max) : chips;
      // Largest at the bottom.
      const frag = document.createDocumentFragment();
      visible.forEach((value, i) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chipVars(chip, value);
        chip.style.setProperty("--i", String(i));
        if (opts && opts.pop && i === visible.length - 1 && this.amount > prev) chip.classList.add("is-new");
        frag.appendChild(chip);
      });
      this.chipsEl.replaceChildren(frag);
      this.chipsEl.style.setProperty("--n", String(visible.length));
      if (this.showTag) {
        this.tagEl.textContent = this.prefix + MBJ.utils.formatMoney(this.amount);
        this.tagEl.hidden = this.amount === 0;
      }
      this.el.classList.toggle("is-empty", this.amount === 0);
    }
  }

  MBJ.Sprite = Sprite;
  MBJ.CardSprite = CardSprite;
  MBJ.ChipStack = ChipStack;
  MBJ.chips = { styles: CHIP_STYLES, chipStyle, breakdown, makeTrayChip, chipVars };
  MBJ.cardArt = { ensureDefs, cardFaceSVG, pip };
})(typeof window !== "undefined" ? window : globalThis);
