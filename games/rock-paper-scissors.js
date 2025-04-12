module.exports = (io, room, roomData, players) => {
  console.log(`Initializing rock paper scissors for room: ${room}`);

  const countdown = 7;

  const playerMoves = {};
  const readyPlayers = [];

  for (let userId in players) {
    const socket = io.sockets.sockets.get(players[userId].socketId);
    initForPlayer(userId, socket, players[userId].name);
  }

  function initForPlayer(userId, socket, name) {
    playerMoves[userId] = { name: name, move: null };

    socket.on("rps-select-move", (move) => {
      console.log("User " + players[userId].name+"("+userId+")("+socket.id+") selected move: " + move + " in room: " + room);
      playerMoves[userId].move = move;
      socket.emit("rps-move-selected", move);
    });

    socket.on("rps-page-loaded", () => {
      if (!readyPlayers.includes(userId)) {
        readyPlayers.push(userId);
        if (readyPlayers.length === Object.keys(players).length) {
          console.log("All players are ready, starting countdown for room: " + room);
          startGame();
        }
      }
    });
  }

  function startGame() {
    const countdownEndUnix = Date.now() + countdown * 1000;
    io.to(room).emit("rps-game-started", countdownEndUnix, Object.entries(players).map(([key, value]) => [value.name, key]));

    setTimeout(() => {
      countdownEnd();
    }, countdown * 1000);
  }

  function countdownEnd() {
    console.log("Countdown ended, processing moves for room: " + room);
    io.to(room).emit("rps-game-ended", playerMoves);
  }
  
};