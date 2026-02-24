/**
 * Color Clash – Socket.io Event Handlers
 */

const {
    isValidPlay,
    applyCardEffect,
    drawCards,
    checkWin,
    publicGameState,
    topCard,
    WILD_TYPES,
} = require('./gameEngine');

const {
    createRoom,
    joinRoom,
    leaveRoom,
    kickPlayer,
    startGame,
    reconnectPlayer,
    getRoomBySocket,
    getRoom,
} = require('./roomManager');

const TURN_TIMEOUT_MS = 25000; // 25 second turn timer
const turnTimers = new Map(); // socketId → timeout handle

function clearTurnTimer(roomCode) {
    if (turnTimers.has(roomCode)) {
        clearTimeout(turnTimers.get(roomCode));
        turnTimers.delete(roomCode);
    }
}

function startTurnTimer(io, room) {
    clearTurnTimer(room.code);
    const handle = setTimeout(() => {
        // Auto-draw for the current player if time expires
        const game = room.game;
        if (!game || game.phase !== 'game') return;
        const player = game.players[game.currentPlayerIndex];
        if (!player || !player.isConnected) {
            // skip disconnected player
            game.currentPlayerIndex =
                (game.currentPlayerIndex + game.direction + game.players.length) %
                game.players.length;
        } else {
            drawCards(game, game.currentPlayerIndex, 1);
            game.currentPlayerIndex =
                (game.currentPlayerIndex + game.direction + game.players.length) %
                game.players.length;
        }
        game.turnStartedAt = Date.now();
        broadcastGameState(io, room);
        startTurnTimer(io, room);
    }, TURN_TIMEOUT_MS);
    turnTimers.set(room.code, handle);
}

function broadcastGameState(io, room) {
    const state = publicGameState(room.game);
    io.to(room.code).emit('game:state', state);
    // Send private hands
    for (const player of room.game.players) {
        io.to(player.id).emit('game:yourHand', player.hand);
    }
}

/** Emit a real-time game event for the activity feed / toast overlays */
function emitEvent(io, room, type, payload) {
    io.to(room.code).emit('game:event', { type, ts: Date.now(), ...payload });
}

module.exports = function registerHandlers(io) {
    io.on('connection', (socket) => {
        console.log(`[connected] ${socket.id}`);

        // ──────────────────────────────────────────────
        // ROOM: CREATE
        // ──────────────────────────────────────────────
        socket.on('room:create', ({ nickname }, callback) => {
            try {
                const room = createRoom(socket.id, nickname);
                socket.join(room.code);
                callback({ ok: true, room: sanitizeRoom(room) });
                io.to(room.code).emit('room:updated', sanitizeRoom(room));
            } catch (err) {
                callback({ ok: false, error: err.message });
            }
        });

        // ──────────────────────────────────────────────
        // ROOM: JOIN
        // ──────────────────────────────────────────────
        socket.on('room:join', ({ roomCode, nickname }, callback) => {
            try {
                const { room, error } = joinRoom(socket.id, roomCode, nickname);
                if (error) return callback({ ok: false, error });
                socket.join(room.code);
                callback({ ok: true, room: sanitizeRoom(room) });
                io.to(room.code).emit('room:updated', sanitizeRoom(room));
            } catch (err) {
                callback({ ok: false, error: err.message });
            }
        });

        // ──────────────────────────────────────────────
        // ROOM: RECONNECT
        // ──────────────────────────────────────────────
        socket.on('room:reconnect', ({ roomCode, oldSocketId, nickname }, callback) => {
            try {
                const { room, error } = reconnectPlayer(roomCode, oldSocketId, socket.id, nickname);
                if (error) return callback({ ok: false, error });
                socket.join(room.code);
                callback({ ok: true, room: sanitizeRoom(room) });
                io.to(room.code).emit('room:updated', sanitizeRoom(room));
                if (room.phase === 'game' && room.game) {
                    broadcastGameState(io, room);
                }
            } catch (err) {
                callback({ ok: false, error: err.message });
            }
        });

        // ──────────────────────────────────────────────
        // ROOM: KICK
        // ──────────────────────────────────────────────
        socket.on('room:kick', ({ roomCode, targetSocketId }, callback) => {
            try {
                const { room, error } = kickPlayer(roomCode, socket.id, targetSocketId);
                if (error) return callback({ ok: false, error });
                io.to(targetSocketId).emit('room:kicked');
                io.to(room.code).emit('room:updated', sanitizeRoom(room));
                callback({ ok: true });
            } catch (err) {
                callback({ ok: false, error: err.message });
            }
        });

        // ──────────────────────────────────────────────
        // GAME: START
        // ──────────────────────────────────────────────
        socket.on('game:start', ({ roomCode }, callback) => {
            try {
                const { room, error } = startGame(roomCode, socket.id);
                if (error) return callback({ ok: false, error });
                room.game.turnStartedAt = Date.now();
                io.to(room.code).emit('room:updated', sanitizeRoom(room));
                broadcastGameState(io, room);
                startTurnTimer(io, room);
                callback({ ok: true });
            } catch (err) {
                callback({ ok: false, error: err.message });
            }
        });

        // ──────────────────────────────────────────────
        // GAME: PLAY CARD
        // ──────────────────────────────────────────────
        socket.on('game:playCard', ({ roomCode, cardIndex, chosenColor }, callback) => {
            try {
                const room = getRoom(roomCode);
                if (!room || room.phase !== 'game') return callback({ ok: false, error: 'No active game.' });

                const game = room.game;
                const currentPlayer = game.players[game.currentPlayerIndex];

                // Validate turn ownership
                if (currentPlayer.id !== socket.id)
                    return callback({ ok: false, error: 'Not your turn.' });

                // Validate card index
                const card = currentPlayer.hand[cardIndex];
                if (!card) return callback({ ok: false, error: 'Invalid card.' });

                // Validate card play
                const top = topCard(game);
                if (!isValidPlay(card, top, game.currentColor))
                    return callback({ ok: false, error: 'Invalid move.' });

                // Validate chosen color for wild
                if (WILD_TYPES.includes(card.type) && !chosenColor)
                    return callback({ ok: false, error: 'Must choose a color for wild card.' });

                // Remove card from hand
                currentPlayer.hand.splice(cardIndex, 1);
                game.discardPile.push(card);

                // Reset clash safety for current player
                currentPlayer.clashSafe = false;
                game.clashCalledBy = null;

                // Emit event for activity feed
                const nextIdx = ((game.currentPlayerIndex + game.direction + game.players.length) % game.players.length);
                const nextPlayer = game.players[nextIdx];
                if (card.type === 'skip') {
                    emitEvent(io, room, 'skip', { by: currentPlayer.nickname, skipped: nextPlayer?.nickname });
                } else if (card.type === 'reverse') {
                    emitEvent(io, room, 'reverse', { by: currentPlayer.nickname });
                } else if (card.type === 'draw_two') {
                    emitEvent(io, room, 'draw_penalty', { by: currentPlayer.nickname, target: nextPlayer?.nickname, count: 2 });
                } else if (card.type === 'wild_draw_four') {
                    emitEvent(io, room, 'draw_penalty', { by: currentPlayer.nickname, target: nextPlayer?.nickname, count: 4 });
                } else if (card.type === 'wild') {
                    emitEvent(io, room, 'wild', { by: currentPlayer.nickname, color: chosenColor });
                } else {
                    emitEvent(io, room, 'play', { by: currentPlayer.nickname, card: { color: card.color, type: card.type, value: card.value } });
                }

                // Check win BEFORE applying effect (to keep currentPlayerIndex valid)
                if (checkWin(currentPlayer)) {
                    game.winner = currentPlayer.nickname;
                    game.phase = 'results';
                    room.phase = 'results';
                    clearTurnTimer(room.code);
                    broadcastGameState(io, room);

                    // Build rankings: winner = rank 1, others by cards held (asc = better)
                    const losers = game.players
                        .filter((p) => p.id !== currentPlayer.id)
                        .sort((a, b) => a.hand.length - b.hand.length);
                    const rankings = [
                        { rank: 1, id: currentPlayer.id, nickname: currentPlayer.nickname, cardCount: 0 },
                        ...losers.map((p, i) => ({
                            rank: i + 2, id: p.id, nickname: p.nickname, cardCount: p.hand.length,
                        })),
                    ];

                    io.to(room.code).emit('game:ended', { winner: currentPlayer.nickname, rankings });
                    return callback({ ok: true });
                }

                // Apply effect and advance turn
                applyCardEffect(game, card, chosenColor);
                game.turnStartedAt = Date.now();

                broadcastGameState(io, room);
                startTurnTimer(io, room);
                callback({ ok: true });
            } catch (err) {
                callback({ ok: false, error: err.message });
            }
        });

        // ──────────────────────────────────────────────
        // GAME: DRAW CARD
        // ──────────────────────────────────────────────
        socket.on('game:drawCard', ({ roomCode }, callback) => {
            try {
                const room = getRoom(roomCode);
                if (!room || room.phase !== 'game') return callback({ ok: false, error: 'No active game.' });

                const game = room.game;
                const currentPlayer = game.players[game.currentPlayerIndex];

                if (currentPlayer.id !== socket.id)
                    return callback({ ok: false, error: 'Not your turn.' });

                drawCards(game, game.currentPlayerIndex, 1);
                const drawn = currentPlayer.hand[currentPlayer.hand.length - 1];

                // Advance turn if drawn card is not playable
                const top = topCard(game);
                const canPlay = drawn && isValidPlay(drawn, top, game.currentColor);

                emitEvent(io, room, 'draw', { by: currentPlayer.nickname, canPlay: !!canPlay });

                if (!canPlay) {
                    game.currentPlayerIndex =
                        (game.currentPlayerIndex + game.direction + game.players.length) %
                        game.players.length;
                }

                game.turnStartedAt = Date.now();
                broadcastGameState(io, room);
                startTurnTimer(io, room);
                callback({ ok: true, drew: drawn, canPlay });
            } catch (err) {
                callback({ ok: false, error: err.message });
            }
        });

        // ──────────────────────────────────────────────
        // GAME: CALL COLOR CLASH (like "UNO!")
        // ──────────────────────────────────────────────
        socket.on('game:callClash', ({ roomCode }, callback) => {
            try {
                const room = getRoom(roomCode);
                if (!room || room.phase !== 'game') return callback({ ok: false, error: 'No active game.' });
                const game = room.game;
                const player = game.players.find((p) => p.id === socket.id);
                if (!player) return callback({ ok: false, error: 'Not in game.' });
                if (player.hand.length !== 1)
                    return callback({ ok: false, error: 'Can only call Color Clash with 1 card.' });

                player.clashSafe = true;
                game.clashCalledBy = player.nickname;
                io.to(room.code).emit('game:clashAlert', { nickname: player.nickname });
                broadcastGameState(io, room);
                callback({ ok: true });
            } catch (err) {
                callback({ ok: false, error: err.message });
            }
        });

        // ──────────────────────────────────────────────
        // GAME: ACCUSE (didn't call Color Clash)
        // ──────────────────────────────────────────────
        socket.on('game:accuseClash', ({ roomCode, targetSocketId }, callback) => {
            try {
                const room = getRoom(roomCode);
                if (!room || room.phase !== 'game') return callback({ ok: false, error: 'No active game.' });
                const game = room.game;
                const target = game.players.find((p) => p.id === targetSocketId);
                if (!target) return callback({ ok: false, error: 'Player not found.' });
                if (target.hand.length !== 1)
                    return callback({ ok: false, error: 'Target does not have 1 card.' });
                if (target.clashSafe)
                    return callback({ ok: false, error: 'Player already called Color Clash.' });

                // Penalty: draw 2
                const targetIdx = game.players.indexOf(target);
                drawCards(game, targetIdx, 2);
                io.to(room.code).emit('game:accuseResult', {
                    accuser: game.players.find((p) => p.id === socket.id)?.nickname,
                    target: target.nickname,
                    penalty: 2,
                });
                broadcastGameState(io, room);
                callback({ ok: true });
            } catch (err) {
                callback({ ok: false, error: err.message });
            }
        });

        // ──────────────────────────────────────────────
        // CHAT: MESSAGE
        // ──────────────────────────────────────────────
        socket.on('chat:message', ({ roomCode, text }) => {
            const room = getRoom(roomCode);
            if (!room) return;
            const player = room.players.find((p) => p.id === socket.id);
            if (!player) return;
            const msg = {
                id: Date.now(),
                nickname: player.nickname,
                text: text.slice(0, 200),
                ts: Date.now(),
            };
            room.chat.push(msg);
            if (room.chat.length > 100) room.chat.shift();
            io.to(room.code).emit('chat:message', msg);
        });

        // ──────────────────────────────────────────────
        // CHAT: EMOJI REACTION
        // ──────────────────────────────────────────────
        socket.on('chat:emoji', ({ roomCode, emoji }) => {
            const room = getRoom(roomCode);
            if (!room) return;
            const player = room.players.find((p) => p.id === socket.id);
            if (!player) return;
            io.to(room.code).emit('chat:emoji', { nickname: player.nickname, emoji });
        });

        // ──────────────────────────────────────────────
        // GAME: REMATCH
        // ──────────────────────────────────────────────
        socket.on('game:rematch', ({ roomCode }, callback) => {
            try {
                const room = getRoom(roomCode);
                if (!room) return callback({ ok: false, error: 'Room not found.' });
                if (room.hostId !== socket.id) return callback({ ok: false, error: 'Only host can rematch.' });

                // Reset to lobby
                room.phase = 'lobby';
                room.game = null;
                for (const p of room.players) {
                    p.hand = [];
                    p.clashSafe = false;
                }
                io.to(room.code).emit('room:updated', sanitizeRoom(room));
                callback({ ok: true });
            } catch (err) {
                callback({ ok: false, error: err.message });
            }
        });

        // ──────────────────────────────────────────────
        // DISCONNECT
        // ──────────────────────────────────────────────
        socket.on('disconnect', () => {
            console.log(`[disconnected] ${socket.id}`);
            const result = leaveRoom(socket.id);
            if (!result.room && !result.deleted) return;
            if (result.deleted) return;
            const room = result.room;
            io.to(result.code).emit('room:updated', sanitizeRoom(room));
            if (room.phase === 'game' && room.game) {
                // Skip disconnected player's turn if it's theirs
                const game = room.game;
                const current = game.players[game.currentPlayerIndex];
                if (current && current.id === socket.id) {
                    game.currentPlayerIndex =
                        (game.currentPlayerIndex + game.direction + game.players.length) %
                        game.players.length;
                    game.turnStartedAt = Date.now();
                    broadcastGameState(io, room);
                    startTurnTimer(io, room);
                } else {
                    broadcastGameState(io, room);
                }
            }
        });
    });
};

/** Strip private hand data from room for lobby broadcasts */
function sanitizeRoom(room) {
    return {
        code: room.code,
        hostId: room.hostId,
        phase: room.phase,
        players: room.players.map((p) => ({
            id: p.id,
            nickname: p.nickname,
            isConnected: p.isConnected,
        })),
    };
}
