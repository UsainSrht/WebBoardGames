import TilePlacementSystem from './kingdomino/tile_system.js';

class KingdominoScene extends Phaser.Scene {
    constructor() {
        super({ key: 'KingdominoScene' });
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

    drawPlayerGrid(scene, centerX, centerY, playerName, gridSize, tileSize, placedGroup = null) {
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
    
        const castleTile = scene.add.rectangle(castleX, castleY, tileSize, tileSize, 0x8888ff)
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
            centerX,
            centerY,
            playerName
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
            tile.setData('number', tileNumber);
            tile.setData('data', tiles[tileNumber]);
            tile.add([rectangle, image, text]);
            //scene.add.existing(tile);
            scene.freeTiles.add(tile);
        }
    }
    
    update() {
        // game loop
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
    
        this.add.text(50, 5, 'Kingdomino', { fontSize: '32px', color: '#ffffff' });
    
        this.freeTiles = this.add.group();
        this.placedTiles = this.add.group();
    
        // Player grid
        this.mainGrid = this.drawPlayerGrid(this, config.width/2, config.height-300, 'YOU', 5, 100, this.placedTiles);

        this.previewHighlight = this.add.rectangle(0, 0, 200, 100, 0x00ff00, 0.3).setVisible(false).setDepth(0);
    
        // Other players (no interactivity needed)
        this.secondGrid = this.drawPlayerGrid(this, config.width/2, 110, 'Player 2', 5, 30);
        this.thirdGrid = this.drawPlayerGrid(this, 180, config.height/2, 'Player 3', 5, 30);
        this.fourthGrid = this.drawPlayerGrid(this, config.width-180, config.height/2, 'Player 4', 5, 30);
    
        socket.on("kingdomino-game-start", (tiles) => {
            gameBoard.removeChild(loadingLabel);
            this.createTestTiles(this, tiles);
        });
    
        this.tilePlacementSystem = new TilePlacementSystem(this, this.mainGrid);

        socket.emit("kingdomino-create-finish");
    }
    
    resize(width, height) {
        this.backgroundRect.setSize(width, height);
        this.mainGrid.setSize(width, height);
        this.secondGrid.setSize(width, height);
        this.thirdGrid.setSize(width, height);
        this.fourthGrid.setSize(width, height);
    }
}

const config = {
    type: Phaser.AUTO,
    width: window.innerWidth,
    height: window.innerHeight*0.95,
    scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH
    },
    transparent: true,
    parent: 'game-board',
    scene: KingdominoScene
};

const game = new Phaser.Game(config);

const onChangeScreen = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;

    game.scale.resize(width, height);

    game.scene.scenes.forEach(scene => {
        if (scene.scene.isActive() && scene.resize) {
            scene.resize(width, height);
        }
    });
};

const _orientation = screen.orientation || screen.mozOrientation || screen.msOrientation;
_orientation.addEventListener('change', () => {
    onChangeScreen();
});

window.addEventListener('resize', () => {
    onChangeScreen();
});