const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json({ limit: "50kb" }));
app.use(bodyParser.urlencoded({ extended: false }));

// ----------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const allowedLangs = ["java", "python", "cpp", "c++", "vhdl"];
const solutionsDir = path.join(__dirname, "solutions");

// ----------------------------------------------------------------------
// PROMPTS
// ----------------------------------------------------------------------
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

// ----------------------------------------------------------------------
// LOAD SOLUTIONS
// ----------------------------------------------------------------------
const knownSolutions = new Map();
try {
    if (fs.existsSync(solutionsDir)) {
        fs.readdirSync(solutionsDir).forEach(file => {
            knownSolutions.set(file, fs.readFileSync(path.join(solutionsDir, file), "utf8"));
        });
        console.log(`Loaded ${knownSolutions.size} solutions.`);
    }
} catch (err) {
    console.error("Solution loading error:", err.message);
}

// ----------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------
function getExtension(lang) {
    switch (lang) {
        case "java": return "java";
        case "python": return "py";
        case "cpp":
        case "c++": return "cpp";
        case "vhdl": return "vhd";
        default: return "txt";
    }
}

// ----------------------------------------------------------------------
// AI CALL WITH RETRY
// ----------------------------------------------------------------------
async function callGroq(systemPrompt, userMessage, retries = 3) {
    if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured");
    const model = "llama-3.1-8b-instant";

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${GROQ_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userMessage }
                    ],
                    temperature: 0.2,
                    max_tokens: 4000
                }),
                signal: AbortSignal.timeout(25000)
            });

            if (!response.ok) {
                const errText = await response.text();
                if (errText.includes("rate_limit_exceeded")) {
                    const sec = parseFloat((errText.match(/in (\d+\.?\d*)s/) || [])[1]) || 15;
                    console.log(`Rate limited, waiting ${sec}s`);
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
            console.log(`Retry ${attempt + 1} after error: ${err.message}`);
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
    }
    throw new Error("Failed after retries");
}

// ----------------------------------------------------------------------
// ROUTES
// ----------------------------------------------------------------------

// Test endpoint – no dependencies
app.get("/test", (req, res) => res.send("Server is alive ✅"));

// Health
app.get("/api/health", (req, res) =>
    res.json({ status: "ok", groq: !!GROQ_API_KEY, solutions: knownSolutions.size })
);

// Experiments list
app.get("/api/experiments", (req, res) => {
    const list = [];
    for (const [filename] of knownSolutions) {
        const m = filename.match(/exp(\d+)_q(\d+)/i);
        if (m) list.push({ experiment: +m[1], question: +m[2], filename });
    }
    res.json(list);
});

// Get a solution
app.get("/api/solution/:filename", (req, res) => {
    const code = knownSolutions.get(req.params.filename);
    if (!code) return res.status(404).send("Solution not found");
    res.type("text/plain").send(code);
});

// Download a solution
app.get("/api/download/:filename", (req, res) => {
    const filePath = path.join(solutionsDir, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send("File not found");
    res.download(filePath);
});

// AI generation (GET)
app.get("/ask", async (req, res) => {
    try {
        let q = req.query.q;
        if (!q) return res.status(400).send("Question required");
        let lang = (req.query.lang || "java").toLowerCase();
        if (lang === "c++") lang = "cpp";
        if (!allowedLangs.includes(lang)) return res.status(400).send("Unsupported language");
        q = q.replace(/[-_]/g, " ");

        const code = await callGroq(SYSTEM_PROMPT, `Language: ${lang}\nQuestion: ${q}`);

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
        console.error("GET /ask error:", err);
        res.status(500).send("Error: " + err.message);
    }
});

// AI generation (POST)
app.post("/solve/raw", async (req, res) => {
    try {
        const q = req.body.question;
        if (!q) return res.status(400).send("Question required");
        let lang = (req.body.language || "java").toLowerCase();
        if (lang === "c++") lang = "cpp";
        if (!allowedLangs.includes(lang)) return res.status(400).send("Unsupported language");

        const code = await callGroq(SYSTEM_PROMPT, `Language: ${lang}\nQuestion: ${q}`);
        res.type("text/plain").send(code);
    } catch (err) {
        console.error("POST /solve/raw error:", err);
        res.status(500).send("Error: " + err.message);
    }
});

// Code fixer
app.post("/api/fix", async (req, res) => {
    try {
        const code = req.body.code;
        if (!code) return res.status(400).send("Code required");
        let lang = (req.body.language || "java").toLowerCase();
        if (lang === "c++") lang = "cpp";
        if (!allowedLangs.includes(lang)) return res.status(400).send("Unsupported language");

        const fixed = await callGroq(FIX_PROMPT, `Language: ${lang}\nBuggy Code:\n${code}`);
        res.json({ fixedCode: fixed, language: lang });
    } catch (err) {
        console.error("POST /api/fix error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------------------
// GLOBAL ERROR HANDLER – keeps server alive no matter what
// ----------------------------------------------------------------------
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).send("Internal server error");
});

// ----------------------------------------------------------------------
// START
// ----------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`GROQ_API_KEY ${GROQ_API_KEY ? "set" : "NOT SET"}`);
});