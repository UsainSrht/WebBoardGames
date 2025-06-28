module.exports = (io, eventBus, room, roomData, players) => {
    console.log(`Initializing kingdomino for room: ${room}`);

    const colorNames = ["red", "blue", "green", "yellow"];
    const colors = [0xff0000,0x0000ff,0x00ff00,0xffff00];
    const tiles = {
        1: { number: 1, left: { type: "farm", crown: 0 }, right: { type: "farm", crown: 0 }, asset: "1" },
        2: { number: 2, left: { type: "farm", crown: 0 }, right: { type: "farm", crown: 0 }, asset: "1" },
        3: { number: 3, left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "3" },
        4: { number: 4, left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "3" },
        5: { number: 5, left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "3" },
        6: { number: 6, left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "3" },
        7: { number: 7, left: { type: "water", crown: 0 }, right: { type: "water", crown: 0 }, asset: "8" },
        8: { number: 8, left: { type: "water", crown: 0 }, right: { type: "water", crown: 0 }, asset: "8" },
        9: { number: 9, left: { type: "water", crown: 0 }, right: { type: "water", crown: 0 }, asset: "8" },
        10: { number: 10, left: { type: "plains", crown: 0 }, right: { type: "plains", crown: 0 }, asset: "10" },
        11: { number: 11, left: { type: "plains", crown: 0 }, right: { type: "plains", crown: 0 }, asset: "10" },
        12: { number: 12, left: { type: "wasteland", crown: 0 }, right: { type: "wasteland", crown: 0 }, asset: "12" },
        13: { number: 13, left: { type: "farm", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "13" },
        14: { number: 14, left: { type: "farm", crown: 0 }, right: { type: "water", crown: 0 }, asset: "14" },
        15: { number: 15, left: { type: "farm", crown: 0 }, right: { type: "plains", crown: 0 }, asset: "15" },
        16: { number: 16, left: { type: "farm", crown: 0 }, right: { type: "wasteland", crown: 0 }, asset: "16" },
        17: { number: 17, left: { type: "forest", crown: 0 }, right: { type: "water", crown: 0 }, asset: "17" },
        18: { number: 18, left: { type: "forest", crown: 0 }, right: { type: "plains", crown: 0 }, asset: "18" },
        19: { number: 19, left: { type: "farm", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "19" },
        20: { number: 20, left: { type: "farm", crown: 1 }, right: { type: "water", crown: 0 }, asset: "20" },
        21: { number: 21, left: { type: "farm", crown: 1 }, right: { type: "plains", crown: 0 }, asset: "21" },
        22: { number: 22, left: { type: "farm", crown: 1 }, right: { type: "wasteland", crown: 0 }, asset: "22" },
        23: { number: 23, left: { type: "farm", crown: 1 }, right: { type: "mine", crown: 0 }, asset: "23" },
        24: { number: 24, left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "24" },
        25: { number: 25, left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "24" },
        26: { number: 26, left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "24" },
        27: { number: 27, left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "24" },
        28: { number: 28, left: { type: "forest", crown: 1 }, right: { type: "water", crown: 0 }, asset: "28" },
        29: { number: 29, left: { type: "forest", crown: 1 }, right: { type: "plains", crown: 0 }, asset: "29" },
        30: { number: 30, left: { type: "water", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "30" },
        31: { number: 31, left: { type: "water", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "30" },
        32: { number: 32, left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "32" },
        33: { number: 33, left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "32" },
        34: { number: 34, left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "32" },
        35: { number: 35, left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "32" },
        36: { number: 36, left: { type: "farm", crown: 0 }, right: { type: "plains", crown: 1 }, asset: "36" },
        37: { number: 37, left: { type: "water", crown: 0 }, right: { type: "plains", crown: 1 }, asset: "37" },
        38: { number: 38, left: { type: "farm", crown: 0 }, right: { type: "wasteland", crown: 1 }, asset: "38" },
        39: { number: 39, left: { type: "plains", crown: 0 }, right: { type: "wasteland", crown: 1 }, asset: "39" },
        40: { number: 40, left: { type: "mine", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "40" },
        41: { number: 41, left: { type: "farm", crown: 0 }, right: { type: "plains", crown: 2 }, asset: "41" },
        42: { number: 42, left: { type: "water", crown: 0 }, right: { type: "plains", crown: 2 }, asset: "42" },
        43: { number: 43, left: { type: "farm", crown: 0 }, right: { type: "wasteland", crown: 2 }, asset: "43" },
        44: { number: 44, left: { type: "plains", crown: 0 }, right: { type: "wasteland", crown: 2 }, asset: "44" },
        45: { number: 45, left: { type: "mine", crown: 2 }, right: { type: "farm", crown: 0 }, asset: "45" },
        46: { number: 46, left: { type: "wasteland", crown: 0 }, right: { type: "mine", crown: 2 }, asset: "46" },
        47: { number: 47, left: { type: "wasteland", crown: 0 }, right: { type: "mine", crown: 2 }, asset: "46" },
        48: { number: 48, left: { type: "farm", crown: 0 }, right: { type: "mine", crown: 3 }, asset: "48" },
    };

    const playerGameData = {};
    const readyPlayers = [];

    for (let userId in players) {
        const socket = io.sockets.sockets.get(players[userId].socketId);
        initForPlayer(userId, socket, players[userId].name);
    }

    function initForPlayer(userId, socket, name) {
        playerGameData[userId] = { name: name, color: null, score: 0 };

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

    const gameTiles = [];
    let totalTiles = 0;

    function startGame() {
        
        totalTiles = readyPlayers.length * 12;

        const shuffledKeys = Object.keys(cloneAndShuffleKeys(tiles));
        for (let i = 0; i < totalTiles; i++) {
            gameTiles.push(shuffledKeys[i]);
        }

        // Assign unique colors to players
        const assignedColors = [...colors];
        let playerIndex = 0;
        for (let userId in playerGameData) {
            // Get a random color from the remaining colors
            const randomColorIndex = Math.floor(Math.random() * assignedColors.length);
            const color = assignedColors.splice(randomColorIndex, 1)[0];
            
            playerGameData[userId].color = color;
            playerIndex++;
        }

        const gameGata = {
            tileCount: totalTiles,
            players: playerGameData,
            turnStartTime: Date.now(),
            currentPlayerIndex: 0
        };

        io.to(room).emit("kingdomino-game-start", gameGata);
        drawNextTiles();
    }

    function drawNextTiles() {
        const drawnTiles = [];
        for (let i = 0; i < totalTiles/12; i++) {
            const tileNumber = gameTiles.pop();
            drawnTiles.push(tiles[tileNumber]);
        }
        io.to(room).emit("kingdomino-draw-tiles", drawnTiles);
    }

    // Fisher-Yates shuffle algorithm
    function shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    // Clone object and shuffle its keys
    function cloneAndShuffleKeys(obj) {
        const keys = Object.keys(obj);
        const shuffledKeys = shuffleArray(keys);
        
        const shuffledObj = {};
        shuffledKeys.forEach(key => {
            shuffledObj[key] = obj[key];
        });
        
        return shuffledObj;
    }

};