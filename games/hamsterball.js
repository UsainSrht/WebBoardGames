module.exports = (io, eventBus, room, roomData, players) => {
    const playerGameData = {};
    const readyPlayers = [];
    let gameLoop = null;
    let isGameActive = true;
    let i = 1;

    // Store socket listeners for cleanup
    const socketListeners = new Map();

    // players object: mapping userId -> { socketId, name, ... }
    for (let userId in players) {
        const socket = io.sockets.sockets.get(players[userId].socketId);
        initForPlayer(userId, socket, players[userId].name, i);
        i++;
    }

    function initForPlayer(userId, socket, name, index) {
        if (!socket) return;
        // initialize player data
        playerGameData[userId] = {
            name: name,
            x: Math.random() * 100 - 50, // spawn in smaller area
            y: Math.random() * 100 - 50,
            vx: 0,
            vy: 0,
            hearts: 3,
            turnIndex: index,
            socketId: socket.id,
            radius: 15 // collision radius
        };

        // Store listeners for cleanup
        const listeners = {};

        // client tells server it's ready
        listeners.ready = () => {
            if (!readyPlayers.includes(userId)) {
                readyPlayers.push(userId);

                console.log(`${name} is ready (${readyPlayers.length}/${Object.keys(players).length})`);

                // start game only when all loaded
                if (readyPlayers.length >= Object.keys(players).length) {
                    console.log("All players are ready! Starting hamsterball in room:", room);
                    startGame();
                }
            }
        };
        socket.on("hamsterball-ready", listeners.ready);

        // handle movement inputs from this socket
        listeners.move = ({ vx, vy }) => {
            if (!playerGameData[userId] || !isGameActive) return;
            // sanitize numeric inputs
            playerGameData[userId].vx = Number(vx) || 0;
            playerGameData[userId].vy = Number(vy) || 0;
        };
        socket.on("hamsterball-move", listeners.move);

        // disconnect cleanup
        listeners.disconnect = () => {
            delete playerGameData[userId];
            const idx = readyPlayers.indexOf(userId);
            if (idx !== -1) readyPlayers.splice(idx, 1);
            io.to(room).emit("removePlayer", userId);

            if (Object.keys(playerGameData).length === 0) {
                cleanup();
            }
        };
        socket.on("disconnect", listeners.disconnect);

        socketListeners.set(userId, { socket, listeners });
    }

    function cleanup() {
        isGameActive = false;
        if (gameLoop) {
            clearInterval(gameLoop);
            gameLoop = null;
        }
        // Remove all socket listeners
        socketListeners.forEach(({ socket, listeners }) => {
            if (socket) {
                socket.off("hamsterball-ready", listeners.ready);
                socket.off("hamsterball-move", listeners.move);
                socket.off("disconnect", listeners.disconnect);
            }
        });
        socketListeners.clear();
        console.log(`Hamsterball game cleaned up for room: ${room}`);
    }

    function startGame() {
        // Send initial state: emit to each connected socket individually so each
        // client receives their own userId (so client can know which player is theirs).
        for (let userId in playerGameData) {
            const sockId = playerGameData[userId].socketId;
            const socket = io.sockets.sockets.get(sockId);
            if (!socket) continue;
            // send init with id of this client and full players snapshot
            socket.emit("init", { id: userId, players: playerGameData });
        }

        // start physics loop
        if (!gameLoop) {
            gameLoop = setInterval(() => {
                if (!isGameActive) {
                    cleanup();
                    return;
                }
                updateGame();
                // broadcast full state to everyone in room including plate tilt
                io.to(room).emit("state", {
                    players: playerGameData,
                    plateTilt: calculatePlateTilt()
                });
            }, 1000 / 30);
        }
    }

    function updateGame() {
        // First apply movement
        for (let id in playerGameData) {
            const p = playerGameData[id];
            
            // Apply gravity/plate tilt effect
            const plateTilt = calculatePlateTilt();
            const gravityForce = 0.5;
            
            // Add plate tilt as a force
            p.vx += Math.sin(plateTilt.z) * gravityForce;
            p.vy += Math.sin(plateTilt.x) * gravityForce;
            
            // Apply friction
            p.vx *= 0.98;
            p.vy *= 0.98;
            
            // Apply movement
            p.x += p.vx * 5;
            p.y += p.vy * 5;
        }

        // Handle collisions between players
        handleCollisions();

        // Boundary checks and respawn
        for (let id in playerGameData) {
            const p = playerGameData[id];
            
            // Check if fallen off the plate (distance from center > 200)
            const distanceFromCenter = Math.sqrt(p.x * p.x + p.y * p.y);
            if (distanceFromCenter > 200) {
                p.hearts -= 1;
                
                // Respawn in center with some randomness
                p.x = Math.random() * 40 - 20;
                p.y = Math.random() * 40 - 20;
                p.vx = 0;
                p.vy = 0;
                
                if (p.hearts <= 0) {
                    // notify only that particular socket (game over)
                    const socket = io.sockets.sockets.get(p.socketId);
                    if (socket) socket.emit("gameOver");
                }
            }
        }
    }

    function handleCollisions() {
        const playerIds = Object.keys(playerGameData);
        
        // Check collision between every pair of players
        for (let i = 0; i < playerIds.length; i++) {
            for (let j = i + 1; j < playerIds.length; j++) {
                const p1 = playerGameData[playerIds[i]];
                const p2 = playerGameData[playerIds[j]];
                
                // Calculate distance between players
                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                const minDistance = p1.radius + p2.radius;
                
                // If collision detected
                if (distance < minDistance && distance > 0) {
                    // Calculate collision normal
                    const nx = dx / distance;
                    const ny = dy / distance;
                    
                    // Separate the balls
                    const overlap = minDistance - distance;
                    const separationX = nx * overlap * 0.5;
                    const separationY = ny * overlap * 0.5;
                    
                    p1.x -= separationX;
                    p1.y -= separationY;
                    p2.x += separationX;
                    p2.y += separationY;
                    
                    // Calculate relative velocity
                    const dvx = p2.vx - p1.vx;
                    const dvy = p2.vy - p1.vy;
                    
                    // Calculate relative velocity in collision normal direction
                    const dvn = dvx * nx + dvy * ny;
                    
                    // Do not resolve if velocities are separating
                    if (dvn > 0) continue;
                    
                    // Collision impulse (assuming equal mass)
                    const impulse = dvn * 0.8; // 0.8 is restitution coefficient
                    const impulseX = impulse * nx;
                    const impulseY = impulse * ny;
                    
                    // Apply impulse to velocities
                    p1.vx += impulseX;
                    p1.vy += impulseY;
                    p2.vx -= impulseX;
                    p2.vy -= impulseY;
                }
            }
        }
    }

    function calculatePlateTilt() {
        if (Object.keys(playerGameData).length === 0) {
            return { x: 0, z: 0 };
        }

        let totalX = 0, totalY = 0, totalMass = 0;
        
        // Calculate weighted center of mass
        for (let playerId in playerGameData) {
            const player = playerGameData[playerId];
            const mass = 1; // All players have equal mass
            
            totalX += player.x * mass;
            totalY += player.y * mass;
            totalMass += mass;
        }
        
        if (totalMass > 0) {
            const centerX = totalX / totalMass;
            const centerY = totalY / totalMass;
            
            // Calculate tilt based on center of mass
            // The plate tilts towards the center of mass
            const maxTilt = 0.15; // maximum tilt in radians
            const plateRadius = 200;
            
            // Normalize position to get tilt factor
            const tiltFactorX = Math.max(-1, Math.min(1, centerY / plateRadius));
            const tiltFactorZ = Math.max(-1, Math.min(1, -centerX / plateRadius));
            
            return {
                x: tiltFactorX * maxTilt,
                z: tiltFactorZ * maxTilt
            };
        }
        
        return { x: 0, z: 0 };
    }
};