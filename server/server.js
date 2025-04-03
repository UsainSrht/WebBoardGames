const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const rooms = {}; // Store room data
const players = {};

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("submit-name", (name) => {
    console.log(`${name} joined. (${socket.id})`);
    players[socket.id] = {
        name: name,
        created: Date.now(),
        current_room: null
    };
  });

  socket.on("create-room", (roomCode) => {
    rooms[roomCode] = { 
        players: [socket.id], kicked_players: [], 
        started: false, created: Date.now()
    };
    socket.join(roomCode);
    console.log(`${getName(socket.id)}(${socket.id}) created room: ${roomCode}`);
  });

  socket.on("join-room", (roomCode) => {
    if (rooms[roomCode]) {
      socket.join(roomCode);
      rooms[roomCode].players.push(socket.id);
      console.log(`User ${getName(socket.id)}(${socket.id}) joined room ${roomCode}`);
      io.to(roomCode).emit("player-joined", socket.id);
    } else {
      socket.emit("error", "Room not found");
    }
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${getName(socket.id)}(${socket.id})`);
    if (socket.id in players && players[socket.id].current_room !== null) {
        let room = players[socket.id].current_room;
        io.to(room).emit("player-left", socket.id);
    }
  });
});

server.listen(3000, () => console.log("Server running on port 3000"));

function getName(socketId) {
    return players[socketId].name;
}