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
        
        this.init();
        this.setupEventListeners();
        this.connectToServer();
    }
    
    init() {
        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.Fog(0x87CEEB, 300, 1000);
        
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
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
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
        label.position.y = 25;
        label.scale.set(32, 8, 1);
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
        socket.emit('hamsterball-ready');
        
        socket.on('init', ({ id, players }) => {
            console.log('Game initialized', { id, players });
            this.myPlayerId = id;
            this.players = players;
            this.gameStarted = true;
            
            // Hide loading indicator
            document.getElementById('loadingIndicator').style.display = 'none';
            
            // Create all player meshes
            for (let playerId in this.players) {
                this.createPlayer(playerId, this.players[playerId]);
            }
            
            this.updateUI();
        });
        
        socket.on('state', ({ players, plateTilt }) => {
            this.players = players;
            
            // Update plate tilt from server data
            if (plateTilt) {
                this.updatePlateTiltFromServer(plateTilt);
            }
            
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
            document.getElementById('gameStatus').style.display = 'block';
        });
        
        socket.on('connect_error', ({ message }) => {
            console.error('Connection error:', message);
            document.getElementById('connectionStatus').textContent = 'Connection failed. Retrying...';
        });
    }
    
    setupEventListeners() {
        // Keyboard controls
        document.addEventListener('keydown', (e) => {
            this.keys[e.code] = true;
        });
        
        document.addEventListener('keyup', (e) => {
            this.keys[e.code] = false;
        });
        
        // Window resize - update orthographic camera
        window.addEventListener('resize', () => {
            const aspect = window.innerWidth / window.innerHeight;
            const frustumSize = 800;
            
            this.camera.left = -frustumSize * aspect / 2;
            this.camera.right = frustumSize * aspect / 2;
            this.camera.top = frustumSize / 2;
            this.camera.bottom = -frustumSize / 2;
            
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }
    
    handleInput() {
        if (!this.gameStarted || this.gameOver || !socket) return;
        
        let vx = 0, vy = 0;
        let boost = 1;
        
        // Boost when spacebar is pressed
        if (this.keys['Space']) {
            boost = 2;
        }
        
        // Movement input
        if (this.keys['KeyW'] || this.keys['ArrowUp']) vy -= 1 * boost;
        if (this.keys['KeyS'] || this.keys['ArrowDown']) vy += 1 * boost;
        if (this.keys['KeyA'] || this.keys['ArrowLeft']) vx -= 1 * boost;
        if (this.keys['KeyD'] || this.keys['ArrowRight']) vx += 1 * boost;
        
        // Normalize diagonal movement
        if (vx !== 0 && vy !== 0) {
            vx *= 0.707;
            vy *= 0.707;
        }
        
        // Send movement to server
        socket.emit('hamsterball-move', { vx, vy });
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
        playerInfo.innerHTML = '';
        
        for (let playerId in this.players) {
            const player = this.players[playerId];
            const playerDiv = document.createElement('div');
            playerDiv.className = 'player-item';
            
            if (playerId === this.myPlayerId) {
                playerDiv.className += ' current-player';
            }
            
            const hearts = '♥'.repeat(Math.max(0, player.hearts));
            const emptyHearts = '♡'.repeat(Math.max(0, 3 - player.hearts));
            
            playerDiv.innerHTML = `
                <span>${player.name}</span>
                <span class="hearts">
                    <span class="heart">${hearts}</span>
                    <span class="heart" style="opacity: 0.3;">${emptyHearts}</span>
                </span>
            `;
            
            playerInfo.appendChild(playerDiv);
        }
    }
    
    animate() {
        requestAnimationFrame(() => this.animate());
        
        this.handleInput();
        
        // Add some ambient animations
        if (this.gameStarted) {
            // Rotate the plate very slightly for visual effect
            if (this.plate) {
                this.plate.rotation.y += 0.001;
            }
        }
        
        this.renderer.render(this.scene, this.camera);
    }
}

const game = new HamsterballGame();