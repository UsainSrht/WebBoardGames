module.exports = (io, eventBus, room, roomData, players) => {
    console.log(`Initializing kingdomino for room: ${room}`);

    const colors = ["red", "blue", "green", "yellow"];
    const tiles = {
        1: { left: { type: "farm", crown: 0 }, right: { type: "farm", crown: 0 } },
        2: { left: { type: "farm", crown: 0 }, right: { type: "farm", crown: 0 } },
        3: { left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 } },
        4: { left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 } },
        5: { left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 } },
        6: { left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 } },
        7: { left: { type: "water", crown: 0 }, right: { type: "water", crown: 0 } },
        8: { left: { type: "water", crown: 0 }, right: { type: "water", crown: 0 } },
        9: { left: { type: "water", crown: 0 }, right: { type: "water", crown: 0 } },
        10: { left: { type: "plains", crown: 0 }, right: { type: "plains", crown: 0 } },
        11: { left: { type: "plains", crown: 0 }, right: { type: "plains", crown: 0 } },
        12: { left: { type: "wasteland", crown: 0 }, right: { type: "wasteland", crown: 0 } },
        13: { left: { type: "farm", crown: 0 }, right: { type: "forest", crown: 0 } },
        14: { left: { type: "farm", crown: 0 }, right: { type: "water", crown: 0 } },
        15: { left: { type: "farm", crown: 0 }, right: { type: "plains", crown: 0 } },
        16: { left: { type: "farm", crown: 0 }, right: { type: "wasteland", crown: 0 } },
        17: { left: { type: "forest", crown: 0 }, right: { type: "water", crown: 0 } },
        18: { left: { type: "forest", crown: 0 }, right: { type: "plains", crown: 0 } },
        19: { left: { type: "farm", crown: 1 }, right: { type: "forest", crown: 0 } },
        20: { left: { type: "farm", crown: 1 }, right: { type: "water", crown: 0 } },
        21: { left: { type: "farm", crown: 1 }, right: { type: "plains", crown: 0 } },
        22: { left: { type: "farm", crown: 1 }, right: { type: "wasteland", crown: 0 } },
        23: { left: { type: "farm", crown: 1 }, right: { type: "mine", crown: 0 } },
        24: { left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 } },
        25: { left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 } },
        26: { left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 } },
        27: { left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 } },
        28: { left: { type: "forest", crown: 1 }, right: { type: "water", crown: 0 } },
        29: { left: { type: "forest", crown: 1 }, right: { type: "plains", crown: 0 } },
        30: { left: { type: "water", crown: 1 }, right: { type: "farm", crown: 0 } },
        31: { left: { type: "water", crown: 1 }, right: { type: "farm", crown: 0 } },
        32: { left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 } },
        33: { left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 } },
        34: { left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 } },
        35: { left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 } },
        36: { left: { type: "farm", crown: 0 }, right: { type: "plains", crown: 1 } },
        37: { left: { type: "water", crown: 0 }, right: { type: "plains", crown: 1 } },
        38: { left: { type: "farm", crown: 0 }, right: { type: "wasteland", crown: 1 } },
        39: { left: { type: "plains", crown: 0 }, right: { type: "wasteland", crown: 1 } },
        40: { left: { type: "mine", crown: 1 }, right: { type: "farm", crown: 0 } },
        41: { left: { type: "farm", crown: 0 }, right: { type: "plains", crown: 2 } },
        42: { left: { type: "water", crown: 0 }, right: { type: "plains", crown: 2 } },
        43: { left: { type: "farm", crown: 0 }, right: { type: "wasteland", crown: 2 } },
        44: { left: { type: "plains", crown: 0 }, right: { type: "wasteland", crown: 2 } },
        45: { left: { type: "mine", crown: 2 }, right: { type: "farm", crown: 0 } },
        46: { left: { type: "wasteland", crown: 0 }, right: { type: "mine", crown: 2 } },
        47: { left: { type: "wasteland", crown: 0 }, right: { type: "mine", crown: 2 } },
        48: { left: { type: "farm", crown: 0 }, right: { type: "mine", crown: 3 } },
    };

    const config = {
        type: Phaser.AUTO,
        width: 800,
        height: 600,
        scene: {
            create: function () {
                const text = this.add.text(100, 100, 'Hello Phaser!', { fontSize: '32px', fill: '#fff' });
    
                text.setInteractive();
    
                text.on('pointerdown', () => {
                    text.setText('Clicked!');
                });
            }
        }
    };
    
    new Phaser.Game(config);

};