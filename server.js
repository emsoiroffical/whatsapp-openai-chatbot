import express from 'express';
// Auto-redeploy trigger
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



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Load centralized credentials
dotenv.config({ path: path.resolve(__dirname, '../../_knowledge/credentials/master.env') });

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
// Flag to ensure QR is printed only once per session
let qrDisplayed = false;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/status', (req, res) => {
    res.json({ state: connectionState, qr: qrCodeBase64, hasOpenAI: !!openai });
});

app.get('/api/qr', (req, res) => {
    if (qrCodeBase64) {
        const img = Buffer.from(qrCodeBase64.split(',')[1], 'base64');
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(img);
    } else {
        res.status(404).send('QR not available');
    }
});

// Public route for QR image (clean PNG)
app.get('/whatsapp-qr', (req, res) => {
  if (qrCodeBase64) {
    const img = Buffer.from(qrCodeBase64.split(',')[1], 'base64');
    res.type('png').send(img);
  } else {
    res.status(404).send('QR not available');
  }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Simple HTML page showing QR image directly
app.get('/qr', (req, res) => {
    if (qrCodeBase64) {
        const html = `<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;color:#fff;"><img src="/api/qr" alt="WhatsApp QR" style="max-width:90%;height:auto;"/></body></html>`;
        res.send(html);
    } else {
        res.send('<p>QR kodu mevcut değil. Lütfen bağlanma aşamasını bekleyin.</p>');
    }
});

// Helper to extract message content from wrappers like ephemeralMessage, viewOnceMessage, etc.
function getRealMessage(message) {
    if (!message) return null;
    if (message.ephemeralMessage?.message) return getRealMessage(message.ephemeralMessage.message);
    if (message.viewOnceMessage?.message) return getRealMessage(message.viewOnceMessage.message);
    if (message.viewOnceMessageV2?.message) return getRealMessage(message.viewOnceMessageV2.message);
    if (message.documentWithCaptionMessage?.message) return getRealMessage(message.documentWithCaptionMessage.message);
    return message;
}

async function connectToWhatsApp() {
    console.log(`\n🔄 WhatsApp connection attempt #${retryCount + 1}`);

    const authDir = path.join(__dirname, 'auth_info_baileys');
    // Ensure auth directory exists; preserve existing session for persistent login
    try {
        if (!fs.existsSync(authDir)) {
            fs.mkdirSync(authDir, { recursive: true });
            console.log(`Auth directory created at ${authDir}`);
        } else {
            console.log(`Using existing auth directory at ${authDir}`);
        }
    } catch (e) {
        console.error('Failed to ensure auth directory:', e);
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
        logger: pino({ level: 'debug' }),
        browser: Browsers.macOS('Safari'),
        connectTimeoutMs: 180_000,
        defaultQueryTimeoutMs: 180_000,
        keepAliveIntervalMs: 25_000,
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 5,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        // Disable QR timeout to allow indefinite scanning period
        qrTimeout: 0,
        getMessage: async () => undefined,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Generate QR only once per session to keep it static
        if (qr && !qrCodeBase64 && !qrDisplayed) {
            retryCount = 0;
            connectionState = 'qr';
            console.log('\n--- SCAN THIS QR CODE ---');
            qrcodeTerminal.generate(qr, { small: true });
            console.log('-------------------------\n');
            try {
                qrCodeBase64 = await qrcode.toDataURL(qr, { scale: 8, margin: 2 });
                // Save QR PNG to public folder for direct access
                const imgBuffer = Buffer.from(qrCodeBase64.split(',')[1], 'base64');
                const qrFilePath = path.join(__dirname, 'public', 'qr.png');
                fs.writeFileSync(qrFilePath, imgBuffer);
                console.log('QR image saved to', qrFilePath);
                qrDisplayed = true; // Mark that QR has been shown
            } catch (err) {
                console.error('QR error:', err);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const reason = lastDisconnect?.error?.message || 'Unknown';
            console.log(`⚠️ Bağlantı kapandı: ${reason} (code ${statusCode})`);
            if (isLoggedOut) {
                console.log('Çıkış yapıldı, oturum dosyaları temizleniyor.');
                fs.rmSync(authDir, { recursive: true, force: true });
                connectionState = 'disconnected';
                // Do not exit, allow user to scan QR again
                setTimeout(connectToWhatsApp, 3000);
            } else {
                if (retryCount < MAX_RETRIES) {
                    retryCount++;
                    console.log(`Yeniden bağlanma denemesi ${retryCount}/${MAX_RETRIES}`);
                    connectionState = 'connecting';
                    setTimeout(connectToWhatsApp, 3000);
                } else {
                    console.log('Maksimum yeniden bağlanma denemesi aşıldı. Bağlantı kesildi.');
                    connectionState = 'disconnected';
                }
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connected!');
            connectionState = 'connected';
            qrCodeBase64 = null;
            qrDisplayed = false; // Reset flag for next session
            retryCount = 0;
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        // Process all message.upsert events regardless of type

        console.log(`\n📬 Incoming messages.upsert event (count: ${m.messages?.length || 0})`);

        for (const msg of m.messages) {
            console.log('Raw message object received:', JSON.stringify(msg, null, 2));

            const timestamp = msg.messageTimestamp;
            if (timestamp) {
                const now = Math.floor(Date.now() / 1000);
                const age = now - timestamp;
                if (age > 60) {
                    console.log(`Skipping: Message is too old (${age}s ago, likely a history/sync message).`);
                    continue;
                }
            }

            const realMessage = getRealMessage(msg.message);
            if (!realMessage) {
                console.log('Skipping: Message payload is empty or only system notification.');
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
            if (realMessage.conversation) {
                messageContent = realMessage.conversation;
            } else if (realMessage.extendedTextMessage?.text) {
                messageContent = realMessage.extendedTextMessage.text;
            } else if (realMessage.imageMessage?.caption) {
                messageContent = realMessage.imageMessage.caption;
            } else if (realMessage.videoMessage?.caption) {
                messageContent = realMessage.videoMessage.caption;
            } else if (realMessage.templateButtonReplyMessage?.selectedId) {
                messageContent = realMessage.templateButtonReplyMessage.selectedId;
            } else if (realMessage.buttonsResponseMessage?.selectedButtonId) {
                messageContent = realMessage.buttonsResponseMessage.selectedButtonId;
            } else if (realMessage.listResponseMessage?.singleSelectReply?.selectedRowId) {
                messageContent = realMessage.listResponseMessage.singleSelectReply.selectedRowId;
            }

            if (!messageContent.trim()) {
                console.log('Skipping: Message content is empty or unsupported format.');
                continue;
            }

            const senderNumber = from.split('@')[0];
            console.log(`📩 Processing message from [${senderNumber}]: "${messageContent}"`);
            await sock.sendMessage(from, { text: `✅ Mesaj alındı: ${messageContent}` });

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
