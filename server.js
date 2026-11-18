require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('node:fs/promises');
const jwt = require('jsonwebtoken');
const {
    makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const logger = pino({ level: LOG_LEVEL });

const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : ['*'];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

app.use(express.json({ limit: '10mb' }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
});

let sock = null;
let qrBase64 = null;
let isReady = false;
let sockInfo = null;

// reset / single-session guards
let isResetting = false;
let suppressReconnect = false;
let generation = 0;

const JWT_SECRET = process.env.JWT_SECRET || '';
const RESET_ALLOWED_ROLES = (process.env.RESET_ALLOWED_ROLES || 'SUPER_ADMIN,ADMIN_TOKO')
    .split(',').map(s => s.trim()).filter(Boolean);

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function waitForQr(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        if (qrBase64) return resolve(qrBase64);
        const timeout = setTimeout(() => {
            clearInterval(interval);
            reject(new Error('QR timeout'));
        }, timeoutMs);
        const interval = setInterval(() => {
            if (qrBase64) {
                clearTimeout(timeout);
                clearInterval(interval);
                resolve(qrBase64);
            }
        }, 500);
    });
}

// Proteksi endpoint mutasi: hanya user login (JWT app POS) dengan role yang diizinkan.
function verifyAppAuth(req, res, next) {
    if (!JWT_SECRET) {
        return res.status(500).json({ status: false, error: 'JWT_SECRET belum dikonfigurasi di server' });
    }
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
        return res.status(401).json({ status: false, error: 'Token tidak ada' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (RESET_ALLOWED_ROLES.length > 0 && !RESET_ALLOWED_ROLES.includes(decoded.role)) {
            return res.status(403).json({ status: false, error: 'Role tidak berhak melakukan aksi ini' });
        }
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ status: false, error: 'Token tidak valid atau kedaluwarsa' });
    }
}

function normalizeNumber(input) {
    if (!input || typeof input !== 'string') return null;
    if (input.includes('@')) return input;

    const cleaned = input.trim();
    let digits = cleaned.replace(/[^+0-9]/g, '');
    if (!digits) return null;

    if (digits.startsWith('+')) digits = digits.slice(1);

    if (digits.startsWith('0')) {
        digits = '62' + digits.slice(1);
    }

    const onlyDigits = digits.replace(/\D/g, '');
    if (onlyDigits.length < 8) return null;

    return onlyDigits + '@s.whatsapp.net';
}

async function createSocket() {
    const myGen = ++generation;
    const authPath = process.env.BAILEYS_AUTH_PATH || './auth';
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();
    logger.info({ authPath, version, generation: myGen }, 'Initializing Baileys socket');

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger.child({ level: 'silent' }))
        },
        logger: logger.child({ level: 'silent' }),
        browser: ['POS WhatsApp API', 'Chrome', '1.0.0'],
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 500,
        maxMsgRetryCount: 3
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                qrBase64 = await qrcode.toDataURL(qr);
                logger.info('QR code generated - GET /qr to display');
                if (process.env.BAILEYS_LOG_QR === 'true') {
                    const ascii = await qrcode.toString(qr, { type: 'terminal', small: true });
                    console.log(ascii);
                }
            } catch (e) {
                logger.error({ err: e }, 'QR toDataURL error');
                qrBase64 = null;
            }
        }

        if (connection === 'open') {
            isReady = true;
            qrBase64 = null;
            sockInfo = {
                wid: sock.user.id,
                pushName: sock.user.name,
                platform: sock.user.platform
            };
            logger.info({ sockInfo }, 'WhatsApp connected and ready');
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            // Abaikan event close dari socket usang (sudah di-reset/diganti).
            if (myGen !== generation) {
                logger.debug({ generation: myGen, current: generation }, 'Ignoring close from stale socket');
                return;
            }

            isReady = false;
            sockInfo = null;
            logger.warn({ statusCode, loggedOut }, 'Connection closed');

            if (!loggedOut && !suppressReconnect) {
                logger.info('Reconnecting in 5s...');
                await sleep(5000);
                if (myGen === generation && !suppressReconnect) {
                    createSocket().catch(e => logger.error({ err: e }, 'Reconnect failed'));
                }
            } else {
                logger.info({ suppressReconnect, loggedOut }, 'No auto-reconnect');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe && msg.message) {
                    logger.info({ from: msg.key.remoteJid }, 'Incoming message received');
                }
            }
        }
    });

    return sock;
}

createSocket().catch(e => logger.error({ err: e }, 'Initial socket setup failed'));

// Hentikan socket lama, hapus sesi, lalu buat sesi baru (hanya 1 sesi aktif).
async function resetSession() {
    if (isResetting) {
        const err = new Error('Sedang membuat sesi baru');
        err.code = 'RESET_IN_PROGRESS';
        throw err;
    }
    isResetting = true;
    suppressReconnect = true;

    try {
        if (sock) {
            try { sock.ev.removeAllListeners(); } catch (e) { logger.warn({ err: e }, 'removeAllListeners failed'); }
            try { await sock.logout(); } catch (e) { logger.warn({ err: e }, 'logout during reset failed'); }
            try { sock.end(undefined); } catch (e) { logger.warn({ err: e }, 'end during reset failed'); }
            sock = null;
        }

        isReady = false;
        sockInfo = null;
        qrBase64 = null;

        const authPath = process.env.BAILEYS_AUTH_PATH || './auth';
        try {
            await fs.rm(authPath, { recursive: true, force: true });
            logger.info({ authPath }, 'Sesi lama dihapus');
        } catch (e) {
            logger.warn({ err: e, authPath }, 'Gagal menghapus folder auth');
        }

        await sleep(500);
        suppressReconnect = false;

        await createSocket();
        const qr = await waitForQr(20000);
        return qr;
    } finally {
        isResetting = false;
    }
}

app.post('/session/reset', verifyAppAuth, async (req, res) => {
    try {
        const qr = await resetSession();
        return res.json({ status: true, qr, message: 'Sesi baru dibuat' });
    } catch (err) {
        if (err && err.code === 'RESET_IN_PROGRESS') {
            return res.status(409).json({ status: false, error: err.message });
        }
        if (err && err.message === 'QR timeout') {
            return res.status(504).json({ status: false, error: 'QR timeout, coba lagi' });
        }
        logger.error({ err }, 'Reset session error');
        return res.status(500).json({ status: false, error: err.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', ready: isReady, uptime: process.uptime() });
});

app.get('/qr', async (req, res) => {
    try {
        if (isReady && sock) {
            return res.json({ status: true, qr: null, message: 'Already connected', info: sockInfo });
        }

        if (qrBase64) {
            return res.json({ status: true, qr: qrBase64 });
        }

        const qr = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                clearInterval(checkQr);
                reject(new Error('QR timeout'));
            }, 30000);

            const checkQr = setInterval(() => {
                if (qrBase64) {
                    clearTimeout(timeout);
                    clearInterval(checkQr);
                    resolve(qrBase64);
                }
                if (isReady) {
                    clearTimeout(timeout);
                    clearInterval(checkQr);
                    resolve(null);
                }
            }, 500);
        });

        if (!qr) {
            return res.json({ status: true, qr: null, message: 'Already connected', info: sockInfo });
        }
        return res.json({ status: true, qr });
    } catch (err) {
        logger.error({ err }, 'Failed to get QR');
        return res.status(500).json({ status: false, error: 'Failed to generate QR' });
    }
});

app.get('/status', (req, res) => {
    res.json({ ready: isReady, info: sockInfo });
});

app.post('/send', async (req, res) => {
    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).json({ error: 'Missing number or message' });
    }

    const normalized = normalizeNumber(number);
    if (!normalized) {
        return res.status(400).json({ error: 'Invalid phone number format' });
    }

    if (!sock || !isReady) {
        return res.status(503).json({ ok: false, error: 'WhatsApp not ready' });
    }

    try {
        const sent = await sock.sendMessage(normalized, { text: message });
        logger.info({ to: normalized, id: sent.key.id }, 'Message sent');
        res.json({ ok: true, id: sent.key.id });
    } catch (err) {
        logger.error({ err, to: normalized }, 'Send message error');
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/send-file', upload.single('file'), async (req, res) => {
    const { number, caption } = req.body;

    if (!number) {
        return res.status(400).json({ error: 'Missing number' });
    }

    const normalized = normalizeNumber(number);
    if (!normalized) {
        return res.status(400).json({ error: 'Invalid phone number format' });
    }

    if (!sock || !isReady) {
        return res.status(503).json({ ok: false, error: 'WhatsApp not ready; try again in a few seconds' });
    }

    try {
        let buffer = null;
        let mimeType = 'application/pdf';
        let filename = 'file.pdf';

        if (req.file && req.file.buffer) {
            buffer = req.file.buffer;
            mimeType = req.file.mimetype || mimeType;
            filename = req.file.originalname || filename;
        } else if (req.body.fileBase64) {
            const b64 = req.body.fileBase64;
            const match = /^data:(.+);base64,(.+)$/.exec(b64);
            let base64data = b64;
            if (match) {
                mimeType = match[1] || mimeType;
                base64data = match[2];
            } else if (req.body.mimeType) {
                mimeType = req.body.mimeType;
            }
            buffer = Buffer.from(base64data, 'base64');
            if (req.body.filename) filename = req.body.filename;
        } else if (req.body.fileUrl) {
            const resp = await fetch(req.body.fileUrl);
            if (!resp.ok) {
                return res.status(400).json({ error: 'Failed to fetch file from URL' });
            }
            const arrayBuf = await resp.arrayBuffer();
            buffer = Buffer.from(arrayBuf);
            mimeType = resp.headers.get('content-type') || mimeType;
            const urlParts = req.body.fileUrl.split('/');
            filename = urlParts[urlParts.length - 1] || filename;
        } else {
            return res.status(400).json({
                error: 'No file provided. Use multipart upload (file), fileBase64, or fileUrl.'
            });
        }

        if (!buffer || buffer.length === 0) {
            return res.status(400).json({ error: 'Empty file' });
        }

        const isPdf = mimeType.includes('pdf');
        const isImage = mimeType.startsWith('image/');
        const isVideo = mimeType.startsWith('video/');
        const isDocument = mimeType.includes('document') || mimeType.includes('spreadsheet') || mimeType.includes('presentation');

        if (!isPdf && !isImage && !isVideo && !isDocument) {
            return res.status(400).json({ error: 'Only PDF, image, video, or document files are allowed' });
        }

        let messageContent;
        if (isImage) {
            messageContent = { image: buffer, caption: caption || '', mimetype: mimeType };
        } else if (isVideo) {
            messageContent = { video: buffer, caption: caption || '', mimetype: mimeType };
        } else {
            messageContent = { document: buffer, mimetype: mimeType, fileName: filename, caption: caption || '' };
        }

        logger.info({ to: normalized, filename, mimeType, size: buffer.length }, 'Sending file');
        const sent = await sock.sendMessage(normalized, messageContent);
        logger.info({ to: normalized, id: sent.key.id }, 'File sent successfully');

        return res.json({ ok: true, id: sent.key.id });
    } catch (err) {
        logger.error({ err, to: normalized }, 'Send file error');
        return res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/logout', verifyAppAuth, async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
            logger.info('Logged out successfully');
        }
        res.json({ status: true, message: 'Logged out' });
    } catch (err) {
        logger.error({ err }, 'Logout error');
        res.status(500).json({ status: false, error: err.message });
    }
});

app.post('/client/restart', verifyAppAuth, async (req, res) => {
    try {
        if (sock) {
            try { await sock.logout(); } catch (e) { logger.warn({ err: e }, 'logout on restart failed'); }
        }
        await sleep(1000);
        await createSocket();
        res.json({ status: true, message: 'Client restarting' });
    } catch (err) {
        logger.error({ err }, 'Restart error');
        res.status(500).json({ status: false, error: err.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Server running');
});

async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down');
    try {
        if (sock) await sock.logout();
    } catch (e) {
        logger.warn({ err: e }, 'logout on shutdown failed');
    }
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));