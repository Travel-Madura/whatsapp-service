const express = require('express');
const dotenv = require('dotenv');
const fs = require('fs');

// Baileys
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    delay,
    Browsers,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

dotenv.config();

const app = express();
app.use(express.json());

// ═══════════════════════════════════
// CONFIG
// ═══════════════════════════════════
const CONFIG = {
    PORT: process.env.PORT || 3001,
    API_KEY: process.env.API_KEY || 'gomad-baileys-secret-key-2024',
    AUTH_DIR: process.env.AUTH_DIR || './auth_info',
    
    MIN_DELAY: parseInt(process.env.MIN_DELAY) || 15000,
    MAX_DELAY: parseInt(process.env.MAX_DELAY) || 35000,
    MAX_PER_HOUR: parseInt(process.env.MAX_PER_HOUR) || 10,
    MAX_PER_DAY: parseInt(process.env.MAX_PER_DAY) || 50,
    OPERATING_START: parseInt(process.env.OPERATING_START) || 7,
    OPERATING_END: parseInt(process.env.OPERATING_END) || 21,
    RETRY_DELAY: 60000,
    MAX_RETRIES: 3,
};

// ═══════════════════════════════════
// LOGGER
// ═══════════════════════════════════
const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    },
    level: process.env.LOG_LEVEL || 'info',
});

// ═══════════════════════════════════
// MESSAGE QUEUE
// ═══════════════════════════════════
const messageQueue = [];
let isProcessing = false;
let todayCount = 0;
let todayDate = new Date().toDateString();
let totalSent = 0;
let lastSentTime = null;
let sock = null;

function resetDaily() {
    const today = new Date().toDateString();
    if (today !== todayDate) {
        logger.info('📅 New day! Counter reset.');
        todayDate = today;
        todayCount = 0;
    }
}

function randomDelay() {
    return Math.floor(Math.random() * (CONFIG.MAX_DELAY - CONFIG.MIN_DELAY + 1)) + CONFIG.MIN_DELAY;
}

function isOperatingHours() {
    const hour = new Date().getHours();
    return hour >= CONFIG.OPERATING_START && hour < CONFIG.OPERATING_END;
}

function canSend() {
    resetDaily();
    if (!isOperatingHours()) return { ok: false, reason: 'Outside operating hours' };
    if (todayCount >= CONFIG.MAX_PER_DAY) return { ok: false, reason: 'Daily limit reached' };
    return { ok: true };
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
            logger.info(`⏸️  Queue paused: ${check.reason}`);
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
// WHATSAPP CONNECTION
// ═══════════════════════════════════
async function connectWA() {
    if (!fs.existsSync(CONFIG.AUTH_DIR)) {
        fs.mkdirSync(CONFIG.AUTH_DIR, { recursive: true });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_DIR);
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: Browsers.macOS('Desktop'),
        logger: logger.child({ level: 'warn' }),
        markOnlineOnConnect: false,
        syncFullHistory: false,
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('');
            console.log('┌─────────────────────────────────────────────┐');
            console.log('│  📱 SCAN QR CODE BELOW WITH WHATSAPP        │');
            console.log('│  WhatsApp → Linked Devices → Link a Device  │');
            console.log('└─────────────────────────────────────────────┘');
            console.log('');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;
            
            logger.error('❌ Disconnected: ' + (lastDisconnect?.error?.message || 'Unknown'));
            
            if (shouldReconnect) {
                logger.info('🔄 Reconnecting in 5s...');
                await delay(5000);
                connectWA();
            } else {
                logger.error('🚫 LOGGED OUT! Delete auth_info folder and restart.');
            }
        } else if (connection === 'open') {
            console.log('');
            console.log('╔══════════════════════════════════════════╗');
            console.log('║   ✅ WHATSAPP CONNECTED!                 ║');
            console.log(`║   Name: ${sock.user?.name || 'Unknown'}`);
            console.log('║   Ready to send messages!               ║');
            console.log('╚══════════════════════════════════════════╝');
            console.log('');
        }
    });
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
    res.json({
        connected: !!sock?.user,
        user: sock?.user?.name || null,
        queue: messageQueue.length,
        today: todayCount,
        total: totalSent,
        limit: CONFIG.MAX_PER_DAY,
        remaining: Math.max(0, CONFIG.MAX_PER_DAY - todayCount),
        lastSent: lastSentTime,
        uptime: process.uptime(),
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: !!sock?.user, timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════
// START
// ═══════════════════════════════════
app.listen(CONFIG.PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   GoMad WhatsApp Service (Baileys)       ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log(`   🚀 Port: ${CONFIG.PORT}`);
    console.log(`   🔑 API Key: ${CONFIG.API_KEY.substring(0, 10)}...`);
    console.log(`   🛡️  Delay: ${CONFIG.MIN_DELAY/1000}-${CONFIG.MAX_DELAY/1000}s`);
    console.log(`   📊 Limit: ${CONFIG.MAX_PER_DAY}/day`);
    console.log(`   🕐 Hours: ${CONFIG.OPERATING_START}:00-${CONFIG.OPERATING_END}:00`);
    console.log('');
});

connectWA();