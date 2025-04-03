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
      if (rooms[roomCode].started) {
        socket.emit("error", "Room already started");
        return;
      }
      if (rooms[roomCode].players.length >= 4) {
        socket.emit("error", "Room is full");
        return;
      }
      socket.join(roomCode);
      rooms[roomCode].players.push(socket.id);
      players[socket.id].current_room = roomCode;
      console.log(`User ${getName(socket.id)}(${socket.id}) joined room ${roomCode}`);
      io.to(roomCode).emit("player-joined", socket.id);
      io.to(roomCode).emit("player-list", rooms[roomCode].players);
    } else {
      socket.emit("error", "Room not found");
    }
  });

  socket.on("chat-message", (message) => {
    const room = players[socket.id].current_room;
    if (room) {
      io.to(room).emit("chat-message", { message, name: getName(socket.id) });
    } else {
      socket.emit("error", "You are not in a room");
    }
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${getName(socket.id)}(${socket.id})`);
    if (socket.id in players && players[socket.id].current_room !== null) {
        let room = players[socket.id].current_room;
        io.to(room).emit("player-left", socket.id);
        io.to(room).emit("player-list", rooms[room].players);
    }
    delete players[socket.id];
  });
});

server.listen(3000, () => console.log("Server running on port 3000"));

function getName(socketId) {
    return socketId in players ? ("name" in players[socketId] ? players[socketId].name : "noname") : "noname";
}