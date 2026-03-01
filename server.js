app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const https = require("https");
require('dotenv').config();

const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();


/* =========================
   🔹 Supabase
========================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/* =========================
   🔹 Auth Middleware
========================= */
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return res.status(401).json({ success: false });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false });
  }
}

/* =========================
   🔹 Helpers
========================= */
function clampText(str, max = 4000) {
  if (str === undefined || str === null) return "";
  const s = String(str);
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/* =========================
   🔹 Gemini (GoogleGenerativeAI)
========================= */
const genAI = process.env.GEMINI_API_KEY

  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;
app.get("/ai/models", (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ success: false, message: "GEMINI_API_KEY missing" });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;

  https
    .get(url, (r) => {
      let data = "";
      r.on("data", (chunk) => (data += chunk));
      r.on("end", () => {
        try {
          const json = JSON.parse(data);
          const names = (json.models || []).map((m) => m.name);
          return res.json({ success: true, models: names });
        } catch {
          return res.status(500).json({ success: false, message: "Bad JSON from Google", raw: data });
        }
      });
    })
    .on("error", (e) => {
      return res.status(500).json({ success: false, message: "Request failed", error: String(e.message || e) });
    });
});
/* =========================
   🔹 Login
========================= */
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  // ✅ FIX: maybeSingle بدل single عشان ما يطلع error لما ما في user
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .maybeSingle();

  if (error) return res.json({ success: false, message: error.message });
  if (!data) return res.json({ success: false, message: "User not found" });

  const ok = await bcrypt.compare(password, data.password);
  if (!ok) return res.json({ success: false, message: "Wrong password" });

  const token = jwt.sign(
    { id: data.id, role: data.role, email: data.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({ success: true, token, role: data.role, email: data.email, id: data.id });
});

/* =========================
   🔹 Create Tech (Supervisor Only)
========================= */
app.post('/create-tech', auth, async (req, res) => {

  if (req.user.role !== 'supervisor')
    return res.status(403).json({ success: false });

  const { techID, password } = req.body;

  const hashed = await bcrypt.hash(password, 10);

  const { error } = await supabase
    .from('users')
    .insert([{
      email: techID,
      password: hashed,
      role: 'tech',
      supervisor_email: req.user.email
    }]);

  if (error) return res.json({ success: false, message: error.message });

  res.json({ success: true });
});

/* =========================
   🔹 Save Report
========================= */
app.post('/save-report', auth, async (req, res) => {

  // ✅ tech_id من التوكن (أضمن)
  const tech_id = req.user.email;

  const { status, system, issue, level_tap, level_gb, fittings_gb_changed } = req.body;

  const { error } = await supabase
    .from('reports')
    .insert([{
      tech_id,
      status,
      system,
      issue,
      level_tap,
      level_gb,
      fittings_gb_changed
    }]);

  if (error) return res.json({ success: false, message: error.message });

  res.json({ success: true });
});

/* =========================
   🔹 Reports
========================= */
app.get('/reports', auth, async (req, res) => {
  try {
    // owner يشوف الكل
    if (req.user.role === 'owner') {
      const { data, error } = await supabase
        .from('reports')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(300);

      if (error) return res.json({ success: false, message: error.message });
      return res.json({ success: true, reports: data || [] });
    }

    // supervisor يشوف تقارير الفنيين التابعين له فقط
    if (req.user.role === 'supervisor') {
      // هات IDs الفنيين تبع السوبرفايزر من جدول users
      const { data: techs, error: tErr } = await supabase
        .from('users')
        .select('email')
        .eq('role', 'tech')
        .eq('supervisor_email', req.user.email);

      if (tErr) return res.json({ success: false, message: tErr.message });

      const techIds = (techs || []).map(t => t.email);

      if (techIds.length === 0) {
        return res.json({ success: true, reports: [] });
      }

      // جيب التقارير حسب tech_id
      const { data: reports, error: rErr } = await supabase
        .from('reports')
        .select('*')
        .in('tech_id', techIds)
        .order('created_at', { ascending: false })
        .limit(300);

      if (rErr) return res.json({ success: false, message: rErr.message });

      return res.json({ success: true, reports: reports || [] });
    }

    // tech ما لازم يشوف الداشبورد
    return res.status(403).json({ success: false, message: "Not allowed" });

  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

/* =========================
   🔹 Owner Billing
========================= */
app.get('/owner/supervisors', auth, async (req, res) => {

  if (req.user.role !== 'owner')
    return res.status(403).json({ success: false });

  const { data: supervisors } = await supabase
    .from('users')
    .select('email')
    .eq('role', 'supervisor');

  let rows = [];

  for (let sup of supervisors || []) {

    const { count } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('role', 'tech')
      .eq('supervisor_email', sup.email);

    rows.push({
      supervisor_email: sup.email,
      tech_count: count || 0,
      weekly_cost: (count || 0) * 10
    });
  }

  res.json({ success: true, rows });
});

/* =========================
   🔹 AI - Copilot (Gemini)
   (Owner / Supervisor / Tech)
========================= */
// ✅ Alias route عشان الموقع اللي يطلب /ask-ai يشتغل بدون ما نغير الفرونت

/* =========================
   🔹 AI - Copilot (Gemini)
   (تم دمج المسارات لتجنب التعارض مع الإبقاء على اسم الموديل كما هو)
========================= */

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://app.techhaj.com");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.post('/ai/copilot', auth, async (req, res) => {
  try {
    if (!genAI) {
      return res.status(500).json({ success: false, message: "GEMINI_API_KEY missing" });
    }

    const body = req.body || {};
    
    // دمج المدخلات لضمان قبول كافة أنواع الطلبات من الفرونت
    let input = body.input || {};
    const issue = body.issue || body.problem || body.text || body.prompt || body.message || body.query || input.symptoms || "";
    const system = body.system || input.service || "";
    const levelTap = body.level_tap ?? input.modem ?? "";
    const levelGb = body.level_gb ?? "";
    const opticPower = body.optic_power ?? "";
    const fittingsChanged = body.fittings_gb_changed ?? input.notes ?? "";

    if (!issue && !input.symptoms) {
      return res.status(400).json({ success: false, message: "Missing input" });
    }

    const safeInput = {
      issue: clampText(issue, 1500),
      system: clampText(system, 40),
      level_tap: clampText(levelTap, 40),
      level_gb: clampText(levelGb, 40),
      optic_power: clampText(opticPower, 40),
      fittings_gb_changed: clampText(fittingsChanged, 40),
    };

    const model = genAI.getGenerativeModel({
      model: "models/gemini-2.5-flash",
      generationConfig: { temperature: 0.2, maxOutputTokens: 600 },
    });

    const prompt = `
Return ONLY valid JSON (no markdown, no extra text).
Schema:
{
  "summary": "string",
  "steps": ["string","string","string"],
  "likely_causes": ["string","string","string"],
  "when_to_escalate": ["string","string","string"]
}

Input:
${JSON.stringify(safeInput)}
`.trim();

    const result = await model.generateContent(prompt);
    const textOut = result?.response?.text() || "";

    let cleaned = textOut.trim();
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) cleaned = cleaned.slice(first, last + 1);

    try {
      const json = JSON.parse(cleaned);
      return res.json({
        summary: String(json.summary || ""),
        steps: Array.isArray(json.steps) ? json.steps.slice(0, 3) : [],
        likely_causes: Array.isArray(json.likely_causes) ? json.likely_causes.slice(0, 3) : [],
        when_to_escalate: Array.isArray(json.when_to_escalate) ? json.when_to_escalate.slice(0, 3) : [],
      });
    } catch {
      return res.json({
        summary: clampText(textOut, 200),
        steps: [],
        likely_causes: [],
        when_to_escalate: [],
      });
    }

  } catch (e) {
    console.error("AI error FULL:", e?.response?.data || e);
    return res.status(500).json({
      success: false,
      message: "AI failed",
      error: String(e?.message || e),
    });
  }
});

/* ================================================================
   تم تحويل المسار المكرر أدناه إلى تعليق لتجنب تضارب الطلبات
   ================================================================
   
app.post('/ai/copilot', auth, async (req, res) => {
    // الكود الأصلي الثاني هنا..
});
*/

/* =========================
   🔹 Catch All
========================= */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* =========================
   🔹 Start
========================= */
const port = process.env.PORT || 3001;
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${port}`);
});