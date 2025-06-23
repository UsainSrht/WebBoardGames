class TilePlacementSystem {
    constructor(scene, playerGrid) {
        this.scene = scene;
        this.playerGrid = playerGrid;
        this.draggedTile = null;
        this.originalPosition = { x: 0, y: 0 };
        this.isRotated = false;
        this.gridOccupancy = this.initializeGridOccupancy();
        
        // Grid properties
        this.gridSize = playerGrid.gridSize;
        this.tileSize = playerGrid.tileSize;
        this.gridStartX = playerGrid.centerX - (this.gridSize * this.tileSize) / 2;
        this.gridStartY = playerGrid.centerY - (this.gridSize * this.tileSize) / 2;
        
        this.setupTileInteractions();
    }
    
    initializeGridOccupancy() {
        // Create a 5x5 grid to track occupied spaces
        const grid = [];
        for (let row = 0; row < this.gridSize; row++) {
            grid[row] = [];
            for (let col = 0; col < this.gridSize; col++) {
                // Mark castle position as occupied (center of 5x5 grid)
                grid[row][col] = (row === 2 && col === 2) ? 'castle' : null;
            }
        }
        return grid;
    }
    
    setupTileInteractions() {
        // Set up interactions for all free tiles
        this.scene.freeTiles.children.entries.forEach(tile => {
            this.makeTileInteractive(tile);
        });
    }
    
    makeTileInteractive(tile) {
        const rectangle = tile.list[0]; // The rectangle is the first child
        
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
    }
    
    startDragging(tile, pointer) {
        if (this.draggedTile !== null) return; // Already dragging something
        
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
        
        console.log('Started dragging tile:', tile.getData('number'));
    }
    
    rotateTile(tile) {
        const rectangle = tile.list[0];
        const image = tile.list[1];
        
        // Rotate 90 degrees
        tile.setRotation(tile.rotation + Math.PI / 2);
        this.isRotated = !this.isRotated;
        
        // Update the visual representation
        if (this.isRotated) {
            // 1x2 becomes 2x1 when rotated
            rectangle.setSize(100, 200);
        } else {
            // Back to 1x2
            rectangle.setSize(200, 100);
        }
        
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
            // 2x1 tile (horizontal)
            return this.canPlaceTile(row, col, 1, 2);
        } else {
            // 1x2 tile (vertical)
            return this.canPlaceTile(row, col, 2, 1);
        }
    }
    
    canPlaceTile(startRow, startCol, height, width) {
        // Check if all required cells are available
        if (startRow + height > this.gridSize || startCol + width > this.gridSize) {
            return false; // Would go outside grid
        }
        
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
        
        if (this.isRotated) {
            // 2x1 tile (horizontal)
            centerX = this.gridStartX + (col + 1) * this.tileSize;
            centerY = this.gridStartY + (row + 0.5) * this.tileSize;
            
            // Mark grid cells as occupied
            this.gridOccupancy[row][col] = tile.getData('number');
            this.gridOccupancy[row][col + 1] = tile.getData('number');
        } else {
            // 1x2 tile (vertical)
            centerX = this.gridStartX + (col + 0.5) * this.tileSize;
            centerY = this.gridStartY + (row + 1) * this.tileSize;
            
            // Mark grid cells as occupied
            this.gridOccupancy[row][col] = tile.getData('number');
            this.gridOccupancy[row + 1][col] = tile.getData('number');
        }
        
        // Snap tile to grid position
        tile.setPosition(centerX, centerY);
        
        // Scale tile to fit grid
        const rectangle = tile.list[0];
        const image = tile.list[1];
        
        if (this.isRotated) {
            rectangle.setSize(this.tileSize * 2, this.tileSize);
            image.setDisplaySize(this.tileSize * 2, this.tileSize);
        } else {
            rectangle.setSize(this.tileSize, this.tileSize * 2);
            image.setDisplaySize(this.tileSize, this.tileSize * 2);
        }
        
        // Lock the tile in place
        this.lockTileInPlace(tile);
        
        console.log(`Placed tile ${tile.getData('number')} at grid position (${row}, ${col})`);
    }
    
    lockTileInPlace(tile) {
        // Remove from free tiles group
        this.scene.freeTiles.remove(tile);
        
        // Add to placed tiles group (you might want to create this group)
        if (!this.scene.placedTiles) {
            this.scene.placedTiles = this.scene.add.group();
        }
        this.scene.placedTiles.add(tile);
        
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
        tile.setData('gridRow', this.getGridPosition(tile.x, tile.y).row);
        tile.setData('gridCol', this.getGridPosition(tile.x, tile.y).col);
        tile.setData('isRotated', this.isRotated);
    }
    
    returnTileToOriginalPosition(tile) {
        // Return tile to its original position
        tile.setPosition(this.originalPosition.x, this.originalPosition.y);
        
        // Reset rotation
        tile.setRotation(0);
        this.isRotated = false;
        
        // Reset appearance
        const rectangle = tile.list[0];
        rectangle.setSize(200, 100); // Original size
        rectangle.setStrokeStyle(2, 0x000000); // Original stroke
        
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
            tile => tile.getData('number') === tileNumber
        );
        
        if (placedTile) {
            const row = placedTile.getData('gridRow');
            const col = placedTile.getData('gridCol');
            const isRotated = placedTile.getData('isRotated');
            
            // Clear grid occupancy
            if (isRotated) {
                this.gridOccupancy[row][col] = null;
                this.gridOccupancy[row][col + 1] = null;
            } else {
                this.gridOccupancy[row][col] = null;
                this.gridOccupancy[row + 1][col] = null;
            }
            
            // Remove tile
            placedTile.destroy();
            
            console.log(`Removed tile ${tileNumber} from grid`);
        }
    }
}

export default TilePlacementSystem;