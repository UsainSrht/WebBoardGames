
module.exports = (io, room, roomData, players) => {
  console.log(`Initializing rock paper scissors for room: ${room}`);

  io.to(room).emit("rps-game-started");

  io.in(room).on("connection", (socket) => {

    socket.on("rps-select-move", (move) => {
      const userId = getUserId(socket.id);
      if (!userId) return;
      io.emit("rps-move-selected", move, userId);
    });

  });

  function getUserId(socketId) {
    return Object.entries(players).find(([key, user]) => user.socketId === socketId)?.[0];
  }

};

alert("Rock Paper Scissors game started! Select your move: rock, paper, or scissors.");