const express = require('express');
const router = express.Router();
const { getRoom } = require('../roomManager');

/** Health check */
router.get('/health', (req, res) => {
    res.json({ status: 'ok', ts: Date.now() });
});

/** Check if a room exists */
router.get('/room/:code', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) return res.status(404).json({ exists: false });
    res.json({
        exists: true,
        phase: room.phase,
        playerCount: room.players.length,
    });
});

module.exports = router;
