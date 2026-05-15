const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json({ limit: "50kb" }));
app.use(bodyParser.urlencoded({ extended: false }));

// ---- Config ----
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const MODEL_NAME = process.env.MODEL_NAME || "MiniMaxAI/MiniMax-M2.7";
const BASE_URL = process.env.BASE_URL || "https://openrouter.ai/api/v1";
const allowedLangs = ["java", "python", "cpp", "c++", "vhdl"];
const solutionsDir = path.join(__dirname, "solutions");

// ---- Prompts (insert your full prompts here) ----
const SYSTEM_PROMPT = `You are a senior software engineer... [your complete prompt]`;
const FIX_PROMPT = `You are an expert debugger... [your complete prompt]`;

// ---- Load solutions ----
const knownSolutions = new Map();
try {
  if (fs.existsSync(solutionsDir)) {
    fs.readdirSync(solutionsDir).forEach(file => {
      knownSolutions.set(file, fs.readFileSync(path.join(solutionsDir, file), "utf8"));
    });
    console.log(`Loaded ${knownSolutions.size} solutions.`);
  }
} catch (e) { console.error("Solutions load error:", e.message); }

// ---- Helpers ----
function getExtension(lang) {
  return { java: "java", python: "py", cpp: "cpp", "c++": "cpp", vhdl: "vhd" }[lang] || "txt";
}

async function callAI(systemPrompt, userMessage, retries = 3) {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not configured");

  const url = `${BASE_URL}/chat/completions`;
  console.log(`Calling AI at ${url}`);

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature: 0.2,
          max_tokens: 4000,
        }),
        signal: AbortSignal.timeout(25000),
      });

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const sec = parseInt(retryAfter) || 15;
          console.log(`Rate limited – waiting ${sec}s`);
          await new Promise(r => setTimeout(r, sec * 1000 + 500));
          continue;
        }
        throw new Error(`AI API ${response.status}: ${errText}`);
      }

      const data = await response.json();
      let code = data.choices[0].message.content;
      code = code.replace(/```[\w]*\n?([\s\S]*?)\n?```/g, "$1").replace(/```/g, "");
      return code.trim();
    } catch (err) {
      if (attempt === retries - 1) throw err;
      console.log(`Retry ${attempt + 1}: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error("Failed after retries");
}

// ---- Routes (all error‑handled) ----
app.get("/test", (req, res) => res.send("✅ MiniMax server is alive"));

app.get("/api/health", (req, res) => res.json({
  status: "ok",
  ai: !!OPENROUTER_API_KEY,
  model: MODEL_NAME,
  solutions: knownSolutions.size,
}));

app.get("/api/experiments", (req, res) => {
  const list = [];
  for (const [filename] of knownSolutions) {
    const m = filename.match(/exp(\d+)_q(\d+)/i);
    if (m) list.push({ experiment: +m[1], question: +m[2], filename });
  }
  res.json(list);
});

app.get("/api/solution/:filename", (req, res) => {
  const code = knownSolutions.get(req.params.filename);
  if (!code) return res.status(404).send("Not found");
  res.type("text/plain").send(code);
});

app.get("/api/download/:filename", (req, res) => {
  const filePath = path.join(solutionsDir, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
  res.download(filePath);
});

app.get("/ask", async (req, res) => {
  try {
    let q = req.query.q;
    if (!q) return res.status(400).send("Question required");
    let lang = (req.query.lang || "java").toLowerCase();
    if (lang === "c++") lang = "cpp";
    if (!allowedLangs.includes(lang)) return res.status(400).send("Unsupported language");
    q = q.replace(/[-_]/g, " ");

    const code = await callAI(SYSTEM_PROMPT, `Language: ${lang}\nQuestion: ${q}`);

    if (req.query.download) {
      const safeName = req.query.download.replace(/[^a-z0-9]/gi, "_").toLowerCase();
      const filename = `${safeName}.${getExtension(lang)}`;
      const filepath = path.join(__dirname, filename);
      fs.writeFileSync(filepath, code);
      res.download(filepath, filename, () => fs.unlinkSync(filepath));
    } else {
      res.type("text/plain").send(code);
    }
  } catch (err) {
    console.error("/ask error:", err);
    res.status(500).send("Error: " + err.message);
  }
});

app.post("/solve/raw", async (req, res) => {
  try {
    const q = req.body.question;
    if (!q) return res.status(400).send("Question required");
    let lang = (req.body.language || "java").toLowerCase();
    if (lang === "c++") lang = "cpp";
    if (!allowedLangs.includes(lang)) return res.status(400).send("Unsupported language");

    const code = await callAI(SYSTEM_PROMPT, `Language: ${lang}\nQuestion: ${q}`);
    res.type("text/plain").send(code);
  } catch (err) {
    console.error("/solve/raw error:", err);
    res.status(500).send("Error: " + err.message);
  }
});

app.post("/api/fix", async (req, res) => {
  try {
    const code = req.body.code;
    if (!code) return res.status(400).send("Code required");
    let lang = (req.body.language || "java").toLowerCase();
    if (lang === "c++") lang = "cpp";
    if (!allowedLangs.includes(lang)) return res.status(400).send("Unsupported language");

    const fixed = await callAI(FIX_PROMPT, `Language: ${lang}\nBuggy Code:\n${code}`);
    res.json({ fixedCode: fixed, language: lang });
  } catch (err) {
    console.error("/api/fix error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Start ----
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}, model=${MODEL_NAME}`);
});