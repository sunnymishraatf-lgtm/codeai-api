const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

// ============================================
// CONFIGURATION
// ============================================
// Use OpenRouter for FREE AI (no credit card needed)
// Get key: https://openrouter.ai/keys
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "mistralai/mistral-7b-instruct:free";
const PORT = process.env.PORT || 3000;

// ============================================
// AI PROMPT BUILDER (exact from your spec)
// ============================================
function buildPrompt(question) {
    return `You are a professional coding assistant.

Your job is to:
1. Read the user's programming question carefully.
2. Understand the requirement clearly.
3. Generate correct and complete code.

Rules:
- Output ONLY code (no explanation, no comments, no extra text).
- Keep code simple and beginner-friendly.
- Use proper syntax and structure.
- Default language: Java.
- If user specifies language (like Python, C++, etc.), follow that.

Extra:
- If question is unclear, assume a reasonable interpretation and solve it.
- Always give full runnable code.

User Question:
${question}

Output:
<only code>`;
}

// ============================================
// AI CALLER (OpenRouter - Free Tier)
// ============================================
async function getCodeFromAI(question) {
    if (!OPENROUTER_API_KEY) {
        throw new Error("No API key set. Add OPENROUTER_API_KEY environment variable.");
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://codeai-api.com",
            "X-Title": "CodeAI API"
        },
        body: JSON.stringify({
            model: AI_MODEL,
            messages: [{ role: "user", content: buildPrompt(question) }],
            temperature: 0.2,
            max_tokens: 2048
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

// Health check
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// API: Solve coding question
app.post("/solve", async (req, res) => {
    const question = req.body.question;

    if (!question || question.trim() === "") {
        return res.status(400).json({ error: "Question is required" });
    }

    try {
        const code = await getCodeFromAI(question);
        res.json({
            success: true,
            question: question,
            code: code,
            language: detectLanguage(question)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err.message || "Failed to generate code"
        });
    }
});

// API: Raw code output (for curl)
app.post("/solve/raw", async (req, res) => {
    const question = req.body.question;

    if (!question || question.trim() === "") {
        return res.status(400).send("Error: Question is required");
    }

    try {
        const code = await getCodeFromAI(question);
        res.type("text/plain");
        res.send(code);
    } catch (err) {
        res.status(500).send(`Error: ${err.message}`);
    }
});

// API: Get supported languages
app.get("/languages", (req, res) => {
    res.json([
        "java", "python", "cpp", "c", "javascript", "typescript",
        "go", "rust", "kotlin", "swift", "csharp", "php", "ruby"
    ]);
});

// ============================================
// HELPERS
// ============================================
function detectLanguage(question) {
    const q = question.toLowerCase();
    if (q.includes("python")) return "python";
    if (q.includes("c++") || q.includes("cpp")) return "cpp";
    if (q.includes("javascript") || q.includes("js")) return "javascript";
    if (q.includes("typescript") || q.includes("ts")) return "typescript";
    if (q.includes("go ") || q.includes("golang")) return "go";
    if (q.includes("rust")) return "rust";
    if (q.includes("kotlin")) return "kotlin";
    if (q.includes("swift")) return "swift";
    if (q.includes("c#") || q.includes("csharp")) return "csharp";
    if (q.includes("php")) return "php";
    if (q.includes("ruby")) return "ruby";
    if (q.includes("c program") || q.includes(" in c ")) return "c";
    return "java"; // default
}

// ============================================
// START
// ============================================
app.listen(PORT, () => {
    console.log("========================================");
    console.log("     🤖 CodeAI API Server");
    console.log("========================================");
    console.log(` Running on http://localhost:${PORT}`);
    console.log("");
    console.log(" Endpoints:");
    console.log(`   POST http://localhost:${PORT}/solve`);
    console.log(`   POST http://localhost:${PORT}/solve/raw`);
    console.log(`   GET  http://localhost:${PORT}/languages`);
    console.log("");
    console.log(" Test with curl:");
    console.log(`   curl -X POST http://localhost:${PORT}/solve/raw \
     -H "Content-Type: application/json" \
     -d '{"question":"wap to print nodes of linked list"}'`);
    console.log("========================================");
});
