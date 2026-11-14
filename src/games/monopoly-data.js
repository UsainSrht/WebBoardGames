/**
 * Board data for the city-themed property trading game: 40 spaces in the classic layout, the colour groups and the
 * two card decks. No text lives here: names and card texts are dictionary keys (`monopoly.space.<n>`,
 * `monopoly.card.<deck>.<n>`), and card parameters named `m_*` are money, `s_*` are space indexes.
 */

export const GO_SALARY = 200;
export const JAIL_POS = 10;
export const GO_TO_JAIL_POS = 30;
export const PARKING_POS = 20;
export const BAIL = 50;
export const INCOME_TAX = 200; // flat
export const LUXURY_TAX = 100;
export const HOUSES_TOTAL = 32;
export const HOTELS_TOTAL = 12;
export const STATION_RENT = [25, 50, 100, 200];
export const UTILITY_MULT = [4, 10];
export const MORTGAGE_INTEREST = 0.1;

/** Colour groups, in board order. */
export const GROUPS = {
  brown: { color: '#8b5a3c', house: 50, spaces: [1, 3] },
  sky: { color: '#7dd3fc', house: 50, spaces: [6, 8, 9] },
  pink: { color: '#e879b9', house: 100, spaces: [11, 13, 14] },
  orange: { color: '#fb923c', house: 100, spaces: [16, 18, 19] },
  red: { color: '#ef4444', house: 150, spaces: [21, 23, 24] },
  yellow: { color: '#facc15', house: 150, spaces: [26, 27, 29] },
  green: { color: '#22c55e', house: 200, spaces: [31, 32, 34] },
  blue: { color: '#3b5bdb', house: 200, spaces: [37, 39] }
};

// [index, group, price, rent with 0..5 buildings]
const STREETS = [
  [1, 'brown', 60, [2, 10, 30, 90, 160, 250]],
  [3, 'brown', 60, [4, 20, 60, 180, 320, 450]],
  [6, 'sky', 100, [6, 30, 90, 270, 400, 550]],
  [8, 'sky', 100, [6, 30, 90, 270, 400, 550]],
  [9, 'sky', 120, [8, 40, 100, 300, 450, 600]],
  [11, 'pink', 140, [10, 50, 150, 450, 625, 750]],
  [13, 'pink', 140, [10, 50, 150, 450, 625, 750]],
  [14, 'pink', 160, [12, 60, 180, 500, 700, 900]],
  [16, 'orange', 180, [14, 70, 200, 550, 750, 950]],
  [18, 'orange', 180, [14, 70, 200, 550, 750, 950]],
  [19, 'orange', 200, [16, 80, 220, 600, 800, 1000]],
  [21, 'red', 220, [18, 90, 250, 700, 875, 1050]],
  [23, 'red', 220, [18, 90, 250, 700, 875, 1050]],
  [24, 'red', 240, [20, 100, 300, 750, 925, 1100]],
  [26, 'yellow', 260, [22, 110, 330, 800, 975, 1150]],
  [27, 'yellow', 260, [22, 110, 330, 800, 975, 1150]],
  [29, 'yellow', 280, [24, 120, 360, 850, 1025, 1200]],
  [31, 'green', 300, [26, 130, 390, 900, 1100, 1275]],
  [32, 'green', 300, [26, 130, 390, 900, 1100, 1275]],
  [34, 'green', 320, [28, 150, 450, 1000, 1200, 1400]],
  [37, 'blue', 350, [35, 175, 500, 1100, 1300, 1500]],
  [39, 'blue', 400, [50, 200, 600, 1400, 1700, 2000]]
];

const FIXED = {
  0: { type: 'go' },
  2: { type: 'chest' },
  4: { type: 'tax', tax: INCOME_TAX, kind: 'income' },
  5: { type: 'station', price: 200 },
  7: { type: 'chance' },
  10: { type: 'jail' },
  12: { type: 'utility', price: 150 },
  15: { type: 'station', price: 200 },
  17: { type: 'chest' },
  20: { type: 'parking' },
  22: { type: 'chance' },
  25: { type: 'station', price: 200 },
  28: { type: 'utility', price: 150 },
  30: { type: 'gotojail' },
  33: { type: 'chest' },
  35: { type: 'station', price: 200 },
  36: { type: 'chance' },
  38: { type: 'tax', tax: LUXURY_TAX, kind: 'luxury' }
};

export const SPACES = Array.from({ length: 40 }, (_, i) => {
  const street = STREETS.find((s) => s[0] === i);
  if (street) {
    const group = street[1];
    return { i, type: 'street', group, price: street[2], rent: street[3], house: GROUPS[group].house, mortgage: street[2] / 2 };
  }
  const fixed = FIXED[i];
  if (!fixed) throw new Error(`space ${i} is not defined`);
  const s = { i, ...fixed };
  if (s.price) s.mortgage = s.price / 2;
  return s;
});

export const STATIONS = SPACES.filter((s) => s.type === 'station').map((s) => s.i);
export const UTILITIES = SPACES.filter((s) => s.type === 'utility').map((s) => s.i);
export const isProperty = (i) => ['street', 'station', 'utility'].includes(SPACES[i].type);

/**
 * Cards. Types: move (to, passes GO), nearest (station|utility), cash, pay, jail, free (get out of jail free),
 * repairs, collectEach, payEach, back.
 */
export const CHANCE = [
  { t: 'move', to: 0, p: { m_a: 200 } },
  { t: 'move', to: 11, p: { s_to: 11 } },
  { t: 'move', to: 24, p: { s_to: 24 } },
  { t: 'nearest', kind: 'utility', p: {} },
  { t: 'nearest', kind: 'station', p: {} },
  { t: 'nearest', kind: 'station', p: {} },
  { t: 'cash', a: 50, p: { m_a: 50 } },
  { t: 'free', p: {} },
  { t: 'back', n: 3, p: { n: 3 } },
  { t: 'jail', p: {} },
  { t: 'repairs', house: 25, hotel: 100, p: { m_h: 25, m_t: 100 } },
  { t: 'pay', a: 15, p: { m_a: 15 } },
  { t: 'move', to: 25, p: { s_to: 25 } },
  { t: 'move', to: 39, p: { s_to: 39 } },
  { t: 'payEach', a: 50, p: { m_a: 50 } },
  { t: 'cash', a: 150, p: { m_a: 150 } }
];

export const CHEST = [
  { t: 'move', to: 0, p: { m_a: 200 } },
  { t: 'cash', a: 200, p: { m_a: 200 } },
  { t: 'pay', a: 50, p: { m_a: 50 } },
  { t: 'cash', a: 50, p: { m_a: 50 } },
  { t: 'free', p: {} },
  { t: 'jail', p: {} },
  { t: 'cash', a: 100, p: { m_a: 100 } },
  { t: 'cash', a: 20, p: { m_a: 20 } },
  { t: 'collectEach', a: 10, p: { m_a: 10 } },
  { t: 'cash', a: 100, p: { m_a: 100 } },
  { t: 'pay', a: 100, p: { m_a: 100 } },
  { t: 'pay', a: 50, p: { m_a: 50 } },
  { t: 'cash', a: 25, p: { m_a: 25 } },
  { t: 'repairs', house: 40, hotel: 115, p: { m_h: 40, m_t: 115 } },
  { t: 'cash', a: 10, p: { m_a: 10 } },
  { t: 'cash', a: 100, p: { m_a: 100 } }
];

export const DECKS = { chance: CHANCE, chest: CHEST };

export const TOKENS = ['rocket', 'anchor', 'kite', 'crown', 'lantern', 'compass'];
export const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#14b8a6'];

/** The static board description sent once to every client. */
export function boardForClient() {
  return {
    spaces: SPACES,
    groups: GROUPS,
    decks: { chance: CHANCE.length, chest: CHEST.length },
    consts: { GO_SALARY, BAIL, HOUSES_TOTAL, HOTELS_TOTAL, STATION_RENT, UTILITY_MULT, MORTGAGE_INTEREST }
  };
}
