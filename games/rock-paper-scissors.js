module.exports = (io, room, roomData, players) => {
  console.log(`Initializing rock paper scissors for room: ${room}`);

  const countdown = 7;

  io.to(room).emit("rps-game-started", countdown, Object.entries(players).map(([key, value]) => [value.name, key]));
  const playerMoves = {};

  setTimeout(() => {
    countdownEnd();
  }, countdown * 1000);

  function countdownEnd() {
    console.log("Countdown ended, processing moves for room: " + room);
    io.to(room).emit("rps-game-ended", playerMoves);
  }

  for (let userId in players) {
    const socket = io.sockets.sockets.get(players[userId].socketId);
    initForPlayer(userId, socket, players[userId].name);
  }

  function initForPlayer(userId, socket, name) {
    playerMoves[userId] = { name: name, move: null };

    socket.on("rps-select-move", (move) => {
      console.log("User " + players[userId].name+"("+userId+")("+socket.id+") selected move: " + move + " in room: " + room);
      playerMoves[userId].move = move;
      io.to(room).emit("rps-move-selected", move);
    });
  }
};