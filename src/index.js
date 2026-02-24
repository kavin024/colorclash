require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const apiRoutes = require('./routes/api');
const registerHandlers = require('./socketHandlers');

const PORT = process.env.PORT || 3001;

// Support multiple origins: comma-separated in env (e.g. Netlify + localhost)
const RAW_ORIGINS = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const ALLOWED_ORIGINS = RAW_ORIGINS.split(',').map((o) => o.trim());

function corsOriginFn(origin, callback) {
    // Allow requests with no origin (server-to-server, Render health checks)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: ${origin} not allowed`));
}

const app = express();
const server = http.createServer(app);

// ── Middleware ──────────────────────────────────────
app.use(cors({ origin: corsOriginFn, credentials: true }));
app.use(express.json());
app.use(
    rateLimit({
        windowMs: 60 * 1000,
        max: 300,
        standardHeaders: true,
        legacyHeaders: false,
    })
);

// ── REST Routes ─────────────────────────────────────
app.use('/api', apiRoutes);

// Root — useful for Render health pings
app.get('/', (_, res) => res.json({ status: 'ok', service: 'color-clash-server' }));

// ── Socket.io ───────────────────────────────────────
const io = new Server(server, {
    cors: {
        origin: corsOriginFn,
        methods: ['GET', 'POST'],
        credentials: true,
    },
    // Improve reliability on Render free tier (has cold-starts and reconnects)
    pingTimeout: 60000,
    pingInterval: 25000,
    // Allow transport fallback: websocket first, then polling
    transports: ['websocket', 'polling'],
});

registerHandlers(io);

// ── Start ───────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🃏 Color Clash server running on port ${PORT}`);
    console.log(`   Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
