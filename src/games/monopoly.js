/**
 * Monopoly-style property trading game (2-6 players) on an original city-themed 40 space board.
 *
 * Options (see config.js):
 *   startCash     1000 | 1500 | 2500
 *   freeParking   'none' | 'pot' (taxes, fines and bail collect in a jackpot taken by whoever lands on Free Parking)
 *   auction       'on' | 'off' (declined or liquidated properties go to auction among everybody)
 *   timeLimit     0 or minutes; when time is up (at the end of the current turn) the highest net worth wins
 *   turnTime      0 or seconds per decision; a timeout plays a sensible default, repeated timeouts make a
 *                 player an auto player so the game never stalls
 *
 * Rule choices: income tax is a flat 200 and luxury tax 100; passing or landing on GO pays 200; doubles roll
 * again and three doubles in a row go to jail; jail costs 50 (or a card, or roll doubles, forced after 3 turns);
 * rent is doubled on an unimproved complete colour group; building follows the even-building rule with the bank
 * limits of 32 houses and 12 hotels; buildings sell back at half price; a hotel sold during a house shortage
 * becomes as many houses as the bank has; mortgages pay half the price and cost 10% interest to lift; a
 * mortgaged property received in a trade or by bankruptcy costs the receiver 10% at once; a bankrupt player's
 * assets go to the creditor (to the bank, and then to auction, when the debt was to the bank or the player leaves);
 * "collect from each player" cards take only what a player can pay in cash; net worth = cash + property
 * (mortgaged ones at half) + buildings at cost.
 *
 * Everything is public, so every snapshot ('monopoly-state') is the same apart from `you` and `manage`.
 */
import {
  SPACES, GROUPS, DECKS, STATIONS, UTILITIES, TOKENS, COLORS, boardForClient,
  GO_SALARY, JAIL_POS, BAIL, HOUSES_TOTAL, HOTELS_TOTAL, STATION_RENT, UTILITY_MULT, MORTGAGE_INTEREST
} from './monopoly-data.js';

const AUCTION_MS = 20000;
const BID_EXTEND_MS = 12000;
const TRADE_MS = 60000;
const AUTO_MS = 900;
const START_FALLBACK_MS = 6000;
const RETURN_TO_LOBBY_MS = 30000;
const TIMEOUTS_TO_AUTO = 3;
const MAX_CASH = 1000000;
const LOG_KEEP = 60;

const M = (k, p) => (p ? { k, p } : { k });
const interest = (idx) => Math.ceil(SPACES[idx].mortgage / Math.round(1 / MORTGAGE_INTEREST));
const unmortgageCost = (idx) => SPACES[idx].mortgage + interest(idx);

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class Monopoly {
  constructor(room, players, options = {}, extra = {}) {
    this.room = room;
    this.isGameActive = true;
    this.rng = extra.rng || Math.random;
    this.now = extra.now || (() => Date.now());
    this.autoMs = extra.autoMs ?? AUTO_MS;
    this.rollDie = () => 1 + Math.floor(this.rng() * 6);

    const cash = [1000, 1500, 2500].includes(Number(options.startCash)) ? Number(options.startCash) : 1500;
    const pick = (v, list, d) => (list.includes(Number(v)) ? Number(v) : d);
    this.opts = {
      startCash: cash,
      freeParking: options.freeParking === 'pot' ? 'pot' : 'none',
      auction: options.auction === 'off' ? 'off' : 'on',
      timeLimit: pick(options.timeLimit, [0, 45, 60, 90], 60),
      turnTime: pick(options.turnTime, [0, 30, 60, 90], 60)
    };
    this.turnMs = this.opts.turnTime * 1000;

    const ids = Object.keys(players).slice(0, 6);
    this.order = shuffle([...ids], this.rng);
    this.P = {};
    this.order.forEach((id, seat) => {
      this.P[id] = {
        id, name: players[id].name, seat, token: TOKENS[seat], color: COLORS[seat],
        cash, pos: 0, jail: false, jailTurns: 0, cards: [],
        bankrupt: false, left: false, auto: false, timeouts: 0
      };
    });

    this.owner = Array(40).fill(null);
    this.houses = Array(40).fill(0);
    this.mortgaged = Array(40).fill(false);
    this.decks = {};
    for (const [name, cards] of Object.entries(DECKS)) {
      this.decks[name] = { q: shuffle(cards.map((_, i) => i), this.rng) };
    }
    this.pot = 0;
    this.dice = [0, 0];
    this.diceSeq = 0;
    this.seq = 0;
    this.logSeq = 0;
    this.logs = [];
    this.moves = [];
    this.lastCard = null;
    this.moveSeq = 0;
    this.cardSeq = 0;
    this.debt = null;
    this.debtCont = null;
    this.auction = null;
    this.queue = [];
    this.trade = null;
    this.tradeSeq = 0;
    this.bankruptOrder = [];
    this.over = false;
    this.winner = null;
    this.timeUp = false;
    this.running = false;
    this.loaded = new Set();
    this.timers = { turn: null, auction: null, trade: null, game: null, auto: null, start: null };
    this.deadline = 0;
    this.endsAt = 0;
    this.t = { doubles: 0, extra: false, jailed: false, rolled: false };

    this.turn = this.order[0];
    this.phase = 'roll';
    this.log('monopoly.log.start', { name: this.P[this.turn].name });
    this.timers.start = setTimeout(() => this.begin(), START_FALLBACK_MS);
  }

  // ------------------------------------------------------------------ basics

  get cur() { return this.P[this.turn]; }
  active() { return this.order.filter((id) => !this.P[id].bankrupt); }
  others(id) { return this.active().filter((x) => x !== id); }
  housesLeft() { return HOUSES_TOTAL - this.houses.reduce((n, h) => n + (h > 0 && h < 5 ? h : 0), 0); }
  hotelsLeft() { return HOTELS_TOTAL - this.houses.filter((h) => h === 5).length; }
  ownedBy(id) { return SPACES.filter((s) => this.owner[s.i] === id).map((s) => s.i); }
  setOwned(id, g) { return GROUPS[g].spaces.every((i) => this.owner[i] === id); }

  log(k, p) {
    this.logs.push({ i: ++this.logSeq, m: M(k, p) });
    if (this.logs.length > LOG_KEEP) this.logs.shift();
  }

  fail(odId, k, p) {
    const ws = this.room.getWsByUserId(odId);
    // the room page also shows this toast, so only plain params (names) are sent
    if (ws) this.room.send(ws, { type: 'error', message: M(k, p && p.name !== undefined ? { name: p.name } : undefined) });
  }

  begin() {
    if (this.running || !this.isGameActive) return;
    this.running = true;
    clearTimeout(this.timers.start);
    if (this.opts.timeLimit > 0) {
      this.endsAt = this.now() + this.opts.timeLimit * 60000;
      this.timers.game = setTimeout(() => this.onTimeUp(), this.opts.timeLimit * 60000);
    }
    this.armTimers();
    this.push();
  }

  netWorth(p) {
    let n = p.cash;
    for (const i of this.ownedBy(p.id)) {
      const s = SPACES[i];
      n += this.mortgaged[i] ? s.mortgage : s.price;
      n += (this.houses[i] || 0) * (s.house || 0);
    }
    return n;
  }

  /** Cash plus everything that could be turned into cash by selling buildings and mortgaging. */
  liquid(p) {
    let n = p.cash;
    for (const i of this.ownedBy(p.id)) {
      const s = SPACES[i];
      n += ((this.houses[i] || 0) * (s.house || 0)) / 2;
      if (!this.mortgaged[i]) n += s.mortgage;
    }
    return n;
  }

  // ---------------------------------------------------------------- messages

  handleMessage(odId, type, payload) {
    if (!this.isGameActive) return;
    const p = this.P[odId];
    if (!p || typeof type !== 'string' || !type.startsWith('monopoly-')) return;
    if (type === 'monopoly-page-loaded') {
      this.loaded.add(odId);
      this.sendBoard(odId);
      this.sendState(odId);
      if (!this.running && this.loaded.size >= this.order.length) this.begin();
      return;
    }
    if (this.over || p.bankrupt) return;
    const d = payload && typeof payload === 'object' ? payload : {};
    p.timeouts = 0;
    if (p.auto) p.auto = false;

    let changed = false;
    switch (type) {
      case 'monopoly-roll': changed = this.doRoll(p); break;
      case 'monopoly-buy': changed = this.doBuy(p); break;
      case 'monopoly-decline': changed = this.doDecline(p); break;
      case 'monopoly-end-turn': changed = this.doEndTurn(p); break;
      case 'monopoly-jail': changed = this.doJail(p, d.how); break;
      case 'monopoly-pay-debt': changed = this.doPayDebt(p); break;
      case 'monopoly-resign': changed = this.doResign(p); break;
      case 'monopoly-build': changed = this.doManage(p, 'build', d.idx); break;
      case 'monopoly-sell': changed = this.doManage(p, 'sell', d.idx); break;
      case 'monopoly-mortgage': changed = this.doManage(p, 'mortgage', d.idx); break;
      case 'monopoly-unmortgage': changed = this.doManage(p, 'unmortgage', d.idx); break;
      case 'monopoly-bid': changed = this.doBid(p, d.amount); break;
      case 'monopoly-auction-pass': changed = this.doAuctionPass(p); break;
      case 'monopoly-trade': changed = this.doTradePropose(p, d); break;
      case 'monopoly-trade-accept': changed = this.doTradeAccept(p); break;
      case 'monopoly-trade-decline': changed = this.doTradeDecline(p); break;
      case 'monopoly-trade-cancel': changed = this.doTradeCancel(p); break;
      case 'monopoly-trade-counter': changed = this.doTradeCounter(p, d); break;
      default: return;
    }
    if (changed !== false) this.push();
  }

  // ---------------------------------------------------------------- the turn

  isTurn(p) { return this.turn === p.id && !this.over; }

  doRoll(p) {
    if (!this.isTurn(p) || this.phase !== 'roll') return this.fail(p.id, 'monopoly.err.notNow'), false;
    this.roll(p);
    return true;
  }

  roll(p) {
    const a = this.rollDie();
    const b = this.rollDie();
    const total = a + b;
    const dbl = a === b;
    this.dice = [a, b];
    this.diceSeq++;
    this.t.rolled = true;
    this.log('monopoly.log.roll', { name: p.name, a, b });

    if (p.jail) {
      this.t.extra = false;
      if (dbl) {
        p.jail = false;
        p.jailTurns = 0;
        this.log('monopoly.log.jailDoubles', { name: p.name });
        return this.advance(p, total);
      }
      p.jailTurns++;
      if (p.jailTurns >= 3) {
        this.log('monopoly.log.jailForced', { name: p.name, m_a: BAIL });
        return this.owe(p, BAIL, 'pot', M('monopoly.reason.bail'), () => {
          p.jail = false;
          p.jailTurns = 0;
          this.advance(p, total);
        });
      }
      this.log('monopoly.log.jailStay', { name: p.name });
      return this.setPhase('end');
    }

    if (dbl) {
      this.t.doubles++;
      if (this.t.doubles >= 3) {
        this.t.extra = false;
        this.log('monopoly.log.speeding', { name: p.name });
        this.sendToJail(p);
        return this.resolveEnd();
      }
      this.t.extra = true;
    } else {
      this.t.extra = false;
    }
    this.advance(p, total);
  }

  advance(p, steps, ctx = {}) {
    const from = p.pos;
    const raw = from + steps;
    p.pos = raw % 40;
    this.addMove({ id: p.id, from, to: p.pos, mode: 'walk' });
    if (raw >= 40) {
      p.cash += GO_SALARY;
      this.log(p.pos === 0 ? 'monopoly.log.landGo' : 'monopoly.log.passGo', { name: p.name, m_a: GO_SALARY });
    }
    this.land(p, ctx);
  }

  addMove(m) {
    this.moves.push({ seq: ++this.moveSeq, ...m });
    if (this.moves.length > 10) this.moves.shift();
  }

  moveBack(p, n) {
    const from = p.pos;
    p.pos = (p.pos - n + 40) % 40;
    this.addMove({ id: p.id, from, to: p.pos, mode: 'back' });
    this.land(p, {});
  }

  sendToJail(p) {
    const from = p.pos;
    p.pos = JAIL_POS;
    p.jail = true;
    p.jailTurns = 0;
    this.t.jailed = true;
    this.t.extra = false;
    this.addMove({ id: p.id, from, to: JAIL_POS, mode: 'jump', jail: true });
    this.log('monopoly.log.toJail', { name: p.name });
  }

  rentFor(idx, ctx = {}) {
    const s = SPACES[idx];
    const o = this.owner[idx];
    if (o === null || this.mortgaged[idx]) return 0;
    if (s.type === 'street') {
      const h = this.houses[idx];
      if (h > 0) return s.rent[h];
      return this.setOwned(o, s.group) ? s.rent[0] * 2 : s.rent[0];
    }
    if (s.type === 'station') {
      const n = STATIONS.filter((i) => this.owner[i] === o).length;
      return STATION_RENT[n - 1] * (ctx.mode === 'double' ? 2 : 1);
    }
    const n = UTILITIES.filter((i) => this.owner[i] === o).length;
    const dice = ctx.dice ?? this.dice[0] + this.dice[1];
    return (ctx.mode === 'ten' ? UTILITY_MULT[1] : UTILITY_MULT[n - 1]) * dice;
  }

  land(p, ctx = {}) {
    const s = SPACES[p.pos];
    switch (s.type) {
      case 'go':
      case 'jail':
        return this.resolveEnd();
      case 'parking':
        if (this.opts.freeParking === 'pot' && this.pot > 0) {
          this.log('monopoly.log.jackpot', { name: p.name, m_a: this.pot });
          p.cash += this.pot;
          this.pot = 0;
        }
        return this.resolveEnd();
      case 'gotojail':
        this.sendToJail(p);
        return this.resolveEnd();
      case 'tax':
        this.log('monopoly.log.tax', { name: p.name, m_a: s.tax, s_i: s.i });
        return this.owe(p, s.tax, 'pot', M('monopoly.reason.tax', { s_i: s.i }), () => this.resolveEnd());
      case 'chance':
      case 'chest':
        return this.drawCard(p, s.type);
      default:
        break;
    }
    const o = this.owner[s.i];
    if (o === null) {
      if (this.opts.auction === 'off' && p.cash < s.price) {
        this.log('monopoly.log.cannotAfford', { name: p.name, s_i: s.i });
        return this.resolveEnd();
      }
      return this.setPhase('buy');
    }
    if (o === p.id) return this.resolveEnd();
    if (this.mortgaged[s.i]) {
      this.log('monopoly.log.noRentMortgaged', { name: p.name, s_i: s.i });
      return this.resolveEnd();
    }
    let rctx = ctx;
    if (s.type === 'utility' && ctx.mode === 'ten') {
      const dice = this.rollDie() + this.rollDie();
      rctx = { ...ctx, dice };
      this.log('monopoly.log.utilityRoll', { name: p.name, n: dice });
    }
    const rent = this.rentFor(s.i, rctx);
    this.log('monopoly.log.rent', { name: p.name, owner: this.P[o].name, m_a: rent, s_i: s.i });
    this.owe(p, rent, o, M('monopoly.reason.rent', { s_i: s.i, owner: this.P[o].name }), () => this.resolveEnd());
  }

  drawCard(p, deckName) {
    const deck = this.decks[deckName];
    const n = deck.q.shift();
    const card = DECKS[deckName][n];
    if (card.t === 'free') p.cards.push(deckName);
    else deck.q.push(n);
    const text = M(`monopoly.card.${deckName}.${n}`, card.p);
    this.lastCard = { seq: ++this.cardSeq, by: p.id, deck: deckName, n, p: card.p, after: this.moveSeq };
    this.log('monopoly.log.card', { name: p.name, text });

    const next = () => this.resolveEnd();
    switch (card.t) {
      case 'move':
        return this.advance(p, (card.to - p.pos + 40) % 40);
      case 'nearest': {
        const list = card.kind === 'station' ? STATIONS : UTILITIES;
        const dest = list.find((i) => i > p.pos) ?? list[0];
        return this.advance(p, (dest - p.pos + 40) % 40, { mode: card.kind === 'station' ? 'double' : 'ten' });
      }
      case 'cash':
        p.cash += card.a;
        return next();
      case 'pay':
        return this.owe(p, card.a, 'pot', M('monopoly.reason.card'), next);
      case 'jail':
        this.sendToJail(p);
        return next();
      case 'free':
        return next();
      case 'repairs': {
        let fee = 0;
        for (const i of this.ownedBy(p.id)) {
          const h = this.houses[i];
          if (h === 5) fee += card.hotel;
          else fee += h * card.house;
        }
        if (fee === 0) return next();
        return this.owe(p, fee, 'pot', M('monopoly.reason.repairs'), next);
      }
      case 'collectEach': {
        for (const id of this.others(p.id)) {
          const q = this.P[id];
          const pay = Math.min(q.cash, card.a);
          q.cash -= pay;
          p.cash += pay;
        }
        return next();
      }
      case 'payEach': {
        const payees = this.others(p.id);
        if (!payees.length) return next();
        return this.owe(p, card.a * payees.length, payees, M('monopoly.reason.chair'), next);
      }
      case 'back':
        return this.moveBack(p, card.n);
      default:
        return next();
    }
  }

  // ------------------------------------------------------------------- money

  pay(p, amount, to) {
    p.cash -= amount;
    if (Array.isArray(to)) {
      const live = to.filter((id) => !this.P[id].bankrupt);
      if (!live.length) return;
      const share = Math.floor(amount / live.length);
      live.forEach((id, i) => { this.P[id].cash += share + (i === 0 ? amount - share * live.length : 0); });
    } else if (to === 'pot') {
      if (this.opts.freeParking === 'pot') this.pot += amount;
    } else if (to !== 'bank' && !this.P[to].bankrupt) {
      this.P[to].cash += amount;
    }
  }

  owe(p, amount, to, reason, cont) {
    if (amount <= 0) return cont();
    if (p.cash >= amount) {
      this.pay(p, amount, to);
      return cont();
    }
    this.debt = { from: p.id, to, amount, reason };
    this.debtCont = cont;
    this.log('monopoly.log.debt', { name: p.name, m_a: amount });
    this.setPhase('debt');
  }

  doPayDebt(p) {
    if (!this.isTurn(p) || this.phase !== 'debt' || !this.debt) return this.fail(p.id, 'monopoly.err.notNow'), false;
    if (p.cash < this.debt.amount) return this.fail(p.id, 'monopoly.err.cash', { m_a: this.debt.amount - p.cash }), false;
    this.settleDebt(p);
    return true;
  }

  settleDebt(p) {
    const { amount, to } = this.debt;
    this.pay(p, amount, to);
    const cont = this.debtCont;
    this.debt = null;
    this.debtCont = null;
    this.log('monopoly.log.paid', { name: p.name, m_a: amount });
    (cont || (() => this.resolveEnd()))();
  }

  // ------------------------------------------------------------- phases/timers

  setPhase(phase) {
    this.phase = phase;
    if (this.timeUp && (phase === 'roll' || phase === 'end') && !this.over) return this.finishByTime();
    this.armTimers();
  }

  resolveEnd() {
    const p = this.cur;
    if (p.bankrupt) return this.nextTurn();
    if (this.t.jailed) return this.setPhase('end');
    this.setPhase(this.t.extra ? 'roll' : 'end');
  }

  doEndTurn(p) {
    if (!this.isTurn(p) || this.phase !== 'end') return this.fail(p.id, 'monopoly.err.notNow'), false;
    this.nextTurn();
    return true;
  }

  nextTurn() {
    if (this.over) return;
    this.debt = null;
    this.debtCont = null;
    if (this.active().length <= 1) return this.finishLast();
    if (this.queue.length && this.opts.auction === 'on') {
      const idx = this.queue.shift();
      return this.startAuction(idx, 'next');
    }
    this.queue = [];
    if (this.timeUp) return this.finishByTime();
    const alive = this.active();
    let i = this.order.indexOf(this.turn);
    for (let n = 0; n < this.order.length; n++) {
      i = (i + 1) % this.order.length;
      if (alive.includes(this.order[i])) break;
    }
    this.turn = this.order[i];
    this.t = { doubles: 0, extra: false, jailed: false, rolled: false };
    this.log('monopoly.log.turn', { name: this.cur.name });
    this.setPhase('roll');
  }

  armTimers() {
    clearTimeout(this.timers.turn);
    this.timers.turn = null;
    this.deadline = 0;
    if (!this.running || this.over) return;
    if (this.phase === 'auction' || this.turnMs <= 0) return;
    this.deadline = this.now() + this.turnMs;
    this.timers.turn = setTimeout(() => this.onTurnTimeout(), this.turnMs);
  }

  onTurnTimeout() {
    this.timers.turn = null;
    if (this.over || !this.running || this.phase === 'auction') return;
    const p = this.cur;
    p.timeouts++;
    if (p.timeouts >= TIMEOUTS_TO_AUTO && !p.auto) {
      p.auto = true;
      this.log('monopoly.log.autoPlay', { name: p.name });
    } else {
      this.log('monopoly.log.timeout', { name: p.name });
    }
    this.autoStep(p);
    this.push();
  }

  onTimeUp() {
    this.timers.game = null;
    if (this.over) return;
    this.timeUp = true;
    this.log('monopoly.log.timeUp');
    if (this.phase === 'roll' || this.phase === 'end') this.finishByTime();
    this.push();
  }

  /** One sensible default move for the player on turn (used by timeouts and auto players). */
  autoStep(p) {
    switch (this.phase) {
      case 'roll':
        return this.roll(p);
      case 'buy': {
        const price = SPACES[p.pos].price;
        if (p.cash - price >= 100) return this.buy(p);
        return this.decline(p);
      }
      case 'debt': {
        this.autoRaise(p, this.debt.amount);
        if (p.cash >= this.debt.amount) return this.settleDebt(p);
        return this.bankrupt(p, this.debt.to);
      }
      case 'end':
        return this.nextTurn();
      default:
    }
  }

  /** Sell buildings and mortgage until `need` cash is on hand (or nothing is left). */
  autoRaise(p, need) {
    for (let guard = 0; guard < 200 && p.cash < need; guard++) {
      const mine = this.ownedBy(p.id);
      const cand = mine
        .filter((i) => !this.mortgaged[i] && this.mortgageBlock(p, i) === null)
        .sort((a, b) => {
          const ga = SPACES[a].group && this.setOwned(p.id, SPACES[a].group) ? 1 : 0;
          const gb = SPACES[b].group && this.setOwned(p.id, SPACES[b].group) ? 1 : 0;
          return ga - gb || SPACES[a].price - SPACES[b].price;
        });
      if (cand.length) { this.mortgage(p, cand[0]); continue; }
      const sellable = mine
        .filter((i) => this.houses[i] > 0 && this.sellBlock(p, i) === null)
        .sort((a, b) => this.houses[b] - this.houses[a] || SPACES[b].house - SPACES[a].house);
      if (!sellable.length) break;
      this.sellBuilding(p, sellable[0]);
    }
  }

  // --------------------------------------------------------------- buy / auction

  doBuy(p) {
    if (!this.isTurn(p) || this.phase !== 'buy') return this.fail(p.id, 'monopoly.err.notNow'), false;
    const price = SPACES[p.pos].price;
    if (p.cash < price) return this.fail(p.id, 'monopoly.err.cash', { m_a: price - p.cash }), false;
    this.buy(p);
    return true;
  }

  buy(p) {
    const s = SPACES[p.pos];
    p.cash -= s.price;
    this.owner[s.i] = p.id;
    this.log('monopoly.log.buy', { name: p.name, s_i: s.i, m_a: s.price });
    this.resolveEnd();
  }

  doDecline(p) {
    if (!this.isTurn(p) || this.phase !== 'buy') return this.fail(p.id, 'monopoly.err.notNow'), false;
    this.decline(p);
    return true;
  }

  decline(p) {
    const s = SPACES[p.pos];
    if (this.opts.auction === 'on') {
      this.log('monopoly.log.declined', { name: p.name, s_i: s.i });
      return this.startAuction(s.i, 'resolve');
    }
    this.log('monopoly.log.passed', { name: p.name, s_i: s.i });
    this.resolveEnd();
  }

  startAuction(idx, after) {
    const participants = this.active();
    this.auction = { idx, bids: [], passed: new Set(), participants, after, deadline: this.now() + AUCTION_MS };
    for (const id of participants) {
      if (this.P[id].auto || this.P[id].cash < 1) this.auction.passed.add(id);
    }
    this.log('monopoly.log.auctionStart', { s_i: idx });
    this.phase = 'auction';
    this.armTimers();
    this.armAuctionTimer(AUCTION_MS);
    this.checkAuctionEnd();
  }

  armAuctionTimer(ms) {
    clearTimeout(this.timers.auction);
    if (!this.auction) return;
    this.auction.deadline = this.now() + ms;
    this.timers.auction = setTimeout(() => { this.timers.auction = null; this.endAuction(); this.push(); }, ms);
  }

  auctionTop() { return this.auction.bids[this.auction.bids.length - 1] || null; }

  doBid(p, amount) {
    const a = this.auction;
    if (!a || this.phase !== 'auction') return this.fail(p.id, 'monopoly.err.notNow'), false;
    if (!a.participants.includes(p.id) || a.passed.has(p.id)) return this.fail(p.id, 'monopoly.err.notNow'), false;
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CASH) return this.fail(p.id, 'monopoly.err.badAmount'), false;
    const top = this.auctionTop();
    if (top && top.id === p.id) return this.fail(p.id, 'monopoly.err.topBidder'), false;
    if (top && amount <= top.amount) return this.fail(p.id, 'monopoly.err.bidLow', { m_a: top.amount + 1 }), false;
    if (amount > p.cash) return this.fail(p.id, 'monopoly.err.cash', { m_a: amount - p.cash }), false;
    a.bids.push({ id: p.id, amount });
    this.armAuctionTimer(BID_EXTEND_MS);
    this.checkAuctionEnd();
    return true;
  }

  doAuctionPass(p) {
    const a = this.auction;
    if (!a || this.phase !== 'auction' || !a.participants.includes(p.id) || a.passed.has(p.id)) {
      return this.fail(p.id, 'monopoly.err.notNow'), false;
    }
    const top = this.auctionTop();
    if (top && top.id === p.id) return this.fail(p.id, 'monopoly.err.topBidder'), false;
    a.passed.add(p.id);
    this.checkAuctionEnd();
    return true;
  }

  checkAuctionEnd() {
    const a = this.auction;
    if (!a) return;
    const top = this.auctionTop();
    const rem = a.participants.filter((id) => !a.passed.has(id) && !this.P[id].bankrupt);
    if (!top ? rem.length === 0 : rem.every((id) => id === top.id)) this.endAuction();
  }

  endAuction() {
    const a = this.auction;
    if (!a) return;
    clearTimeout(this.timers.auction);
    this.timers.auction = null;
    while (a.bids.length && this.P[a.bids[a.bids.length - 1].id].cash < a.bids[a.bids.length - 1].amount) a.bids.pop();
    const top = this.auctionTop();
    if (top) {
      const w = this.P[top.id];
      w.cash -= top.amount;
      this.owner[a.idx] = w.id;
      this.log('monopoly.log.auctionWon', { name: w.name, s_i: a.idx, m_a: top.amount });
    } else {
      this.log('monopoly.log.auctionNone', { s_i: a.idx });
    }
    this.auction = null;
    if (a.after === 'next') return this.nextTurn();
    this.resolveEnd();
  }

  // ------------------------------------------------------------------- jail

  doJail(p, how) {
    if (!this.isTurn(p) || this.phase !== 'roll' || !p.jail) return this.fail(p.id, 'monopoly.err.notNow'), false;
    if (how === 'card') {
      if (!p.cards.length) return this.fail(p.id, 'monopoly.err.noCard'), false;
      const deck = p.cards.shift();
      const n = DECKS[deck].findIndex((c) => c.t === 'free');
      this.decks[deck].q.push(n);
      p.jail = false;
      p.jailTurns = 0;
      this.log('monopoly.log.jailCard', { name: p.name });
      return true;
    }
    if (how !== 'pay') return this.fail(p.id, 'monopoly.err.badRequest'), false;
    if (p.cash < BAIL) return this.fail(p.id, 'monopoly.err.cash', { m_a: BAIL - p.cash }), false;
    this.pay(p, BAIL, 'pot');
    p.jail = false;
    p.jailTurns = 0;
    this.log('monopoly.log.jailPaid', { name: p.name, m_a: BAIL });
    return true;
  }

  // ------------------------------------------------------- build / mortgage

  /** Why can't the property be built on right now? null when it can. */
  buildBlock(p, idx) {
    const s = SPACES[idx];
    if (!s || s.type !== 'street') return M('monopoly.why.notStreet');
    if (this.owner[idx] !== p.id) return M('monopoly.why.notOwner');
    const g = GROUPS[s.group];
    if (!this.setOwned(p.id, s.group)) return M('monopoly.why.needSet');
    if (g.spaces.some((i) => this.mortgaged[i])) return M('monopoly.why.mortgagedInSet');
    const h = this.houses[idx];
    if (h >= 5) return M('monopoly.why.maxBuilt');
    if (h > Math.min(...g.spaces.map((i) => this.houses[i]))) return M('monopoly.why.even');
    if (h === 4 ? this.hotelsLeft() < 1 : this.housesLeft() < 1) return M(h === 4 ? 'monopoly.why.noHotels' : 'monopoly.why.noHouses');
    if (p.cash < s.house) return M('monopoly.why.cash', { m_a: s.house });
    return null;
  }

  sellBlock(p, idx) {
    const s = SPACES[idx];
    if (!s || s.type !== 'street') return M('monopoly.why.notStreet');
    if (this.owner[idx] !== p.id) return M('monopoly.why.notOwner');
    const h = this.houses[idx];
    if (h < 1) return M('monopoly.why.noBuildings');
    if (h < Math.max(...GROUPS[s.group].spaces.map((i) => this.houses[i]))) return M('monopoly.why.evenSell');
    return null;
  }

  mortgageBlock(p, idx) {
    const s = SPACES[idx];
    if (!s || !s.price) return M('monopoly.why.notProperty');
    if (this.owner[idx] !== p.id) return M('monopoly.why.notOwner');
    if (this.mortgaged[idx]) return M('monopoly.why.alreadyMortgaged');
    if (s.group && GROUPS[s.group].spaces.some((i) => this.houses[i] > 0)) return M('monopoly.why.hasBuildings');
    return null;
  }

  unmortgageBlock(p, idx) {
    const s = SPACES[idx];
    if (!s || !s.price) return M('monopoly.why.notProperty');
    if (this.owner[idx] !== p.id) return M('monopoly.why.notOwner');
    if (!this.mortgaged[idx]) return M('monopoly.why.notMortgaged');
    if (p.cash < unmortgageCost(idx)) return M('monopoly.why.cash', { m_a: unmortgageCost(idx) });
    return null;
  }

  doManage(p, what, idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx > 39) return this.fail(p.id, 'monopoly.err.badRequest'), false;
    if (this.phase === 'auction') return this.fail(p.id, 'monopoly.why.auction'), false;
    const block = { build: this.buildBlock, sell: this.sellBlock, mortgage: this.mortgageBlock, unmortgage: this.unmortgageBlock }[what].call(this, p, idx);
    if (block) { this.fail(p.id, block.k, block.p); return false; }
    if (what === 'build') this.build(p, idx);
    else if (what === 'sell') this.sellBuilding(p, idx);
    else if (what === 'mortgage') this.mortgage(p, idx);
    else this.unmortgage(p, idx);
    return true;
  }

  build(p, idx) {
    const s = SPACES[idx];
    p.cash -= s.house;
    this.houses[idx]++;
    this.log(this.houses[idx] === 5 ? 'monopoly.log.hotel' : 'monopoly.log.house', { name: p.name, s_i: idx, m_a: s.house });
  }

  sellBuilding(p, idx) {
    const s = SPACES[idx];
    const h = this.houses[idx];
    let to = h - 1;
    if (h === 5) to = Math.min(4, this.housesLeft());
    const refund = ((h - to) * s.house) / 2;
    this.houses[idx] = to;
    p.cash += refund;
    this.log('monopoly.log.sellBuilding', { name: p.name, s_i: idx, m_a: refund });
  }

  mortgage(p, idx) {
    this.mortgaged[idx] = true;
    p.cash += SPACES[idx].mortgage;
    this.log('monopoly.log.mortgage', { name: p.name, s_i: idx, m_a: SPACES[idx].mortgage });
  }

  unmortgage(p, idx) {
    const cost = unmortgageCost(idx);
    this.mortgaged[idx] = false;
    p.cash -= cost;
    this.log('monopoly.log.unmortgage', { name: p.name, s_i: idx, m_a: cost });
  }

  // ------------------------------------------------------------------ trades

  /** Normalise one side of an offer; returns null for garbage. */
  normOffer(o) {
    if (!o || typeof o !== 'object') return null;
    const cash = o.cash === undefined ? 0 : o.cash;
    const jail = o.jail === undefined ? 0 : o.jail;
    const props = o.props === undefined ? [] : o.props;
    if (!Number.isInteger(cash) || cash < 0 || cash > MAX_CASH) return null;
    if (!Number.isInteger(jail) || jail < 0 || jail > 2) return null;
    if (!Array.isArray(props) || props.length > 28) return null;
    if (!props.every((i) => Number.isInteger(i) && i >= 0 && i < 40 && SPACES[i].price)) return null;
    if (new Set(props).size !== props.length) return null;
    return { cash, jail, props: [...props].sort((a, b) => a - b) };
  }

  /** Returns a message object when the trade cannot be executed right now. */
  tradeBlock(t) {
    const a = this.P[t.from];
    const b = this.P[t.to];
    if (!a || !b || a.bankrupt || b.bankrupt || a === b) return M('monopoly.err.badRequest');
    const empty = (o) => !o.cash && !o.jail && !o.props.length;
    if (empty(t.give) && empty(t.take)) return M('monopoly.err.emptyTrade');
    const check = (giver, o) => {
      if (giver.cash < o.cash) return M('monopoly.err.tradeCash', { name: giver.name });
      if (giver.cards.length < o.jail) return M('monopoly.err.tradeCard', { name: giver.name });
      for (const i of o.props) {
        if (this.owner[i] !== giver.id) return M('monopoly.err.tradeOwner', { name: giver.name, s_i: i });
        const g = SPACES[i].group;
        if (g && GROUPS[g].spaces.some((j) => this.houses[j] > 0)) return M('monopoly.err.tradeBuildings', { s_i: i });
      }
      return null;
    };
    const e = check(a, t.give) || check(b, t.take);
    if (e) return e;
    // the receiver of a mortgaged property pays 10% interest at once
    const fee = (o) => o.props.filter((i) => this.mortgaged[i]).reduce((n, i) => n + interest(i), 0);
    if (a.cash - t.give.cash + t.take.cash < fee(t.take)) return M('monopoly.err.tradeFee', { name: a.name, m_a: fee(t.take) });
    if (b.cash - t.take.cash + t.give.cash < fee(t.give)) return M('monopoly.err.tradeFee', { name: b.name, m_a: fee(t.give) });
    return null;
  }

  openTrade(from, to, give, take) {
    const t = { id: ++this.tradeSeq, from, to, give, take };
    const block = this.tradeBlock(t);
    if (block) return block;
    this.trade = t;
    clearTimeout(this.timers.trade);
    t.deadline = this.now() + TRADE_MS;
    this.timers.trade = setTimeout(() => { this.timers.trade = null; this.cancelTrade('monopoly.log.tradeExpired'); this.push(); }, TRADE_MS);
    return null;
  }

  doTradePropose(p, d) {
    if (this.phase === 'auction') return this.fail(p.id, 'monopoly.why.auction'), false;
    if (this.trade) return this.fail(p.id, 'monopoly.err.tradeBusy'), false;
    const to = typeof d.to === 'string' ? this.P[d.to] : null;
    if (!to || to.bankrupt || to === p) return this.fail(p.id, 'monopoly.err.badRequest'), false;
    const give = this.normOffer(d.give);
    const take = this.normOffer(d.take);
    if (!give || !take) return this.fail(p.id, 'monopoly.err.badRequest'), false;
    const block = this.openTrade(p.id, to.id, give, take);
    if (block) { this.fail(p.id, block.k, block.p); return false; }
    this.log('monopoly.log.tradeOffer', { name: p.name, to: to.name });
    return true;
  }

  doTradeAccept(p) {
    const t = this.trade;
    if (!t || t.to !== p.id) return this.fail(p.id, 'monopoly.err.notNow'), false;
    const block = this.tradeBlock(t);
    if (block) {
      this.fail(p.id, block.k, block.p);
      this.cancelTrade('monopoly.log.tradeCancelled');
      return true;
    }
    this.execTrade(t);
    return true;
  }

  execTrade(t) {
    const a = this.P[t.from];
    const b = this.P[t.to];
    const move = (from, to, o) => {
      from.cash -= o.cash;
      to.cash += o.cash;
      for (let n = 0; n < o.jail; n++) to.cards.push(from.cards.shift());
      for (const i of o.props) {
        this.owner[i] = to.id;
        if (this.mortgaged[i]) { to.cash -= interest(i); }
      }
    };
    move(a, b, t.give);
    move(b, a, t.take);
    this.trade = null;
    clearTimeout(this.timers.trade);
    this.timers.trade = null;
    this.log('monopoly.log.tradeDone', { name: a.name, to: b.name });
  }

  doTradeDecline(p) {
    const t = this.trade;
    if (!t || t.to !== p.id) return this.fail(p.id, 'monopoly.err.notNow'), false;
    this.trade = null;
    clearTimeout(this.timers.trade);
    this.log('monopoly.log.tradeDeclined', { name: p.name, to: this.P[t.from].name });
    return true;
  }

  doTradeCancel(p) {
    const t = this.trade;
    if (!t || t.from !== p.id) return this.fail(p.id, 'monopoly.err.notNow'), false;
    this.cancelTrade('monopoly.log.tradeCancelled');
    return true;
  }

  doTradeCounter(p, d) {
    const t = this.trade;
    if (!t || t.to !== p.id) return this.fail(p.id, 'monopoly.err.notNow'), false;
    const give = this.normOffer(d.give);
    const take = this.normOffer(d.take);
    if (!give || !take) return this.fail(p.id, 'monopoly.err.badRequest'), false;
    this.trade = null;
    const block = this.openTrade(p.id, t.from, give, take);
    if (block) {
      this.cancelTrade('monopoly.log.tradeCancelled');
      this.fail(p.id, block.k, block.p);
      return true;
    }
    this.log('monopoly.log.tradeCounter', { name: p.name, to: this.P[t.from].name });
    return true;
  }

  cancelTrade(logKey) {
    if (!this.trade) return false;
    this.trade = null;
    clearTimeout(this.timers.trade);
    this.timers.trade = null;
    if (logKey) this.log(logKey);
    return true;
  }

  // ----------------------------------------------------------------- bankruptcy

  doResign(p) {
    if (this.isTurn(p) && this.debt) return (this.bankrupt(p, this.debt.to), true);
    this.bankrupt(p, 'bank');
    return true;
  }

  /** Eliminate a player. `to` is a player id, an array of ids (share the cash), or 'bank'/'pot'. */
  bankrupt(p, to) {
    if (p.bankrupt) return;
    const wasTurn = this.turn === p.id;
    const creditor = typeof to === 'string' && this.P[to] && !this.P[to].bankrupt && to !== p.id ? this.P[to] : null;
    const each = Array.isArray(to) ? to.filter((id) => this.P[id] && !this.P[id].bankrupt && id !== p.id) : [];

    this.cancelTrade();
    // buildings go back to the bank at half price
    for (const i of this.ownedBy(p.id)) {
      if (this.houses[i] > 0) {
        p.cash += (this.houses[i] * SPACES[i].house) / 2;
        this.houses[i] = 0;
      }
    }
    const owned = this.ownedBy(p.id);
    const returned = [];
    if (creditor) {
      creditor.cash += p.cash;
      creditor.cards.push(...p.cards);
      for (const i of owned) {
        this.owner[i] = creditor.id;
        if (this.mortgaged[i]) creditor.cash -= Math.min(creditor.cash, interest(i));
      }
      this.log('monopoly.log.bankruptTo', { name: p.name, to: creditor.name });
    } else {
      if (each.length) {
        const share = Math.floor(p.cash / each.length);
        each.forEach((id, i) => { this.P[id].cash += share + (i === 0 ? p.cash - share * each.length : 0); });
      }
      for (const deck of p.cards) this.decks[deck].q.push(DECKS[deck].findIndex((c) => c.t === 'free'));
      for (const i of owned) {
        this.owner[i] = null;
        this.mortgaged[i] = false;
        returned.push(i);
      }
      this.log('monopoly.log.bankruptBank', { name: p.name });
    }
    p.cash = 0;
    p.cards = [];
    p.bankrupt = true;
    p.jail = false;
    this.bankruptOrder.push(p.id);
    this.queue.push(...returned);
    if (this.active().length <= 1) return this.finishLast();

    // the turn moves on once the dust has settled
    if (this.debt && this.debt.from === p.id) { this.debt = null; this.debtCont = null; }
    if (this.auction) {
      this.auction.bids = this.auction.bids.filter((b) => b.id !== p.id);
      if (wasTurn) this.auction.after = 'next';
      this.checkAuctionEnd();
    } else if (wasTurn) {
      this.nextTurn();
    }
  }

  onPlayerLeft(odId) {
    const p = this.P[odId];
    if (!p || p.left) return;
    p.left = true;
    if (this.over) return;
    if (!p.bankrupt) this.bankrupt(p, 'bank');
    this.push();
  }

  // ----------------------------------------------------------------- finishing

  ranking(kind) {
    const alive = this.active();
    const dead = [...this.bankruptOrder].reverse();
    const rows = [];
    let rank = 0;
    let prev = null;
    const sorted = kind === 'time'
      ? [...alive].sort((a, b) => this.netWorth(this.P[b]) - this.netWorth(this.P[a]))
      : alive;
    sorted.forEach((id, i) => {
      const net = this.netWorth(this.P[id]);
      if (net !== prev) rank = i + 1;
      prev = net;
      rows.push({ id, name: this.P[id].name, rank, score: net, note: M('monopoly.note.net', { amount: net }) });
    });
    dead.forEach((id, i) => {
      rows.push({
        id, name: this.P[id].name, rank: alive.length + i + 1, score: 0,
        note: M(this.P[id].left ? 'monopoly.note.left' : 'monopoly.note.bankrupt')
      });
    });
    return rows;
  }

  finishLast() {
    const alive = this.active();
    this.winner = alive[0] || null;
    this.endGame(this.winner
      ? { title: M('monopoly.over.win', { name: this.P[this.winner].name }), subtitle: M('monopoly.over.last') }
      : { title: M('monopoly.over.nobody'), subtitle: M('monopoly.over.last') }, 'last');
  }

  finishByTime() {
    const rows = this.ranking('time');
    this.winner = rows[0]?.id || null;
    const tied = rows.filter((r) => r.rank === 1).length > 1;
    this.endGame(tied
      ? { title: M('monopoly.over.tie'), subtitle: M('monopoly.over.time') }
      : { title: M('monopoly.over.win', { name: this.P[this.winner].name }), subtitle: M('monopoly.over.time') }, 'time');
  }

  endGame(texts, kind) {
    if (this.over) return;
    this.over = true;
    this.phase = 'over';
    this.debt = null;
    this.auction = null;
    this.trade = null;
    this.clearTimers();
    this.log('monopoly.log.over');
    this.push();
    this.room.finishGame({ ...texts, rows: this.ranking(kind), delayMs: RETURN_TO_LOBBY_MS });
  }

  // ---------------------------------------------------------------- snapshots

  stateFor(odId) {
    const me = odId ? this.P[odId] : null;
    const now = this.now();
    const a = this.auction;
    const left = this.phase === 'auction' && a ? Math.max(0, a.deadline - now) : this.deadline ? Math.max(0, this.deadline - now) : 0;
    const seatOf = (id) => (id === null ? -1 : this.P[id].seat);
    const state = {
      type: 'monopoly-state',
      seq: this.seq,
      you: odId || null,
      opts: this.opts,
      order: this.order,
      players: this.order.map((id) => {
        const q = this.P[id];
        return {
          id, name: q.name, seat: q.seat, token: q.token, color: q.color, cash: q.cash, pos: q.pos,
          jail: q.jail, jailTurns: q.jailTurns, cards: q.cards.length, bankrupt: q.bankrupt, left: q.left, auto: q.auto,
          net: q.bankrupt ? 0 : this.netWorth(q), liquid: q.bankrupt ? 0 : this.liquid(q)
        };
      }),
      turn: this.turn,
      phase: this.phase,
      dice: this.dice,
      diceSeq: this.diceSeq,
      doubles: this.t.doubles,
      rolled: this.t.rolled,
      own: this.owner.map(seatOf),
      hs: this.houses,
      ms: this.mortgaged.map((m) => (m ? 1 : 0)),
      housesLeft: this.housesLeft(),
      hotelsLeft: this.hotelsLeft(),
      pot: this.pot,
      debt: this.debt ? { from: this.debt.from, to: this.debt.to, amount: this.debt.amount, reason: this.debt.reason } : null,
      auction: a ? {
        idx: a.idx, bids: a.bids.slice(-6), top: this.auctionTop(), passed: [...a.passed],
        participants: a.participants, left: Math.max(0, a.deadline - now)
      } : null,
      trade: this.trade ? {
        id: this.trade.id, from: this.trade.from, to: this.trade.to, give: this.trade.give, take: this.trade.take,
        left: Math.max(0, this.trade.deadline - now)
      } : null,
      timeLeft: left,
      turnMs: this.turnMs,
      endsIn: this.endsAt && !this.over ? Math.max(0, this.endsAt - now) : null,
      timeUp: this.timeUp,
      moves: this.moves,
      lastCard: this.lastCard,
      log: this.logs,
      over: this.over,
      winner: this.winner
    };
    if (me && !me.bankrupt) {
      const manage = {};
      for (const i of this.ownedBy(me.id)) {
        manage[i] = { b: this.buildBlock(me, i) || 0, s: this.sellBlock(me, i) || 0, m: this.mortgageBlock(me, i) || 0, u: this.unmortgageBlock(me, i) || 0 };
      }
      state.manage = manage;
    }
    return state;
  }

  sendBoard(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { type: 'monopoly-board', board: boardForClient() });
  }

  sendState(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, this.stateFor(odId));
  }

  /** Host view: the public state (there is nothing private in this game). */
  spectatorSync(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (!ws) return;
    this.room.send(ws, { type: 'monopoly-board', board: boardForClient() });
    this.room.send(ws, { ...this.stateFor(null), you: odId, spectator: true });
  }

  push() {
    this.seq++;
    for (const id of this.order) if (!this.P[id].left) this.sendState(id);
    for (const id of this.room.spectatorIds()) {
      const ws = this.room.getWsByUserId(id);
      if (ws) this.room.send(ws, { ...this.stateFor(null), you: id, spectator: true });
    }
    this.scheduleAuto();
  }

  /** Auto players (and people who timed out repeatedly) keep the game moving. */
  scheduleAuto() {
    clearTimeout(this.timers.auto);
    this.timers.auto = null;
    if (this.over || !this.running) return;
    const need = this.autoWork();
    if (!need) return;
    this.timers.auto = setTimeout(() => {
      this.timers.auto = null;
      if (this.over) return;
      const job = this.autoWork();
      if (job) job();
      this.push();
    }, this.autoMs);
  }

  /** The next thing an auto player has to do, as a function, or null. */
  autoWork() {
    if (this.trade && this.P[this.trade.to].auto) return () => this.doTradeDecline(this.P[this.trade.to]);
    if (this.phase === 'auction' && this.auction) {
      const id = this.auction.participants.find((x) => this.P[x].auto && !this.P[x].bankrupt && !this.auction.passed.has(x) && this.auctionTop()?.id !== x);
      if (id) return () => this.doAuctionPass(this.P[id]);
      return null;
    }
    const p = this.cur;
    if (p.auto && !p.bankrupt && ['roll', 'buy', 'debt', 'end'].includes(this.phase)) return () => this.autoStep(p);
    return null;
  }

  clearTimers() {
    for (const k of Object.keys(this.timers)) { clearTimeout(this.timers[k]); this.timers[k] = null; }
  }

  cleanup() {
    this.isGameActive = false;
    this.clearTimers();
  }
}
