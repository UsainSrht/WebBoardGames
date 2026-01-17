const GAME_CONFIGS = {
  "rock-paper-scissors": { min: 2, max: 12, name: "Rock Paper Scissors", icon: "🪨" },
  "dice": { min: 2, max: 12, name: "Dice", icon: "🎲" },
  "kingdomino": { min: 1, max: 4, name: "Kingdomino", icon: "👑" },
  "uno": { min: 2, max: 10, name: "Uno", icon: "🃏" },
  "hamsterball": { min: 1, max: 12, name: "Hamsterball", icon: "🐹" },
  "chess": { min: 2, max: 2, name: "Chess", icon: "♟️" }
};

export async function onRequest(context) {
  return new Response(JSON.stringify(GAME_CONFIGS), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
