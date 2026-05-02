const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// ============================================
// CONFIG
// ============================================
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const PORT = process.env.PORT || 3000;
const allowedLangs = ["java", "python", "cpp", "c++", "vhdl"];

// ============================================
// PROMPT
// ============================================
function buildPrompt(question, language = "java") {
    return `You are a professional coding assistant.

Rules:
- Output ONLY code
- No explanation
- Simple beginner-friendly code
- Language: ${language}

User Question:
${question}

Output:
<only code>`;
}

// ============================================
// EXTENSION HELPER
// ============================================
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

// ============================================
// GROQ AI CALL
// ============================================
async function getCodeFromAI(prompt) {
    if (!GROQ_API_KEY) {
        throw new Error("No GROQ API key set.");
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2
        })
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`AI API error: ${response.status} - ${err}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

// ============================================
// ROUTES
// ============================================

// Home
app.get("/", (req, res) => {
    res.send("CodeAI API is running 🚀");
});

// 🔥 MAIN API
app.get("/ask", async (req, res) => {
    let question = req.query.q;
    let language = (req.query.lang || "java").toLowerCase();
    const downloadName = req.query.download;

    if (!question) {
        return res.send("Error: Question is required");
    }

    // ✅ convert dash to space
    question = question.replace(/[-_]/g, " ");

    // normalize
    if (language === "c++") language = "cpp";

    // validate
    if (!allowedLangs.includes(language)) {
        return res.send("Error: Unsupported language");
    }

    try {
        const prompt = buildPrompt(question, language);
        const code = await getCodeFromAI(prompt);

        // 🔥 DOWNLOAD MODE (custom filename)
        if (downloadName) {
            const safeName = downloadName.replace(/[^a-z0-9]/gi, "_").toLowerCase();
            const filename = `${safeName}.${getExtension(language)}`;
            const filepath = path.join(__dirname, filename);

            fs.writeFileSync(filepath, code);

            res.download(filepath, filename, () => {
                fs.unlinkSync(filepath);
            });

        } else {
            // NORMAL MODE
            res.type("text/plain");
            res.send(code);
        }

    } catch (err) {
        res.send("Error: " + err.message);
    }
});

// POST API
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
        const prompt = buildPrompt(question, language);
        const code = await getCodeFromAI(prompt);

        res.type("text/plain");
        res.send(code);

    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

// ============================================
// START
// ============================================
app.listen(PORT, () => {
    console.log("=================================");
    console.log("   🚀 CodeAI API (FINAL VERSION)");
    console.log("=================================");
    console.log(`Running on port ${PORT}`);
});