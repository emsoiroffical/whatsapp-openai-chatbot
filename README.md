# WhatsApp OpenAI Chatbot

Bu proje, WhatsApp üzerinden gelen mesajları OpenAI API kullanarak otomatik olarak yanıtlayan akıllı bir asistandır.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/emsoiroffical/whatsapp-openai-chatbot&referralCode=bttO3T)

## Özellikler
- **Baileys Entegrasyonu:** WhatsApp Business API veya Meta API gerektirmeden direkt olarak WhatsApp Web protokolü üzerinden çalışır.
- **OpenAI Desteği:** `gpt-4o-mini` veya tercih ettiğiniz herhangi bir OpenAI sohbet modeli ile uyumludur.
- **Bellek/Hafıza Yönetimi:** Her sohbetin son 15 mesajlık bağlamını hatırlar ve anlamlı sohbetler yürütür.
- **Yönetim Paneli:** Web arayüzü üzerinden veya doğrudan terminal/Railway loglarından QR kodunu taratarak sistemi saniyeler içinde aktif edebilirsiniz.

## Kurulum ve Dağıtım (Railway)

1. Yukarıdaki **Deploy on Railway** butonuna tıklayın.
2. Railway sizden aşağıdaki değişkenleri isteyecektir:
   - `OPENAI_API_KEY`: OpenAI API anahtarınız.
   - `SYSTEM_PROMPT`: Botunuzun karakteri ve yanıt tarzı (varsayılan değer tanımlıdır).
3. Kurulum tamamlandıktan sonra, Railway loglarında veya uygulamanın sağladığı web arayüzünde QR kodunu göreceksiniz.
4. Telefonunuzdan **WhatsApp > Bağlı Cihazlar > Cihaz Bağla** kısmına girip bu QR kodunu taratın.
5. Botunuz anında aktif ve 7/24 çalışmaya başlayacaktır!

## Yerel Kurulum
Lokalde çalıştırmak isterseniz:
1. `npm install`
2. `.env` dosyası oluşturup değişkenleri tanımlayın.
3. `npm start`
