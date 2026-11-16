/* Every Blackjack rule the engine obeys lives here (aligned with ../rules.txt).
   Change a value here and both the engine and the table UI follow. */
(function (global) {
  "use strict";

  const MBJ = (global.MBJ = global.MBJ || {});

  MBJ.RULES = Object.freeze({
    // Shoe
    decks: 6,
    penetration: 0.75, // cut card position – reshuffle before the next round once reached

    // Table
    seats: 3,
    startingBankroll: 100000, // cents ($1 000)
    minBet: 500, // cents ($5)
    maxBet: 50000, // cents ($500) per seat
    chipValues: Object.freeze([500, 2500, 10000, 50000]), // $5, $25, $100, $500

    // Payouts (profit multipliers)
    blackjackPays: 1.5, // 3:2
    winPays: 1, // 1:1
    insurancePays: 2, // 2:1

    // Dealer
    dealerHitsSoft17: false, // S17 – dealer hits <= 16, stands on 17..21
    dealerPeeks: true, // dealer checks the hole card for Blackjack under an Ace or a ten

    // Player options
    insurance: true, // offered when the dealer shows an Ace (costs half the bet)
    surrender: true, // late surrender on initial 2-card hand returns half the bet
    doubleOnAnyTwo: true, // otherwise only on hard 9, 10, 11
    doubleAfterSplit: true,
    maxHandsPerSeat: 4, // up to 3 splits per seat
    splitByValue: true, // 10-J-Q-K count as a pair
    resplitAces: false,
    splitAcesOneCard: true, // each split Ace receives one card
    autoStandOn21: true,
  });
})(typeof window !== "undefined" ? window : globalThis);
