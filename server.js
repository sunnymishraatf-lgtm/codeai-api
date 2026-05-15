const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ extended: false }));

// ============================================
// CONFIG
// ============================================
const API_KEY = process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || "";
const PORT = process.env.PORT || 3000;
const AI_MODEL = process.env.AI_MODEL || "llama-3.1-8b-instant";
const solutionsDir = path.join(__dirname, "solutions");

const LANG_CONFIG = {
    "java": "java",
    "python": "py",
    "cpp": "cpp",
    "c++": "cpp",
    "vhdl": "vhd"
};
const allowedLangs = Object.keys(LANG_CONFIG);

// ============================================
// PROMPTS
// ============================================
const SYSTEM_PROMPT = `
You are a senior software engineer and competitive programming expert.

Your task is to generate COMPLETE, CORRECT, and EXECUTABLE source code for the user's programming question.

STRICT OUTPUT RULES:
1. Output ONLY raw source code.
2. Do NOT use markdown.
3. Do NOT add explanations, comments, notes, headings, or extra text.
4. Do NOT repeat the question.
5. Do NOT include \`\`\` or language tags.
6. Generate complete and executable code.
7. The code must directly solve the exact problem asked by the user.
8. Keep the code simple, clean, and beginner-friendly.
9. Avoid unnecessary complexity.
10. Use fast and optimized logic when possible.
11. Include all required imports/libraries.
12. If input/output format is mentioned, follow it exactly.
13. Do not leave incomplete functions or placeholders.
14. If multiple approaches exist, return the most reliable one.
15. Ensure the code runs without syntax errors.
16. Use only the programming language requested by the user.
17. Never give pseudocode.
18. Never explain anything before or after the code.
19. If the user provides buggy code, return the corrected full code only.
20. Always prioritize correctness over creativity.

Your response must contain nothing except the final code.
`;

const FIX_PROMPT = `
You are an expert debugger. A user has provided buggy code below. Your task is to return the CORRECTED version of the code.

STRICT RULES:
1. Output ONLY the corrected raw source code.
2. Do NOT use markdown.
3. Do NOT explain what you changed.
4. Do NOT include backticks.
5. Return a complete, runnable program.
6. Fix all logical, syntax, and runtime errors.
7. Keep the original code structure as much as possible, only fix what's broken.
8. Include all necessary imports.
9. If the code is already correct, return it unchanged.
10. The final response must contain ONLY the corrected code.
`;

// ============================================
// LOAD PRE‑SAVED SOLUTIONS (from /solutions folder)
// ============================================
const knownSolutions = new Map();

function loadSolutions() {
    if (!fs.existsSync(solutionsDir)) {
        fs.mkdirSync(solutionsDir);
        console.log("Created 'solutions/' folder. Add your .java/.py files there.");
        return;
    }
    const files = fs.readdirSync(solutionsDir);
    files.forEach(file => {
        try {
            const filePath = path.join(solutionsDir, file);
            const code = fs.readFileSync(filePath, "utf8");
            knownSolutions.set(file, code);
            console.log(`📁 Loaded solution: ${file}`);
        } catch (err) {
            console.error(`❌ Failed to load ${file}: ${err.message}`);
        }
    });
    console.log(`✅ Total solutions loaded: ${knownSolutions.size}`);
}
loadSolutions();

// ============================================
// EXTENSION HELPER
// ============================================
function getExtension(lang) {
    return LANG_CONFIG[lang] || "txt";
}

// ============================================
// GROQ AI CALL (with rate‑limit retry)
// ============================================
async function callGroq(systemPrompt, userMessage, retries = 3) {
    if (!API_KEY) {
        throw new Error("No API key set (GROQ_API_KEY or OPENROUTER_API_KEY).");
    }

    for (let attempt = 0; attempt < retries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000);

        try {
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: AI_MODEL,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userMessage }
                    ],
                    temperature: 0.2,
                    max_tokens: 4000
                }),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const errText = await response.text();
                let errData;
                try { errData = JSON.parse(errText); } catch {}

                // Handle rate limit specifically
                if (errData?.error?.code === "rate_limit_exceeded") {
                    const waitMsg = errData.error.message || "";
                    const match = waitMsg.match(/in (\d+\.?\d*)s/);
                    const waitSeconds = match ? parseFloat(match[1]) : 15;
                    console.log(`Rate limited, waiting ${waitSeconds}s before retry...`);
                    await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000 + 500));
                    continue;
                }

                throw new Error(`AI API error: ${response.status} - ${errText}`);
            }

            const data = await response.json();
            let code = data.choices[0].message.content;

            // Strip markdown
            code = code.replace(/```[\w]*\n?([\s\S]*?)\n?```/g, "$1");
            code = code.replace(/```/g, "");
            return code.trim();
        } catch (err) {
            clearTimeout(timeout);
            if (attempt === retries - 1) throw err;
            await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
        }
    }
    throw new Error("Failed after multiple retries");
}

// ============================================
// ROUTES
// ============================================

app.get("/", (req, res) => {
    res.send("CodeAI API is running 🚀. Use /api/experiments, /api/solution/:filename, /api/ask, /api/fix");
});

app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        api_key: !!API_KEY,
        solutions: knownSolutions.size
    });
});

app.get("/api/experiments", (req, res) => {
    const list = [];
    for (const filename of knownSolutions.keys()) {
        const match = filename.match(/exp(\d+)_q(\d+)/i);
        if (match) {
            const fileExt = path.extname(filename).toLowerCase().replace(".", "");
            // Map extension back to language name for consistency
            const lang = Object.keys(LANG_CONFIG).find(k => LANG_CONFIG[k] === fileExt) || "txt";

            list.push({
                experiment: parseInt(match[1]),
                question: parseInt(match[2]),
                filename,
                language: lang
            });
        }
    }
    res.json(list);
});

app.get("/api/solution/:filename", (req, res) => {
    const safeFilename = path.basename(req.params.filename);
    const code = knownSolutions.get(safeFilename);
    if (!code) {
        return res.status(404).send("Solution not found.");
    }
    res.type("text/plain").send(code);
});

app.get("/api/download/:filename", (req, res) => {
    const safeFilename = path.basename(req.params.filename);
    const filePath = path.join(solutionsDir, safeFilename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File not found.");
    }
    res.download(filePath);
});

app.get("/ask", async (req, res) => {
    let question = req.query.q;
    let language = (req.query.lang || "java").toLowerCase();
    const downloadName = req.query.download;

    if (!question) {
        return res.status(400).send("Error: Question is required");
    }

    question = question.replace(/[-_]/g, " ");

    if (language === "c++") language = "cpp";
    if (!allowedLangs.includes(language)) {
        return res.status(400).send("Error: Unsupported language");
    }

    try {
        const code = await callGroq(SYSTEM_PROMPT, `Language: ${language}\nQuestion: ${question}`);

        if (downloadName) {
            const safeName = downloadName.replace(/[^a-z0-9]/gi, "_").toLowerCase();
            const filename = `${Date.now()}_${safeName}.${getExtension(language)}`;
            const filepath = path.join(__dirname, filename);
            fs.writeFileSync(filepath, code);
            res.download(filepath, filename, () => {
                fs.unlinkSync(filepath);
            });
        } else {
            res.type("text/plain");
            res.send(code);
        }
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

app.get("/languages", (req, res) => {
    res.json(allowedLangs);
});

app.post("/solve", async (req, res) => {
    const question = req.body.question;
    let language = (req.body.language || "java").toLowerCase();

    if (!question) {
        return res.status(400).json({ success: false, error: "Question is required" });
    }
    if (language === "c++") language = "cpp";
    if (!allowedLangs.includes(language)) {
        return res.status(400).json({ success: false, error: "Unsupported language" });
    }

    try {
        const code = await callGroq(SYSTEM_PROMPT, `Language: ${language}\nQuestion: ${question}`);
        res.json({
            success: true,
            question,
            code,
            language
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/solve/raw", async (req, res) => {
    const question = req.body.question;
    let language = (req.body.language || "java").toLowerCase();

    if (!question) {
        return res.status(400).send("Error: Question is required");
    }
    if (language === "c++") language = "cpp";
    if (!allowedLangs.includes(language)) {
        return res.status(400).send("Error: Unsupported language");
    }

    try {
        const code = await callGroq(SYSTEM_PROMPT, `Language: ${language}\nQuestion: ${question}`);
        res.type("text/plain");
        res.send(code);
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

app.post("/api/fix", async (req, res) => {
    const code = req.body.code;
    let language = (req.body.language || "java").toLowerCase();

    if (!code) {
        return res.status(400).send("Error: Code is required");
    }
    if (language === "c++") language = "cpp";
    if (!allowedLangs.includes(language)) {
        return res.status(400).send("Error: Unsupported language");
    }

    try {
        const fixedCode = await callGroq(FIX_PROMPT, `Language: ${language}\nBuggy Code:\n${code}`);
        res.json({ fixedCode, language });
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send("Something went wrong!");
});

// ============================================
// START (bind to 0.0.0.0 for Render)
// ============================================
app.listen(PORT, '0.0.0.0', () => {
    console.log("=================================");
    console.log("   🚀 CodeAI API (Enhanced)");
    console.log("=================================");
    console.log(`Running on port ${PORT}`);
    console.log(`API Key: ${API_KEY ? "✅" : "❌"}`);
    console.log(`Pre‑loaded solutions: ${knownSolutions.size}`);
});