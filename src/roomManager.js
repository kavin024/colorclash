/**
 * Color Clash – Room Manager
 * In-memory store of all rooms and their game states.
 */

const { v4: uuidv4 } = require('uuid');
const {
    createDeck,
    shuffle,
    dealCards,
} = require('./gameEngine');

// Map<roomCode, RoomObject>
const rooms = new Map();

/** Generate a unique 6-character alphanumeric room code */
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

/** Create a new room. Returns the room object. */
function createRoom(socketId, nickname) {
    const code = generateRoomCode();
    const player = {
        id: socketId,
        nickname: nickname.trim().slice(0, 20) || 'Player',
        isConnected: true,
        hand: [],
        clashSafe: false,
    };
    const room = {
        code,
        hostId: socketId,
        players: [player],
        phase: 'lobby', // lobby | game | results
        game: null,
        chat: [],
    };
    rooms.set(code, room);
    return room;
}

/** Join an existing room. Returns { room, error }. */
function joinRoom(socketId, roomCode, nickname) {
    const room = rooms.get(roomCode.toUpperCase());
    if (!room) return { error: 'Room not found.' };
    if (room.phase !== 'lobby') return { error: 'Game already in progress.' };
    if (room.players.length >= 6) return { error: 'Room is full (max 6 players).' };

    // Check for duplicate nickname
    const cleanNick = nickname.trim().slice(0, 20) || 'Player';
    const existing = room.players.find((p) => p.id === socketId);
    if (existing) return { room }; // already in (reconnect during lobby)

    const player = {
        id: socketId,
        nickname: cleanNick,
        isConnected: true,
        hand: [],
        clashSafe: false,
    };
    room.players.push(player);
    return { room };
}

/** Remove a player from the room. Cleans up empty rooms. */
function leaveRoom(socketId) {
    for (const [code, room] of rooms.entries()) {
        const idx = room.players.findIndex((p) => p.id === socketId);
        if (idx === -1) continue;

        if (room.phase === 'lobby') {
            room.players.splice(idx, 1);
            if (room.players.length === 0) {
                rooms.delete(code);
                return { deleted: true, code };
            }
            // Transfer host if needed
            if (room.hostId === socketId && room.players.length > 0) {
                room.hostId = room.players[0].id;
            }
        } else {
            // During game, mark as disconnected
            room.players[idx].isConnected = false;
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

/** Start the game. Returns { room, error }. */
function startGame(roomCode, hostSocketId) {
    const room = rooms.get(roomCode);
    if (!room) return { error: 'Room not found.' };
    if (room.hostId !== hostSocketId) return { error: 'Only the host can start the game.' };
    if (room.players.length < 2) return { error: 'Need at least 2 players to start.' };
    if (room.phase !== 'lobby') return { error: 'Game already started.' };

    // Build game state
    const deck = shuffle(createDeck());
    room.game = {
        phase: 'game',
        drawPile: deck,
        discardPile: [],
        currentPlayerIndex: 0,
        currentColor: 'red',
        direction: 1, // 1 = clockwise, -1 = counter-clockwise
        players: room.players.map((p) => ({ ...p, hand: [], clashSafe: false })),
        turnStartedAt: Date.now(),
        winner: null,
        clashCalledBy: null,
    };

    dealCards(room.game);
    room.phase = 'game';

    // sync hand references back to room.players (for reconnect)
    room.players = room.game.players;

    return { room };
}

/** Handle reconnect: remap old socketId to new socketId. */
function reconnectPlayer(roomCode, oldSocketId, newSocketId, nickname) {
    const room = rooms.get(roomCode);
    if (!room) return { error: 'Room not found.' };

    // Find by old ID or nickname
    let player = room.players.find((p) => p.id === oldSocketId);
    if (!player && nickname) {
        player = room.players.find(
            (p) => p.nickname === nickname.trim() && !p.isConnected
        );
    }
    if (!player) {
        // Fresh join during lobby
        return joinRoom(newSocketId, roomCode, nickname);
    }

    player.id = newSocketId;
    player.isConnected = true;

    // Also update hostId if host reconnected
    if (room.hostId === oldSocketId) room.hostId = newSocketId;

    return { room };
}

/** Return room by code */
function getRoom(roomCode) {
    return rooms.get(roomCode?.toUpperCase());
}

/** Return which room a socket is in */
function getRoomBySocket(socketId) {
    for (const room of rooms.values()) {
        if (room.players.find((p) => p.id === socketId)) return room;
    }
    return null;
}

module.exports = {
    createRoom,
    joinRoom,
    leaveRoom,
    kickPlayer,
    startGame,
    reconnectPlayer,
    getRoom,
    getRoomBySocket,
    rooms,
};
