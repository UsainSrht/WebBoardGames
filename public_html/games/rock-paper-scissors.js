console.log("Rock Paper Scissors game script loaded.");
if (typeof socket === "undefined") {
    console.error("Socket is not defined!");
}

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

socket.on("rps-game-started", (countdown, players) => {
    console.log("Game started with", players.length, "players and countdown:", countdown);
    document.getElementById("countdown-label").textContent = countdown;
    countDown(countdown);

    const scoreboard = document.getElementById("scoreboard-players");
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
    const countdownLabel = document.getElementById("countdown-label");
    setTimeout(() => {
        countdownLabel.textContent = countdown;
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
    console.log(`selected ${move}`);
    for (const element in ["rock", "paper", "scissors"]) {
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
    }
});

socket.on("rps-game-end", (playerMoves) => {
    const rpsPopup = document.getElementById("rps-popup");
    rpsPopup.classList.add("hidden");

    const center = { x: canvas.width / 2, y: canvas.height / 2 };
    const radius = Math.min(canvas.width, canvas.height) / 3;

    const movesData = {};

    let index = 0;
    for (const key of Object.keys(playerMoves)) {
        const angle = (index / playerMoves.length) * Math.PI * 2;
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
        drawMoves(movesData);
    });
});

function drawMoves(movesData) {
    console.log("Drawing moves", movesData);
    const gameBoard = document.getElementById('game-board');
    gameBoard.innerHTML = ""; // Clear previous content

    const canvas = document.createElement("canvas");
    canvas.id = "rps-canvas";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gameBoard.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    movesData.forEach(move => {
        const img = loadedImages[move];
        if (img) {
            const x = player.x + (center.x - player.x) * player.progress;
            const y = player.y + (center.y - player.y) * player.progress;
            ctx.drawImage(img, x - 30, y - 30, 60, 60);
            ctx.fillStyle = "white";
            ctx.font = "16px Arial";
            ctx.fillText(player.name, x - 20, y + 50);
        }
    });
}