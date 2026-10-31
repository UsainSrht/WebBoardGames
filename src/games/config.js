/**
 * Shared game catalogue. `available: false` games are listed but cannot be selected.
 */
export const GAME_CONFIGS = {
  "rock-paper-scissors": { min: 2, max: 12, name: "Rock Paper Scissors", icon: "🪨", available: true },
  "dice": { min: 2, max: 12, name: "Dice", icon: "🎲", available: true },
  "kingdomino": { min: 1, max: 4, name: "Kingdomino", icon: "👑", available: true },
  "uno": { min: 2, max: 10, name: "Uno", icon: "🃏", available: true },
  "hamsterball": { min: 1, max: 12, name: "Hamsterball", icon: "🐹", available: true },
  "chess": { min: 2, max: 2, name: "Chess", icon: "♟️", available: true }
};

export const MAX_ROOM_PLAYERS = Math.max(...Object.values(GAME_CONFIGS).map(g => g.max));
