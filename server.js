const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

// ============================================
// CONFIGURATION (FIXED)
// ============================================

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

// ✅ FIX: use working model + env fallback
const AI_MODEL = process.env.AI_MODEL || "meta-llama/llama-3-8b-instruct";

const PORT = process.env.PORT || 3000;

// ============================================
// PROMPT
// ============================================
function buildPrompt(question) {
    return `You are a professional coding assistant.

Rules:
- Output ONLY code
- No explanation
- Simple beginner-friendly code
- Default language: Java

User Question:
${question}

Output:
<only code>`;
}

// ============================================
// AI CALL (FIXED)
// ============================================
async function getCodeFromAI(question) {
    if (!OPENROUTER_API_KEY) {
        throw new Error("No API key set.");
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: AI_MODEL,
            messages: [{ role: "user", content: buildPrompt(question) }]
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

// ✅ SIMPLE GET API (NEW - EASY USE)
app.get("/ask", async (req, res) => {
    const question = req.query.q;

    if (!question) {
        return res.send("Error: Question is required");
    }

    try {
        const code = await getCodeFromAI(question);
        res.type("text/plain");
        res.send(code);
    } catch (err) {
        res.send("Error: " + err.message);
    }
});

// POST API
app.post("/solve/raw", async (req, res) => {
    const question = req.body.question;

    if (!question) {
        return res.status(400).send("Error: Question is required");
    }

    try {
        const code = await getCodeFromAI(question);
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
    console.log(`Server running on port ${PORT}`);
});