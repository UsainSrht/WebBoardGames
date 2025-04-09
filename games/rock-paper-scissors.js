module.exports = (io, room, roomData, players) => {
  console.log(`Initializing rock paper scissors for room: ${room}`);

  io.to(room).emit("rps-game-started");

  io.on("connection", (socket) => {

    const userId = getUserId(socket.id);
    if (!userId) return;

    socket.on("rps-select-move", (move) => {
      const userId = getUserId(socket.id);
      if (!userId) return;
      io.to(room).emit("rps-move-selected", move, userId);
    });

  });

  //returns only for players that are in this room
  function getUserId(socketId) {
    return Object.entries(players).find(([key, user]) => user.socketId === socketId)?.[0];
  }

};