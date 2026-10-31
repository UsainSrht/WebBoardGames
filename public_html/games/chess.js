(() => {
    const PIECES = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙', k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
    const myId = localStorage.getItem('userId');
    const $ = (id) => document.getElementById(id);
    let state = null;
    let selected = null;

    const sq = (i) => 'abcdefgh'[i % 8] + (8 - Math.floor(i / 8));
    const isWhitePiece = (p) => p !== '.' && p === p.toUpperCase();

    function render() {
        if (!state || !$('chess-board')) return;
        const myColor = state.white === myId ? 'w' : state.black === myId ? 'b' : null;
        const flip = myColor === 'b';
        const board = $('chess-board');
        board.innerHTML = '';

        const targets = new Set(selected ? state.legal.filter(m => m.from === selected).map(m => m.to) : []);
        const myTurn = !state.result && myColor === state.turn;

        for (let k = 0; k < 64; k++) {
            const i = flip ? 63 - k : k;
            const name = sq(i);
            const piece = state.board[i];
            const dark = (Math.floor(i / 8) + (i % 8)) % 2 === 1;
            const cell = document.createElement('button');
            let bg = dark ? 'bg-amber-700' : 'bg-amber-200';
            if (state.lastMove && (state.lastMove.from === name || state.lastMove.to === name)) bg = dark ? 'bg-yellow-600' : 'bg-yellow-300';
            if (selected === name) bg = 'bg-emerald-400';
            if (state.check && piece === (state.turn === 'w' ? 'K' : 'k')) bg = 'bg-red-500';
            cell.className = `relative flex items-center justify-center ${bg} leading-none`;
            cell.style.fontSize = 'min(8vw, 6vh)';
            const glyph = document.createElement('span');
            glyph.textContent = piece === '.' ? '' : PIECES[piece];
            glyph.style.color = isWhitePiece(piece) ? '#fff' : '#000';
            glyph.style.textShadow = isWhitePiece(piece) ? '0 0 3px #000, 0 0 3px #000' : 'none';
            cell.appendChild(glyph);
            if (targets.has(name)) {
                const dot = document.createElement('span');
                dot.className = 'absolute w-1/4 h-1/4 rounded-full bg-emerald-700/70';
                cell.appendChild(dot);
            }
            cell.addEventListener('click', () => onCell(name, piece, myTurn, myColor));
            board.appendChild(cell);
        }

        const nameOf = (id) => state.names[id] || '?';
        const opp = myColor === 'w' ? state.black : state.white;
        $('chess-opponent').textContent = myColor ? `${nameOf(opp)} (${myColor === 'w' ? 'black' : 'white'})` : `${nameOf(state.black)} (black)`;
        $('chess-me').textContent = myColor ? `${nameOf(myId)} (${myColor === 'w' ? 'white' : 'black'})` : `${nameOf(state.white)} (white)`;

        let status;
        if (state.result) {
            const { winner, reason } = state.result;
            status = winner ? `${nameOf(winner)} wins by ${reason}!` : `Draw – ${reason}`;
        } else {
            status = (myTurn ? 'Your move' : `${nameOf(state.turn === 'w' ? state.white : state.black)} to move`) + (state.check ? ' – check!' : '');
        }
        $('chess-status').textContent = status;
        $('chess-resign').classList.toggle('hidden', !!state.result || !myColor);
    }

    function onCell(name, piece, myTurn, myColor) {
        if (!myTurn) return;
        if (selected) {
            const options = state.legal.filter(m => m.from === selected && m.to === name);
            if (options.length) {
                const from = selected;
                selected = null;
                if (options.some(m => m.promo)) return askPromotion(from, name, myColor);
                return socket.emit('chess-move', { from, to: name });
            }
        }
        const mine = piece !== '.' && (isWhitePiece(piece) ? 'w' : 'b') === myColor;
        selected = mine && state.legal.some(m => m.from === name) ? name : null;
        render();
    }

    function askPromotion(from, to, color) {
        const box = $('chess-promo-options');
        box.innerHTML = '';
        for (const p of ['q', 'r', 'b', 'n']) {
            const b = document.createElement('button');
            b.textContent = PIECES[color === 'w' ? p.toUpperCase() : p];
            b.className = 'hover:scale-125 transition-transform';
            b.addEventListener('click', () => {
                $('chess-promo').classList.add('hidden');
                socket.emit('chess-move', { from, to, promotion: p });
            });
            box.appendChild(b);
        }
        $('chess-promo').classList.remove('hidden');
    }

    socket.off('chess-state');
    socket.on('chess-state', (s) => { state = s; selected = null; render(); });
    $('chess-resign').addEventListener('click', () => { if (confirm('Resign this game?')) socket.emit('chess-resign'); });
    socket.emit('chess-page-loaded');
})();
