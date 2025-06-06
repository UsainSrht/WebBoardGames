module.exports = (io, eventBus, room, roomData, players) => {
  console.log(`Initializing rock paper scissors for room: ${room}`);

  const countdown = 7;
  const waitBeforeNewGame = 7;
  const maxRounds = 3;
  
  let round = 1;

  const playerGameData = {};
  const readyPlayers = [];

  for (let userId in players) {
    const socket = io.sockets.sockets.get(players[userId].socketId);
    initForPlayer(userId, socket, players[userId].name);
  }

  function initForPlayer(userId, socket, name) {
    playerGameData[userId] = { name: name, move: null, score: 0 };

    socket.on("rps-select-move", (move) => {
      console.log("User " + players[userId].name+"("+userId+")("+socket.id+") selected move: " + move + " in room: " + room);
      playerGameData[userId].move = move;
      socket.emit("rps-move-selected", move);
    });

    socket.on("rps-page-loaded", () => {
      if (!readyPlayers.includes(userId)) {
        readyPlayers.push(userId);
        if (readyPlayers.length >= Object.keys(players).length) {
          console.log("All players are ready, starting countdown for room: " + room);
          startGame();
        }
      }
    });
  }

  function startGame() {
    const countdownEndUnix = Date.now() + (countdown * 1000);
    io.to(room).emit("rps-game-started", countdownEndUnix);
    io.to(room).emit("update-scoreboard", playerGameData);

    setTimeout(() => {
      countdownEnd();
    }, countdown * 1000);
  }

  function countdownEnd() {
    console.log("Countdown ended, processing moves for room: " + room);
    for (let userId in playerGameData) {
      if (!playerGameData[userId].move) {
        playerGameData[userId].move = getRandomMove();
      }
    }
    io.to(room).emit("rps-game-ended", playerGameData);
    processMoves(playerGameData);
    io.to(room).emit("update-scoreboard", playerGameData);
    round++;
    for (let userId in playerGameData) {
      playerGameData[userId].move = null;
    }
    if (round > maxRounds) {
      console.log("Game ended, resetting for room: " + room);
      setTimeout(() => {
        eventBus.emit("game-ended", room);
      }, waitBeforeNewGame * 1000);
      return;
    }
    setTimeout(() => {
      startGame();
    }, waitBeforeNewGame * 1000);
  }

  function processMoves(moveData) {
    const keys = Object.keys(moveData);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const userId = keys[i];
        const user2 = keys[j];
        if (userId === user2) continue;
        const move1 = moveData[userId].move;
        const move2 = moveData[user2].move;
        const winner = getWinner(move1, move2);
        if (winner === 1) {
          moveData[userId].score++;
          moveData[user2].score--;
        } else if (winner === 2) {
          moveData[user2].score++;
          moveData[userId].score--;
        }
      }
    }
  }

  function getWinner(move1, move2) {
    if (move1 === move2) return "draw";
    if (
      (move1 === "rock" && move2 === "scissors") ||
      (move1 === "scissors" && move2 === "paper") ||
      (move1 === "paper" && move2 === "rock")
    ) {
      return 1;
    } else {
      return 2;
    }
  }

  function getRandomMove() {
    const moves = ["rock", "paper", "scissors"];
    return moves[Math.floor(Math.random() * moves.length)];
  }

};