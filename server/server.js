const { v4: uuidv4 } = require('uuid');
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

  socket.emit("request-user-id");

  socket.on("send-user-id", (userId) => {
    if (!userId) {
      userId = uuidv4(); // Generate a new UUID if none is provided
    }
    players[userId] = players[userId] || {}; 
    players[userId].socketId = socket.id;
    console.log(`User sent id: ${getName(userId)}(${userId})(${socket.id})`);
    socket.emit("connect-user", userId, getName(userId), getRoom(userId));
  });

  //is in game page
  socket.on("submit-name", (receivedName, isInGame) => {
    const userId = getUserId(socket.id);
    console.log(`User submitted name: ${receivedName}(${userId})(${socket.id})`);
    players[userId] = players[userId] || {}; 
    players[userId].name = receivedName;
    players[userId].socketId = socket.id;
    if (isInGame) socket.emit("connect-user", userId, getName(userId), getRoom(userId));
  });

  socket.on("create-room", (roomCode) => {
    const userId = getUserId(socket.id);
    rooms[roomCode] = { 
        players: [], kicked_players: [], 
        started: false, created: Date.now()
    };
    socket.join(roomCode);
    console.log(`${getName(userId)}(${socket.id}) created room: ${roomCode}`);
  });

  socket.on("join-room", (roomCode) => {
    const userId = getUserId(socket.id);
    const name = getName(userId);
    if (!name) {
      socket.emit("request-nickname");
      return;
    }
    //console.log(`${name}(${userId})(${socket.id}) wants to join room: ${roomCode}`);
    if (rooms[roomCode]) {
      if (rooms[roomCode].started) {
        socket.emit("error", "Room already started");
        return;
      }
      if (rooms[roomCode].players.length >= 4) {
        socket.emit("error", "Room is full");
        return;
      }
      if (!rooms[roomCode].players.includes(userId)) {
        console.log(`${userId} added to room ${roomCode}`);
        rooms[roomCode].players.push(userId);
      }
      io.to(roomCode).emit("player-list", rooms[roomCode].players.map(getName));
      socket.join(roomCode);
      io.to(roomCode).emit("player-joined", name);
      players[userId].current_room = roomCode;
      socket.emit("send-room-data", roomCode, rooms[roomCode].players.map(getName), rooms[roomCode].started);
      console.log(`User ${name}(${socket.id}) joined room ${roomCode}`);
    } else {
      socket.emit("error", "Room not found");
    }
  });

  socket.on("request-room-data", (roomCode) => {
    console.log(`sending room data ${roomCode} ${rooms[roomCode].players.length}`);
    socket.emit("send-room-data", roomCode, rooms[roomCode].players.map(getName), rooms[roomCode].started);
  });

  socket.on("chat-message", (message) => {
    const userId = getUserId(socket.id);
    const room = getRoom(userId);
    if (room) {
      console.log(`${room}: ${getName(userId)}: ${message}`);
      io.to(room).emit("chat-message", message, getName(userId));
    } else {
      socket.emit("error", "You are not in a room");
    }
  });

  socket.on("disconnect", () => {
    const userId = getUserId(socket.id);
    const name = getName(userId);
    console.log(`User disconnected: ${name}(${userId})(${socket.id})`);
    if (userId in players && players[userId].current_room) {
        let room = players[userId].current_room;
        if (room in rooms) {
          io.to(room).emit("player-left", name);
          rooms[room].players = rooms[room].players.filter(player => player !== userId);
          io.to(room).emit("player-list", rooms[room].players.map(getName));
        }
    }
    //add timeout and delete
    //delete players[userId];
  });

  socket.on("kick-player", (userId) => {});

});

server.listen(3000, () => console.log("Server running on port 3000"));

function getName(userId) {
  return userId in players ? ("name" in players[userId] ? players[userId].name : null) : null;
}

function getUserId(socketId) {
  return Object.entries(players).find(([key, user]) => user.socketId === socketId)?.[0];
}

function getRoom(userId) {
  return userId in players ? ("current_room" in players[userId] ? players[userId].current_room : null) : null;
}