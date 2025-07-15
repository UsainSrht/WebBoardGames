class TilePlacementSystem {
    constructor(scene, playerGrid) {
        this.scene = scene;
        this.playerGrid = playerGrid;
        this.draggedTile = null;
        this.originalPosition = { x: 0, y: 0 };
        this.currentPosition = { x: -1, y: -1 };
        
        // Grid properties
        this.gridSize = playerGrid.gridSize;
        this.tileSize = playerGrid.tileSize;
        this.gridStartX = playerGrid.centerX - (this.gridSize * this.tileSize) / 2;
        this.gridStartY = playerGrid.centerY - (this.gridSize * this.tileSize) / 2;
        
        this.gridOccupancy = this.initializeGridOccupancy();
    }
    
    initializeGridOccupancy() {
        // Create a grid to track occupied spaces
        const grid = [];
        for (let row = 0; row < this.gridSize; row++) {
            grid[row] = [];
            for (let col = 0; col < this.gridSize; col++) {
                grid[row][col] = null;
            }
        }
        // Mark castle position as occupied
        const castleRow = Math.floor(this.gridSize / 2);
        const castleCol = Math.floor(this.gridSize / 2);
        grid[castleRow][castleCol] = 'castle'; // Mark castle position
        return grid;
    }
    
    makeTileDraggable(tile, draggable) {
        console.log('makeTileDraggable', tile.getData('data').number, draggable);
        const rectangle = tile.list[0]; // The rectangle is the first child
        
        if (draggable) {

            rectangle.setInteractive({ cursor: 'grab' });

            rectangle.on('pointerdown', (pointer, localX, localY, event) => {
                this.startDragging(tile, pointer);
                event.stopPropagation();
            });
            
            rectangle.on('pointerup', (pointer, localX, localY, event) => {
                this.stopDragging(tile, pointer);
                event.stopPropagation();
            });
            
            rectangle.on('pointermove', (pointer, localX, localY, event) => {
                if (this.draggedTile === tile) {
                    this.updateDraggedTile(tile, pointer);
                }
            });

        } else {
            rectangle.disableInteractive();

            rectangle.off('pointerdown');
            rectangle.off('pointerup');
            rectangle.off('pointermove');
        }
    }

    makeTileSelectable(tile, selectable) {
        console.log('makeTileSelectable', tile.getData('data').number, selectable);
        const rectangle = tile.list[0]; // The rectangle is the first child

        if (selectable) {
            rectangle.setInteractive({ cursor: 'pointer' });
            
            rectangle.on('pointerdown', (pointer, localX, localY, event) => {
                this.selectTile(tile);
                event.stopPropagation();
            });

            //todo make hover look good
            // Hover enter - add glow effect
            rectangle.on('pointerover', () => {
                // Add a subtle glow by changing fill and stroke
                rectangle.setFillStyle(Phaser.Display.Color.Interpolate.ColorWithColor(
                    Phaser.Display.Color.ValueToColor(this.scene.myData.color),
                    Phaser.Display.Color.ValueToColor(0xffffff),
                    100, 20
                ));
                
                // Add a brighter stroke for glow effect
                rectangle.setStrokeStyle(3, 0xffffff, 0.8);
            });

            // Hover exit - restore original appearance
            rectangle.on('pointerout', () => {
                rectangle.setFillStyle(this.scene.myData.color);
                rectangle.setStrokeStyle(rectangle.lineWidth, 0x342ddb, rectangle.strokeAlpha);
            });
        } else {
            rectangle.disableInteractive();

            //remove listeners
            rectangle.off('pointerdown');
            rectangle.off('pointerover');
            rectangle.off('pointerout');
        }
    }

    selectTile(tile) {

        if (!this.scene.isMyTurn() || !this.scene.isTileSelecting) {
            return;
        }

        // Check if tile is already selected
        if (tile.getData('isSelected')) {
            return;
        }
        
        // Mark tile as selected
        tile.setData('isSelected', true);
        tile.setData('selectedBy', this.scene.myUserId);
        
        // Visual feedback for selection
        const rectangle = tile.list[0];
        rectangle.setStrokeStyle(4, 0xff0000); // Red border for selected
        
        // Disable interaction for this tile
        this.makeTileSelectable(tile, false);
        
        socket.emit('kingdomino-select-tile', tile.getData('data').number, tile.getData('drawn-index'));
    }
    
    startDragging(tile, pointer) {
        if (this.draggedTile !== null) return; // Already dragging something

        if (!this.scene.isMyTurn() || this.scene.isTileSelecting) {
            return
        }
        
        this.draggedTile = tile;
        this.originalPosition = { x: tile.x, y: tile.y };
        
        // Bring tile to front
        tile.setDepth(1000);
        
        // Change appearance to show it's being dragged
        const rectangle = tile.list[0];
        rectangle.setStrokeStyle(3, 0xffff00); // Yellow highlight
        
        // Enable rotation on right click or specific key
        this.scene.input.keyboard.on('keydown-R', () => {
            if (this.draggedTile === tile) {
                this.rotateTile(tile);
            }
        });
        
        console.log('Started dragging tile:', tile.getData('data').number);
    }
    
    rotateTile(tile) {
        // Rotate 90 degrees
        const degToRadian = Math.PI / 180;
        const currentDegree = tile.getData('rotation') || 0;
        const newDegree = (currentDegree + 90) % 360;
        tile.setData('rotation', newDegree);
        tile.setRotation(newDegree * degToRadian);
    }
    
    updateDraggedTile(tile, pointer) {
        // Update tile position to follow pointer
        tile.setPosition(pointer.worldX, pointer.worldY);
        
        // Check for valid placement and provide visual feedback
        const gridPos = this.getGridPosition(pointer.worldX, pointer.worldY);
        if (!gridPos) {
            this.invalidPlacement(tile);
            return;
        }

        if (gridPos.row === this.currentPosition.x && gridPos.col === this.currentPosition.y) {
            return; // No change in position, skip further checks
        }
        this.currentPosition = { x: gridPos.row, y: gridPos.col };

        if (this.isValidPlacement(gridPos.row, gridPos.col, tile)) {
            // Show valid placement (green tint)
            const rectangle = tile.list[0];
            rectangle.setStrokeStyle(3, 0x00ff00);
            const offset = this.getCenterOffset(tile);
            this.scene.previewHighlight.setVisible(true).setPosition(
                this.gridStartX + (gridPos.col + offset.x) * this.tileSize,
                this.gridStartY + (gridPos.row + offset.y) * this.tileSize
            ).setRotation(tile.rotation);
        } else {
            this.invalidPlacement(tile);
        }
    }

    invalidPlacement(tile) {
        // Show invalid placement (red tint)
        const rectangle = tile.list[0];
        rectangle.setStrokeStyle(3, 0xff0000);
        this.scene.previewHighlight.setVisible(false);
    }
    
    stopDragging(tile, pointer) {
        if (this.draggedTile !== tile) return;
        
        const gridPos = this.getGridPosition(pointer.worldX, pointer.worldY);
        
        if (gridPos && this.isValidPlacement(gridPos.row, gridPos.col, tile)) {
            // Valid placement - snap to grid
            this.placeTileOnGrid(tile, gridPos.row, gridPos.col);
        } else {
            // Invalid placement - return to original position
            this.returnTileToOriginalPosition(tile);
        }
        
        this.draggedTile = null;
        this.currentPosition = { x: -1, y: -1 };
        
        // Remove keyboard listener
        this.scene.input.keyboard.off('keydown-R');

        this.scene.previewHighlight.setVisible(false);
    }
    
    getGridPosition(worldX, worldY) {
        // Convert world coordinates to grid coordinates
        const localX = worldX - this.gridStartX;
        const localY = worldY - this.gridStartY;
        
        if (localX < 0 || localY < 0 || 
            localX >= this.gridSize * this.tileSize || 
            localY >= this.gridSize * this.tileSize) {
            return null; // Outside grid
        }
        
        const col = Math.floor(localX / this.tileSize);
        const row = Math.floor(localY / this.tileSize);
        
        return { row, col };
    }

    getSize(tile) {
        // Determine the size of the tile based on its rotation
        // sizes here are the number that should be added to the current grild position to check if its outside.
        const rotation = tile.getData('rotation') || 0;
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
    
    isValidPlacement(row, col, tile) {
        const size = this.getSize(tile);
        return this.canPlaceTile(row, col, size.width, size.height);
    }
    
    canPlaceTile(startRow, startCol, width, height) {
        console.log('canPlaceTile', startRow, startCol, width, height);

        // Check if all required cells are available
        if (startRow + height > this.gridSize-1 || startCol + width > this.gridSize-1 ||
            startRow + height < 0 || startCol + width < 0
        ) {
            console.log('Tile placement would go outside the grid');
            return false; // Would go outside grid
        }
        
        if (this.gridOccupancy[startRow][startCol] !== null || 
            this.gridOccupancy[startRow + height][startCol + width] !== null
        ) {
            console.log('Tile placement overlaps with occupied space');
            return false; // occupied space
        }

        console.log('Tile placement is valid');
        return true;
    }

    getCenterOffset(tile) {
        // Calculate the center offset based on tile rotation
        const rotation = tile.getData('rotation') || 0;
        if (rotation === 0) {
            return { x: 1, y: 0.5 };
        } else if (rotation === 90) {
            return { x: 0.5, y: 1 };
        } else if (rotation === 180) {
            return { x: 0, y: 0.5 };
        } else if (rotation === 270) {
            return { x: 0.5, y: 0 };
        } else {
            return null;
        }
    }
    
    placeTileOnGrid(tile, row, col) {

        const tileNumber = tile.getData('data').number;
        const rotation = tile.getData('rotation') || 0;
        if (rotation === 0) {
            this.gridOccupancy[row][col + 1] = tileNumber;
        } else if (rotation === 90) {
            this.gridOccupancy[row + 1][col] = tileNumber;
        } else if (rotation === 180) {
            this.gridOccupancy[row][col - 1] = tileNumber;
        } else if (rotation === 270) {
            this.gridOccupancy[row - 1][col] = tileNumber;
        } else {
            console.error('Invalid tile rotation:', rotation);
        }
        this.gridOccupancy[row][col] = tileNumber;

        const offset = this.getCenterOffset(tile);
        const centerX = this.gridStartX + (col + offset.x) * this.tileSize;
        const centerY = this.gridStartY + (row + offset.y) * this.tileSize;
        tile.setPosition(centerX, centerY);

        this.scene.placedTiles.add(tile);
        
        // Lock the tile in place
        this.lockTileInPlace(tile);

        socket.emit('kingdomino-place-tile', tile.getData('data').number, row, col, rotation);
    }
    
    lockTileInPlace(tile) {
        
        // Remove interactivity
        const rectangle = tile.list[0];
        rectangle.removeInteractive();
        
        // Change appearance to show it's locked
        rectangle.setStrokeStyle(2, 0x888888); // Gray stroke
        rectangle.setAlpha(0.8); // Slightly transparent
        
        // Reset depth
        tile.setDepth(0);
        
        // Store placement data
        tile.setData('placed', true);

        this.scene.previewHighlight.setVisible(false);
    }
    
    returnTileToOriginalPosition(tile) {
        // Return tile to its original position
        tile.setPosition(this.originalPosition.x, this.originalPosition.y);
        
        // Reset rotation
        tile.setRotation(0);
        tile.setData('rotation', 0);
        
        // Reset appearance
        //const rectangle = tile.list[0];
        //rectangle.setSize(200, 100); // Original size
        //rectangle.setStrokeStyle(2, 0x000000); // Original stroke
        
        // Reset depth
        tile.setDepth(0);
        
        console.log('Returned tile to original position');
    }
    
    // Utility method to check current grid state
    printGridOccupancy() {
        console.log('Grid Occupancy:');
        for (let row = 0; row < this.gridSize; row++) {
            console.log(this.gridOccupancy[row]);
        }
    }
}

export default TilePlacementSystem;