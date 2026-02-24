/**
 * Color Clash – Room Manager
 * In-memory store with grace-period disconnect support.
 */

const { v4: uuidv4 } = require('uuid');
const { createDeck, shuffle, dealCards } = require('./gameEngine');

const rooms = new Map();
const MAX_PLAYERS = 8;

// Grace period: how long (ms) a player can be offline before being skipped over
const DISCONNECT_GRACE_MS = 30000;   // 30s — enough for Render cold-start reconnect
const disconnectTimers = new Map();  // `${roomCode}:${playerId}` → timer handle

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = Array.from({ length: 6 }, () =>
            chars[Math.floor(Math.random() * chars.length)]
        ).join('');
    } while (rooms.has(code));
    return code;
}

/** Create a new room. */
function createRoom(socketId, nickname) {
    const code = generateRoomCode();
    const player = makePlayer(socketId, nickname);
    const room = {
        code, hostId: socketId,
        players: [player],
        phase: 'lobby',
        game: null, chat: [],
    };
    rooms.set(code, room);
    return room;
}

/** Join an existing room. */
function joinRoom(socketId, roomCode, nickname) {
    const room = rooms.get(roomCode.toUpperCase());
    if (!room) return { error: 'Room not found.' };
    if (room.phase !== 'lobby') return { error: 'Game already in progress.' };
    if (room.players.length >= MAX_PLAYERS)
        return { error: `Room is full (max ${MAX_PLAYERS} players).` };

    const existing = room.players.find((p) => p.id === socketId);
    if (existing) return { room };

    room.players.push(makePlayer(socketId, nickname));
    return { room };
}

/** Mark player disconnected; start grace timer. */
function leaveRoom(socketId, io) {
    for (const [code, room] of rooms.entries()) {
        const idx = room.players.findIndex((p) => p.id === socketId);
        if (idx === -1) continue;

        if (room.phase === 'lobby') {
            // Remove immediately from lobby
            room.players.splice(idx, 1);
            if (room.players.length === 0) {
                rooms.delete(code);
                return { deleted: true, code };
            }
            if (room.hostId === socketId && room.players.length > 0)
                room.hostId = room.players[0].id;
        } else {
            // ── Game phase: grace period before skipping ──────────────────
            room.players[idx].isConnected = false;

            const timerKey = `${code}:${socketId}`;
            // Start grace timer — if they don't reconnect, skip their turns
            const handle = setTimeout(() => {
                disconnectTimers.delete(timerKey);
                // Player still offline after grace period — they stay in the
                // player list (so the game can continue) but keep isConnected=false.
                // The turn timer in socketHandlers already skips offline players.
                if (io && room.game) {
                    io.to(code).emit('room:updated', sanitizeRoomPublic(room));
                }
            }, DISCONNECT_GRACE_MS);
            disconnectTimers.set(timerKey, handle);
        }

        return { room, code };
    }
    return {};
}

/** Host kicks a player (lobby only). */
function kickPlayer(roomCode, hostSocketId, targetSocketId) {
    const room = rooms.get(roomCode);
    if (!room) return { error: 'Room not found.' };
    if (room.hostId !== hostSocketId) return { error: 'Only the host can kick players.' };
    if (room.phase !== 'lobby') return { error: 'Cannot kick during a game.' };
    const idx = room.players.findIndex((p) => p.id === targetSocketId);
    if (idx === -1) return { error: 'Player not found.' };
    room.players.splice(idx, 1);
    return { room };
}

/** Start the game. */
function startGame(roomCode, hostSocketId) {
    const room = rooms.get(roomCode);
    if (!room) return { error: 'Room not found.' };
    if (room.hostId !== hostSocketId) return { error: 'Only the host can start.' };
    if (room.players.length < 2) return { error: 'Need at least 2 players.' };
    if (room.phase !== 'lobby') return { error: 'Game already started.' };

    const deck = shuffle(createDeck());
    room.game = {
        phase: 'game',
        drawPile: deck,
        discardPile: [],
        currentPlayerIndex: 0,
        currentColor: 'red',
        direction: 1,
        players: room.players.map((p) => ({ ...p, hand: [], clashSafe: false })),
        turnStartedAt: Date.now(),
        winner: null,
        clashCalledBy: null,
    };
    dealCards(room.game);
    room.phase = 'game';
    room.players = room.game.players;
    return { room };
}

/**
 * Reconnect: remap old socketId → new socketId.
 * Cancels grace timer, marks player online again.
 */
function reconnectPlayer(roomCode, oldSocketId, newSocketId, nickname) {
    const room = rooms.get(roomCode);
    if (!room) return { error: 'Room not found.' };

    // Find by old ID first, then by nickname (for page-refresh case)
    let player = room.players.find((p) => p.id === oldSocketId);
    if (!player && nickname) {
        player = room.players.find(
            (p) => p.nickname === nickname.trim() && !p.isConnected
        );
    }

    if (!player) {
        // No match: treat as fresh join if still in lobby
        if (room.phase === 'lobby') return joinRoom(newSocketId, roomCode, nickname);
        return { error: 'Player not found in this game.' };
    }

    // Cancel any pending grace timer
    const timerKey = `${room.code}:${player.id}`;
    if (disconnectTimers.has(timerKey)) {
        clearTimeout(disconnectTimers.get(timerKey));
        disconnectTimers.delete(timerKey);
    }

    // Remap ID
    player.id = newSocketId;
    player.isConnected = true;
    if (room.hostId === oldSocketId) room.hostId = newSocketId;

    // Keep game.players in sync (they share the same objects after startGame)
    // but double-check the game array just in case
    if (room.game) {
        const gp = room.game.players.find(
            (p) => p.id === oldSocketId || p.nickname === player.nickname
        );
        if (gp) { gp.id = newSocketId; gp.isConnected = true; }
    }

    return { room };
}

/** Return a room by code. */
function getRoom(roomCode) {
    return rooms.get(roomCode?.toUpperCase());
}

/** Return which room a socket is in. */
function getRoomBySocket(socketId) {
    for (const room of rooms.values()) {
        if (room.players.find((p) => p.id === socketId)) return room;
    }
    return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function makePlayer(socketId, nickname) {
    return {
        id: socketId,
        nickname: (nickname || '').trim().slice(0, 20) || 'Player',
        isConnected: true,
        hand: [],
        clashSafe: false,
    };
}

/** Safe public room snapshot (no hands). */
function sanitizeRoomPublic(room) {
    return {
        code: room.code,
        hostId: room.hostId,
        phase: room.phase,
        players: room.players.map(({ id, nickname, isConnected }) =>
            ({ id, nickname, isConnected })),
    };
}

module.exports = {
    createRoom, joinRoom, leaveRoom, kickPlayer,
    startGame, reconnectPlayer, getRoom, getRoomBySocket,
    rooms, MAX_PLAYERS,
};
