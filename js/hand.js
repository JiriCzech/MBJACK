/* Pure Blackjack hand arithmetic. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});

  /** Base value of a card: Ace = 1 (promoted to 11 by evaluate), faces = 10. */
  function cardValue(card) {
    if (card.rank === "A") return 1;
    if (card.rank === "J" || card.rank === "Q" || card.rank === "K") return 10;
    return Number(card.rank);
  }

  /**
   * Evaluate a list of cards.
   * At most one Ace can ever count as 11 (two would be 22), so the best total
   * is the hard total plus 10 when there is an Ace and that does not bust.
   */
  function evaluate(cards) {
    let hard = 0;
    let aces = 0;
    for (const card of cards) {
      hard += cardValue(card);
      if (card.rank === "A") aces += 1;
    }
    const soft = aces > 0 && hard + 10 <= 21;
    const total = soft ? hard + 10 : hard;
    return {
      total,
      hard,
      soft,
      bust: total > 21,
      twentyOne: total === 21,
      natural: cards.length === 2 && total === 21,
      count: cards.length,
    };
  }

  /** Text used on the total badge, e.g. "7 / 17" for a soft 17. */
  function label(cards) {
    if (!cards.length) return "";
    const ev = evaluate(cards);
    if (ev.natural) return "BJ";
    if (ev.soft && ev.total !== 21) return `${ev.hard} / ${ev.total}`;
    return String(ev.total);
  }

  function isPair(cards, byValue) {
    if (cards.length !== 2) return false;
    if (byValue) return cardValue(cards[0]) === cardValue(cards[1]);
    return cards[0].rank === cards[1].rank;
  }

  MBJ.Hand = Object.freeze({ cardValue, evaluate, label, isPair });
})(typeof window !== "undefined" ? window : globalThis);
