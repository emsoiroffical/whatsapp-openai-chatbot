import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pino from 'pino';
import { OpenAI } from 'openai';
import qrcode from 'qrcode';
const QRCode = qrcode;
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
// let latestQrCode = null;  // removed – QR is refreshed on every event
let sock = null;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/qr', (req, res) => {
  if (!qrCodeBase64) {
    return res.send("QR henüz hazır değil. Server logunu kontrol edin.");
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp QR</title>
      <meta http-equiv="refresh" content="15">
      <style>
        body {
          margin:0;
          height:100vh;
          display:flex;
          justify-content:center;
          align-items:center;
          background:#111;
          font-family:Arial;
        }
        .box {
          background:white;
          padding:30px;
          border-radius:24px;
          text-align:center;
        }
        img {
          width:360px;
          height:360px;
        }
      </style>
    </head>
    <body>
      <div class="box">
        <h2>WhatsApp Business Bağlantısı</h2>
        <p>QR her 15 saniyede güncellenir, telefonu hazır tutun.</p>
        <img src="${qrCodeBase64}" />
      </div>
    </body>
    </html>
  `);
});

app.get('/api/status', (req, res) => {
    res.json({ state: connectionState, qr: qrCodeBase64, hasOpenAI: !!openai });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server Heartbeat (5 saniyede bir durum basar)
setInterval(() => {
  console.log("SERVER HEARTBEAT", new Date().toISOString(), "state:", connectionState);
}, 5000);

async function startWhatsApp() {
    console.log(`\n🔄 WhatsApp connection attempt`);

    const authDir = path.join(__dirname, 'auth_info_baileys');
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    // If a SESSION_DATA env var exists, restore auth files from it
    if (process.env.SESSION_DATA) {
        try {
            const decoded = Buffer.from(process.env.SESSION_DATA, 'base64').toString('utf-8');
            const sessionObj = JSON.parse(decoded);
            // Ensure auth directory exists
            if (!fs.existsSync(authDir)) {
                fs.mkdirSync(authDir, { recursive: true });
            }
            for (const [filename, fileContent] of Object.entries(sessionObj)) {
                const filePath = path.join(authDir, filename);
                fs.writeFileSync(filePath, fileContent, 'utf-8');
            }
            console.log('✅ Restored Baileys auth session from SESSION_DATA');
        } catch (e) {
            console.error('⚠️ Failed to restore SESSION_DATA:', e);
        }
    }
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const version = [2, 3000, 1035194821];

    connectionState = 'connecting';
    qrCodeBase64 = null;

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.macOS('Safari'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        fireInitQueries: false,
        getMessage: async () => ({ conversation: '' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        console.log("CONNECTION UPDATE RAW:", JSON.stringify(update, null, 2));
        console.log("CONNECTION STATE:", update.connection);
        console.log("LAST DISCONNECT RAW:", JSON.stringify(update.lastDisconnect, null, 2));
        console.log("LAST DISCONNECT STATUS:", update.lastDisconnect?.error?.output?.statusCode);
        console.log("LAST DISCONNECT MESSAGE:", update.lastDisconnect?.error?.message);
        if (update.isNewLogin) {
            console.log("🔐 New login detected");
        }

        if (update.qr) {
            qrCodeBase64 = await QRCode.toDataURL(update.qr);
            console.log('QR code refreshed.');
            console.log('--- SCAN THIS QR CODE ---');
            qrcodeTerminal.generate(update.qr, { small: true });
            console.log('-------------------------\n');
        }

        if (connection === 'close') {
            console.log(`❌ Connection closed.`);
            connectionState = 'disconnected';
            qrCodeBase64 = null;
            // latestQrCode cleared implicitly – variable removed
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Reconnecting:', shouldReconnect, 'Status:', statusCode);
            if (shouldReconnect) {
                setTimeout(() => startWhatsApp(), 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connected!');
            connectionState = 'connected';
            qrCodeBase64 = null;
            // Save current auth files into SESSION_DATA env variable (base64)
            try {
                const files = fs.readdirSync(authDir);
                const sessionObj = {};
                for (const file of files) {
                    const filePath = path.join(authDir, file);
                    const data = fs.readFileSync(filePath, 'utf-8');
                    sessionObj[file] = data;
                }
                const jsonStr = JSON.stringify(sessionObj);
                const encoded = Buffer.from(jsonStr, 'utf-8').toString('base64');
                process.env.SESSION_DATA = encoded;
                console.log('✅ Saved Baileys auth session to SESSION_DATA (env var)');
            } catch (e) {
                console.error('⚠️ Failed to save SESSION_DATA:', e);
            }
            latestQrCode = null;
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        console.log('📨 RAW MESSAGE EVENT:', JSON.stringify(m, null, 2));
    if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (!msg.message) continue;

            const from = msg.key.remoteJid;
            if (msg.key.fromMe) continue;
            if (from.endsWith('@g.us')) continue;

            const messageContent = msg.message.conversation ||
                                   msg.message.extendedTextMessage?.text || '';
            if (!messageContent.trim()) continue;

            const senderNumber = from.split('@')[0];
            console.log(`📩 [${senderNumber}]: ${messageContent}`);

            if (!openai) {
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

                const response = await openai.chat.completions.create({
                    model,
                    messages: [{ role: 'system', content: systemPrompt }, ...history]
                });

                const replyText = response.choices[0]?.message?.content;
                if (replyText) {
                    history.push({ role: 'assistant', content: replyText });
                    chatHistories.set(from, history);
                    await sock.sendMessage(from, { text: replyText });
                    console.log(`📤 [${senderNumber}]: ${replyText.substring(0, 80)}...`);
                }
            } catch (err) {
                console.error('OpenAI error:', err.message);
                await sock.sendMessage(from, { text: 'Bir hata oluştu, lütfen tekrar deneyin.' });
            }
        }
    });
}

server.listen(PORT, () => {
    console.log(`\n==============================================`);
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Web panel: http://localhost:${PORT}`);
    console.log(`==============================================\n`);
    startWhatsApp().catch(err => console.error('Fatal error:', err));
});
