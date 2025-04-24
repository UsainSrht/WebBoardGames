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