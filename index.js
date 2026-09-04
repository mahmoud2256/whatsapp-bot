// ==============================================
//  روز V7 - نسخة Baileys الخفيفة (من غير متصفح)
//  محوّلة من whatsapp-web.js لتوفير الموارد
// ==============================================

require("dotenv").config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const { useMongoDBAuthState } = require("mongo-baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const qrcodeTerminal = require("qrcode-terminal");
const qrcode = require("qrcode");
const express = require("express");
const fs = require("fs");
const path = require("path");
const faqList = require("./faq");
const longTermMemory = require("./memory");

const sentMessageTexts = new Set();
const conversationHistory = new Map();
const MAX_HISTORY_MESSAGES = 20;
const LAST_TOPIC = new Map(); // ذاكرة آخر موضوع

function pushToHistory(chatId, role, content, topic = null) {
  if (!conversationHistory.has(chatId)) conversationHistory.set(chatId, []);
  const h = conversationHistory.get(chatId);
  h.push({ role, content, time: Date.now(), topic });
  while (h.length > MAX_HISTORY_MESSAGES) h.shift();
  if (topic) LAST_TOPIC.set(chatId, { topic, time: Date.now() });
}
function trackSentMessage(text) {
  if (text) sentMessageTexts.add(text.slice(0, 60));
}

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const TRIGGER_NAME = "روز";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";
const AUTH_DIR = path.join(__dirname, "auth_info_baileys");
const MONGODB_URL = process.env.MONGODB_URL || "";
let mongoClient = null;

// كاش الطقس 10 دقايق عشان يثبت
let weatherCache = { city: "", data: null, time: 0 };
async function getWeatherSmart(city = "Cairo") {
  const now = Date.now();
  if (weatherCache.city.toLowerCase() === city.toLowerCase() && weatherCache.data && now - weatherCache.time < 10 * 60 * 1000) {
    return weatherCache.data;
  }
  try {
    city = city.replace(/(اليوم|النهارده|دلوقتي|كام|ايه|في|in|today|now|درجة|الحرارة|الجو|الطقس|حراره|دلوقتي)/gi, "").trim();
    if (!city || city.length < 2) city = "Cairo";
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ar&format=json`);
    let geoData = await geoRes.json();
    if (!geoData.results || geoData.results.length === 0) {
      const geoRes2 = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&format=json`);
      geoData = await geoRes2.json();
      if (!geoData.results || geoData.results.length === 0) return null;
    }
    const place = geoData.results[0];
    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current_weather=true&hourly=temperature_2m,relativehumidity_2m,apparent_temperature&timezone=Africa/Cairo&forecast_days=1`);
    const weatherData = await weatherRes.json();
    const curr = weatherData.current_weather;
    if (!curr) return null;
    const idx = weatherData.hourly ? weatherData.hourly.time.findIndex(t => new Date(t).getHours() === new Date().getHours()) : 0;
    const humidity = weatherData.hourly?.relativehumidity_2m?.[idx] || weatherData.hourly?.relativehumidity_2m?.[0] || 50;
    const feels = weatherData.hourly?.apparent_temperature?.[idx] || weatherData.hourly?.apparent_temperature?.[0] || curr.temperature;

    const result = { temp: curr.temperature, feels_like: Math.round(feels), city: place.name, humidity, wind: curr.windspeed, code: curr.weathercode };
    weatherCache = { city, data: result, time: now };
    return result;
  } catch (e) { console.error(e); return null; }
}

let lastWeatherCity = "Cairo";
function detectIntent(text) {
  const cleanText = text.replace(/[؟?.,!]/g, "").trim();
  const blacklist = ["الطقس", "طقس", "الحرارة", "حراره", "الجو", "جو", "درجة", "درجه", "كام", "ايه", "روز", "الساعه", "ساعه", "اكتر", "اكثر"];
  const isWeatherQ = /(طقس|حرارة|الجو|weather|درجة|حراره)/i.test(text);

  // ملحوظة: مبقاش في fallback بيحوّل أي كلمة قصيرة لاسم مدينة —
  // كان ده بيخطف رسائل عادية زي "المدن" أو "اسماء" ويفهمها غلط كطقس.
  // دلوقتي لازم كلمة الطقس تكون موجودة صراحةً، أو نكون في سياق طقس حديث.
  if (isWeatherQ) {
    let city = "";
    const match = text.match(/(?:في|in)\s+([a-zA-Z\u0600-\u06FF\s]{3,20})/i);
    if (match) { city = match[1].replace(/(اليوم|النهارده|دلوقتي|كام|ايه|الجو|الطقس|درجة|الحرارة)/gi, "").trim().replace(/[؟?.,!]/g, "").trim(); }
    if (!city) city = lastWeatherCity;
    if (!city || blacklist.includes(city) || city.length < 3) city = lastWeatherCity;
    if (city && city.length >= 3) { lastWeatherCity = city; return { type: "weather", city }; }
  }
  return null;
}

async function searchWeb(query) {
  if (!TAVILY_API_KEY) return "";
  if (/(طقس|حرارة|الجو|درجة|weather|حراره)/i.test(query)) return ""; // الطقس من Open-Meteo بس
  try {
    const r = await fetch("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: TAVILY_API_KEY, query, max_results: 4, include_answer: true, search_depth: "advanced" }) });
    const d = await r.json();
    let result = "";
    if (d.answer) result += d.answer + "\n";
    if (d.results) result += d.results.map(x => x.content?.slice(0, 200)).join("\n");
    return result;
  } catch { return ""; }
}

function getCurrentEgyptTime() { return new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }); }

const SYSTEM_CONTEXT = `
انتِ روز 🌹 بنت مصرية ذكية وخفيفة الدم، شخصيتك ودودة وفيها روح مرحة بسيطة - مش مبالغ فيها.

الوقت الحالي: ${getCurrentEgyptTime()} - انتِ محدثة لحظياً زي ChatGPT

🧠 أهم قاعدة على الإطلاق - الذكاء والدقة قبل أي حاجة:
- أولويتك القصوى إنك تفهمي السؤال صح وتجاوبي عليه بدقة ومعلومة صحيحة، زي مساعد ذكي محترف.
- ردك لازم يجاوب على السؤال الحقيقي كامل قبل أي حاجة تانية. لو مش متأكدة من قصده، اسأليه يوضح بدل ما تخميني غلط.
- ممنوع تمامًا تتجاهلي جزء من السؤال أو ترتبطي بموضوع قديم مش له علاقة بالسؤال الجديد.
- اقري آخر 10 رسائل بعناية وافهمي السياق كويس قبل ما تردي، زي إنسان بيسمع فعلاً مش بيخمن.
- لو كنا بنتكلم عن الطقس وقال "بس حاسس انها اكتر من كده" = يقصد إحساس الحرارة، مش كلام عاطفي.
- لو كنا بنتكلم عن قطر وقال "طب الساعة كام" = يقصد ميعاد القطر.

💬 أسلوبك (بسيط ومتزن، مش مبالغ فيه):
- ردودك قصيرة ومفيدة ومباشرة، بلمسة ودّية خفيفة بس مش مصطنعة.
- استخدمي اسم دلع بسيط أحيانًا (مش في كل رسالة) زي "يا حوده" لمحمود، أو اسم الشخص عادي لو معروف. متكرريش نفس الاسم في كل جملة.
- حطي إيموجي واحد بس لو فعلاً بيضيف معنى، مش أكتر من كده، ومش في كل رسالة أصلاً.
- ابعدي عن المبالغة في الوصف أو التكرار ("يا لهوي"، "بموت فيك"، إلخ) - اتكلمي عادي وطبيعي زي صحبة بترد بذكاء.

🚫 ممنوع:
- تكرري نفس الجملة أو نفس الأسلوب في كل رد.
- تحطي أكتر من إيموجي واحد أو اتنين في الرسالة.
- تفسري كلام الطقس أو أي كلام عادي كأنه غزل أو حب.
- تديلي معلومة غلط أو غير مؤكدة على إنها حقيقة.

انتِ زي ChatGPT في الذكاء والدقة، وشخصيتك المصرية بتظهر في أسلوب الكلام بس مش على حساب الفهم.
`;

let latestQr = null, isReady = false, connectedNumber = null, botOwnId = null;
const app = express();
app.get("/", (req, res) => {
  if (isReady) res.send(`<h1>✅ روز V7 الذكية 🌹 شغالة</h1><p>${connectedNumber}</p>`);
  else if (latestQr) res.send(`<div style="text-align:center"><h2>امسح الكود يا قمر 😍</h2><img src="/qr" /></div>`);
  else res.send("⏳ بتجهز يا حلو...");
});
app.get("/qr", async (req, res) => { if (!latestQr) return res.status(404).send("No QR"); try { const img = await qrcode.toDataURL(latestQr); res.send(`<img src="${img}" />`); } catch { res.status(500).send("error"); } });
// نقطة "صحصحة" جاهزة تستخدمها أي خدمة Ping خارجية (زي cron-job.org) عشان السيرفر يفضل صاحي
app.get("/ping", (req, res) => res.send("pong"));
app.listen(PORT, () => console.log(`🌐 ${PORT}`));

async function askAI(question, senderName, history, lastTopicInfo, searchResult = "") {
  if (!GROQ_API_KEY) return "مفتاح Groq مش متظبط يا قلبي 😅";
  try {
    const nick = senderName ? senderName : "يا قمر";

    const contextStr = history.slice(-10).map(h => `${h.role} [${h.topic || 'عام'}]: ${h.content}`).join("\n");

    const messages = [
      { role: "system", content: `${SYSTEM_CONTEXT}\nاللي بيكلمك اسمه: ${senderName || "مش معروف"}\nآخر موضوع اتكلمنا فيه: ${lastTopicInfo ? `${lastTopicInfo.topic} من ${Math.round((Date.now() - lastTopicInfo.time) / 1000)} ثانية فاتت` : "مفيش"}\nالوقت: ${getCurrentEgyptTime()}\nبحث محدث: ${searchResult || "مفيش"}\n\nالسياق الكامل (اربطي الأحداث):\n${contextStr}` },
      { role: "user", content: `رسالته الجديدة: "${question}"\n\nتذكير: كنا بنتكلم عن ${lastTopicInfo?.topic || 'موضوع عام'} - اربطي رسالته دي بآخر موضوع، ولو هتنادي عليه استخدمي اسمه الحقيقي (${nick}) بس مش في كل جملة` }
    ];

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.55, max_tokens: 600, top_p: 0.9 }),
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim() || `يا لهوي يا ${nick} مفهمتش، قول تاني؟ 😅`;
  } catch (e) { console.error(e); return "أوف يا قلبي حصلت مشكلة صغننة، جرب تاني يا حلو 😘"; }
}

// بتستخرج نص الرسالة من أي شكل رسالة (نص عادي / رد / إلخ)
function extractText(message) {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  );
}

function checkIsReplyToBot(message, chatId) {
  const ctx = message?.extendedTextMessage?.contextInfo;
  if (ctx?.participant && botOwnId && ctx.participant === botOwnId) return true; // رد على رسالة روز
  const quotedText = extractText(ctx?.quotedMessage);
  if (quotedText && sentMessageTexts.has(quotedText.slice(0, 60))) return true;
  try {
    const history = conversationHistory.get(chatId) || [];
    if (history.length > 0) {
      const last = history[history.length - 1];
      if (last.role === "assistant" && Date.now() - last.time < 2 * 60 * 1000) return true;
    }
  } catch {}
  return false;
}

async function getAuthState() {
  if (MONGODB_URL) {
    if (!mongoClient) {
      mongoClient = new MongoClient(MONGODB_URL);
      await mongoClient.connect();
      console.log("🗄️  متصل بقاعدة بيانات MongoDB - الجلسة هتتخزن هناك");
    }
    const collection = mongoClient.db("rose_bot").collection("auth_state");
    return useMongoDBAuthState(collection);
  }
  console.log("💾 MONGODB_URL مش متظبط - هيتخزن الجلسة في ملفات محلية (auth_info_baileys)");
  return useMultiFileAuthState(AUTH_DIR);
}

async function startBot() {
  const { state, saveCreds } = await getAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["روز", "Chrome", "1.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      latestQr = qr;
      qrcodeTerminal.generate(qr, { small: true });
    }
    if (connection === "open") {
      isReady = true;
      latestQr = null;
      botOwnId = sock.user?.id?.split(":")[0] + "@s.whatsapp.net";
      connectedNumber = sock.user?.id?.split(":")[0] || "";
      console.log("✅ روز V7 الذكية جاهزة 🌹");
    }
    if (connection === "close") {
      isReady = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("⚠️ الاتصال اتقفل، إعادة اتصال:", shouldReconnect);
      if (shouldReconnect) startBot();
      else console.log("❌ اتعمل تسجيل خروج - محتاج QR جديد");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    const msg = messages[0];
    try {
      if (!msg.message || msg.key.fromMe) return;
      const chatId = msg.key.remoteJid;
      const text = extractText(msg.message).trim();
      if (!text) return;
      const lowerText = text.toLowerCase();

      if (["المطور", "مين عملك", "مين برمجك"].some(k => lowerText.includes(k))) {
        const p = path.join(__dirname, "developer.jpg");
        if (fs.existsSync(p)) {
          await sock.sendMessage(chatId, { image: fs.readFileSync(p), caption: "👨‍💻 محمود أمين - اللي عامل القمر روز 🌹" }, { quoted: msg });
        } else {
          const replyText = "اللي عاملني القمر محمود أمين يا قلب روز 👨‍💻😍";
          await sock.sendMessage(chatId, { text: replyText }, { quoted: msg });
          trackSentMessage(replyText);
        }
        return;
      }

      const isGroup = chatId.endsWith("@g.us");
      let isDirectedToBot = true;
      if (isGroup) {
        const calledByName = lowerText.includes(TRIGGER_NAME.toLowerCase());
        const mentionedIds = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const mentionedForReal = botOwnId && mentionedIds.includes(botOwnId);
        const isReplyToBot = checkIsReplyToBot(msg.message, chatId);
        isDirectedToBot = mentionedForReal || calledByName || isReplyToBot;
        if (!isDirectedToBot) return;
      }

      const personId = msg.key.participant || chatId;

      // لو الشخص بيقول اسمه الحقيقي، نحفظه دايمًا ونستخدمه من هنا وبعد كده
      const nameCorrection = text.match(/(?:اسمي|انا اسمي|my name is)\s+([a-zA-Z\u0600-\u06FF]{2,20})/i);
      if (nameCorrection) {
        longTermMemory.setName(personId, nameCorrection[1].trim());
      }

      let senderName = longTermMemory.getName(personId);
      if (!senderName && msg.pushName) {
        senderName = msg.pushName.split(" ")[0]; // أول كلمة بس، تجنبًا لأسماء واتساب المركبة الغريبة
        longTermMemory.setName(personId, senderName);
      }
      const senderPushName = senderName || null;

      const intent = detectIntent(text);
      if (intent && intent.type === "weather") {
        const w = await getWeatherSmart(intent.city);
        if (w) {
          const nick = senderPushName ? senderPushName : "";
          const flirty = `الجو في ${w.city} دلوقتي ${w.temp}°C بس بيتحس ${w.feels_like}°C بسبب الرطوبة ${w.humidity}%${nick ? ` يا ${nick}` : ""} 🌡️`;
          await sock.sendMessage(chatId, { text: flirty }, { quoted: msg });
          trackSentMessage(flirty);
          pushToHistory(chatId, "user", text, "طقس");
          pushToHistory(chatId, "assistant", flirty, "طقس");
          return;
        }
      }

      // ربط ذكي: لو قال "اكتر من كده" أو "حاسس" بعد طقس، افهمها طقس
      const lastTopic = LAST_TOPIC.get(chatId);
      if (lastTopic && lastTopic.topic === "طقس" && Date.now() - lastTopic.time < 2 * 60 * 1000) {
        if (/(اكتر|اكثر|اكتر من كده|حاسس|حاسه|اكتر من كدا|من كده|من كدا)/i.test(text) && text.length < 30) {
          const w = await getWeatherSmart(lastWeatherCity);
          if (w) {
            const nick = senderPushName ? senderPushName : "";
            const smartReply = `عندك حق${nick ? ` يا ${nick}` : ""}، هي ${w.temp}°C بس بتتحس ${w.feels_like}°C بسبب الرطوبة ${w.humidity}% 🌡️`;
            await sock.sendMessage(chatId, { text: smartReply }, { quoted: msg });
            trackSentMessage(smartReply);
            pushToHistory(chatId, "user", text, "طقس");
            pushToHistory(chatId, "assistant", smartReply, "طقس");
            return;
          }
        }
      }

      const isDynamicQuestion = /(قطار|قطارات|قطر|مواعيد|موعد|سعر|اسعار|مواصلات|طيران|اتوبيس|train|price|بحبك|اسمك|بتحبي)/i.test(lowerText);
      let match = null;
      if (!isDynamicQuestion) {
        match = faqList.find(i => i.keywords.some(k => lowerText.includes(k.toLowerCase())));
      }

      if (match) {
        await sock.sendMessage(chatId, { text: match.answer }, { quoted: msg });
        trackSentMessage(match.answer);
        pushToHistory(chatId, "user", text, "عام");
        pushToHistory(chatId, "assistant", match.answer, "عام");
        return;
      }

      const cleanQuestion = text.replace(new RegExp(TRIGGER_NAME, "gi"), "").trim() || text;
      longTermMemory.getPersonRecord(personId);
      longTermMemory.touchLastSeen(personId);
      const history = conversationHistory.get(chatId) || [];

      let searchResult = "";
      if (isDynamicQuestion || text.length > 12) searchResult = await searchWeb(cleanQuestion);

      const aiReply = await askAI(cleanQuestion, senderPushName, history, lastTopic, searchResult);
      await sock.sendMessage(chatId, { text: aiReply }, { quoted: msg });
      trackSentMessage(aiReply);
      pushToHistory(chatId, "user", cleanQuestion, lastTopic?.topic || "عام");
      pushToHistory(chatId, "assistant", aiReply, lastTopic?.topic || "عام");

    } catch (err) { console.error("خطأ:", err); }
  });
}

startBot();
