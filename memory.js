// ==============================================
//  إدارة الذاكرة الدائمة لروز
//  بتحفظ معلومات عن كل شخص في ملف JSON على نفس مساحة
//  التخزين الدائمة اللي بتحفظ فيها جلسة واتساب (عشان متتمسحش)
// ==============================================

const fs = require("fs");
const path = require("path");

const MEMORY_FILE = path.join(__dirname, "auth_info_baileys", "memory.json");
const MAX_FACTS_PER_PERSON = 15;

function loadMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return {};
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("⚠️ فشل قراءة ملف الذاكرة الدائمة:", e.message);
    return {};
  }
}

function saveMemory(data) {
  try {
    const dir = path.dirname(MEMORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("⚠️ فشل حفظ ملف الذاكرة الدائمة:", e.message);
  }
}

// بترجع سجل الشخص (المعلومات المحفوظة + آخر مرة اتكلم فيها)
function getPersonRecord(personId) {
  const memory = loadMemory();
  return memory[personId] || { facts: [], lastSeen: null };
}

// بتحدّث "آخر ظهور" للشخص، وبترجع الوقت القديم قبل التحديث (عشان نحسب الفجوة)
function touchLastSeen(personId) {
  const memory = loadMemory();
  if (!memory[personId]) memory[personId] = { facts: [], lastSeen: null };
  const previousLastSeen = memory[personId].lastSeen;
  memory[personId].lastSeen = new Date().toISOString();
  saveMemory(memory);
  return previousLastSeen;
}

// بتضيف معلومة جديدة عن شخص، وبتحافظ على حد أقصى لعدد المعلومات
function addFact(personId, factText) {
  const memory = loadMemory();
  if (!memory[personId]) memory[personId] = { facts: [], lastSeen: null };
  memory[personId].facts.push({
    text: factText,
    date: new Date().toISOString(),
  });
  while (memory[personId].facts.length > MAX_FACTS_PER_PERSON) {
    memory[personId].facts.shift();
  }
  saveMemory(memory);
}

// بتوصف الفجوة الزمنية بجملة بسيطة بالعربي
function describeGap(previousIso) {
  if (!previousIso) return null;
  const diffMs = Date.now() - new Date(previousIso).getTime();
  const hours = diffMs / (1000 * 60 * 60);
  if (hours < 3) return null; // فجوة قصيرة، متستاهلش نلمّح لها
  if (hours < 20) return "من كذا ساعة";
  const days = Math.round(hours / 24);
  if (days <= 1) return "من يوم";
  if (days < 7) return `من ${days} أيام`;
  return "من فترة";
}

// بتجيب الاسم المحفوظ لشخص معين (لو موجود)
function getName(personId) {
  const memory = loadMemory();
  return memory[personId]?.name || null;
}

// بتحفظ/تحدّث اسم شخص معين بشكل دائم
function setName(personId, name) {
  const memory = loadMemory();
  if (!memory[personId]) memory[personId] = { facts: [], lastSeen: null, name: null };
  memory[personId].name = name;
  saveMemory(memory);
}

module.exports = { getPersonRecord, touchLastSeen, addFact, describeGap, getName, setName };
