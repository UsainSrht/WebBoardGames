class HamsterballGame {
    constructor() {
        this.canvas = document.getElementById('canvas');
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.myPlayerId = null;
        this.players = {};
        this.playerMeshes = {};
        this.plate = null;
        this.plateGroup = null;
        this.keys = {};
        this.gameStarted = false;
        this.gameOver = false;
        this.spectator = WBG.isSpectator;
        this.touch = { x: 0, y: 0, boost: false };
        this.cleanups = [];
        this.raf = 0;
        this.lastVx = 0;
        this.lastVy = 0;
        
        this.init();
        this.setupEventListeners();
        this.connectToServer();
    }
    
    init() {
        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.Fog(0x0b1020, 500, 1100);
        
        // Fixed Isometric Camera
        this.camera = new THREE.OrthographicCamera(
            -400, 400,  // left, right
            400, -400,  // top, bottom
            0.1, 1000   // near, far
        );
        
        // Position camera for isometric view
        this.camera.position.set(300, 400, 300);
        this.camera.lookAt(0, 0, 0);
        
        // Renderer
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
        this.renderer.setClearColor(0x0b1020, 0);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        
        // Lighting - enhanced for better material visibility
        const ambientLight = new THREE.AmbientLight(0x404040, 0.4);
        this.scene.add(ambientLight);
        
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(200, 300, 200);
        directionalLight.castShadow = true;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        directionalLight.shadow.camera.near = 0.5;
        directionalLight.shadow.camera.far = 1000;
        directionalLight.shadow.camera.left = -300;
        directionalLight.shadow.camera.right = 300;
        directionalLight.shadow.camera.top = 300;
        directionalLight.shadow.camera.bottom = -300;
        this.scene.add(directionalLight);
        
        // Add additional point light for better sphere lighting
        const pointLight = new THREE.PointLight(0xffffff, 0.6, 500);
        pointLight.position.set(-200, 250, -200);
        this.scene.add(pointLight);
        
        // Add subtle fill light
        const fillLight = new THREE.DirectionalLight(0x87CEEB, 0.3);
        fillLight.position.set(-100, 200, 100);
        this.scene.add(fillLight);
        
        // Create plate
        this.createPlate();
        
        // Start render loop
        this.animate();
    }
    
    createPlate() {
        this.plateGroup = new THREE.Group();
        
        // Create wood texture for the plate
        const plateCanvas = document.createElement('canvas');
        const plateCtx = plateCanvas.getContext('2d');
        plateCanvas.width = 512;
        plateCanvas.height = 512;
        
        // Wood texture background
        const gradient = plateCtx.createRadialGradient(256, 256, 0, 256, 256, 256);
        gradient.addColorStop(0, '#D2691E');
        gradient.addColorStop(0.3, '#8B4513');
        gradient.addColorStop(0.7, '#A0522D');
        gradient.addColorStop(1, '#654321');
        
        plateCtx.fillStyle = gradient;
        plateCtx.fillRect(0, 0, 512, 512);
        
        // Add wood grain lines
        plateCtx.strokeStyle = 'rgba(101, 67, 33, 0.3)';
        plateCtx.lineWidth = 2;
        for (let i = 0; i < 20; i++) {
            plateCtx.beginPath();
            plateCtx.moveTo(0, i * 25 + Math.sin(i) * 10);
            plateCtx.lineTo(512, i * 25 + Math.sin(i + 1) * 10);
            plateCtx.stroke();
        }
        
        // Add circular rings for more wood texture
        plateCtx.strokeStyle = 'rgba(101, 67, 33, 0.2)';
        plateCtx.lineWidth = 1;
        for (let r = 50; r < 300; r += 30) {
            plateCtx.beginPath();
            plateCtx.arc(256, 256, r, 0, Math.PI * 2);
            plateCtx.stroke();
        }
        
        const plateTexture = new THREE.CanvasTexture(plateCanvas);
        plateTexture.wrapS = THREE.RepeatWrapping;
        plateTexture.wrapT = THREE.RepeatWrapping;
        
        // Main plate geometry with enhanced material
        const plateGeometry = new THREE.CylinderGeometry(200, 200, 20, 32);
        const plateMaterial = new THREE.MeshPhongMaterial({ 
            map: plateTexture,
            shininess: 30,
            specular: 0x222222
        });
        
        this.plate = new THREE.Mesh(plateGeometry, plateMaterial);
        this.plate.position.y = -10;
        this.plate.receiveShadow = true;
        this.plate.castShadow = true;
        this.plateGroup.add(this.plate);
        
        // Enhanced plate rim/edge with darker wood
        const rimGeometry = new THREE.TorusGeometry(200, 8, 12, 32);
        const rimMaterial = new THREE.MeshPhongMaterial({ 
            color: 0x3E2723,
            shininess: 60,
            specular: 0x444444
        });
        const rim = new THREE.Mesh(rimGeometry, rimMaterial);
        rim.position.y = 0;
        rim.rotation.x = Math.PI / 2; // lay the ring flat on the plate
        rim.castShadow = true;
        this.plateGroup.add(rim);
        
        // Add corner markers for better spatial reference
        const markerGeometry = new THREE.CylinderGeometry(3, 3, 2, 8);
        const markerMaterial = new THREE.MeshPhongMaterial({ color: 0x444444 });
        
        for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 2) {
            const marker = new THREE.Mesh(markerGeometry, markerMaterial);
            marker.position.x = Math.cos(angle) * 180;
            marker.position.z = Math.sin(angle) * 180;
            marker.position.y = 1;
            marker.castShadow = true;
            this.plateGroup.add(marker);
        }
        
        this.scene.add(this.plateGroup);
    }
    
    createPlayer(playerId, playerData) {
        // Create hamsterball (sphere in a transparent sphere)
        const ballGroup = new THREE.Group();
        
        // Create glass texture for outer shell
        const shellCanvas = document.createElement('canvas');
        const shellCtx = shellCanvas.getContext('2d');
        shellCanvas.width = 256;
        shellCanvas.height = 256;
        
        // Create subtle glass pattern
        const shellGradient = shellCtx.createRadialGradient(128, 128, 0, 128, 128, 128);
        shellGradient.addColorStop(0, 'rgba(255, 255, 255, 0.1)');
        shellGradient.addColorStop(0.7, 'rgba(255, 255, 255, 0.3)');
        shellGradient.addColorStop(1, 'rgba(255, 255, 255, 0.5)');
        
        shellCtx.fillStyle = shellGradient;
        shellCtx.fillRect(0, 0, 256, 256);
        
        // Add reflection highlights
        shellCtx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        shellCtx.beginPath();
        shellCtx.arc(180, 80, 30, 0, Math.PI * 2);
        shellCtx.fill();
        
        shellCtx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        shellCtx.beginPath();
        shellCtx.arc(100, 180, 20, 0, Math.PI * 2);
        shellCtx.fill();
        
        const shellTexture = new THREE.CanvasTexture(shellCanvas);
        
        // Outer transparent shell with better material
        const shellGeometry = new THREE.SphereGeometry(15, 20, 20);
        const shellMaterial = new THREE.MeshPhongMaterial({ 
            map: shellTexture,
            transparent: true, 
            opacity: 0.4,
            shininess: 100,
            specular: 0xffffff,
            reflectivity: 0.3
        });
        const shell = new THREE.Mesh(shellGeometry, shellMaterial);
        shell.castShadow = true;
        shell.receiveShadow = true;
        ballGroup.add(shell);
        
        // Create fur texture for hamster
        const hamsterCanvas = document.createElement('canvas');
        const hamsterCtx = hamsterCanvas.getContext('2d');
        hamsterCanvas.width = 128;
        hamsterCanvas.height = 128;
        
        const colors = [0xff6b6b, 0x4ecdc4, 0x45b7d1, 0x96ceb4, 0xffa726, 0xab47bc];
        const hamsterColor = colors[playerData.turnIndex % colors.length];
        const colorStr = '#' + hamsterColor.toString(16).padStart(6, '0');
        
        // Base color
        hamsterCtx.fillStyle = colorStr;
        hamsterCtx.fillRect(0, 0, 128, 128);
        
        // Add fur texture with random dots
        hamsterCtx.fillStyle = 'rgba(0, 0, 0, 0.1)';
        for (let i = 0; i < 100; i++) {
            hamsterCtx.beginPath();
            hamsterCtx.arc(
                Math.random() * 128,
                Math.random() * 128,
                Math.random() * 2,
                0, Math.PI * 2
            );
            hamsterCtx.fill();
        }
        
        // Add lighter highlights
        hamsterCtx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        for (let i = 0; i < 30; i++) {
            hamsterCtx.beginPath();
            hamsterCtx.arc(
                Math.random() * 128,
                Math.random() * 128,
                Math.random() * 1.5,
                0, Math.PI * 2
            );
            hamsterCtx.fill();
        }
        
        const hamsterTexture = new THREE.CanvasTexture(hamsterCanvas);
        
        // Inner hamster with enhanced material and better geometry
        const hamsterGeometry = new THREE.SphereGeometry(8, 16, 16);
        const hamsterMaterial = new THREE.MeshPhongMaterial({ 
            map: hamsterTexture,
            shininess: 20,
            specular: 0x333333
        });
        const hamster = new THREE.Mesh(hamsterGeometry, hamsterMaterial);
        hamster.castShadow = true;
        hamster.receiveShadow = true;
        ballGroup.add(hamster);
        
        // Add small eyes to hamster
        const eyeGeometry = new THREE.SphereGeometry(0.8, 8, 8);
        const eyeMaterial = new THREE.MeshPhongMaterial({ color: 0x000000 });
        
        const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
        leftEye.position.set(-2, 2, 6);
        hamster.add(leftEye);
        
        const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
        rightEye.position.set(2, 2, 6);
        hamster.add(rightEye);
        
        // Add nose
        const noseGeometry = new THREE.SphereGeometry(0.5, 6, 6);
        const noseMaterial = new THREE.MeshPhongMaterial({ color: 0xFF69B4 });
        const nose = new THREE.Mesh(noseGeometry, noseMaterial);
        nose.position.set(0, 0, 7);
        hamster.add(nose);
        
        // Player name label with better styling
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = 128;
        canvas.height = 32;
        
        // Background with rounded corners effect
        context.fillStyle = 'rgba(0, 0, 0, 0.8)';
        context.fillRect(2, 2, canvas.width - 4, canvas.height - 4);
        context.fillStyle = 'rgba(255, 255, 255, 0.1)';
        context.fillRect(0, 0, canvas.width, 2);
        
        context.fillStyle = 'white';
        context.font = 'bold 14px Arial';
        context.textAlign = 'center';
        context.fillText(playerData.name, canvas.width / 2, 20);
        
        const labelTexture = new THREE.CanvasTexture(canvas);
        const labelMaterial = new THREE.SpriteMaterial({ 
            map: labelTexture,
            transparent: true
        });
        const label = new THREE.Sprite(labelMaterial);
        label.position.y = 28;
        label.scale.set(46, 11.5, 1);
        ballGroup.add(label);
        
        // Add movement trail effect
        const trailGeometry = new THREE.RingGeometry(12, 18, 8);
        const trailMaterial = new THREE.MeshBasicMaterial({ 
            color: hamsterColor, 
            transparent: true, 
            opacity: 0.1,
            side: THREE.DoubleSide
        });
        const trail = new THREE.Mesh(trailGeometry, trailMaterial);
        trail.rotation.x = -Math.PI / 2;
        trail.position.y = -10;
        ballGroup.add(trail);
        
        ballGroup.position.set(playerData.x, 20, playerData.y);
        this.scene.add(ballGroup);
        this.playerMeshes[playerId] = ballGroup;
        
        // Store trail reference for animation
        ballGroup.userData = { trail: trail, baseOpacity: 0.1 };
    }
    
    connectToServer() {
        for (const ev of ['init', 'state', 'removePlayer', 'gameOver']) socket.off(ev);

        socket.on('init', ({ id, players }) => {
            this.myPlayerId = id;
            this.players = players;
            this.gameStarted = true;
            this.gameOver = false;
            document.getElementById('gameStatus').hidden = true;
            document.getElementById('loadingIndicator').style.display = 'none';
            document.getElementById('spectatorNote').hidden = !this.spectator;

            // (Re)create all player meshes; init is also sent again after a page reload.
            for (const mesh of Object.values(this.playerMeshes)) this.scene.remove(mesh);
            this.playerMeshes = {};
            for (const playerId in this.players) this.createPlayer(playerId, this.players[playerId]);
            this.updateUI();
        });

        socket.on('state', ({ players, plateTilt }) => {
            this.players = players;
            if (plateTilt) this.updatePlateTiltFromServer(plateTilt);
            this.updateGameState();
            this.updateUI();
        });

        socket.on('removePlayer', ({ odId }) => {
            if (this.playerMeshes[odId]) {
                this.scene.remove(this.playerMeshes[odId]);
                delete this.playerMeshes[odId];
            }
            delete this.players[odId];
            this.updateUI();
        });

        socket.on('gameOver', () => {
            this.gameOver = true;
            this.sendMove(0, 0);
            document.getElementById('gameStatus').hidden = false;
        });

        WBG.gameReady('hamsterball-ready');
    }

    setupEventListeners() {
        const keydown = (e) => {
            if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
            this.keys[e.code] = true;
        };
        const keyup = (e) => { this.keys[e.code] = false; };
        const blur = () => { this.keys = {}; };
        const resize = () => this.onResize();

        document.addEventListener('keydown', keydown);
        document.addEventListener('keyup', keyup);
        window.addEventListener('blur', blur);
        window.addEventListener('resize', resize);
        this.cleanups.push(() => {
            document.removeEventListener('keydown', keydown);
            document.removeEventListener('keyup', keyup);
            window.removeEventListener('blur', blur);
            window.removeEventListener('resize', resize);
        });

        this.setupTouchControls();
        this.onResize();
    }

    onResize() {
        const w = this.canvas.clientWidth || window.innerWidth;
        const h = this.canvas.clientHeight || window.innerHeight;
        const aspect = w / h;
        // Keep the whole plate visible on tall (phone) screens as well as wide ones.
        const frustum = aspect < 1 ? 640 / aspect : 640;
        this.camera.left = -frustum * aspect / 2;
        this.camera.right = frustum * aspect / 2;
        this.camera.top = frustum / 2;
        this.camera.bottom = -frustum / 2;
        this.camera.updateProjectionMatrix();
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setSize(w, h, false);
    }

    setupTouchControls() {
        const stick = document.getElementById('joystick');
        const knob = document.getElementById('joystickKnob');
        const boost = document.getElementById('boostBtn');
        if (!stick || !boost) return;
        let pointerId = null;

        const move = (e) => {
            const r = stick.getBoundingClientRect();
            const max = r.width / 2;
            let dx = e.clientX - (r.left + max);
            let dy = e.clientY - (r.top + max);
            const len = Math.hypot(dx, dy);
            if (len > max) { dx = (dx / len) * max; dy = (dy / len) * max; }
            knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
            this.touch.x = Math.abs(dx / max) < 0.15 ? 0 : dx / max;
            this.touch.y = Math.abs(dy / max) < 0.15 ? 0 : dy / max;
        };
        const end = (e) => {
            if (e.pointerId !== pointerId) return;
            pointerId = null;
            this.touch.x = this.touch.y = 0;
            knob.style.transform = 'translate(-50%, -50%)';
        };
        stick.addEventListener('pointerdown', (e) => { pointerId = e.pointerId; stick.setPointerCapture(pointerId); move(e); });
        stick.addEventListener('pointermove', (e) => { if (e.pointerId === pointerId) move(e); });
        stick.addEventListener('pointerup', end);
        stick.addEventListener('pointercancel', end);

        boost.addEventListener('pointerdown', (e) => { boost.setPointerCapture(e.pointerId); this.touch.boost = true; });
        const boostEnd = () => { this.touch.boost = false; };
        boost.addEventListener('pointerup', boostEnd);
        boost.addEventListener('pointercancel', boostEnd);
    }

    sendMove(vx, vy) {
        // The server keeps the last input, so only changes need to be sent.
        if (vx === this.lastVx && vy === this.lastVy) return;
        this.lastVx = vx;
        this.lastVy = vy;
        socket.emit('hamsterball-move', { vx, vy });
    }

    handleInput() {
        if (!this.gameStarted || this.gameOver || this.spectator) return;

        let vx = 0, vy = 0;
        const boost = this.keys['Space'] || this.touch.boost ? 2 : 1;

        if (this.keys['KeyW'] || this.keys['ArrowUp']) vy -= 1;
        if (this.keys['KeyS'] || this.keys['ArrowDown']) vy += 1;
        if (this.keys['KeyA'] || this.keys['ArrowLeft']) vx -= 1;
        if (this.keys['KeyD'] || this.keys['ArrowRight']) vx += 1;
        if (vx !== 0 && vy !== 0) { vx *= 0.707; vy *= 0.707; }

        // analog touch input overrides the keyboard when active
        if (this.touch.x || this.touch.y) { vx = this.touch.x; vy = this.touch.y; }

        this.sendMove(Math.round(vx * boost * 100) / 100, Math.round(vy * boost * 100) / 100);
    }

    updateGameState() {
        // Update player positions and animations
        for (let playerId in this.players) {
            const playerData = this.players[playerId];
            const mesh = this.playerMeshes[playerId];
            
            if (mesh && playerData) {
                // Smooth movement interpolation
                const targetX = playerData.x;
                const targetZ = playerData.y;
                
                mesh.position.x += (targetX - mesh.position.x) * 0.3;
                mesh.position.z += (targetZ - mesh.position.z) * 0.3;
                mesh.position.y = 20;
                
                // Calculate movement speed for effects
                const moveSpeed = Math.sqrt(playerData.vx * playerData.vx + playerData.vy * playerData.vy);
                
                // Rotate the hamsterball based on movement
                if (playerData.vx !== 0 || playerData.vy !== 0) {
                    // Rotate outer shell
                    mesh.children[0].rotation.x += playerData.vy * 0.1;
                    mesh.children[0].rotation.z -= playerData.vx * 0.1;
                    
                    // Rotate inner hamster
                    mesh.children[1].rotation.x += playerData.vy * 0.1;
                    mesh.children[1].rotation.z -= playerData.vx * 0.1;
                }
                
                // Animate trail based on movement
                if (mesh.userData && mesh.userData.trail) {
                    const trail = mesh.userData.trail;
                    const targetOpacity = moveSpeed > 0.1 ? 0.3 : 0.1;
                    trail.material.opacity += (targetOpacity - trail.material.opacity) * 0.1;
                    
                    // Rotate trail
                    trail.rotation.z += 0.05;
                    
                    // Scale trail based on speed
                    const targetScale = 1 + moveSpeed * 0.2;
                    trail.scale.x += (targetScale - trail.scale.x) * 0.1;
                    trail.scale.y += (targetScale - trail.scale.y) * 0.1;
                }
                
                // Add slight bounce animation when moving
                if (moveSpeed > 0.1) {
                    mesh.position.y = 20 + Math.sin(Date.now() * 0.01) * 2;
                } else {
                    mesh.position.y += (20 - mesh.position.y) * 0.1;
                }
            }
        }
    }
    
    updatePlateTiltFromServer(plateTilt) {
        if (!this.plateGroup) return;
        
        // Smooth tilt transition using server-calculated values
        this.plateGroup.rotation.x += (plateTilt.x - this.plateGroup.rotation.x) * 0.1;
        this.plateGroup.rotation.z += (plateTilt.z - this.plateGroup.rotation.z) * 0.1;
    }
    
    updateUI() {
        const playerInfo = document.getElementById('playerInfo');
        if (!playerInfo) return;
        // state arrives 30 times a second; only rebuild the list when something visible changed
        const sig = this.myPlayerId + JSON.stringify(Object.entries(this.players).map(([id, p]) => [id, p.name, p.hearts]));
        if (sig === this.uiSig) return;
        this.uiSig = sig;
        const rows = Object.entries(this.players).map(([playerId, player]) => {
            const mine = playerId === this.myPlayerId;
            const hearts = Array.from({ length: 3 }, (_, i) =>
                WBG.icon('heart', `size-4 ${i < player.hearts ? 'fill-rose-500 text-rose-500' : 'text-white/25'}`)).join('');
            const li = document.createElement('li');
            li.className = `flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm ${mine ? 'bg-brand-500/25 ring-1 ring-brand-400/50' : 'bg-white/5'}`;
            li.innerHTML = `<span class="truncate text-white">${WBG.esc(player.name)}</span><span class="flex shrink-0 gap-0.5">${hearts}</span>`;
            return li;
        });
        playerInfo.replaceChildren(...rows);
    }

    animate() {
        this.raf = requestAnimationFrame(() => this.animate());

        this.handleInput();

        if (this.gameStarted && this.plate) this.plate.rotation.y += 0.001;

        this.renderer.render(this.scene, this.camera);
    }

    destroy() {
        cancelAnimationFrame(this.raf);
        for (const fn of this.cleanups.splice(0)) fn();
        this.renderer.dispose();
        this.renderer.forceContextLoss?.();
    }
}

const game = new HamsterballGame();
WBG.onTeardown(() => game.destroy());
