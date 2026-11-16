/* Headless test-suite for the MB Jack engine.
   Run:  node tests/engine.test.mjs
   No dependencies – the classic browser scripts are loaded into a VM context. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ console, Math, JSON, Uint32Array, crypto: globalThis.crypto });
for (const file of ["utils.js", "events.js", "rules.js", "shoe.js", "hand.js", "blackjack.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "js", file), "utf8"), context, { filename: file });
}
const MBJ = context.MBJ;
const H = MBJ.Hand;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}\n   ${error.stack}`);
  }
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || "expected"}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
function ok(value, message) {
  if (!value) throw new Error(message || "assertion failed");
}

const c = (spec) => {
  const rank = spec.slice(0, -1);
  return { id: "t" + Math.random(), rank, suit: spec.slice(-1) };
};

/** Make the next draws come out in exactly this order. */
function stack(engine, specs) {
  const cards = specs.map(c);
  engine.shoe.cards.push(...cards.reverse());
}

function newEngine(rules, bankroll) {
  const bus = new MBJ.EventBus();
  const engine = new MBJ.BlackjackEngine({ bus, rules, random: MBJ.utils.mulberry32(7), bankroll });
  const log = [];
  bus.on("*", (payload, name) => log.push({ name, payload }));
  engine.log = log;
  return engine;
}

/* ------------------------------ hand maths ------------------------------ */

test("ace counts as 11 or 1", () => {
  eq(H.evaluate([c("AS"), c("6H")]).total, 17);
  eq(H.evaluate([c("AS"), c("6H")]).soft, true);
  eq(H.evaluate([c("AS"), c("6H"), c("9C")]).total, 16);
  eq(H.evaluate([c("AS"), c("6H"), c("9C")]).soft, false);
  eq(H.evaluate([c("AS"), c("AH"), c("9C")]).total, 21);
  eq(H.evaluate([c("AS"), c("AH")]).total, 12);
  eq(H.evaluate([c("AS"), c("AH"), c("AD"), c("AC")]).total, 14);
  eq(H.evaluate([c("KS"), c("QH"), c("2C")]).bust, true);
  eq(H.label([c("AS"), c("6H")]), "7 / 17");
  eq(H.label([c("AS"), c("KH")]), "BJ");
});

test("natural blackjack only with two cards", () => {
  ok(H.evaluate([c("AS"), c("JH")]).natural);
  ok(!H.evaluate([c("7S"), c("7H"), c("7D")]).natural);
});

test("pairs by value", () => {
  ok(H.isPair([c("KS"), c("10H")], true));
  ok(!H.isPair([c("KS"), c("10H")], false));
  ok(H.isPair([c("8S"), c("8H")], false));
});

/* ------------------------------- betting -------------------------------- */

test("betting limits and bankroll", () => {
  const e = newEngine();
  eq(e.placeBet(0, 500).ok, true);
  eq(e.bankroll, 99500);
  eq(e.placeBet(0, 50000).reason, "max-bet");
  eq(e.placeBet(5, 500).reason, "bad-seat");
  eq(e.placeBet(1, 0).reason, "bad-amount");
  eq(e.removeBet(0).ok, true);
  eq(e.bankroll, 100000);
  eq(e.deal().reason, "no-bets");
  const poor = newEngine({}, 1000);
  eq(poor.placeBet(0, 2500).reason, "insufficient-funds");
});

test("actions rejected in wrong phase", () => {
  const e = newEngine();
  eq(e.hit().ok, false);
  eq(e.stand().ok, false);
  eq(e.newRound().ok, false);
  eq(e.insurance(true).ok, false);
});

/* ------------------------------- payouts -------------------------------- */

test("player blackjack pays 3:2", () => {
  const e = newEngine();
  e.placeBet(0, 1000);
  stack(e, ["AS", "9H", "KD", "7C"]); // P: A,K  D: 9,7
  e.deal();
  eq(e.phase, "roundOver");
  eq(e.state.lastResult.results[0].result, "blackjack");
  eq(e.bankroll, 100000 + 1500);
});

test("player blackjack vs dealer blackjack pushes", () => {
  const e = newEngine();
  e.placeBet(0, 1000);
  stack(e, ["AS", "KH", "KD", "AC"]);
  e.deal();
  eq(e.phase, "roundOver");
  eq(e.state.lastResult.results[0].result, "push");
  eq(e.bankroll, 100000);
});

test("dealer peeks for blackjack under a ten", () => {
  const e = newEngine();
  e.placeBet(1, 1000);
  stack(e, ["9S", "KH", "9D", "AC"]);
  e.deal();
  eq(e.phase, "roundOver");
  eq(e.state.lastResult.dealerBlackjack, true);
  eq(e.state.lastResult.results[0].result, "lose");
  eq(e.bankroll, 99000);
});

test("insurance pays 2:1 when dealer has blackjack", () => {
  const e = newEngine();
  e.placeBet(0, 1000);
  stack(e, ["9S", "AH", "9D", "KC"]);
  e.deal();
  eq(e.phase, "insurance");
  eq(e.insurance(true).ok, true);
  eq(e.phase, "roundOver");
  // bet lost (-1000), insurance 500 returns 1500
  eq(e.bankroll, 100000);
});

test("insurance lost when dealer has no blackjack, play continues", () => {
  const e = newEngine();
  e.placeBet(0, 1000);
  stack(e, ["10S", "AH", "9D", "6C"]);
  e.deal();
  e.insurance(true);
  eq(e.phase, "playerTurn");
  ok(e.log.some((l) => l.name === "insurance:lost"));
  stack(e, ["5S"]); // dealer: A,6 = soft 17 -> stands (S17)
  e.stand();
  eq(e.phase, "roundOver");
  eq(e.state.lastResult.dealerTotal, 17);
  eq(e.state.lastResult.results[0].result, "win");
  eq(e.bankroll, 100000 - 500 + 1000);
});

test("dealer stands on soft 17 (S17) and hits it with H17", () => {
  const s17 = newEngine();
  s17.placeBet(0, 1000);
  stack(s17, ["10S", "6H", "8D", "AC"]);
  s17.deal(); // dealer up 6 -> no peek
  s17.stand();
  eq(s17.state.dealer.cards.length, 2);
  eq(s17.state.lastResult.dealerTotal, 17);

  const h17 = newEngine({ dealerHitsSoft17: true });
  h17.placeBet(0, 1000);
  stack(h17, ["10S", "6H", "8D", "AC", "4S"]);
  h17.deal();
  h17.stand();
  eq(h17.state.dealer.cards.length, 3);
  eq(h17.state.lastResult.dealerTotal, 21);
});

test("dealer must hit 16 and bust pays winners", () => {
  const e = newEngine();
  e.placeBet(0, 1000);
  e.placeBet(2, 2000);
  stack(e, ["10S", "9H", "10D", "8C", "7D", "6S", "KH"]);
  // P0: 10,8 ; P2: 9,7 ; D: 10,6
  e.deal();
  e.stand();
  e.stand();
  eq(e.state.lastResult.dealerBust, true);
  eq(e.bankroll, 100000 + 1000 + 2000);
});

test("bust loses even if dealer busts; dealer does not draw when all bust", () => {
  const e = newEngine();
  e.placeBet(0, 1000);
  stack(e, ["10S", "6H", "6D", "10C", "KH"]);
  e.deal();
  e.hit();
  eq(e.phase, "roundOver");
  eq(e.state.dealer.cards.length, 2);
  eq(e.state.lastResult.results[0].result, "bust");
  eq(e.bankroll, 99000);
});

test("push returns the stake", () => {
  const e = newEngine();
  e.placeBet(0, 1000);
  stack(e, ["10S", "10H", "8D", "8C"]);
  e.deal();
  e.stand();
  eq(e.state.lastResult.results[0].result, "push");
  eq(e.bankroll, 100000);
});

test("double down doubles the stake and takes exactly one card", () => {
  const e = newEngine();
  e.placeBet(0, 1000);
  stack(e, ["6S", "10H", "5D", "7C", "10D", "KS"]);
  // P: 6,5=11 ; D: 10,7
  e.deal();
  ok(e.getAvailableActions().double);
  e.double();
  eq(e.state.hands[0].cards.length, 3);
  eq(e.state.hands[0].bet, 2000);
  eq(e.state.lastResult.results[0].result, "win");
  eq(e.bankroll, 100000 + 2000);
});

test("split creates two hands, 21 after split is not blackjack", () => {
  const e = newEngine();
  e.placeBet(0, 1000);
  stack(e, ["8S", "10H", "8D", "9C", "3H", "AS", "KD"]);
  // P: 8,8 ; D: 10,9 ; split -> hand1: 8+3 ; hand2: 8+A? no - order below
  e.deal();
  ok(e.getAvailableActions().split);
  e.split();
  eq(e.state.hands.length, 2);
  eq(e.state.hands[0].cards.length, 2); // 8,3 = 11
  e.double(); // 8,3,A = 12
  // hand 2 receives K -> 18
  eq(e.state.hands[1].cards.length, 2);
  e.stand();
  eq(e.phase, "roundOver");
  eq(e.bankroll, 100000 - 2000 - 1000);
});

test("split aces receive one card each and A+10 pays 1:1", () => {
  const e = newEngine();
  e.placeBet(0, 1000);
  stack(e, ["AS", "9H", "AD", "7C", "KH", "5D", "2S"]); // dealer 9,7 + 2 = 18
  e.deal();
  e.split();
  eq(e.phase, "roundOver");
  const r = e.state.lastResult.results;
  eq(r[0].result, "win"); // A+K = 21 but not blackjack
  eq(r[0].payout, 2000);
  eq(r[1].result, "lose"); // A+5 = 16 vs 18
});

test("max hands per seat", () => {
  const e = newEngine({ maxHandsPerSeat: 2 });
  e.placeBet(0, 1000);
  stack(e, ["8S", "10H", "8D", "9C", "8H"]);
  e.deal();
  e.split();
  eq(e.state.hands[0].cards.length, 2);
  eq(e.getAvailableActions().split, false);
});

test("auto-stand on 21 and rebet", () => {
  const e = newEngine();
  e.placeBet(1, 2500);
  stack(e, ["5S", "10H", "6D", "9C", "KH"]);
  e.deal();
  e.hit(); // 21
  eq(e.phase, "roundOver");
  e.newRound();
  eq(e.phase, "betting");
  ok(e.getAvailableActions().rebet);
  e.rebet();
  eq(e.state.seatBets[1], 2500);
});

test("broke player can rebuy", () => {
  const e = newEngine({}, 500);
  e.placeBet(0, 500);
  stack(e, ["10S", "10H", "6D", "9C", "KH"]);
  e.deal();
  e.hit();
  e.newRound();
  ok(e.isBroke());
  eq(e.rebuy().ok, true);
  eq(e.bankroll, MBJ.RULES.startingBankroll);
});

test("re-entrant actions from listeners are refused", () => {
  const e = newEngine();
  let inner = null;
  e.on("bet:changed", () => {
    if (!inner) inner = e.deal();
  });
  e.placeBet(0, 500);
  eq(inner.reason, "busy");
});

test("late surrender returns half the bet and cannot follow hit or split", () => {
  const e = newEngine();
  e.placeBet(0, 2000);
  stack(e, ["10S", "10H", "6D", "7C"]); // P: 10,6=16 vs D: 10,7=17
  e.deal();
  ok(e.getAvailableActions().surrender);
  eq(e.surrender().ok, true);
  eq(e.phase, "roundOver");
  eq(e.state.dealer.cards.length, 2);
  eq(e.state.lastResult.results[0].result, "surrender");
  eq(e.state.lastResult.results[0].payout, 1000);
  eq(e.bankroll, 99000);

  e.newRound();
  e.placeBet(0, 1000);
  stack(e, ["5S", "9H", "4D", "8C", "2H"]); // P: 5,4 -> hit 2 = 11
  e.deal();
  e.hit();
  eq(e.getAvailableActions().surrender, false);
  eq(e.surrender().ok, false);
});

/* -------------------------------- fuzzing ------------------------------- */

test("20 000 random rounds keep every invariant", () => {
  const rnd = MBJ.utils.mulberry32(1234);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const e = new MBJ.BlackjackEngine({ random: MBJ.utils.mulberry32(99) });
  const legalPhases = new Set(Object.values(MBJ.PHASE));
  let ledger = e.bankroll; // what bankroll + table money must equal
  let rounds = 0;
  let steps = 0;
  const seen = {};

  e.on("round:settled", (res) => {
    ledger += res.net;
    for (const r of res.results) seen[r.result] = (seen[r.result] || 0) + 1;
    // Payout sanity
    for (const r of res.results) {
      if (r.result === "blackjack") eq(r.payout, r.bet + Math.floor(r.bet * 1.5), "bj payout");
      if (r.result === "win") eq(r.payout, r.bet * 2, "win payout");
      if (r.result === "push") eq(r.payout, r.bet, "push payout");
      if (r.result === "surrender") eq(r.payout, Math.floor(r.bet / 2), "surrender payout");
      if (r.result === "lose" || r.result === "bust") eq(r.payout, 0, "lose payout");
    }
  });
  e.on("bankroll:rebuy", (p) => {
    ledger = p.bankroll;
  });

  while (rounds < 20000) {
    steps += 1;
    if (steps > 2_000_000) throw new Error("fuzz did not terminate");
    ok(legalPhases.has(e.phase), "legal phase");
    ok(e.bankroll >= 0, "bankroll never negative");
    const inPlay = e.phase !== "roundOver";
    eq(e.bankroll + (inPlay ? e.moneyOnTable() : 0), ledger, `money conservation in ${e.phase}`);

    const a = e.getAvailableActions();
    switch (e.phase) {
      case "betting": {
        if (a.rebuy) {
          e.rebuy();
          break;
        }
        if (a.rebet && rnd() < 0.4) {
          e.rebet();
          break;
        }
        if (a.deal && rnd() < 0.5) {
          eq(e.deal().ok, true);
          break;
        }
        const r = e.placeBet(Math.floor(rnd() * 3), pick(MBJ.RULES.chipValues));
        if (!r.ok && !a.deal && e.totalSeatBets() === 0) {
          // can't afford chosen chip – try the smallest
          e.placeBet(0, MBJ.RULES.minBet);
        }
        break;
      }
      case "insurance":
        e.insurance(rnd() < 0.3);
        break;
      case "playerTurn": {
        const hand = e.activeHand;
        ok(hand && hand.status === "playing", "active hand is playable");
        const options = ["stand"];
        if (a.hit) options.push("hit", "hit");
        if (a.double) options.push("double");
        if (a.split) options.push("split", "split");
        if (a.surrender) options.push("surrender");
        const choice = pick(options);
        eq(e[choice]().ok, true, `action ${choice}`);
        break;
      }
      case "roundOver": {
        for (const h of e.state.hands) ok(h.result, "every hand settled");
        const d = H.evaluate(e.state.dealer.cards);
        const anyLive = e.state.hands.some((h) => h.status === "stood");
        if (anyLive && !e.state.lastResult.dealerBlackjack) ok(d.total >= 17, "dealer drew to 17");
        if (e.state.dealer.cards.length > 2) ok(H.evaluate(e.state.dealer.cards.slice(0, -1)).total < 17, "dealer never hits a hard 17+");
        for (const h of e.state.hands) {
          ok(e.state.hands.filter((x) => x.seat === h.seat).length <= MBJ.RULES.maxHandsPerSeat, "max hands");
          if (h.splitAces) eq(h.cards.length, 2, "split aces one card");
          if (h.doubled) eq(h.cards.length, 3, "double one card");
        }
        e.newRound();
        rounds += 1;
        break;
      }
      default:
        throw new Error("unexpected phase " + e.phase);
    }
  }
  ok(seen.blackjack && seen.win && seen.push && seen.lose && seen.bust && seen.surrender, "every result type occurred");
  // Card conservation: shoe + discards == decks * 52 between rounds
  eq(e.shoe.cards.length + e.shoe.discards.length, MBJ.RULES.decks * 52, "card conservation");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
