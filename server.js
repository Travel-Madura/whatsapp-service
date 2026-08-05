// ═══════════════════════════════════
// POLYFILL: crypto untuk Node.js 18/20
// ═══════════════════════════════════
const crypto = require('crypto');

// Patch global crypto jika belum ada
if (!globalThis.crypto) {
    globalThis.crypto = {
        getRandomValues: (buffer) => {
            return crypto.randomFillSync(buffer);
        },
        randomUUID: () => {
            return crypto.randomUUID();
        },
        subtle: {
            digest: async (algorithm, buffer) => {
                const hash = crypto.createHash(algorithm.replace('-', '').toLowerCase());
                hash.update(Buffer.from(buffer));
                return hash.digest();
            },
            importKey: async (format, keyData, algorithm, extractable, keyUsages) => {
                return crypto.createSecretKey(keyData);
            },
            deriveBits: async (algorithm, baseKey, length) => {
                const { createHmac } = require('crypto');
                const hmac = createHmac('sha256', baseKey);
                return hmac.digest();
            }
        }
    };
}

const express = require('express');
const dotenv = require('dotenv');
const fs = require('fs');

// Baileys v7
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    delay,
} = require('@whiskeysockets/baileys');

// Note: @hapi/boom is a transitive dependency of baileys.
// We avoid direct import for stability; use statusCode checks instead.
const pino = require('pino');
const qrcode = require('qrcode-terminal');

dotenv.config();

// Validate required env vars
if (!process.env.API_KEY) {
    console.error('❌ ERROR: API_KEY is required in .env');
    process.exit(1);
}
if (!process.env.PHONE_NUMBER) {
    console.error('❌ ERROR: PHONE_NUMBER is required in .env');
    process.exit(1);
}

const app = express();
app.use(express.json());

// ═══════════════════════════════════
// CONFIG - SEMUA DARI .ENV
// ═══════════════════════════════════
const CONFIG = {
    PORT: process.env.PORT || 3001,
    API_KEY: process.env.API_KEY,
    AUTH_DIR: process.env.AUTH_DIR || './auth_info',
    PHONE_NUMBER: process.env.PHONE_NUMBER,

    // Anti-Banned Settings
    MIN_DELAY: parseInt(process.env.MIN_DELAY) || 15000,
    MAX_DELAY: parseInt(process.env.MAX_DELAY) || 35000,
    MAX_PER_HOUR: parseInt(process.env.MAX_PER_HOUR) || 10,
    MAX_PER_DAY: parseInt(process.env.MAX_PER_DAY) || 50,
    
    // Jam Operasional (default 24 jam)
    OPERATING_START: parseInt(process.env.OPERATING_START) || 0,
    OPERATING_END: parseInt(process.env.OPERATING_END) || 24,
    
    RETRY_DELAY: parseInt(process.env.RETRY_DELAY) || 60000,
    MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || 3,
    
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

// ═══════════════════════════════════
// LOGGER
// ═══════════════════════════════════
const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    },
    level: CONFIG.LOG_LEVEL,
});

// ═══════════════════════════════════
// MESSAGE QUEUE
// ═══════════════════════════════════
const messageQueue = [];
let isProcessing = false;
let todayCount = 0;
let hourlyCount = 0;
let todayDate = new Date().toDateString();
let currentHour = new Date().getHours();
let totalSent = 0;
let lastSentTime = null;
let sock = null;
let state = null;
let pairingCodeAttempted = false;
let lastResetTime = 0; // cooldown untuk reset-auth

// Simple rate limiter
const rateLimitStore = new Map();
function rateLimit(ip, limit = 30, windowMs = 60000) {
    const now = Date.now();
    const entry = rateLimitStore.get(ip) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
    entry.count++;
    rateLimitStore.set(ip, entry);
    return entry.count <= limit;
}
// Cleanup rate limit store setiap 5 menit
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitStore) {
        if (now > entry.resetAt) rateLimitStore.delete(ip);
    }
}, 300000);

function resetDaily() {
    const today = new Date().toDateString();
    if (today !== todayDate) {
        logger.info('📅 New day! Counter reset.');
        todayDate = today;
        todayCount = 0;
    }
    const hour = new Date().getHours();
    if (hour !== currentHour) {
        currentHour = hour;
        hourlyCount = 0;
    }
}

function canSend() {
    resetDaily();
    if (!isOperatingHours()) return { ok: false, reason: `Outside operating hours (${CONFIG.OPERATING_START}:00-${CONFIG.OPERATING_END}:00)` };
    if (hourlyCount >= CONFIG.MAX_PER_HOUR) return { ok: false, reason: `Hourly limit reached (${CONFIG.MAX_PER_HOUR}/hour)` };
    if (todayCount >= CONFIG.MAX_PER_DAY) return { ok: false, reason: `Daily limit reached (${CONFIG.MAX_PER_DAY}/day)` };
    return { ok: true };
}

function randomDelay() {
    return Math.floor(Math.random() * (CONFIG.MAX_DELAY - CONFIG.MIN_DELAY + 1)) + CONFIG.MIN_DELAY;
}

function isOperatingHours() {
    const hour = new Date().getHours();
    const isActive = hour >= CONFIG.OPERATING_START && hour < CONFIG.OPERATING_END;
    
    if (!isActive && messageQueue.length > 0) {
        logger.debug(`⏸️ Outside operating hours (${CONFIG.OPERATING_START}:00-${CONFIG.OPERATING_END}:00)`);
    }
    
    return isActive;
}

async function processQueue() {
    if (isProcessing || messageQueue.length === 0) return;
    if (!sock) {
        setTimeout(processQueue, 5000);
        return;
    }

    isProcessing = true;

    while (messageQueue.length > 0) {
        const { phone, message, resolve, reject, retries = 0 } = messageQueue[0];
        const check = canSend();

        if (!check.ok) {
            logger.info(`⏸️ Queue paused: ${check.reason}`);
            isProcessing = false;
            setTimeout(processQueue, 60000);
            return;
        }

        try {
            const ms = randomDelay();
            logger.info(`⏳ [${phone}] Sending in ${(ms/1000).toFixed(1)}s (${todayCount + 1}/${CONFIG.MAX_PER_DAY})`);
            await delay(ms);

            const jid = phone.includes('@s.whatsapp.net') ? phone : `${phone}@s.whatsapp.net`;
            const result = await sock.sendMessage(jid, { text: message });

            todayCount++;
            hourlyCount++;
            totalSent++;
            lastSentTime = new Date();

            logger.info(`✅ [${phone}] Sent! ID: ${result.key.id}`);
            messageQueue.shift();
            resolve({ success: true, phone, messageId: result.key.id });
            await delay(2000);

        } catch (error) {
            logger.error(`❌ [${phone}] ${error.message}`);
            if (retries < CONFIG.MAX_RETRIES) {
                messageQueue[0].retries = retries + 1;
                logger.info(`🔄 Retry ${retries + 1}/${CONFIG.MAX_RETRIES}`);
                await delay(CONFIG.RETRY_DELAY);
            } else {
                messageQueue.shift();
                reject(error);
            }
        }
    }

    isProcessing = false;
}

function queueMessage(phone, message) {
    return new Promise((resolve, reject) => {
        let clean = phone.replace(/[^0-9]/g, '');
        if (clean.startsWith('0')) clean = '62' + clean.slice(1);
        if (!clean.startsWith('62')) clean = '62' + clean;

        messageQueue.push({ phone: clean, message, resolve, reject, retries: 0, queuedAt: new Date() });
        logger.info(`📨 Queued [${clean}] (Queue: ${messageQueue.length})`);
        processQueue();
    });
}

// ═══════════════════════════════════
// FORCE RESET AUTH
// ═══════════════════════════════════
async function forceResetAuth() {
    try {
        logger.warn('🗑️ Force resetting auth...');
        
        if (sock) {
            try {
                await sock.end();
            } catch (e) {}
            sock = null;
        }
        
        if (fs.existsSync(CONFIG.AUTH_DIR)) {
            fs.rmSync(CONFIG.AUTH_DIR, { recursive: true, force: true });
            logger.info('✅ Auth folder deleted!');
        }
        
        if (state) {
            state.creds.registered = false;
        }
        pairingCodeAttempted = false;
        
        logger.info('🔄 Restarting with fresh auth in 3s...');
        await delay(3000);
        connectWA();
        
    } catch (err) {
        logger.error('❌ Gagal reset auth:', err.message);
    }
}

// ═══════════════════════════════════
// WHATSAPP CONNECTION - V7 COMPATIBLE
// ═══════════════════════════════════
async function connectWA() {
    if (!fs.existsSync(CONFIG.AUTH_DIR)) {
        fs.mkdirSync(CONFIG.AUTH_DIR, { recursive: true });
    }

    const { state: authState, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_DIR);
    state = authState;

    // V7: Browser format berbeda
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Mac OS', 'Desktop', '10.15.7'], // V7 format
        logger: logger.child({ level: 'warn' }),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        // V7: tambahan config
        patchMessageBeforeSending: (message) => {
            return message;
        },
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ── QR CODE & PAIRING CODE ──
        if (qr && !state.creds.registered && !pairingCodeAttempted) {
            console.log('');
            console.log('╔══════════════════════════════════════════════════╗');
            console.log('║     📱 SCAN QR ATAU PAKAI PAIRING CODE           ║');
            console.log('╚══════════════════════════════════════════════════╝');
            console.log('');

            console.log('┌──────────────────────────────────────────────────┐');
            console.log('│  📱 OPSI 1: SCAN QR CODE                        │');
            console.log('└──────────────────────────────────────────────────┘');
            console.log('');
            
            qrcode.generate(qr, { small: true });

            const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=' + encodeURIComponent(qr);
            console.log('');
            console.log('🔗 QR URL (Buka di browser):');
            console.log('   ' + qrUrl);
            console.log('');
            console.log('📋 Raw QR (copy ke WhatsApp Web):');
            console.log('   ' + qr);
            console.log('');

            console.log('┌──────────────────────────────────────────────────┐');
            console.log('│  🔑 OPSI 2: PAKAI PAIRING CODE                  │');
            console.log('└──────────────────────────────────────────────────┘');
            console.log('');

            try {
                // V7: requestPairingCode mungkin berbeda
                const code = await sock.requestPairingCode(CONFIG.PHONE_NUMBER);
                
                console.log('╔══════════════════════════════════════════════════╗');
                console.log('║                                                  ║');
                console.log(`║   🔑 PAIRING CODE: ${code}                           ║`);
                console.log('║                                                  ║');
                console.log('╚══════════════════════════════════════════════════╝');
                console.log('');
                console.log('📱 CARA PAKAI PAIRING CODE:');
                console.log('1. Buka WhatsApp di HP');
                console.log('2. Settings → Linked Devices → Link a Device');
                console.log(`3. Masukkan kode: ${code}`);
                console.log('');
                console.log('⏰ Kode berlaku 5-10 menit!');
                console.log('');

                pairingCodeAttempted = true;

            } catch (error) {
                console.log('❌ Pairing code error:', error.message);
                console.log('ℹ️ Pakai QR Code saja untuk login.');
                console.log('');
            }

            console.log('┌──────────────────────────────────────────────────┐');
            console.log('│  ⏳ Tunggu sampai konek...                      │');
            console.log('└──────────────────────────────────────────────────┘');
            console.log('');
        }

        // ── HANDLE CONNECTION CLOSE ──
        if (connection === 'close') {
            const error = lastDisconnect?.error;
            const errorMessage = error?.message || 'Unknown';
            const statusCode = error?.output?.statusCode;
            
            logger.error(`❌ Disconnected: ${errorMessage}`);

            // Hanya force reset untuk auth-related errors
            const shouldForceReset = 
                errorMessage.includes('Invalid account signature') ||
                statusCode === DisconnectReason.loggedOut ||
                statusCode === 401 ||
                statusCode === 403;

            // Network errors: retry reconnect (jangan hapus auth!)
            const isNetworkError = 
                errorMessage.includes('Connection Failure') ||
                errorMessage.includes('Timed Out') ||
                errorMessage.includes('connect ECONNREFUSED') ||
                errorMessage.includes('WebSocket was closed') ||
                statusCode === 408 ||
                statusCode === 440;

            if (shouldForceReset) {
                logger.error(`🚫 AUTH ERROR DETECTED: ${errorMessage}`);
                await forceResetAuth();
                return;
            }

            if (isNetworkError) {
                logger.info(`🌐 Network error, reconnecting in 10s (preserving auth)...`);
                await delay(10000);
                connectWA();
                return;
            }

            // Default: coba reconnect
            if (statusCode !== DisconnectReason.loggedOut) {
                logger.info('🔄 Reconnecting in 5s...');
                await delay(5000);
                connectWA();
            } else {
                logger.error('🚫 LOGGED OUT! Silakan restart manual.');
            }
            
        } else if (connection === 'open') {
            console.log('');
            console.log('╔══════════════════════════════════════════╗');
            console.log('║   ✅ WHATSAPP CONNECTED!                 ║');
            console.log(`║   Name: ${sock.user?.name || 'Unknown'}`);
            console.log(`║   Number: ${sock.user?.id || 'Unknown'}`);
            console.log('║   Ready to send messages!               ║');
            console.log('╚══════════════════════════════════════════╝');
            console.log('');
            
            pairingCodeAttempted = true;
        }
    });

    return sock;
}

// ═══════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════
function auth(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (key !== CONFIG.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Global rate limiting middleware
app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (!rateLimit(ip, 60, 60000)) {
        return res.status(429).json({ error: 'Too many requests, slow down!' });
    }
    next();
});

app.post('/send', auth, async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Phone and message required' });
    if (!sock) return res.status(503).json({ error: 'WhatsApp not connected' });

    try {
        const result = await queueMessage(phone, message);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/send-bulk', auth, async (req, res) => {
    const { messages } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'Messages required' });

    const results = [];
    for (const m of messages) {
        try { results.push(await queueMessage(m.phone, m.message)); }
        catch (e) { results.push({ success: false, phone: m.phone, error: e.message }); }
    }
    res.json({ success: true, results });
});

app.get('/status', auth, (req, res) => {
    const operatingStart = CONFIG.OPERATING_START;
    const operatingEnd = CONFIG.OPERATING_END;
    const isActive = isOperatingHours();
    
    res.json({
        connected: !!sock?.user,
        user: sock?.user?.name || null,
        number: sock?.user?.id || null,
        queue: messageQueue.length,
        today: todayCount,
        hourly: hourlyCount,
        hourlyLimit: CONFIG.MAX_PER_HOUR,
        total: totalSent,
        limit: CONFIG.MAX_PER_DAY,
        remaining: Math.max(0, CONFIG.MAX_PER_DAY - todayCount),
        lastSent: lastSentTime,
        uptime: process.uptime(),
        operatingHours: `${operatingStart}:00 - ${operatingEnd}:00`,
        isOperatingHours: isActive,
        baileysVersion: require('./package.json').dependencies['@whiskeysockets/baileys'] || 'unknown',
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        connected: !!sock?.user, 
        timestamp: new Date().toISOString()
    });
});

app.post('/reset-auth', auth, async (req, res) => {
    const now = Date.now();
    const cooldownMs = 300000; // 5 menit cooldown
    if (now - lastResetTime < cooldownMs) {
        const remaining = Math.ceil((cooldownMs - (now - lastResetTime)) / 1000);
        return res.status(429).json({ 
            error: `Reset auth cooldown active. Try again in ${remaining}s`,
            cooldownRemaining: remaining
        });
    }
    try {
        lastResetTime = now;
        logger.warn('🗑️ Manual reset auth requested!');
        await forceResetAuth();
        res.json({ success: true, message: 'Auth reset, reconnecting...' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/auth-files', auth, (req, res) => {
    try {
        const files = fs.existsSync(CONFIG.AUTH_DIR) 
            ? fs.readdirSync(CONFIG.AUTH_DIR) 
            : [];
        res.json({ 
            authDir: CONFIG.AUTH_DIR,
            exists: fs.existsSync(CONFIG.AUTH_DIR),
            files: files,
            fileCount: files.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════
// START
// ═══════════════════════════════════
app.listen(CONFIG.PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   GoMad WhatsApp Service (Baileys v7)    ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log(`   🚀 Port: ${CONFIG.PORT}`);
    console.log(`   🔑 API Key: ${CONFIG.API_KEY.substring(0, 10)}...`);
    console.log(`   🛡️  Delay: ${CONFIG.MIN_DELAY/1000}-${CONFIG.MAX_DELAY/1000}s`);
    console.log(`   📊 Limit: ${CONFIG.MAX_PER_HOUR}/hour, ${CONFIG.MAX_PER_DAY}/day`);
    console.log(`   🕐 Hours: ${CONFIG.OPERATING_START}:00-${CONFIG.OPERATING_END}:00`);
    console.log(`   📱 Phone: ${CONFIG.PHONE_NUMBER}`);
    console.log('');
    console.log('   🔄 Waiting for WhatsApp connection...');
    console.log('');
});

connectWA();