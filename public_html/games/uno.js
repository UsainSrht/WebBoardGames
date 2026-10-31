(() => {
    const myId = localStorage.getItem('userId');
    const $ = (id) => document.getElementById(id);
    const BG = { red: 'bg-red-600', yellow: 'bg-yellow-400 text-black', green: 'bg-green-600', blue: 'bg-blue-600', wild: 'bg-gray-800' };
    const LABEL = { skip: '⊘', reverse: '⇄', draw2: '+2', wild: '★', wild4: '+4' };
    let state = null;

    const label = (v) => LABEL[v] || v;

    function playable(card) {
        return card.color === 'wild' || card.color === state.color || card.value === state.top.value;
    }

    function render() {
        if (!state || !$('uno-root')) return;
        const myTurn = state.turn === myId && !state.winner;

        const players = $('uno-players');
        players.innerHTML = '';
        for (const p of state.players) {
            const chip = document.createElement('div');
            chip.className = 'px-4 py-2 rounded-xl border-2 ' + (p.id === state.turn && !state.winner ? 'border-emerald-400 bg-emerald-500/20' : 'border-white/10 bg-white/5');
            chip.textContent = `${p.name}${p.id === myId ? ' (you)' : ''} · ${p.count} cards${p.count === 1 ? ' – UNO!' : ''}`;
            players.appendChild(chip);
        }

        const top = $('uno-top');
        top.className = `${BG[state.top.color === 'wild' ? state.color : state.top.color]} w-24 h-32 rounded-xl border-4 border-white flex items-center justify-center text-4xl font-black`;
        top.textContent = label(state.top.value);
        $('uno-color').textContent = `Current colour: ${state.color} · direction ${state.dir === 1 ? '↻' : '↺'}`;
        $('uno-deck-count').textContent = `${state.deckCount} left`;
        $('uno-deck').disabled = !myTurn || state.pending !== null;
        $('uno-log').textContent = state.winner ? (state.winner === myId ? '🏆 You win!' : state.log) : (myTurn ? `Your turn – ${state.log}` : state.log);
        $('uno-pass').classList.toggle('hidden', !(myTurn && state.pending !== null));

        const hand = $('uno-hand');
        hand.innerHTML = '';
        for (const card of state.hand) {
            const el = document.createElement('button');
            el.className = `${BG[card.color]} w-16 h-24 text-2xl rounded-xl border-4 border-white font-black flex items-center justify-center shadow-lg transition-transform`;
            el.textContent = label(card.value);
            const ok = myTurn && playable(card) && (state.pending === null || state.pending === card.id);
            if (!ok) el.classList.add('opacity-40');
            else el.classList.add('hover:-translate-y-2', 'cursor-pointer');
            if (state.pending === card.id) el.classList.add('ring-4', 'ring-emerald-400');
            el.addEventListener('click', () => {
                if (!ok) return;
                if (card.color === 'wild') chooseColor((color) => socket.emit('uno-play', { cardId: card.id, color }));
                else socket.emit('uno-play', { cardId: card.id });
            });
            hand.appendChild(el);
        }
    }

    function chooseColor(cb) {
        const box = $('uno-color-options');
        box.innerHTML = '';
        for (const color of ['red', 'yellow', 'green', 'blue']) {
            const b = document.createElement('button');
            b.className = `${BG[color]} w-24 h-16 rounded-xl border-4 border-white font-semibold capitalize`;
            b.textContent = color;
            b.addEventListener('click', () => { $('uno-colors').classList.add('hidden'); cb(color); });
            box.appendChild(b);
        }
        $('uno-colors').classList.remove('hidden');
    }

    const timer = setInterval(() => {
        const el = $('uno-timer');
        if (!el) return clearInterval(timer);
        el.textContent = state && state.deadline && !state.winner ? `${Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000))}s` : '';
    }, 250);

    socket.off('uno-state');
    socket.on('uno-state', (s) => { state = s; render(); });
    $('uno-deck').addEventListener('click', () => socket.emit('uno-draw'));
    $('uno-pass').addEventListener('click', () => socket.emit('uno-pass'));
    socket.emit('uno-page-loaded');
})();
