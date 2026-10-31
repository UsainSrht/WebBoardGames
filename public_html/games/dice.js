(() => {
    const FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const myId = localStorage.getItem('userId');
    let state = null;

    const $ = (id) => document.getElementById(id);

    function render() {
        if (!state || !$('dice-root')) return;
        const { round, maxRounds, phase, players, roundWinners } = state;
        const me = players[myId];

        $('dice-round').textContent = phase === 'waiting' ? 'Waiting for players…'
            : phase === 'over' ? 'Final results' : `Round ${round} of ${maxRounds}`;
        $('dice-roll-btn').disabled = !(phase === 'rolling' && me && !me.dice);
        $('dice-roll-btn').textContent = me && me.dice && phase === 'rolling' ? 'Waiting for others…' : 'Roll the dice';

        const list = $('dice-players');
        list.innerHTML = '';
        const rows = Object.entries(players).sort((a, b) => b[1].score - a[1].score);
        for (const [id, p] of rows) {
            const row = document.createElement('div');
            const won = phase !== 'rolling' && roundWinners.includes(id);
            row.className = 'flex items-center justify-between p-4 rounded-xl border-2 ' +
                (won ? 'border-emerald-400 bg-emerald-500/10' : 'border-white/10 bg-white/5');
            const name = document.createElement('span');
            name.className = 'font-medium';
            name.textContent = p.name + (id === myId ? ' (you)' : '');
            const hidden = phase === 'rolling' && id !== myId;
            const dice = document.createElement('span');
            dice.className = 'text-4xl tracking-widest';
            dice.textContent = p.dice ? (hidden ? '🎲' : `${FACES[p.dice[0]]} ${FACES[p.dice[1]]}`) : '–';
            const total = document.createElement('span');
            total.className = 'text-gray-300 w-16 text-center';
            total.textContent = p.dice && !hidden ? `= ${p.total}` : '';
            const score = document.createElement('span');
            score.className = 'font-bold text-indigo-300 w-20 text-right';
            score.textContent = `${p.score} pt${p.score === 1 ? '' : 's'}`;
            row.append(name, dice, total, score);
            list.appendChild(row);
        }

        if (phase === 'over') {
            const best = Math.max(...rows.map(([, p]) => p.score));
            const winners = rows.filter(([, p]) => p.score === best).map(([, p]) => p.name);
            $('dice-footer').textContent = winners.length > 1 ? `Tie: ${winners.join(' & ')}` : `${winners[0]} wins! 🏆`;
        } else {
            $('dice-footer').textContent = '';
        }
    }

    const timer = setInterval(() => {
        const el = $('dice-timer');
        if (!el) return clearInterval(timer);
        if (!state || !state.deadline || state.phase === 'waiting') { el.textContent = ''; return; }
        const s = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
        el.textContent = state.phase === 'rolling' ? `${s}s left to roll`
            : state.phase === 'reveal' ? `Next round in ${s}s` : `Back to lobby in ${s}s`;
    }, 250);

    socket.off('dice-state');
    socket.on('dice-state', (s) => { state = s; render(); });
    $('dice-roll-btn').addEventListener('click', () => socket.emit('dice-roll'));
    socket.emit('dice-page-loaded');
})();
