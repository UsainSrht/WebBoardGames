class TilePlacementSystem {
    constructor(scene, playerGrid) {
        this.scene = scene;
        this.playerGrid = playerGrid;
        this.draggedTile = null;
        this.originalPosition = { x: 0, y: 0 };
        this.isRotated = false;
        
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
        this.isRotated = false;
        
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
        //const rectangle = tile.list[0];
        //const image = tile.list[1];
        
        // Rotate 90 degrees
        const radian90deg = Math.PI / 2;
        tile.setRotation(tile.rotation === radian90deg ? 0 : radian90deg);
        this.isRotated = !this.isRotated;
        
        /*// Update the visual representation
        if (this.isRotated) {
            // 2x1 becomes 1x2 when rotated
            rectangle.setSize(200, 100);
        } else {
            // Back to 2x1
            rectangle.setSize(100, 200);
        }*/
        
        console.log('Rotated tile, isRotated:', this.isRotated);
    }
    
    updateDraggedTile(tile, pointer) {
        // Update tile position to follow pointer
        tile.setPosition(pointer.worldX, pointer.worldY);
        
        // Check for valid placement and provide visual feedback
        const gridPos = this.getGridPosition(pointer.worldX, pointer.worldY);
        if (gridPos && this.isValidPlacement(gridPos.row, gridPos.col)) {
            // Show valid placement (green tint)
            const rectangle = tile.list[0];
            rectangle.setStrokeStyle(3, 0x00ff00);
        } else {
            // Show invalid placement (red tint)
            const rectangle = tile.list[0];
            rectangle.setStrokeStyle(3, 0xff0000);
        }
    }
    
    stopDragging(tile, pointer) {
        if (this.draggedTile !== tile) return;
        
        const gridPos = this.getGridPosition(pointer.worldX, pointer.worldY);
        
        if (gridPos && this.isValidPlacement(gridPos.row, gridPos.col)) {
            // Valid placement - snap to grid
            this.placeTileOnGrid(tile, gridPos.row, gridPos.col);
        } else {
            // Invalid placement - return to original position
            this.returnTileToOriginalPosition(tile);
        }
        
        this.draggedTile = null;
        
        // Remove keyboard listener
        this.scene.input.keyboard.off('keydown-R');
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
    
    isValidPlacement(row, col) {
        // Check if the tile can be placed at this position
        if (this.isRotated) {
            // 1x2 tile (vertical)
            return this.canPlaceTile(row, col, 2, 1);
        } else {
            // 2x1 tile (horizontal)
            return this.canPlaceTile(row, col, 1, 2);
        }
    }
    
    canPlaceTile(startRow, startCol, height, width) {
        // Check if all required cells are available
        if (startRow + height > this.gridSize || startCol + width > this.gridSize) {
            return false; // Would go outside grid
        }
        console.log(`Checking placement at (${startRow}, ${startCol}) for size ${height}x${width}`);
        
        for (let row = startRow; row < startRow + height; row++) {
            for (let col = startCol; col < startCol + width; col++) {
                if (this.gridOccupancy[row][col] !== null) {
                    return false; // Cell is occupied
                }
            }
        }
        
        return true;
    }
    
    placeTileOnGrid(tile, row, col) {
        // Calculate the center position of the tile on the grid
        let centerX, centerY;
        
        const tileNumber = tile.getData('data').number;
        if (this.isRotated) {
            // 1x2 tile (vertical)
            centerX = this.gridStartX + (col + 0.5) * this.tileSize;
            centerY = this.gridStartY + (row + 1) * this.tileSize;
            
            // Mark grid cells as occupied
            this.gridOccupancy[row][col] = tileNumber;
            this.gridOccupancy[row + 1][col] = tileNumber;
        } else {
            // 2x1 tile (horizontal)
            centerX = this.gridStartX + (col + 1) * this.tileSize;
            centerY = this.gridStartY + (row + 0.5) * this.tileSize;
            
            // Mark grid cells as occupied
            this.gridOccupancy[row][col] = tileNumber;
            this.gridOccupancy[row][col + 1] = tileNumber;
        }
        
        // Snap tile to grid position
        tile.setPosition(centerX, centerY);
        
        // Scale tile to fit grid
        //const rectangle = tile.list[0];
        //const image = tile.list[1];
        
        /*if (this.isRotated) {
            rectangle.setSize(this.tileSize, this.tileSize * 2);
            image.setDisplaySize(this.tileSize, this.tileSize * 2);
        } else {
            rectangle.setSize(this.tileSize * 2, this.tileSize);
            image.setDisplaySize(this.tileSize * 2, this.tileSize);
        }*/

        this.scene.placedTiles.add(tile);
        
        // Lock the tile in place
        this.lockTileInPlace(tile);

        socket.emit('kingdomino-place-tile', tile.getData('data').number, row, col, this.isRotated);
        
        console.log(`Placed tile ${tile.getData('data').number} at grid position (${row}, ${col})`);
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
        tile.setData('isRotated', this.isRotated);
    }
    
    returnTileToOriginalPosition(tile) {
        // Return tile to its original position
        tile.setPosition(this.originalPosition.x, this.originalPosition.y);
        
        // Reset rotation
        tile.setRotation(0);
        this.isRotated = false;
        
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
    
    // Method to remove a placed tile (for debugging or game mechanics)
    removePlacedTile(tileNumber) {
        const placedTile = this.scene.placedTiles.children.entries.find(
            tile => tile.getData('data').number === tileNumber
        );
        
        if (placedTile) {
            const row = placedTile.getData('gridRow');
            const col = placedTile.getData('gridCol');
            const isRotated = placedTile.getData('isRotated');
            
            // Clear grid occupancy
            if (isRotated) {
                this.gridOccupancy[row][col] = null;
                this.gridOccupancy[row + 1][col] = null;
            } else {
                this.gridOccupancy[row][col] = null;
                this.gridOccupancy[row][col + 1] = null;
            }
            
            // Remove tile
            placedTile.destroy();
            
            console.log(`Removed tile ${tileNumber} from grid`);
        }
    }
}

export default TilePlacementSystem;