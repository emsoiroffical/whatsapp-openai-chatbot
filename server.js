import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pino from 'pino';
import { OpenAI } from 'openai';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

let openai = null;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('OpenAI API successfully initialized. ✅');
} else {
    console.warn('⚠️ WARNING: OPENAI_API_KEY is missing!');
}

const chatHistories = new Map();

let connectionState = 'disconnected';
let qrCodeBase64 = null;
let sock = null;
let retryCount = 0;
const MAX_RETRIES = 15;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/status', (req, res) => {
    res.json({ state: connectionState, qr: qrCodeBase64, hasOpenAI: !!openai });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function connectToWhatsApp() {
    console.log(`\n🔄 WhatsApp connection attempt #${retryCount + 1}`);

    const authDir = path.join(__dirname, 'auth_info_baileys');
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    let version = [2, 3000, 1015901307];
    try {
        const result = await fetchLatestBaileysVersion();
        version = result.version;
        console.log(`Using WA v${version.join('.')}`);
    } catch(e) {
        console.log(`Using fallback WA version: ${version.join('.')}`);
    }

    connectionState = 'connecting';
    qrCodeBase64 = null;

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Safari'),
        connectTimeoutMs: 90_000,
        defaultQueryTimeoutMs: 90_000,
        keepAliveIntervalMs: 25_000,
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 5,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            retryCount = 0;
            connectionState = 'qr';
            console.log('\n--- SCAN THIS QR CODE ---');
            qrcodeTerminal.generate(qr, { small: true });
            console.log('-------------------------\n');
            try {
                qrCodeBase64 = await qrcode.toDataURL(qr, { scale: 8, margin: 2 });
            } catch (err) {
                console.error('QR error:', err);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const reason = lastDisconnect?.error?.message || 'Unknown';

            console.log(`❌ Connection closed. Code: ${statusCode} | Reason: ${reason}`);
            connectionState = 'disconnected';
            qrCodeBase64 = null;

            if (isLoggedOut) {
                console.log('Logged out — clearing session...');
                try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
                retryCount = 0;
                setTimeout(connectToWhatsApp, 3000);
            } else if (retryCount < MAX_RETRIES) {
                retryCount++;
                const delay = Math.min(5000 * retryCount, 30000);
                console.log(`⏳ Retry ${retryCount}/${MAX_RETRIES} in ${delay/1000}s...`);
                setTimeout(connectToWhatsApp, delay);
            } else {
                console.error('🚨 Max retries reached. Railway IP may be blocked by WhatsApp.');
            }

        } else if (connection === 'open') {
            console.log('✅ WhatsApp connected!');
            connectionState = 'connected';
            qrCodeBase64 = null;
            retryCount = 0;
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        console.log(`\n📬 Incoming messages.upsert event (count: ${m.messages?.length || 0})`);

        for (const msg of m.messages) {
            if (!msg.message) {
                console.log('Skipping: Message object is empty.');
                continue;
            }

            const from = msg.key.remoteJid;
            const fromMe = msg.key.fromMe;
            const isGroup = from.endsWith('@g.us');

            console.log(`Analyzing message from: ${from} | fromMe: ${fromMe} | isGroup: ${isGroup}`);

            if (fromMe) {
                console.log('Skipping: Message was sent by this bot number (fromMe).');
                continue;
            }
            if (isGroup) {
                console.log('Skipping: Group message (groups are disabled).');
                continue;
            }

            // Extract text from various message structures
            let messageContent = '';
            if (msg.message.conversation) {
                messageContent = msg.message.conversation;
            } else if (msg.message.extendedTextMessage?.text) {
                messageContent = msg.message.extendedTextMessage.text;
            } else if (msg.message.imageMessage?.caption) {
                messageContent = msg.message.imageMessage.caption;
            } else if (msg.message.videoMessage?.caption) {
                messageContent = msg.message.videoMessage.caption;
            } else if (msg.message.templateButtonReplyMessage?.selectedId) {
                messageContent = msg.message.templateButtonReplyMessage.selectedId;
            } else if (msg.message.buttonsResponseMessage?.selectedButtonId) {
                messageContent = msg.message.buttonsResponseMessage.selectedButtonId;
            } else if (msg.message.listResponseMessage?.singleSelectReply?.selectedRowId) {
                messageContent = msg.message.listResponseMessage.singleSelectReply.selectedRowId;
            }

            if (!messageContent.trim()) {
                console.log('Skipping: Message content is empty or unsupported format.');
                continue;
            }

            const senderNumber = from.split('@')[0];
            console.log(`📩 Processing message from [${senderNumber}]: "${messageContent}"`);

            if (!openai) {
                console.log('Warning: OpenAI client is not initialized. Sending warning message to user.');
                await sock.sendMessage(from, { text: 'Bot aktif ancak OpenAI yapılandırılmamış.' });
                continue;
            }

            try {
                let history = chatHistories.get(from) || [];
                history.push({ role: 'user', content: messageContent });
                if (history.length > 15) history = history.slice(-15);
                chatHistories.set(from, history);

                const systemPrompt = process.env.SYSTEM_PROMPT || 'Sen yardımsever bir yapay zeka asistanısın.';
                const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

                console.log(`Calling OpenAI API (${model}) with system prompt and history...`);
                const response = await openai.chat.completions.create({
                    model,
                    messages: [{ role: 'system', content: systemPrompt }, ...history]
                });

                const replyText = response.choices[0]?.message?.content;
                if (replyText) {
                    history.push({ role: 'assistant', content: replyText });
                    chatHistories.set(from, history);

                    console.log(`Sending response via WhatsApp to ${from}...`);
                    await sock.sendMessage(from, { text: replyText });
                    console.log(`📤 Successfully sent reply to [${senderNumber}]: "${replyText.substring(0, 80)}..."`);
                } else {
                    console.log('OpenAI returned an empty response choice.');
                }
            } catch (err) {
                console.error('Error handling message with OpenAI/Baileys:', err);
                try {
                    await sock.sendMessage(from, { text: 'Bir hata oluştu, lütfen tekrar deneyin.' });
                } catch (sendErr) {
                    console.error('Failed to send error message back to user:', sendErr);
                }
            }
        }
    });
}

server.listen(PORT, () => {
    console.log(`\n==============================================`);
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Web panel: http://localhost:${PORT}`);
    console.log(`==============================================\n`);
    connectToWhatsApp().catch(err => console.error('Fatal error:', err));
});
