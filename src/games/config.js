/**
 * Shared game catalogue.
 *
 * - `icon` is a name from public_html/core.js (never an emoji).
 * - `available: false` games are listed but cannot be selected.
 * - `options` are host-editable settings shown in the lobby. Each option is a choice list:
 *   { key, label, hint?, choices: [{ value, label }], default }. Values are strings or numbers.
 *   The selected values reach the game as the third constructor argument: `new Game(room, players, options)`.
 */
export const GAME_CONFIGS = {
  "chess": {
    min: 2, max: 2, name: "Chess", icon: "chess", available: true,
    options: [
      {
        key: "clock", label: "Time control", default: "10+0",
        choices: [
          { value: "none", label: "No clock" },
          { value: "3+2", label: "3+2" },
          { value: "5+0", label: "5 min" },
          { value: "10+0", label: "10 min" },
          { value: "15+10", label: "15+10" }
        ]
      }
    ]
  },
  "uno": {
    min: 2, max: 10, name: "Uno", icon: "cards", available: true,
    options: [
      {
        key: "target", label: "Game length", default: 0,
        choices: [{ value: 0, label: "One round" }, { value: 100, label: "To 100" }, { value: 200, label: "To 200" }, { value: 500, label: "To 500" }]
      },
      {
        key: "stacking", label: "Stack +2 / +4", default: "off",
        choices: [{ value: "off", label: "Off" }, { value: "on", label: "On" }]
      },
      {
        key: "unoCall", label: "UNO call", hint: "Say UNO on your last card or be caught", default: "on",
        choices: [{ value: "on", label: "On" }, { value: "off", label: "Off" }]
      },
      {
        key: "turnTime", label: "Turn timer", default: 30,
        choices: [{ value: 20, label: "20s" }, { value: 30, label: "30s" }, { value: 45, label: "45s" }, { value: 60, label: "60s" }]
      }
    ]
  },
  "kingdomino": {
    min: 2, max: 4, name: "Kingdomino", icon: "castle", available: true,
    options: [
      {
        key: "size", label: "Kingdom size", hint: "7x7 suits two players", default: 5,
        choices: [{ value: 5, label: "5x5" }, { value: 7, label: "7x7" }]
      },
      {
        key: "bonuses", label: "Bonus points", hint: "Middle Kingdom +10, Harmony +5", default: "on",
        choices: [{ value: "on", label: "On" }, { value: "off", label: "Off" }]
      }
    ]
  },
  "dice": {
    min: 2, max: 8, name: "Dice", icon: "dice", available: true,
    options: [
      {
        key: "target", label: "Target score", default: 4000,
        choices: [{ value: 2000, label: "2,000" }, { value: 4000, label: "4,000" }, { value: 10000, label: "10,000" }]
      },
      {
        key: "opening", label: "To get on the board", hint: "Minimum turn score for your first bank", default: 0,
        choices: [{ value: 0, label: "Any" }, { value: 500, label: "500" }]
      }
    ]
  },
  "rock-paper-scissors": {
    min: 2, max: 12, name: "Rock Paper Scissors", icon: "scissors", available: true,
    options: [
      {
        key: "mode", label: "Mode", default: "points",
        choices: [{ value: "points", label: "Points" }, { value: "elimination", label: "Elimination" }]
      },
      {
        key: "rounds", label: "Rounds", hint: "Points mode only", default: 5,
        choices: [{ value: 3, label: "3" }, { value: 5, label: "5" }, { value: 7, label: "7" }]
      }
    ]
  },
  "hamsterball": {
    min: 2, max: 12, name: "Hamsterball", icon: "ball", available: true,
    options: [
      {
        key: "rounds", label: "Rounds", default: 3,
        choices: [{ value: 1, label: "1" }, { value: 3, label: "3" }, { value: 5, label: "5" }]
      },
      {
        key: "lives", label: "Lives per round", default: 3,
        choices: [{ value: 1, label: "1" }, { value: 3, label: "3" }, { value: 5, label: "5" }]
      },
      {
        key: "shrink", label: "Shrinking plate", default: "on",
        choices: [{ value: "on", label: "On" }, { value: "off", label: "Off" }]
      }
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
