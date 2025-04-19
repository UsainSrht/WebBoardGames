console.log("Rock Paper Scissors game script loaded.");
if (typeof socket === "undefined") {
    console.error("Socket is not defined!");
}

socket.emit("rps-page-loaded");

const images = {
    rock: "./images/rps-rock.png",
    paper: "./images/rps-paper.png",
    scissors: "./images/rps-scissors.png"
};
const loadedImages = {};

function loadImages(callback) {
    let count = 0;
    const keys = Object.keys(images);
    keys.forEach(key => {
        const img = new Image();
        img.src = images[key];
        img.onload = () => {
            loadedImages[key] = img;
            count++;
            if (count === keys.length) {
                console.log("All images loaded, calling callback.");
                callback();
            }
        };
    });
}

socket.on("rps-game-started", (countdownEndUnix, players) => {
    console.log("Game started with", players.length, "players and countdown:", countdownEndUnix);
    const remainingSeconds = Math.floor((countdownEndUnix-Date.now()) / 1000);
    document.getElementById("countdown-label").textContent = remainingSeconds;
    countDown(remainingSeconds);

    const scoreboard = document.getElementById("scoreboard-players");
    scoreboard.innerHTML = ""; // Clear previous content
    players.forEach(player => {
        for (let name in player) {
            let userId = player[name];

            const line = document.createElement("div");
            line.innerHTML = `
                <div id="scoreboard-player-${userId}" class="flex items-center justify-between p-4 bg-gray-800 border-b border-gray-600 rounded-t text-white">
                    <span>${name}</span>
                    <span id="scoreboard-player-score-${userId}">Score</span>
                </div>
            `;
            scoreboard.appendChild(line);
        }
    });
});

function countDown(countdown) {
    console.log("Countdown:", countdown);
    const countdownLabel = document.getElementById("countdown-label");
    countdownLabel.textContent = countdown;
    setTimeout(() => {
        countdown--;
        if (countdown > 0) {
            countDown(countdown);
        }
    }, 1000);
}

window.rpsSelectMove = function (move) {
    socket.emit("rps-select-move", move);
};

socket.on("rps-move-selected", (move) => {
    ["rock", "paper", "scissors"].forEach(element => {
        const moveButton = document.getElementById(`rps-move-${element}`);
        if (moveButton) {
            if (move === element) {
                moveButton.classList.remove("border-gray-700");
                moveButton.classList.add("border-green-700");
            } else {
                moveButton.classList.remove("border-green-700");
                moveButton.classList.add("border-gray-700");
            }
        }
    });
});

socket.on("rps-game-ended", (playerMoves) => {
    console.log("rps countdown ended");
    const rpsPopup = document.getElementById("rps-popup");
    rpsPopup.classList.add("hidden");

    const gameBoard = document.getElementById('game-board');
    gameBoard.innerHTML = ""; // Clear previous content

    const loadingLabel = document.createElement("div");
    loadingLabel.id = "loading-label";
    loadingLabel.className = "flex items-center justify-center h-screen w-screen bg-gray-800 bg-opacity-50 fixed top-0 left-0 z-50";
    loadingLabel.innerHTML = `<svg aria-hidden="true" class="w-8 h-8 text-gray-600 animate-spin fill-blue-600" viewBox="0 0 100 101" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z" fill="currentColor"/>
                                    <path d="M93.9676 39.0409C96.393 38.4038 97.8624 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6781 93.9676 39.0409Z" fill="currentFill"/>
                                </svg>`;
    gameBoard.appendChild(loadingLabel);

    const canvas = document.createElement("canvas");
    canvas.id = "rps-canvas";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gameBoard.appendChild(canvas);

    const center = { x: canvas.width / 2, y: canvas.height / 2 };
    const radius = Math.min(canvas.width, canvas.height) / 3;

    const movesData = {};

    let index = 0;
    for (const key of Object.keys(playerMoves)) {
        const angle = (index / Object.keys(playerMoves).length) * Math.PI * 2;
        movesData[key] = {
            name: playerMoves[key].name,
            move: playerMoves[key].move,
            x: center.x + radius * Math.cos(angle),
            y: center.y + radius * Math.sin(angle),
            angle,
            progress: 0
        };
        index++;
    }

    loadImages(() => {
        drawMoves(movesData, center);
    });
});

function easeInOutCirc(x) {
    return x < 0.5
        ? (1 - Math.sqrt(1 - Math.pow(2 * x, 2))) / 2
        : (Math.sqrt(1 - Math.pow(-2 * x + 2, 2)) + 1) / 2;
}

function drawMoves(movesData, center) {

    const canvas = document.getElementById("rps-canvas");
    const ctx = canvas.getContext("2d");

    let animationFrameId;
    function animateMoves() {
        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        let allDone = true;

        Object.keys(movesData).forEach(userId => {
            const data = movesData[userId];

            if (data.progress < 1) {
                data.progress += 0.02;
                if (data.progress > 1) data.progress = 1;
                allDone = false;
            }

            const easedProgress = easeInOutCirc(data.progress);

            const x = data.x + (center.x - data.x) * easedProgress;
            const y = data.y + (center.y - data.y) * easedProgress;

            const img = loadedImages[data.move];
            if (img) {
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(data.angle + (270 * Math.PI / 180));
                ctx.drawImage(img, -30, -30, 60, 60);
                ctx.restore();

                ctx.fillStyle = "white";
                ctx.font = "16px Arial";
                ctx.fillText(data.name, x - 20, y + 50);
            }
        });

        // Continue animation if not done
        if (!allDone) {
            animationFrameId = requestAnimationFrame(animateMoves);
        }
    }

    animateMoves();
}