const { v4: uuidv4 } = require('uuid');
const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const EventEmitter = require('events');
const eventBus = new EventEmitter();

// Game configurations
const gameDatas = {
  "rock-paper-scissors": { min: 2, max: 12, name: "Rock Paper Scissors", icon: "🪨" },
  "dice": { min: 2, max: 12, name: "Dice", icon: "🎲" },
  "kingdomino": { min: 1, max: 4, name: "Kingdomino", icon: "👑" },
  "uno": { min: 2, max: 10, name: "Uno", icon: "🃏" },
  "hamsterball": { min: 1, max: 12, name: "Hamsterball", icon: "🐹" },
  "chess": { min: 2, max: 2, name: "Chess", icon: "♟️" }
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // Optimized Socket.IO settings
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  perMessageDeflate: {
    threshold: 1024 // Only compress messages larger than 1KB
  }
});
const port = process.env.PORT || 3000;

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Serve static files with caching
app.use(express.static(path.join(__dirname, "public_html"), {
  maxAge: '1d',
  etag: true,
  setHeaders: (res, filePath) => {
    // Don't cache HTML files
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// Serve index.html for GET /
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public_html", "index.html"));
});

// 404 handler
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public_html", "404.html"));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

server.listen(port, () => {
  console.log(`🎮 Web Board Games server running on port ${port}`);
  console.log(`📡 Socket.IO ready for connections`);
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
    const currentRoom = getRoom(userId);
    if (currentRoom && rooms[currentRoom]) {
      if (rooms[currentRoom].players.map(getName).includes(receivedName)) {
        socket.emit("error", "Name already taken in this room");
        socket.emit("request-user-id"); // ask for name again
        return;
      }
    }
    players[userId] = players[userId] || {}; 
    players[userId].name = receivedName;
    players[userId].socketId = socket.id;
    if (isInGame) socket.emit("connect-user", userId, getName(userId), getRoom(userId));
  });

  socket.on("create-room", (roomCode) => {
    const userId = getUserId(socket.id);
    rooms[roomCode] = { 
        players: [], kicked_players: [], playerReadyStates: [],
        started: false, created: Date.now(),
        host: userId, game: null
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
      if (rooms[roomCode].started && players[userId].current_room !== roomCode) {
        socket.emit("error", "Room already started");
        return;
      }
      //no player cap on lobby, games have their own to start
      /*if (rooms[roomCode].players.length >= 4) {
        socket.emit("error", "Room is full");
        return;
      }*/
      if (rooms[roomCode].kicked_players.includes(userId)) {
        socket.emit("error", "You have been kicked from this room!");
        return;
      }
      if (!rooms[roomCode].players.includes(userId)) {
        console.log(`${userId} added to room ${roomCode}`);
        rooms[roomCode].players.push(userId);
      }
      io.to(roomCode).emit("player-list", getPlayerMap(roomCode));
      socket.join(roomCode);
      io.to(roomCode).emit("player-joined", name);
      players[userId].current_room = roomCode;
      socket.emit("send-room-data", ...getRoomData(roomCode));
      console.log(`User ${name}(${socket.id}) joined room ${roomCode}`);
    } else {
      socket.emit("error", "Room not found");
      socket.emit("return-to-main-page");
    }
  });

  socket.on("request-room-data", (roomCode) => {
    socket.emit("send-room-data", ...getRoomData(roomCode));
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

  socket.on("select-game", (game) => {
    const userId = getUserId(socket.id);
    const room = getRoom(userId);
    if (room && rooms[room]) {
      if (rooms[room].host !== userId) {
        socket.emit("error", "You are not the host of this room");
        return;
      }
      rooms[room].game = game;
      io.to(room).emit("game-selected", game, gameDatas[game].min, gameDatas[game].max, gameDatas[game].name);
      //cancel all ready states
      rooms[room].playerReadyStates = [];
      rooms[room].players.forEach(userId2 => {
        io.to(room).emit("ready-state", userId2, false);
      });
    } else {
      socket.emit("error", "You are not in a room");
    }
  });

  socket.on("leave-room", () => {
    const userId = getUserId(socket.id);
    if (!userId) return;
    const name = getName(userId);
    const room = getRoom(userId);
    if (room && rooms[room]) {
      console.log(`${name}(${userId})(${socket.id}) left room ${room}`);
      socket.leave(room);
      rooms[room].players = rooms[room].players.filter(player => player !== userId);
      io.to(room).emit("player-left", name);
      io.to(room).emit("player-list", getPlayerMap(room));
      delete players[userId].current_room;
    }
  });

  socket.on("disconnect", () => {
    const userId = getUserId(socket.id);
    if (!userId) return;
    const name = getName(userId);
    delete players[userId].socketId;
    console.log(`User disconnected: ${name}(${userId})(${socket.id})`);
    if (userId in players && players[userId].current_room) {
        let room = players[userId].current_room;
        if (room in rooms) {
          io.to(room).emit("player-left", name);
          rooms[room].players = rooms[room].players.filter(player => player !== userId);
          io.to(room).emit("player-list", getPlayerMap(room));
        }
    }
    setTimeout(() => {
      if (userId in players && "socketId" in players[userId] && players[userId].socketId) return; // still connected
      else {
        delete players[userId]; // delete player if not connected
      }
    }, 10000); // 10 seconds timeout
  });

  socket.on("kick-player", (kickedUserId) => {
    const userId = getUserId(socket.id);
    if (!userId) return;
    const room = getRoom(userId);
    if (!room || !rooms[room]) return;
    if (userId !== rooms[room].host) {
      socket.emit("error", "You are not the host of this room!");
      return;
    }
    if (!rooms[room].players.includes(kickedUserId)) {
      socket.emit("error", "Player not in room!");
      return;
    }
    rooms[room].kicked_players.push(kickedUserId);
    rooms[room].players = rooms[room].players.filter(player => player !== kickedUserId);
    io.to(room).emit("player-kicked", getName(kickedUserId));
    io.to(room).emit("player-list", getPlayerMap(room));

    if (players[kickedUserId]) {
      delete players[kickedUserId].current_room;
      const socketId = players[kickedUserId]?.socketId;
      if (socketId) {
        const kickedUserSocket = io.sockets.sockets.get(socketId);
        kickedUserSocket.emit("you-got-kicked");
        kickedUserSocket.leave(room);
      }
    }
    
  });

  socket.on("toggle-ready", () => {
    const userId = getUserId(socket.id);
    if (!userId) return;
    const room = getRoom(userId);
    if (!room || !rooms[room]) return;
    let isReady;
    if (rooms[room].playerReadyStates.includes(userId)) {
      rooms[room].playerReadyStates = rooms[room].playerReadyStates.filter(player => player !== userId);
      isReady = false;
    } else {
      rooms[room].playerReadyStates.push(userId);
      isReady = true;
    }
    io.to(room).emit("ready-state", userId, isReady);

    if (!rooms[room].game) return;
    if (rooms[room].playerReadyStates.length >= gameDatas[rooms[room].game].min) {
      if (rooms[room].playerReadyStates.length <= gameDatas[rooms[room].game].max) {
        if (rooms[room].playerReadyStates.length === rooms[room].players.length) {
          startGame(room, rooms[room].game);
        }
      }
    }
  });

  socket.on("ping", (callback) => {
    callback();
  });

});

function getName(userId) {
  return userId in players ? ("name" in players[userId] ? players[userId].name : null) : null;
}

function getUserId(socketId) {
  return Object.entries(players).find(([key, user]) => user.socketId === socketId)?.[0];
}

function getRoom(userId) {
  return userId in players ? ("current_room" in players[userId] ? players[userId].current_room : null) : null;
}

function getPlayerMap(roomCode) {
  return rooms[roomCode].players.map(userId => ({ [getName(userId)]: userId }));
}

function getRoomData(roomCode) {
  return [
    roomCode,
    getPlayerMap(roomCode),
    rooms[roomCode].host,
    rooms[roomCode].started,
    rooms[roomCode].game,
    gameDatas[rooms[roomCode].game]?.min,
    gameDatas[rooms[roomCode].game]?.max,
    gameDatas[rooms[roomCode].game]?.name
  ];
}

function startGame(room, game) {
  console.log(`Starting game ${game} in room ${room}`);
  rooms[room].started = true;
  rooms[room].game = game;
  io.to(room).emit("game-started", game);

  let gameScript;
  if (game === "rock-paper-scissors") {
    const rockPaperScissors = require('./games/rock-paper-scissors');
    gameScript = rockPaperScissors(io, eventBus, room, rooms[room], getDetailedPlayerMap(room));
  } else if (game === "dice") {
    //load dice
  } else if (game === "kingdomino") {
    const kingdomino = require('./games/kingdomino/kingdomino.js');
    gameScript = kingdomino(io, eventBus, room, rooms[room], getDetailedPlayerMap(room));
  } else if (game === "hamsterball") {
    const hamsterball = require('./games/hamsterball.js');
    gameScript = hamsterball(io, eventBus, room, rooms[room], getDetailedPlayerMap(room));
  } else {
    console.error("Game not implemented yet! " + game);
  }
}

eventBus.on("game-ended", (room) => {
  console.log(`Game ended in room ${room}`);
  endGame(room);
});

function endGame(room) {
  console.log(`Ending game in room ${room}`);
  rooms[room].started = false;
  rooms[room].game = null;
  rooms[room].playerReadyStates = [];
  io.to(room).emit("back-to-lobby");
  //todo ready states - reset game html page completely when going back
  //rooms[room].players.forEach(userId => {
  //  io.to(room).emit("ready-state", userId, false);
  //});
}

function getDetailedPlayerMap(roomCode) {
  return Object.fromEntries(
    Object.entries(players).filter(([key]) => rooms[roomCode].players.includes(key))
  );
}