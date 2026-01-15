module.exports = (io, eventBus, room, roomData, players) => {
    console.log(`Initializing kingdomino for room: ${room}`);

    const colorNames = ["red", "blue", "green", "yellow"];
    const colors = [0xff0000,0x0000ff,0x00ff00,0xffff00];
    const tileSelectTurntime = 10000; // 10 seconds for tile selection
    const tilePlaceTurnTime = 15000; // 15 seconds for tile placement
    const gridSize = 5;
    
    let isGameActive = true;
    const socketListeners = new Map();
    
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

    let i = 1;
    for (let userId in players) {
        const socket = io.sockets.sockets.get(players[userId].socketId);
        initForPlayer(userId, socket, players[userId].name, i);
        i++;
    }

    function cleanup() {
        isGameActive = false;
        if (turnTimer) {
            clearTimeout(turnTimer);
            turnTimer = null;
        }
        
        socketListeners.forEach(({ socket, listeners }) => {
            if (socket) {
                socket.off("kingdomino-create-finish", listeners.createFinish);
                socket.off("kingdomino-select-tile", listeners.selectTile);
                socket.off("kingdomino-place-tile", listeners.placeTile);
            }
        });
        socketListeners.clear();
        console.log(`Kingdomino game cleaned up for room: ${room}`);
    }

    function initForPlayer(userId, socket, name, index) {
        if (!socket) return;
        
        playerGameData[userId] = { name: name, color: null, selectedTile: 0, turnIndex: index, score: 0 };

        const listeners = {};

        listeners.createFinish = () => {
            if (!readyPlayers.includes(userId)) {
                readyPlayers.push(userId);
                if (readyPlayers.length >= Object.keys(players).length) {
                console.log("All players are ready, starting kingdomino for room: " + room);
                    startGame();
                }
            }
        };
        socket.on("kingdomino-create-finish", listeners.createFinish);

        listeners.selectTile = (tileNumber, drawnIndex) => {
            if (!isGameActive) return;
            if (currentPlayerIndex === playerGameData[userId].turnIndex) {
                selectTile(userId, tileNumber, drawnIndex);
            }
        };
        socket.on("kingdomino-select-tile", listeners.selectTile);

        listeners.placeTile = (tileNumber, row, col, rotation) => {
            if (!isGameActive) return;
            if (currentPlayerIndex === playerGameData[userId].turnIndex) {
                placeTile(userId, tileNumber, row, col, rotation);
            }
        };
        socket.on("kingdomino-place-tile", listeners.placeTile);

        socketListeners.set(userId, { socket, listeners });
    }

    const gameTiles = [];
    let totalTiles = 0;

    function startGame() {
        
        totalTiles = readyPlayers.length * 12;

        const shuffledKeys = Object.keys(tiles).sort(() => Math.random() - 0.5);
        for (let i = 0; i < totalTiles; i++) {
            gameTiles.push(shuffledKeys[i]);
        }

        // Assign unique colors to players
        const assignedColors = [...colors];
        for (let userId in playerGameData) {
            // Get a random color from the remaining colors
            const randomColorIndex = Math.floor(Math.random() * assignedColors.length);
            const color = assignedColors.splice(randomColorIndex, 1)[0];
            
            playerGameData[userId].color = color;
            playerGameData[userId].gridOccupancy = initializeGridOccupancy();
        }

        const gameGata = {
            tileCount: totalTiles,
            players: playerGameData,
            turnStartTime: Date.now(),
            currentPlayerIndex: 1
        };

        io.to(room).emit("kingdomino-game-start", gameGata);
        io.to(room).emit("kingdomino-tile-selection-start");
        drawNextTiles();
        nextTurn();
    }

    let isTileSelecting = true;
    let currentPlayerIndex = 1;
    let turnTimer = null;
    let isWaitingForPlayer = false;
    let gameEnded = false;

    function nextTurn() {
        if (gameEnded || !isGameActive) return;

        //3 selecting turn when 2 player exists, fix that
        //end turn system, currently able to do more moves in his turn befoe passing
        console.log('turn index:', currentPlayerIndex, 'isTileSelecting:', isTileSelecting);

        // Clear any existing timer
        if (turnTimer) {
            clearTimeout(turnTimer);
            turnTimer = null;
        }

        const turnStartTime = Date.now();
        const turnEndTime = turnStartTime + (isTileSelecting ? tileSelectTurntime : tilePlaceTurnTime);

        // Emit current turn info
        io.to(room).emit("kingdomino-turn-info", currentPlayerIndex, turnStartTime, turnEndTime);
        
        // Set flag that we're waiting for player action
        isWaitingForPlayer = true;
        
        // Start 15-second timer for automatic turn advance
        turnTimer = setTimeout(() => {
            if (isWaitingForPlayer) {
                if (isTileSelecting) {
                    selectRandomTile();
                } else {
                    placeRandomTile();
                }
                advanceToNextPlayer();
            }
        }, isTileSelecting ? tileSelectTurntime : tilePlaceTurnTime);
    }

    function initializeGridOccupancy() {
        // Create a grid to track occupied spaces
        const grid = [];
        for (let row = 0; row < gridSize; row++) {
            grid[row] = [];
            for (let col = 0; col < gridSize; col++) {
                grid[row][col] = null;
            }
        }
        // Mark castle position as occupied
        const castleRow = Math.floor(gridSize / 2);
        const castleCol = Math.floor(gridSize / 2);
        grid[castleRow][castleCol] = 'castle'; // Mark castle position
        return grid;
    }

    function selectRandomTile() {
        const userId = Object.keys(playerGameData).find(id => playerGameData[id].turnIndex === currentPlayerIndex);
        const availableTiles = drawnTiles.filter(tile => tile && !Object.values(playerGameData).some(player => player.selectedTile === tile.number));
        const randomTile = availableTiles[Math.floor(Math.random() * availableTiles.length)];
        selectTile(userId, randomTile.number, drawnTiles.indexOf(randomTile));
    }

    function placeRandomTile() {
        //todo console warns about invalid placements and it does place over other tiles sometimes
        console.log('placing random tile');
        const userId = Object.keys(playerGameData).find(id => playerGameData[id].turnIndex === currentPlayerIndex);
        const playerData = playerGameData[userId];
        const selectedTile = playerData.selectedTile;
        if (selectedTile > 0) {
            
            const rotations = [0, 90, 180, 270];
            let rotation = rotations[Math.floor(Math.random() * rotations.length)];
            for (let i = 0; i < rotations.length; i++) {
                const size = getSize(rotation);
                for (let row = 0; row < gridSize; row++) {
                    for (let col = 0; col < gridSize; col++) {
                        if (canPlaceTile(row, col, size.width, size.height, playerData.gridOccupancy)) {
                            placeTile(userId, selectedTile, row, col, rotation);
                            return;
                        }
                    }
                }
                rotation = (rotation + 90) % 360;
            }

        }
    }

    function canPlaceTile(startRow, startCol, width, height, gridOccupancy) {

        // Check if all required cells are available
        if (startRow + height > gridSize-1 || startCol + width > gridSize-1 ||
            startRow + height < 0 || startCol + width < 0
        ) {
            return false; // Would go outside grid
        }
        
        if (gridOccupancy[startRow][startCol] !== null || 
            gridOccupancy[startRow + height][startCol + width] !== null
        ) {
            return false; // occupied space
        }

        return true;
    }

    function getSize(rotation) {
        if (rotation === 0) {
            return { width: 1, height: 0 };
        } else if (rotation === 90) {
            return { width: 0, height: 1 };
        } else if (rotation === 180) {
            return { width: -1, height: 0 };
        } else if (rotation === 270) {
            return { width: 0, height: -1 };
        } else {
            return null;
        }
    }

    function advanceToNextPlayer() {
        isWaitingForPlayer = false;
        currentPlayerIndex++;
        if (currentPlayerIndex > readyPlayers.length) {
            currentPlayerIndex = 1;
        }
        nextTurn();
    }

    function selectTile(userId, tileNumber, drawnIndex) {
        if (drawnTiles.filter(tile => tile.number === tileNumber).length === 1 && isTileSelecting && Object.values(playerGameData).filter(player => player.selectedTile === tileNumber).length === 0) {
            playerGameData[userId].selectedTile = tileNumber;
            
            io.to(room).emit("kingdomino-tile-selected", userId, tileNumber, drawnIndex);

            // Check if all players have selected their tiles
            const selectedTiles = Object.values(playerGameData).filter(player => player.selectedTile > 0).length;
            if (selectedTiles >= readyPlayers.length) {
                isTileSelecting = false;
                io.to(room).emit("kingdomino-tile-selection-end");
            }

            advanceToNextPlayer();
        } else {
            console.log('invalid tile selection attempt:', userId, tileNumber, drawnIndex);
        }
    }

    function placeTile(userId, tileNumber, row, col, rotation) {
        if (!isTileSelecting && playerGameData[userId].selectedTile === tileNumber) {
            // Validate tile placement logic here
            // For simplicity, we assume the placement is valid
            
            playerGameData[userId].selectedTile = 0; // Reset selected tile
            
            io.to(room).emit("kingdomino-tile-placed", userId, tileNumber, row, col, rotation);
            
            // Check if all players have placed their tiles
            const placedTiles = Object.values(playerGameData).filter(player => player.selectedTile === 0).length;
            if (placedTiles >= readyPlayers.length) {
                isTileSelecting = true; // Reset for next round
                io.to(room).emit("kingdomino-tile-selection-start");
                drawNextTiles();
            }
            
            advanceToNextPlayer();
        } else {
            console.log('invalid tile placement attempt:', userId, tileNumber, row, col, rotation);
        }
    }

    const drawnTiles = [];
    function drawNextTiles() {
        if (gameTiles.length < totalTiles / 12) {
            console.log("Not enough tiles left to draw, game ends.");
            endGame();
            return;
        }

        drawnTiles.length = 0; // Clear previous drawn tiles
        for (let i = 0; i < totalTiles/12; i++) {
            const tileNumber = gameTiles.pop();
            drawnTiles.push(tiles[tileNumber]);
        }
        io.to(room).emit("kingdomino-draw-tiles", drawnTiles);
    }

    function endGame() {
        gameEnded = true;
        // Calculate scores and emit final results
        const scores = {};
        for (let userId in playerGameData) {
            const playerData = playerGameData[userId];
            scores[userId] = playerData.score; // Assuming score is calculated elsewhere
        }
        io.to(room).emit("kingdomino-game-end", scores);
        cleanup();
        eventBus.emit("game-ended", room);
    }

};