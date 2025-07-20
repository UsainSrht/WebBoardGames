import TilePlacementSystem from './kingdomino/tile_system.js';
import TitleEffect from './kingdomino/title_effect.js';

class KingdominoScene extends Phaser.Scene {
    constructor() {
        super({ key: 'KingdominoScene' });
        this.players = [];
        this.currentPlayerIndex = 0;
        this.currentTurnStartTime = 0;
        this.currentTurnEndTime = 0;
        this.playerListContainer = null;
        this.turnProgressBar = null;
        this.isTileSelecting = true;
        this.drawnTiles = [];
        this.turnCount = 0;
    }

    preload() {
        socket.emit("kingdomino-preload-start");
        
        const gameBoard = document.getElementById('game-board');
    
        const loadingLabel = document.createElement("div");
        loadingLabel.id = "loading-label";
        loadingLabel.className = "flex items-center justify-center h-screen w-screen bg-gray-800 bg-opacity-50 fixed top-0 left-0 z-50";
        loadingLabel.innerHTML = `<svg aria-hidden="true" class="w-8 h-8 text-gray-600 animate-spin fill-blue-600" viewBox="0 0 100 101" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z" fill="currentColor"/>
                                        <path d="M93.9676 39.0409C96.393 38.4038 97.8624 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6781 93.9676 39.0409Z" fill="currentFill"/>
                                    </svg>`;
        gameBoard.appendChild(loadingLabel);

        this.load.image('castle', './images/kingdomino/castle.png');
        this.load.image('background', './images/kingdomino/background.png');
        this.load.image('pawn-red', './images/kingdomino/pawn-red.png');
        this.load.image('pawn-blue', './images/kingdomino/pawn-blue.png');
        this.load.image('pawn-green', './images/kingdomino/pawn-green.png');
        this.load.image('pawn-yellow', './images/kingdomino/pawn-yellow.png');
    
        this.load.image('1', './images/kingdomino/1.png');
        this.load.image('3', './images/kingdomino/3.png');
        this.load.image('8', './images/kingdomino/8.png');
        this.load.image('10', './images/kingdomino/10.png');
        this.load.image('12', './images/kingdomino/12.png');
        this.load.image('13', './images/kingdomino/13.png');
        this.load.image('14', './images/kingdomino/14.png');
        this.load.image('15', './images/kingdomino/15.png');
        this.load.image('16', './images/kingdomino/16.png');
        this.load.image('17', './images/kingdomino/17.png');
        this.load.image('18', './images/kingdomino/18.png');
        this.load.image('19', './images/kingdomino/19.png');
        this.load.image('20', './images/kingdomino/20.png');
        this.load.image('21', './images/kingdomino/21.png');
        this.load.image('22', './images/kingdomino/22.png');
        this.load.image('23', './images/kingdomino/23.png');
        this.load.image('24', './images/kingdomino/24.png');
        this.load.image('28', './images/kingdomino/28.png');
        this.load.image('29', './images/kingdomino/29.png');
        this.load.image('30', './images/kingdomino/30.png');
        this.load.image('31', './images/kingdomino/30.png');
        this.load.image('32', './images/kingdomino/32.png');
        this.load.image('36', './images/kingdomino/36.png');
        this.load.image('37', './images/kingdomino/37.png');
        this.load.image('38', './images/kingdomino/38.png');
        this.load.image('39', './images/kingdomino/39.png');
        this.load.image('40', './images/kingdomino/40.png');
        this.load.image('41', './images/kingdomino/41.png');
        this.load.image('42', './images/kingdomino/42.png');
        this.load.image('43', './images/kingdomino/43.png');
        this.load.image('44', './images/kingdomino/44.png');
        this.load.image('45', './images/kingdomino/45.png');
        this.load.image('46', './images/kingdomino/46.png');
        this.load.image('48', './images/kingdomino/48.png');
    
        socket.emit("kingdomino-preload-finish");
    }

    showTitleEffect(text, iconKey, targetX, targetY, options) {
        return this.titleEffect.show(text, iconKey, targetX, targetY, options);
    }

    createPlayerList() {
        // Create container for player list in bottom left
        this.playerListContainer = this.add.container(20, this.scale.height - 20);
        
        // Background for player list
        const listBackground = this.add.rectangle(0, 0, 250, this.players.length * 60 + 20, 0x000000, 0.7)
            .setOrigin(0, 1)
            .setStrokeStyle(2, 0xffffff);
        
        this.playerListContainer.add(listBackground);
        
        // Create player entries
        Object.values(this.players).forEach(player => {
            this.createPlayerEntry(player);
        });
        
        this.updatePlayerListHighlight();
    }
    
    createPlayerEntry(player) {
        const index = player.turnIndex;
        const yOffset = -(index * 60 + 40);
        
        // Player container
        const playerContainer = this.add.container(10, yOffset);
        
        // Player color indicator
        const colorIndicator = this.add.circle(15, 0, 12, player.color);
        
        // Player name
        const nameText = this.add.text(35, -5, player.name, { 
            fontSize: '14px', 
            color: '#ffffff',
            fontFamily: 'Arial'
        });
        
        // Turn indicator background (invisible by default)
        const turnIndicator = this.add.rectangle(0, 0, 230, 50, 0xffff00, 0.2)
            .setOrigin(0, 0.5)
            .setVisible(false);
        
        // Time progress bar background
        const progressBg = this.add.rectangle(35, 15, 180, 8, 0x333333)
            .setOrigin(0, 0.5);
        
        // Time progress bar fill
        const progressFill = this.add.rectangle(35, 15, 180, 8, 0x00ff00)
            .setOrigin(0, 0.5);
        
        // Store references for updates
        player.ui = {
            container: playerContainer,
            turnIndicator: turnIndicator,
            progressBg: progressBg,
            progressFill: progressFill,
            nameText: nameText,
            colorIndicator: colorIndicator
        };
        
        playerContainer.add([turnIndicator, colorIndicator, nameText, progressBg, progressFill]);
        this.playerListContainer.add(playerContainer);
    }
    
    updatePlayerListHighlight() {
        Object.values(this.players).forEach(player => {
            const isCurrentPlayer = player.turnIndex === this.currentPlayerIndex;
            player.ui.turnIndicator.setVisible(isCurrentPlayer);
            
            if (isCurrentPlayer) {
                player.ui.nameText.setColor('#000000');
                player.ui.progressFill.setVisible(true);
            } else {
                player.ui.nameText.setColor('#ffffff');
                player.ui.progressFill.setVisible(false);
            }
        });
    }

    isMyTurn() {
        return this.myData.turnIndex === this.currentPlayerIndex;
    }
    
    updateTurnProgress() {
        if (this.players.length === 0) return;
        
        const remaining = Math.max(0, this.currentTurnEndTime - Date.now());
        const progress = Math.max(0, (remaining / (this.currentTurnEndTime - this.currentTurnStartTime)));
        
        const currentPlayer = Object.values(this.players).filter(player => player.turnIndex === this.currentPlayerIndex)[0];
        if (currentPlayer && currentPlayer.ui) {
            const progressWidth = 180 * progress;

            currentPlayer.ui.progressFill.displayWidth = progressWidth;
            
            // Change color based on remaining time
            if (progress > 0.5) {
                currentPlayer.ui.progressFill.setFillStyle(0x00ff00); // Green
            } else if (progress > 0.25) {
                currentPlayer.ui.progressFill.setFillStyle(0xffff00); // Yellow
            } else {
                currentPlayer.ui.progressFill.setFillStyle(0xff0000); // Red
            }
        }
    }

    drawPlayerGrid(scene, centerX, centerY, playerName, gridSize, tileSize, color, placedGroup, userId) {
        const container = scene.add.container(); // Acts like a group
        const graphics = scene.add.graphics({ lineStyle: { width: 1, color: 0xffffff } });
        container.add(graphics);
    
        const gridWidth = gridSize * tileSize;
        const gridHeight = gridSize * tileSize;
        const startX = centerX - gridWidth / 2;
        const startY = centerY - gridHeight / 2;
    
        // Grid lines
        for (let row = 0; row <= gridSize; row++) {
            graphics.lineBetween(startX, startY + row * tileSize, startX + gridWidth, startY + row * tileSize);
        }
        for (let col = 0; col <= gridSize; col++) {
            graphics.lineBetween(startX + col * tileSize, startY, startX + col * tileSize, startY + gridHeight);
        }
    
        // Player name
        const nameText = scene.add.text(centerX, startY - 20, playerName, { fontSize: '16px', color: '#ffffff' }).setOrigin(0.5);
        container.add(nameText);
    
        // Castle
        const castleX = startX + 2 * tileSize + tileSize / 2;
        const castleY = startY + 2 * tileSize + tileSize / 2;
    
        const castleTile = scene.add.rectangle(castleX, castleY, tileSize, tileSize, color)
            .setStrokeStyle(2, 0xffffff)
            .setOrigin(0.5);
        const castleImage = scene.add.image(castleX, castleY, 'castle')
            .setOrigin(0.5)
            .setDisplaySize(tileSize, tileSize);
    
        container.add([castleTile, castleImage]);
    
        if (placedGroup) {
            placedGroup.add(castleTile);
        }
    
        return {
            container,
            graphics,
            nameText,
            castleTile,
            castleImage,
            gridSize,
            tileSize,
            centerX,
            centerY,
            playerName,
            color,
            placedGroup,
            userId
        };
    }
    
    createTestTiles(scene, tiles) {
        let keys = Object.keys(tiles);
        for (let i = 0; i < keys.length; i++) {
            let tileNumber = keys[i];
            let tile = scene.add.container(50 + (i%12)*205, 50 + Math.floor(i/12)*105); 
            let rectangle = scene.add.rectangle(0,0, 200, 100, 0x00ff00) // 1x2 vertical
                .setStrokeStyle(2, 0x000000)
                .setInteractive();
            let text = scene.add.text(0, 0, tileNumber, { fontSize: '18px', color: '#000000' }).setOrigin(0.5);
            let image = scene.add.image(0, 0, tiles[tileNumber].asset)
                .setOrigin(0.5);
            image.setScale(200 / image.width, 100 / image.height);
            tile.setData('data', tiles[tileNumber]);
            tile.add([rectangle, image, text]);
        }
    }

    createTileStack(scene, count) {
        for (let i = 0; i < count; i++) {
            let flippedTile = scene.add.container(450, 250 + i*1.5); 
            let rectangle = scene.add.rectangle(0,0, 200, 100, 0x00ff00) // 1x2 vertical
                .setStrokeStyle(2, 0x000000)
                .setInteractive();
            let image = scene.add.image(0, 0, 'background')
                .setOrigin(0.5);
            image.setScale(200 / image.width, 100 / image.height);
            flippedTile.add([rectangle, image]);
            scene.tileStack.add(flippedTile);
        }
        this.tilesLeftText = scene.add.text(450, 330, `Tiles left: ${count}`, { fontSize: '24px', color: '#ffffff' }).setOrigin(0.5);
    }

    drawTiles(scene, drawnTiles) {
        this.drawnTiles.length = 0; // Reset drawn tiles array
        drawnTiles.forEach((tileData, index) => {
            // Starting position (tile stack position - adjust these coordinates to match your stack)
            const startX = 450; // Adjust to your tile stack X position
            const startY = 250; // Adjust to your tile stack Y position
            
            // Final position
            const finalX = 700 + index * 205;
            const finalY = 250;
            
            // Remove the tile from the stack
            const lastTile = scene.tileStack.getLast();
            scene.tileStack.remove(lastTile, true, true); // Remove from scene and destroy
            this.tilesLeftText.text = `Tiles left: ${scene.tileStack.getLength()}`;

            // Create tile container at starting position
            const tile = scene.add.container(startX, startY);
            
            // Create tile elements
            const rectangle = scene.add.rectangle(0, 0, 200, 100, 0x00ff00)
                .setStrokeStyle(2, 0x000000)
                .setInteractive();
            
            const text = scene.add.text(0, 0, tileData.number, { fontSize: '24px', color: '#ffffff' })
                .setOrigin(0.5)
                .setAlpha(1);
            
            // Back of tile (shown initially)
            const backImage = scene.add.image(0, 0, 'background')
                .setOrigin(0.5);
            backImage.setScale(200 / backImage.width, 100 / backImage.height);
            
            // Front of tile (hidden initially)
            const frontImage = scene.add.image(0, 0, tileData.asset)
                .setOrigin(0.5)
                .setAlpha(0);
            frontImage.setScale(200 / frontImage.width, 100 / frontImage.height);
            
            // Set tile data
            tile.setData('data', tileData);
            console.log(index, ' tileData:', tileData);
            tile.setData('drawn-index', index);
            tile.add([rectangle, backImage, frontImage, text]);
            
            this.drawnTiles.push(tile);

            // Animation sequence
            const animationDelay = index * 300; // Stagger each tile by 200ms
            
            // 1. Move tile from stack to position
            scene.tweens.add({
                targets: tile,
                x: finalX,
                y: finalY,
                duration: 700,
                ease: 'Power2.easeOut',
                delay: animationDelay,
                onComplete: () => {
                    // 2. Wait a bit, then flip the tile
                    scene.time.delayedCall(1000, () => {
                        this.flipTile(scene, tile, backImage, frontImage, text, tileData);
                    });
                }
            });
        });
    }

    flipTile(scene, tile, backImage, frontImage, text, tileData) {
        // Flip animation - scale X to 0, switch images, scale back to 1
        scene.tweens.add({
            targets: [tile],
            scaleX: 0,
            duration: 200,
            ease: 'Power2.easeIn',
            onComplete: () => {
                // Switch from back to front at the middle of flip
                backImage.setAlpha(0);
                frontImage.setAlpha(1);
                text.setAlpha(0);
                
                // Scale back up
                scene.tweens.add({
                    targets: [tile],
                    scaleX: 1,
                    duration: 200,
                    ease: 'Power2.easeOut'
                });
            }
        });
    }

    placeOtherPlayersTile(userId, tile, row, col, rotation) {
        const player = this.players[userId];
        if (!player) return;
        
        let targetGrid = null;
        if (this.mainGrid && this.mainGrid.userId === userId) {
            targetGrid = this.mainGrid;
        } else if (this.secondGrid && this.secondGrid.userId === userId) {
            targetGrid = this.secondGrid;
        } else if (this.thirdGrid && this.thirdGrid.userId === userId) {
            targetGrid = this.thirdGrid;
        } else if (this.fourthGrid && this.fourthGrid.userId === userId) {
            targetGrid = this.fourthGrid;
        }
        if (!targetGrid) return;
        
        // Calculate position on the target grid
        const gridStartX = targetGrid.centerX - (targetGrid.gridSize * targetGrid.tileSize) / 2;
        const gridStartY = targetGrid.centerY - (targetGrid.gridSize * targetGrid.tileSize) / 2;
        
        const offset = this.tilePlacementSystem.getCenterOffset(rotation || 0);
        const centerX = gridStartX + (col + offset.x) * targetGrid.tileSize;
        const centerY = gridStartY + (row + offset.y) * targetGrid.tileSize;

        tile.setPosition(centerX, centerY);

        const isRotated = rotation === 90 || rotation === 270;
        // Get the original tile dimensions (assuming they were created with a standard size)
        const originalTileWidth = isRotated ? this.mainGrid.tileSize : this.mainGrid.tileSize * 2;
        const originalTileHeight = isRotated ? this.mainGrid.tileSize * 2 : this.mainGrid.tileSize;
        
        // Calculate new dimensions for target grid
        const newTileWidth = isRotated ? targetGrid.tileSize : targetGrid.tileSize * 2;
        const newTileHeight = isRotated ? targetGrid.tileSize * 2 : targetGrid.tileSize;
        
        // Calculate scale factors
        const scaleX = newTileWidth / originalTileWidth;
        const scaleY = newTileHeight / originalTileHeight;
        
        // Apply scaling
        tile.setScale(scaleX, scaleY);

        targetGrid.placedGroup.add(tile);

        this.tilePlacementSystem.lockTileInPlace(tile);
    }

    getColorName(color) {
        switch (color) {
            case 0xff0000: return 'red';
            case 0x00ff00: return 'green';
            case 0x0000ff: return 'blue';
            case 0xffff00: return 'yellow';
            default: return 'unknown';
        }
    }
    
    update() {
        // Update turn progress bar
        this.updateTurnProgress();
    }
    
    create() {
        socket.emit("kingdomino-create-start");
    
        const gameBoard = document.getElementById('game-board');
    
        const loadingLabel = document.getElementById("loading-label");
    
        this.backgroundRect = this.add.rectangle(
            0,
            0,
            this.scale.width,
            this.scale.height
        )
        .setOrigin(0)
        .setStrokeStyle(1, 0xffffff);
    
        this.add.text(150, 5, 'Kingdomino', { fontSize: '32px', color: '#ffffff' });
    
        this.placedTiles = this.add.group();
        this.placedTiles2ndGrid = this.add.group();
        this.placedTiles3rdGrid = this.add.group();
        this.placedTiles4thGrid = this.add.group();

        this.tileStack = this.add.group();
        this.placedPawns = this.add.group();

        this.previewHighlight = this.add.rectangle(0, 0, 200, 100, 0x00ff00, 0.3).setVisible(false).setDepth(0);
        this.previewTile = this.add.container(0,0).setVisible(false);

        // Socket event listeners
        socket.on("kingdomino-game-start", (gameData) => {
            gameBoard.removeChild(loadingLabel);
            
            // Initialize players from server data
            this.players = gameData.players;

            this.myUserId = localStorage.getItem('userId');
            this.myData = this.players[this.myUserId];
            this.myColorName = this.getColorName(this.myData.color);

            // Player grid
            this.mainGrid = this.drawPlayerGrid(this, this.scale.width/2, this.scale.height-300, this.myData.name, 5, 100, this.myData.color, this.placedTiles, this.myUserId);
        
            // Other players (no interactivity needed)
            const playerKeys = Object.keys(this.players);
            playerKeys.splice(playerKeys.indexOf(this.myUserId), 1); // Remove current player from the list
            const playerSize = playerKeys.length;
            if (playerSize > 0) {
                const userId = playerKeys[0];
                const player = this.players[userId];
                this.secondGrid = this.drawPlayerGrid(this, this.scale.width/2, 110, player.name, 5, 30, player.color, this.placedTiles2ndGrid, userId);
            }
            if (playerSize > 1) {
                const userId = playerKeys[1];
                const player = this.players[userId];
                this.thirdGrid = this.drawPlayerGrid(this, 180, this.scale.height/2, player.name, 5, 30, player.color, this.placedTiles3rdGrid, userId);
            }
            if (playerSize > 2) {
                const userId = playerKeys[2];
                const player = this.players[userId];
                this.fourthGrid = this.drawPlayerGrid(this, this.scale.width-180, this.scale.height/2, player.name, 5, 30, player.color, this.placedTiles4thGrid, userId);
            }

            this.titleEffect = new TitleEffect(this);
            const iconKey = 'pawn-' + this.myColorName;
            const targetX = 0;
            const targetY = this.scale.height;
            this.showTitleEffect('You are ' + this.myColorName, iconKey, targetX, targetY, {
                fontSize: '42px',
                animationDuration: 400,
                displayDuration: 1000,
                fadeOutDuration: 400
            });
            
            this.currentPlayerIndex = gameData.currentPlayerIndex;
            this.turnStartTime = gameData.turnStartTime;
            
            this.tilePlacementSystem = new TilePlacementSystem(this, this.mainGrid);
            this.createTileStack(this, gameData.tileCount);
            this.createPlayerList();
        });

        socket.on("kingdomino-draw-tiles", (drawnTiles) => {
            this.drawTiles(this, drawnTiles);
        });
        
        socket.on("kingdomino-players-update", (playersData) => {
            this.players = playersData;
            if (this.playerListContainer) {
                this.playerListContainer.destroy();
                this.createPlayerList();
            }
        });
        
        socket.on('kingdomino-turn-info', (turnIndex, turnStartTime, turnEndTime) => {
            this.currentPlayerIndex = turnIndex;
            this.currentTurnStartTime = turnStartTime;
            this.currentTurnEndTime = turnEndTime;
            this.updatePlayerListHighlight();

            if (this.isMyTurn()) {
                if (this.turnCount !== 0) {
                    this.showTitleEffect('Your turn', 'pawn-' + this.myColorName, this.scale.width / 2, this.scale.height / 2, {
                        fontSize: '32px',
                        animationDuration: 400,
                        displayDuration: 1000,
                        fadeOutDuration: 400
                    });
                }

                if (this.isTileSelecting) {
                    this.drawnTiles.forEach(tile => {
                        //add delays
                        this.tilePlacementSystem.makeTileSelectable(tile, !tile.getData('isSelected'));
                    });
                } else {
                    this.drawnTiles.filter(tile => tile.getData('data').number === this.myData.selectedTile).forEach(tile => {
                        this.tilePlacementSystem.makeTileDraggable(tile, true);
                    });
                }
            } else {
                if (this.isTileSelecting) {
                    this.drawnTiles.forEach(tile => {
                        this.tilePlacementSystem.makeTileSelectable(tile, false);
                    });
                } else {
                    /*this.drawnTiles.forEach(tile => {
                        this.tilePlacementSystem.makeTileDraggable(tile, false);
                    });*/
                }
            }

            this.turnCount++;
        });
        
        socket.on("kingdomino-tile-selected", (userId, tileNumber, drawnIndex) => {
            
            this.players[userId].selectedTile = tileNumber;

            const tile = this.drawnTiles.find(t => t.getData('data').number === tileNumber);
            if (!tile) return;
            tile.setData('isSelected', true);
            tile.setData('selectedBy', userId);

            const pawn = this.add.image(700 + drawnIndex * 205, 300, 'pawn-' + this.getColorName(this.players[userId].color));
            pawn.setDisplaySize(50,50);
            pawn.setData('tileNumber', tileNumber);
            this.placedPawns.add(pawn);

            console.log(`Tile ${tileNumber} selected by ${this.players[userId].name}`);
        });

        socket.on("kingdomino-tile-placed", (userId, tileNumber, row, col, rotation) => {
            
            this.drawnTiles.filter(tile => tile.getData('data').number === tileNumber).forEach(tile => {
                if (userId !== this.myUserId) {
                    this.placeOtherPlayersTile(userId, tile, row, col, rotation);
                } else if (!tile.getData('placed')) {
                    this.tilePlacementSystem.placeTileOnGrid(tile, row, col);
                }
                //tile.destroy();  
                this.drawnTiles.splice(this.drawnTiles.indexOf(tile), 1);
            });

            this.placedPawns.getChildren().forEach(pawn => {
                if (pawn.getData('tileNumber') === tileNumber) {
                    this.placedPawns.remove(pawn, true, true);
                }
            });
        });

        socket.on("kingdomino-tile-selection-end", () => {
            this.isTileSelecting = false;
            /*this.showTitleEffect('Tile selection ended', null, this.scale.width / 2, this.scale.height / 2, {
                fontSize: '32px',
                animationDuration: 400,
                displayDuration: 1000,
                fadeOutDuration: 400
            });*/
            showToast('Tile selection ended.');
        });

        socket.on("kingdomino-tile-selection-start", () => {
            this.isTileSelecting = true;
            /*this.showTitleEffect('Tile selection started', null, this.scale.width / 2, this.scale.height / 2, {
                fontSize: '32px',
                animationDuration: 400,
                displayDuration: 1000,
                fadeOutDuration: 400
            });*/
            showToast('Tile selection started.');
        });

        socket.on("kingdomino-game-end", (scores) => {
            this.showTitleEffect('Game ended!', null, this.scale.width / 2, this.scale.height / 2, {
                fontSize: '32px',
                animationDuration: 400,
                displayDuration: 1000,
                fadeOutDuration: 400
            });
            showToast('Game ended.');
        });

        socket.emit("kingdomino-create-finish");
    }
    
    resize(width, height) {
        this.backgroundRect.setSize(width, height);
        
        // Reposition player list
        if (this.playerListContainer) {
            this.playerListContainer.setPosition(20, height - 20);
        }

        
    }
}

const config = {
    type: Phaser.AUTO,
    scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: 1920,
        height: 1080,
        parent: 'game-board',
    },
    transparent: true,
    scene: KingdominoScene
};

const game = new Phaser.Game(config);

const onChangeScreen = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    console.log('Screen changed:', width, height);
    
    // Use refresh() for FIT mode - it handles everything automatically
    game.scale.refresh();
    
    // Optional: Force a small delay to ensure DOM has updated
    setTimeout(() => {
        game.scale.refresh();
    }, 10);
};

// Handle window resize (browser resize, dev tools, etc.)
window.addEventListener('resize', onChangeScreen);

// Handle orientation change (mobile devices)
if (screen.orientation) {
    screen.orientation.addEventListener('change', onChangeScreen);
} else if (screen.mozOrientation) {
    screen.addEventListener('mozorientationchange', onChangeScreen);
} else if (screen.msOrientation) {
    screen.addEventListener('msorientationchange', onChangeScreen);
}

// Optional: Handle visibility change to ensure proper scaling when tab becomes visible
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        // Small delay to ensure page is fully visible
        setTimeout(onChangeScreen, 100);
    }
});

// Optional: Force initial scale check after a short delay
setTimeout(() => {
    onChangeScreen();
}, 100);