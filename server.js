import express from 'express';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';

dotenv.config();

const app = express();
app.use(express.json());
// Simple rate limiter (max 5 requests per minute per IP)
const rateLimitMap = new Map();
app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - record.start > 60000) {
    // Reset each minute
    record.count = 0;
    record.start = now;
  }
  record.count++;
  rateLimitMap.set(ip, record);
  if (record.count > 5) {
    console.warn(`⚠️ Rate limit exceeded for ${ip}`);
    return res.status(429).send('Too Many Requests');
  }
  next();
});

const PORT = process.env.PORT || 3000;

// WAHA Ayarları
const WAHA_URL = process.env.WAHA_URL; 
const WAHA_API_KEY = process.env.WAHA_API_KEY;

// OpenAI Kurulumu
let openai = null;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('✅ OpenAI API başarıyla başlatıldı.');
} else {
    console.warn('⚠️ DİKKAT: OPENAI_API_KEY eksik!');
}

// EMSOIR Müşteri Temsilcisi Promptu
const SYSTEM_PROMPT = `Sen EMSOIR markasının profesyonel, sıcak ve premium müşteri temsilcisisin. 
Müşterilerle Türkçe konuşuyorsun. 
Cevapların kısa, net ve yardımcı olmalı. Gereksiz uzun paragraflar yazma. 
Sipariş, kargo, ürün, koku, iade gibi konularda müşteri temsilcisi gibi doğal davran.`;

// Geçmiş sohbetleri kısa süreli hafızada tutmak için
const chatHistories = new Map();

// WAHA'dan gelen Webhook'ları dinleyen Endpoint
app.post('/webhook', async (req, res) => {
    // Railway webhook time-out olmaması için hemen 200 dönüyoruz
    res.status(200).send('OK');

    const event = req.body;
    
    console.log('🔔 [WEBHOOK RAW]', JSON.stringify(req.body, null, 2));
console.log(`\n🔔 [WEBHOOK GELDİ] Event tipi: ${event.event}`);
    
    // Sadece yeni mesaj olaylarını işle
    if (event.event !== 'message' && event.event !== 'message.any') {
        return;
    }
    const payload = event.payload;
    if (!payload) return;

    // Kendi gönderdiğimiz mesajları yoksay
    if (payload.fromMe) return;

    // Grup mesajlarını yoksay
    if (payload.isGroup) return;

    const from = payload.from; // Müşterinin numarası
    const messageContent = payload.body; // Gelen mesaj içeriği

    if (!messageContent) return;

    const senderNumber = from.split('@')[0];
    console.log(`\n📩 [MÜŞTERİ - ${senderNumber}]: ${messageContent}`);

    if (!openai) {
        console.error("OpenAI tanımlı değil. Cevap yazılamadı.");
        return;
    }

    try {
        // Müşterinin eski mesajlarını al
        let history = chatHistories.get(from) || [];
        history.push({ role: 'user', content: messageContent });
        
        // Sadece son 10 mesajı hatırla (Hafıza şişmesini önler)
        if (history.length > 10) history = history.slice(-10);
        chatHistories.set(from, history);

        // OpenAI'den cevap iste
        console.log("🤖 OpenAI'ye soruluyor...");
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history]
        });

        const replyText = response.choices[0]?.message?.content;
        
        if (replyText) {
            // Asistanın cevabını hafızaya ekle
            history.push({ role: 'assistant', content: replyText });
            chatHistories.set(from, history);

            console.log(`📤 [EMSOIR BOT]: ${replyText.substring(0, 80)}...`);

            // WAHA API üzerinden mesajı gönder
            await sendWahaMessage(from, replyText);
        }
    } catch (err) {
        console.error('❌ OpenAI veya WAHA Hatası:', err.message);
    }
});

// WAHA'ya Mesaj Gönderme Fonksiyonu
async function sendWahaMessage(chatId, text) {
    if (!WAHA_URL) {
        console.error("❌ WAHA_URL tanımlı değil!");
        return;
    }

    const endpoint = `${WAHA_URL}/api/sendText`;

    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };

    // WAHA API Key ayarlandıysa ekle
    if (WAHA_API_KEY) {
        headers['X-Api-Key'] = WAHA_API_KEY;
    }

    const bodyObj = {
        session: 'default',
        chatId: chatId,
        text: text
    };

    // Log request details
    console.log('🔔 WAHA sendText request:', bodyObj);

    const body = JSON.stringify(bodyObj);

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: body
        });

        const responseData = await response.text();
        // Log raw response
        console.log('🔔 WAHA sendText response (status:', response.status, '):', responseData);

        if (!response.ok) {
            console.error(`❌ WAHA'ya mesaj gönderilemedi. Status: ${response.status}`, responseData);
        } else {
            console.log(`✅ Mesaj WAHA üzerinden gönderildi.`);
        }
    } catch (error) {
        console.error(`❌ WAHA Sunucusuna bağlanılamadı:`, error.message);
    }
}

// Sunucunun ayakta olup olmadığını test etmek için
app.get('/', (req, res) => {
    res.send('EMSOIR Webhook Sunucusu Aktif ✅');
});
// Health endpoint for Railway
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Sunucuyu başlat
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n==============================================`);
    console.log(`🚀 Webhook Sunucusu ${PORT} portunda çalışıyor`);
    console.log(`==============================================\n`);
});
// Graceful error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
});
process.on('uncaughtException', err => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});
