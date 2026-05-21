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
    DisconnectReason 
} from '@whiskeysockets/baileys';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Initialize OpenAI
let openai = null;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });
    console.log('OpenAI API successfully initialized. ✅');
} else {
    console.warn('⚠️ WARNING: OPENAI_API_KEY environment variable is missing!');
}

// Conversation History Memory
const chatHistories = new Map();

// Bot state
let connectionState = 'disconnected'; // disconnected, connecting, qr, connected
let qrCodeBase64 = null;
let sock = null;

// Express setup
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API to get current status and QR code
app.get('/api/status', (req, res) => {
    res.json({
        state: connectionState,
        qr: qrCodeBase64,
        hasOpenAI: !!openai
    });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Main WhatsApp Connection logic
async function connectToWhatsApp() {
    console.log('Starting WhatsApp connection flow... 🔄');
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
    
    connectionState = 'connecting';
    qrCodeBase64 = null;

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // We will print it manually using qrcode-terminal with better formatting
        logger: pino({ level: 'silent' }),
        browser: ['WhatsApp Chatbot', 'Chrome', '1.0.0']
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Watch connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            connectionState = 'qr';
            console.log('\n--- SCAN THIS QR CODE TO CONNECT WHATSAPP ---');
            qrcodeTerminal.generate(qr, { small: true });
            console.log('---------------------------------------------\n');
            
            try {
                qrCodeBase64 = await qrcode.toDataURL(qr, { scale: 8, margin: 2 });
            } catch (err) {
                console.error('Failed to generate Base64 QR code:', err);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed. Reason: ${lastDisconnect?.error}. Reconnecting: ${shouldReconnect}`);
            
            connectionState = 'disconnected';
            qrCodeBase64 = null;

            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log('Logged out of WhatsApp. Please delete auth_info_baileys folder and scan QR code again.');
                // Clear session files to force fresh QR code on next run
                try {
                    fs.rmSync(path.join(__dirname, 'auth_info_baileys'), { recursive: true, force: true });
                    console.log('Cleaned up auth session. Retrying connection in 5 seconds...');
                    setTimeout(connectToWhatsApp, 5000);
                } catch (e) {
                    console.error('Error cleaning up auth folder:', e);
                }
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connection successfully established! 🎉 Bot is online. ✅');
            connectionState = 'connected';
            qrCodeBase64 = null;
        }
    });

    // Message upsert handler (incoming messages)
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            // Process text messages only
            if (!msg.message) continue;
            
            const from = msg.key.remoteJid;
            const fromMe = msg.key.fromMe;
            const isGroup = from.endsWith('@g.us');

            // Skip messages from self or groups
            if (fromMe) continue;
            if (isGroup) continue;

            const messageContent = msg.message.conversation || 
                                   msg.message.extendedTextMessage?.text || 
                                   '';

            if (!messageContent.trim()) continue;

            const senderNumber = from.split('@')[0];
            console.log(`📩 Message from [${senderNumber}]: ${messageContent}`);

            // If OpenAI is not configured, reply with warning
            if (!openai) {
                console.warn('OpenAI is not configured. Skipping reply.');
                await sock.sendMessage(from, { 
                    text: 'Merhaba! Bot şu anda aktif ancak OpenAI entegrasyonu tamamlanmamış. Lütfen API anahtarınızı kontrol edin.' 
                });
                continue;
            }

            try {
                // Get or initialize chat history
                let history = chatHistories.get(from) || [];
                history.push({ role: 'user', content: messageContent });

                // Keep only last 15 messages for context window efficiency
                if (history.length > 15) {
                    history = history.slice(-15);
                }
                chatHistories.set(from, history);

                // Call OpenAI API
                const systemPrompt = process.env.SYSTEM_PROMPT || 'Sen yardımsever bir yapay zeka asistanısın.';
                const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

                const response = await openai.chat.completions.create({
                    model: model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        ...history
                    ]
                });

                const replyText = response.choices[0]?.message?.content;

                if (replyText) {
                    // Update history
                    history.push({ role: 'assistant', content: replyText });
                    chatHistories.set(from, history);

                    // Send response on WhatsApp
                    await sock.sendMessage(from, { text: replyText });
                    console.log(`📤 Reply to [${senderNumber}]: ${replyText}`);
                }
            } catch (err) {
                console.error('Error generating AI response:', err);
                await sock.sendMessage(from, { 
                    text: 'Bir hata oluştu, lütfen daha sonra tekrar deneyin.' 
                });
            }
        }
    });
}

// Start Server and WhatsApp Bot
server.listen(PORT, () => {
    console.log(`\n===============================================`);
    console.log(`🚀 Web server running on port ${PORT}`);
    console.log(`📊 Access status page here: http://localhost:${PORT}`);
    console.log(`===============================================\n`);
    
    connectToWhatsApp().catch(err => {
        console.error('Fatal WhatsApp connection error:', err);
    });
});
