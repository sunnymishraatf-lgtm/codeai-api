const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// ============================================
// CONFIG (FREE GROQ)
// ============================================
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
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
// GROQ AI CALL (FREE)
// ============================================
async function getCodeFromAI(question) {
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
            model: "llama3-8b-8192",
            messages: [
                {
                    role: "user",
                    content: buildPrompt(question)
                }
            ],
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

// 🔥 EASY GET API
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

// POST API (for curl JSON)
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
// START SERVER
// ============================================
app.listen(PORT, () => {
    console.log("=================================");
    console.log("   🚀 CodeAI API (FREE VERSION)");
    console.log("=================================");
    console.log(`Running on port ${PORT}`);
});