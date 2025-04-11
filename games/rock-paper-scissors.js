module.exports = (io, room, roomData, players) => {
  console.log(`Initializing rock paper scissors for room: ${room}`);

  const countdown = 7;

  io.to(room).emit("rps-game-started", countdown, Object.entries(players).map(([key, value]) => [value.name, key]));
  const playerMoves = {};

  io.on("connection", (socket) => {

    const userId = getUserId(socket.id);
    if (!userId) return;
    playerMoves[userId] = { name: getName(userId), move: null };

    socket.on("rps-select-move", (move) => {
      const userId = getUserId(socket.id);
      if (!userId) return;
      playerMoves[userId].move = move;
      io.to(room).emit("rps-move-selected", move);
    });

  });

  setTimeout(() => {
    countdownEnd();
  }, countdown * 1000);

  function countdownEnd() {
    console.log(room + "Countdown ended, processing moves...");
    io.to(room).emit("rps-game-ended", playerMoves);
  }

  //returns only for players that are in this room
  function getUserId(socketId) {
    return Object.entries(players).find(([key, user]) => user.socketId === socketId)?.[0];
  }

};