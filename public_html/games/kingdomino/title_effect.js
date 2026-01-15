class TitleEffect {
    constructor(scene) {
        this.scene = scene;
        this.activeEffects = [];
    }

    show(text, iconKey, targetX, targetY, options = {}) {
        const config = {
            fontSize: options.fontSize || '48px',
            fontFamily: options.fontFamily || 'Arial Black',
            fill: options.textColor || '#ffffff',
            stroke: options.strokeColor || '#000000',
            strokeThickness: options.strokeThickness || 4,
            iconScale: options.iconScale || 1,
            animationDuration: options.animationDuration || 2000,
            displayDuration: options.displayDuration || 1500,
            fadeOutDuration: options.fadeOutDuration || 1000,
            ...options
        };

        // Create container for the effect
        const container = this.scene.add.container(this.scene.cameras.main.centerX, this.scene.cameras.main.centerY);
        
        // Create icon
        const icon = this.scene.add.image(0, -40, iconKey);
        if (!iconKey) {
            icon.setVisible(false);
        }
        icon.setScale(config.iconScale);
        icon.setOrigin(0.5);
        
        // Create text
        const titleText = this.scene.add.text(0, 20, text, {
            fontSize: config.fontSize,
            fontFamily: config.fontFamily,
            fill: config.fill,
            stroke: config.stroke,
            strokeThickness: config.strokeThickness,
            align: 'center'
        });
        titleText.setOrigin(0.5);
        
        // Add to container
        container.add([icon, titleText]);
        
        // Initial state - hidden and scaled down
        container.setAlpha(0);
        container.setScale(0.1);
        
        // Store effect data
        const effect = {
            container: container,
            icon: icon,
            text: titleText,
            targetX: targetX,
            targetY: targetY
        };
        
        this.activeEffects.push(effect);
        
        // Animation sequence
        this.animateEffect(effect, config);
        
        return effect;
    }

    animateEffect(effect, config) {
        const { container, targetX, targetY } = effect;
        
        // Phase 1: Entrance animation
        this.scene.tweens.add({
            targets: container,
            alpha: 1,
            scaleX: 1,
            scaleY: 1,
            duration: config.animationDuration * 0.3,
            ease: 'Back.easeOut',
            onComplete: () => {
                // Phase 2: Bounce/pulse effect
                this.scene.tweens.add({
                    targets: container,
                    scaleX: 1.1,
                    scaleY: 1.1,
                    duration: 200,
                    yoyo: true,
                    repeat: 2,
                    ease: 'Sine.easeInOut',
                    onComplete: () => {
                        // Phase 3: Display duration
                        this.scene.time.delayedCall(config.displayDuration, () => {
                            // Phase 4: Move to target and fade out
                            this.scene.tweens.add({
                                targets: container,
                                x: targetX,
                                y: targetY,
                                alpha: 0,
                                scaleX: 0.5,
                                scaleY: 0.5,
                                duration: config.fadeOutDuration,
                                ease: 'Power2.easeInOut',
                                onComplete: () => {
                                    this.destroyEffect(effect);
                                }
                            });
                        });
                    }
                });
            }
        });

        // Icon rotation animation
        this.scene.tweens.add({
            targets: effect.icon,
            rotation: Math.PI * 2,
            duration: config.animationDuration,
            ease: 'Linear'
        });
    }

    destroyEffect(effect) {
        // Remove from active effects
        const index = this.activeEffects.indexOf(effect);
        if (index > -1) {
            this.activeEffects.splice(index, 1);
        }
        
        // Destroy the container and its children
        effect.container.destroy();
    }

    clearAllEffects() {
        this.activeEffects.forEach(effect => {
            effect.container.destroy();
        });
        this.activeEffects = [];
    }
}

export default TitleEffect;