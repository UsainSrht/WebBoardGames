/**
 * Shared game catalogue.
 *
 * - `icon` is a name from public_html/core.js (never an emoji).
 * - `available: false` games are listed but cannot be selected (not finished yet).
 * - `category`: 'cards' | 'board' | 'word' | 'party' | 'action'. `featured` games are the default list in the lobby.
 *   `solo` marks games that make sense with one player. `minutes` is a typical session length. `added` orders "newest".
 * - Names and descriptions shown to people are translated: `games.<id>.name` / `games.<id>.desc` in
 *   public_html/i18n/core.json (the English `name` below is only a fallback and what search matches as a tag).
 * - `options` are host-editable settings shown in the lobby. Each option is a choice list:
 *   { key, label, hint?, choices: [{ value, label }], default }. Values are strings or numbers. Their labels are
 *   translated through the game's dictionary (public_html/i18n/<id>.json): `<id>.opt.<key>` (label),
 *   `<id>.opt.<key>.hint`, and `<id>.opt.<key>.<value>` (choice). The selected values reach the game as the
 *   third constructor argument: `new Game(room, players, options)`.
 */
export const CATEGORIES = ['cards', 'board', 'word', 'party', 'action'];

const sel = (key, label, def, choices, hint) => ({ key, label, default: def, ...(hint ? { hint } : {}), choices: choices.map(([value, text]) => ({ value, label: text })) });
const onOff = (key, label, def = 'on', hint) => sel(key, label, def, [['on', 'On'], ['off', 'Off']], hint);
const seconds = (key, label, def, list) => sel(key, label, def, list.map((n) => [n, `${n}s`]));

export const GAME_CONFIGS = {
  "chess": {
    min: 2, max: 2, name: "Chess", icon: "chess", available: true, category: "board", featured: true, solo: false, minutes: 15, added: 0,
    options: [sel("clock", "Time control", "10+0", [["none", "No clock"], ["3+2", "3+2"], ["5+0", "5 min"], ["10+0", "10 min"], ["15+10", "15+10"]])]
  },
  "uno": {
    min: 2, max: 10, name: "Uno", icon: "cards", available: true, category: "cards", featured: true, solo: false, minutes: 15, added: 0,
    options: [
      sel("target", "Game length", 0, [[0, "One round"], [100, "To 100"], [200, "To 200"], [500, "To 500"]]),
      onOff("stacking", "Stack +2 / +4", "off"),
      onOff("unoCall", "UNO call", "on", "Say UNO on your last card or be caught"),
      seconds("turnTime", "Turn timer", 30, [20, 30, 45, 60])
    ]
  },
  "kingdomino": {
    min: 2, max: 4, name: "Kingdomino", icon: "castle", available: true, category: "board", featured: false, solo: false, minutes: 20, added: 0,
    options: [
      sel("size", "Kingdom size", 5, [[5, "5x5"], [7, "7x7"]], "7x7 suits two players"),
      onOff("bonuses", "Bonus points", "on", "Middle Kingdom +10, Harmony +5")
    ]
  },
  "dice": {
    min: 2, max: 8, name: "Dice", icon: "dice", available: true, category: "party", featured: false, solo: false, minutes: 15, added: 0,
    options: [
      sel("target", "Target score", 4000, [[2000, "2,000"], [4000, "4,000"], [10000, "10,000"]]),
      sel("opening", "To get on the board", 0, [[0, "Any"], [500, "500"]], "Minimum turn score for your first bank")
    ]
  },
  "rock-paper-scissors": {
    min: 2, max: 12, name: "Rock Paper Scissors", icon: "scissors", available: true, category: "party", featured: false, solo: false, minutes: 5, added: 0,
    options: [
      sel("mode", "Mode", "points", [["points", "Points"], ["elimination", "Elimination"]]),
      sel("rounds", "Rounds", 5, [[3, "3"], [5, "5"], [7, "7"]], "Points mode only")
    ]
  },
  "hamsterball": {
    min: 2, max: 12, name: "Hamsterball", icon: "ball", available: true, category: "action", featured: false, solo: false, minutes: 10, added: 0,
    options: [
      sel("rounds", "Rounds", 3, [[1, "1"], [3, "3"], [5, "5"]]),
      sel("lives", "Lives per round", 3, [[1, "1"], [3, "3"], [5, "5"]]),
      onOff("shrink", "Shrinking plate", "on")
    ]
  },

  // ---------------------------------------------------------------- new games
  "poker": {
    min: 2, max: 8, name: "Poker", icon: "chip", available: true, category: "cards", featured: true, solo: false, minutes: 30, added: 1,
    options: [
      sel("chips", "Starting chips", 2000, [[1000, "1,000"], [2000, "2,000"], [5000, "5,000"]]),
      sel("blinds", "Blinds", "25/50", [["10/20", "10/20"], ["25/50", "25/50"], ["50/100", "50/100"]]),
      sel("blindUp", "Blinds go up", 10, [[0, "Never"], [5, "Every 5 min"], [10, "Every 10 min"]]),
      seconds("turnTime", "Turn timer", 30, [20, 30, 45])
    ]
  },
  "okey": {
    min: 2, max: 4, name: "Okey", icon: "tiles", available: true, category: "board", featured: true, solo: false, minutes: 30, added: 1,
    options: [
      sel("mode", "Variant", "classic", [["classic", "Classic"], ["101", "101"]]),
      sel("rounds", "Hands", 1, [[1, "1"], [3, "3"], [5, "5"]], "Classic only"),
      seconds("turnTime", "Turn timer", 45, [30, 45, 60, 90])
    ]
  },
  "pool": {
    min: 2, max: 2, name: "8 Ball Pool", icon: "pool", available: true, category: "action", featured: false, solo: false, minutes: 15, added: 1,
    options: [
      sel("shotClock", "Shot clock", 45, [[0, "Off"], [30, "30s"], [45, "45s"], [60, "60s"]]),
      onOff("callPocket", "Call the 8 ball pocket", "off")
    ]
  },
  "monopoly": {
    min: 2, max: 6, name: "Monopoly", icon: "house", available: true, category: "board", featured: true, solo: false, minutes: 90, added: 1,
    options: [
      sel("startCash", "Starting cash", 1500, [[1000, "1,000"], [1500, "1,500"], [2500, "2,500"]]),
      sel("freeParking", "Free Parking", "none", [["none", "Nothing"], ["pot", "Jackpot"]]),
      onOff("auction", "Auctions", "on"),
      sel("timeLimit", "Time limit", 60, [[0, "None"], [45, "45 min"], [60, "60 min"], [90, "90 min"]], "Richest player wins when time is up"),
      sel("turnTime", "Turn timer", 60, [[0, "Off"], [30, "30s"], [60, "60s"], [90, "90s"]])
    ]
  },
  "wordle": {
    min: 1, max: 12, name: "Wordle", icon: "wordle", available: true, category: "word", featured: true, solo: true, minutes: 10, added: 1,
    options: [
      sel("language", "Language", "en", [["en", "English"], ["tr", "Turkish"]]),
      sel("rounds", "Words", 3, [[1, "1"], [3, "3"], [5, "5"]]),
      onOff("hard", "Hard mode", "off", "Revealed hints must be used"),
      sel("time", "Time per word", 180, [[0, "No limit"], [120, "2 min"], [180, "3 min"], [300, "5 min"]])
    ]
  },
  "typing": {
    min: 1, max: 12, name: "Typing Test", icon: "keyboard", available: true, category: "word", featured: false, solo: true, minutes: 3, added: 1,
    options: [
      sel("language", "Language", "en", [["en", "English"], ["tr", "Turkish"]]),
      sel("duration", "Duration", 30, [[15, "15s"], [30, "30s"], [60, "60s"], [120, "2 min"]]),
      sel("source", "Text", "words", [["words", "Random words"], ["quotes", "Quotes"]])
    ]
  },
  "gofish": {
    min: 2, max: 6, name: "Go Fish", icon: "fish", available: true, category: "cards", featured: false, solo: false, minutes: 15, added: 1,
    options: [
      sel("hand", "Starting hand", "auto", [["auto", "Auto"], [5, "5"], [7, "7"]]),
      seconds("turnTime", "Turn timer", 30, [20, 30, 45])
    ]
  },
  "pisti": {
    min: 2, max: 4, name: "Pisti", icon: "pair", available: true, category: "cards", featured: false, solo: false, minutes: 15, added: 1,
    options: [
      sel("target", "Game length", 0, [[0, "One deal"], [101, "To 101"], [151, "To 151"]]),
      sel("teams", "Teams (4 players)", "off", [["off", "Everyone for themselves"], ["on", "2 vs 2"]]),
      seconds("turnTime", "Turn timer", 30, [20, 30, 45])
    ]
  },
  "papaz": {
    min: 2, max: 8, name: "Papaz Kaçtı", icon: "crown", available: true, category: "cards", featured: false, solo: false, minutes: 10, added: 1,
    options: [
      sel("rounds", "Rounds", 3, [[1, "1"], [3, "3"], [5, "5"]]),
      seconds("turnTime", "Turn timer", 30, [20, 30, 45])
    ]
  }
};

export const MAX_ROOM_PLAYERS = Math.max(...Object.values(GAME_CONFIGS).map(g => g.max));

/** Defaults for a game's options, e.g. { clock: "10+0" }. */
export function defaultOptions(game) {
  const out = {};
  for (const opt of GAME_CONFIGS[game]?.options || []) out[opt.key] = opt.default;
  return out;
}

/** Keep only known keys with allowed values; fall back to the default for anything else. */
export function sanitizeOptions(game, raw = {}) {
  const out = defaultOptions(game);
  for (const opt of GAME_CONFIGS[game]?.options || []) {
    const choice = opt.choices.find(c => c.value === raw?.[opt.key]);
    if (choice) out[opt.key] = choice.value;
  }
  return out;
}
