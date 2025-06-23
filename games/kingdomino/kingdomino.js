module.exports = (io, eventBus, room, roomData, players) => {
    console.log(`Initializing kingdomino for room: ${room}`);

    const colors = ["red", "blue", "green", "yellow"];
    const tiles = {
        1: { left: { type: "farm", crown: 0 }, right: { type: "farm", crown: 0 }, asset: "1" },
        2: { left: { type: "farm", crown: 0 }, right: { type: "farm", crown: 0 }, asset: "1" },
        3: { left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "3" },
        4: { left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "3" },
        5: { left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "3" },
        6: { left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "3" },
        7: { left: { type: "water", crown: 0 }, right: { type: "water", crown: 0 }, asset: "8" },
        8: { left: { type: "water", crown: 0 }, right: { type: "water", crown: 0 }, asset: "8" },
        9: { left: { type: "water", crown: 0 }, right: { type: "water", crown: 0 }, asset: "8" },
        10: { left: { type: "plains", crown: 0 }, right: { type: "plains", crown: 0 }, asset: "10" },
        11: { left: { type: "plains", crown: 0 }, right: { type: "plains", crown: 0 }, asset: "10" },
        12: { left: { type: "wasteland", crown: 0 }, right: { type: "wasteland", crown: 0 }, asset: "12" },
        13: { left: { type: "farm", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "13" },
        14: { left: { type: "farm", crown: 0 }, right: { type: "water", crown: 0 }, asset: "14" },
        15: { left: { type: "farm", crown: 0 }, right: { type: "plains", crown: 0 }, asset: "15" },
        16: { left: { type: "farm", crown: 0 }, right: { type: "wasteland", crown: 0 }, asset: "16" },
        17: { left: { type: "forest", crown: 0 }, right: { type: "water", crown: 0 }, asset: "17" },
        18: { left: { type: "forest", crown: 0 }, right: { type: "plains", crown: 0 }, asset: "18" },
        19: { left: { type: "farm", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "19" },
        20: { left: { type: "farm", crown: 1 }, right: { type: "water", crown: 0 }, asset: "20" },
        21: { left: { type: "farm", crown: 1 }, right: { type: "plains", crown: 0 }, asset: "21" },
        22: { left: { type: "farm", crown: 1 }, right: { type: "wasteland", crown: 0 }, asset: "22" },
        23: { left: { type: "farm", crown: 1 }, right: { type: "mine", crown: 0 }, asset: "23" },
        24: { left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "24" },
        25: { left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "24" },
        26: { left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "24" },
        27: { left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "24" },
        28: { left: { type: "forest", crown: 1 }, right: { type: "water", crown: 0 }, asset: "28" },
        29: { left: { type: "forest", crown: 1 }, right: { type: "plains", crown: 0 }, asset: "29" },
        30: { left: { type: "water", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "30" },
        31: { left: { type: "water", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "30" },
        32: { left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "32" },
        33: { left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "32" },
        34: { left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "32" },
        35: { left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "32" },
        36: { left: { type: "farm", crown: 0 }, right: { type: "plains", crown: 1 }, asset: "36" },
        37: { left: { type: "water", crown: 0 }, right: { type: "plains", crown: 1 }, asset: "37" },
        38: { left: { type: "farm", crown: 0 }, right: { type: "wasteland", crown: 1 }, asset: "38" },
        39: { left: { type: "plains", crown: 0 }, right: { type: "wasteland", crown: 1 }, asset: "39" },
        40: { left: { type: "mine", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "40" },
        41: { left: { type: "farm", crown: 0 }, right: { type: "plains", crown: 2 }, asset: "41" },
        42: { left: { type: "water", crown: 0 }, right: { type: "plains", crown: 2 }, asset: "42" },
        43: { left: { type: "farm", crown: 0 }, right: { type: "wasteland", crown: 2 }, asset: "43" },
        44: { left: { type: "plains", crown: 0 }, right: { type: "wasteland", crown: 2 }, asset: "44" },
        45: { left: { type: "mine", crown: 2 }, right: { type: "farm", crown: 0 }, asset: "45" },
        46: { left: { type: "wasteland", crown: 0 }, right: { type: "mine", crown: 2 }, asset: "46" },
        47: { left: { type: "wasteland", crown: 0 }, right: { type: "mine", crown: 2 }, asset: "46" },
        48: { left: { type: "farm", crown: 0 }, right: { type: "mine", crown: 3 }, asset: "48" },
    };

    const playerGameData = {};
    const readyPlayers = [];

    for (let userId in players) {
        const socket = io.sockets.sockets.get(players[userId].socketId);
        initForPlayer(userId, socket, players[userId].name);
    }

    function initForPlayer(userId, socket, name) {
        playerGameData[userId] = { name: name, move: null, score: 0 };

        socket.on("kingdomino-create-finish", () => {
        if (!readyPlayers.includes(userId)) {
            readyPlayers.push(userId);
            if (readyPlayers.length >= Object.keys(players).length) {
            console.log("All players are ready, starting kingdomino for room: " + room);
                startGame();
            }
        }
        });
    }

    function startGame() {
        io.to(room).emit("kingdomino-game-start", tiles);
    }

};