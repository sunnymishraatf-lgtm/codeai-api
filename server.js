require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const bodyParser = require("body-parser");
const fs = require("fs").promises;          // promises for async
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const winston = require("winston");
const NodeCache = require("node-cache");
const Joi = require("joi");

// ============================================
// CONFIGURATION & ENVIRONMENT
// ============================================
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const NODE_ENV = process.env.NODE_ENV || "development";
const allowedLangs = ["java", "python", "cpp", "c++", "vhdl"];

// ---- Logger ----
const logger = winston.createLogger({
    level: NODE_ENV === "production" ? "info" : "debug",
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: "codeai-api" },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

if (!GROQ_API_KEY) {
    logger.error("❌ GROQ_API_KEY is not set. AI features will fail.");
    // In production you might want to exit, but we leave it running for health checks.
}

// ---- Cache (in-memory) ----
const codeCache = new NodeCache({ stdTTL: 600, checkperiod: 120 }); // 10 min TTL

// ============================================
// SYSTEM PROMPT (EXACTLY AS REQUESTED)
// ============================================
const SYSTEM_PROMPT = `
You are a senior software engineer and competitive programming expert.

Your task is to generate COMPLETE, CORRECT, and EXECUTABLE source code for the user's programming question.

STRICT OUTPUT RULES:
1. Output ONLY raw source code.
2. Do NOT use markdown.
3. Do NOT add explanations, comments, notes, headings, or extra text.
4. Do NOT repeat the question.
5. Do NOT include backticks.
6. Return a complete runnable program.
7. Include all necessary imports.
8. Follow the exact input/output format from the question.
9. Never leave incomplete functions, TODOs, placeholders, or pseudocode.
10. Use only the programming language requested by the user.
11. Ensure the code is syntactically correct.
12. Ensure the code is logically correct.
13. Avoid runtime errors.
14. Avoid compilation errors.
15. Handle edge cases properly.
16. Prefer beginner-friendly and readable solutions.
17. If user code contains bugs, return the fully corrected code only.
18. Do NOT explain fixes.
19. Before outputting, internally verify:
   - syntax correctness
   - compilation correctness
   - runtime safety
   - variable declarations
   - imports
   - class names
   - function completeness
20. If the question is ambiguous, choose the most standard correct implementation.
21. Never output partial code.
22. The final response must contain ONLY the final code.
`;

// ============================================
// UTILITY FUNCTIONS
// ============================================

/** Async wrapper to catch errors in route handlers */
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

/** Custom application error */
class AppError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

/** Extension helper */
const getExtension = (lang) => {
    const map = { java: "java", python: "py", cpp: "cpp", "c++": "cpp", vhdl: "vhd" };
    return map[lang] || "txt";
};

/** AI call with retry logic */
const fetchWithRetry = async (url, options, retries = 2) => {
    for (let i = 0; i <= retries; i++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 25000);
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok) {
                const errBody = await response.text();
                throw new AppError(`AI API error: ${response.status} - ${errBody}`, 502);
            }
            return response;
        } catch (err) {
            if (i === retries) throw err;
            logger.warn(`AI request failed (attempt ${i + 1}), retrying...`, { error: err.message });
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // exponential backoff 1s, 2s
        }
    }
};

/** Get code from Groq AI */
const getCodeFromAI = async (question, language) => {
    if (!GROQ_API_KEY) throw new AppError("GROQ API key not configured", 500);

    const response = await fetchWithRetry(
        "https://api.groq.com/openai/v1/chat/completions",
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: `Language: ${language}\nQuestion: ${question}` }
                ],
                temperature: 0.2,
                max_tokens: 4000,
            }),
        }
    );

    const data = await response.json();
    if (!data?.choices?.[0]?.message?.content) {
        throw new AppError("Invalid response structure from AI", 502);
    }

    let code = data.choices[0].message.content;

    // Strip any accidental markdown fences
    code = code.replace(/```[\w]*\n?([\s\S]*?)\n?```/g, "$1");
    code = code.replace(/```/g, "");
    code = code.replace(/^`|`$/g, "");
    return code.trim();
};

// ============================================
// EXPRESS APP SETUP
// ============================================
const app = express();

// ---- Security headers ----
app.use(helmet());

// ---- CORS ----
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));

// ---- Compression ----
app.use(compression());

// ---- Body parsing with size limits ----
app.use(bodyParser.json({ limit: "1kb" }));
app.use(bodyParser.urlencoded({ extended: false, limit: "1kb" }));

// ---- Request ID ----
app.use((req, res, next) => {
    req.id = uuidv4();
    res.setHeader("X-Request-ID", req.id);
    next();
});

// ---- Logging middleware ----
app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
        logger.info({
            requestId: req.id,
            method: req.method,
            url: req.originalUrl,
            status: res.statusCode,
            responseTime: `${Date.now() - start}ms`,
        });
    });
    next();
});

// ---- Rate Limiting ----
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later.", success: false },
});
app.use(generalLimiter);

const aiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 20,
    message: { error: "AI request limit exceeded. Please slow down.", success: false },
});
app.use(["/ask", "/solve/raw"], aiLimiter);

// ---- Input sanitization (basic) ----
const sanitize = (str) => {
    if (!str) return str;
    return str.replace(/[<>{}]/g, "").trim().substring(0, 500);
};

// ============================================
// VALIDATION SCHEMAS (Joi)
// ============================================
const askQuerySchema = Joi.object({
    q: Joi.string().required().min(3).max(500).messages({
        "string.empty": "Question (q) is required",
        "string.min": "Question must be at least 3 characters",
    }),
    lang: Joi.string().valid(...allowedLangs, "c++").default("java"),
    download: Joi.string().optional().max(100),
});

const solveBodySchema = Joi.object({
    question: Joi.string().required().min(3).max(500),
    language: Joi.string().valid(...allowedLangs, "c++").default("java"),
});

// ============================================
// ROUTES
// ============================================

// Home
app.get("/", (req, res) => {
    res.json({
        message: "CodeAI API is running 🚀",
        version: "2.0.0",
        endpoints: {
            get: "/ask?q=question&lang=language&download=filename",
            post: "/solve/raw",
            health: "/health",
        },
        supportedLanguages: allowedLangs,
    });
});

// Health check
app.get("/health", async (req, res) => {
    const health = {
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        groqConfigured: !!GROQ_API_KEY,
    };
    // Optional: quick connectivity test (cached for 30s)
    if (GROQ_API_KEY) {
        const cacheKey = "health_check_groq";
        let reachable = codeCache.get(cacheKey);
        if (reachable === undefined) {
            try {
                await fetch("https://api.groq.com/openai/v1/models", {
                    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
                    signal: AbortSignal.timeout(5000),
                });
                reachable = true;
            } catch {
                reachable = false;
            }
            codeCache.set(cacheKey, reachable, 30);
        }
        health.groqReachable = reachable;
    }
    res.json(health);
});

// 🔥 Main GET ask endpoint
app.get("/ask", asyncHandler(async (req, res) => {
    // Validate query
    const { error, value } = askQuerySchema.validate(req.query, { stripUnknown: true });
    if (error) {
        throw new AppError(error.details[0].message, 400);
    }

    let { q: question, lang: language, download: downloadName } = value;

    // Normalize language
    if (language === "c++") language = "cpp";

    // Sanitize question (remove dashes/underscores)
    question = sanitize(question.replace(/[-_]/g, " "));

    // Check cache
    const cacheKey = `code:${language}:${question}`;
    let code = codeCache.get(cacheKey);

    if (!code) {
        logger.info("Cache miss, calling AI", { requestId: req.id, language, question });
        code = await getCodeFromAI(question, language);
        codeCache.set(cacheKey, code);
    } else {
        logger.info("Cache hit", { requestId: req.id, cacheKey });
    }

    // Download mode
    if (downloadName) {
        const safeName = downloadName.replace(/[^a-z0-9]/gi, "_").toLowerCase().substring(0, 50);
        const filename = `${safeName}_${Date.now()}.${getExtension(language)}`;
        const filepath = path.join(__dirname, "downloads", filename);

        // Ensure downloads directory exists
        await fs.mkdir(path.join(__dirname, "downloads"), { recursive: true });
        await fs.writeFile(filepath, code, "utf8");

        res.download(filepath, filename, async (err) => {
            // Cleanup after download
            try {
                await fs.unlink(filepath);
            } catch (unlinkErr) {
                logger.error("Failed to delete temp file", { filepath, error: unlinkErr.message });
            }
            if (err) {
                logger.error("Download error", { error: err.message });
            }
        });
    } else {
        // Normal mode: respond with raw code
        res.set("Content-Type", "text/plain; charset=utf-8");
        res.send(code);
    }
}));

// POST solve endpoint
app.post("/solve/raw", asyncHandler(async (req, res) => {
    const { error, value } = solveBodySchema.validate(req.body, { stripUnknown: true });
    if (error) {
        throw new AppError(error.details[0].message, 400);
    }

    let { question, language } = value;
    if (language === "c++") language = "cpp";

    question = sanitize(question);

    const cacheKey = `code:${language}:${question}`;
    let code = codeCache.get(cacheKey);

    if (!code) {
        logger.info("POST cache miss, calling AI", { requestId: req.id, language, question });
        code = await getCodeFromAI(question, language);
        codeCache.set(cacheKey, code);
    }

    res.set("Content-Type", "text/plain; charset=utf-8");
    res.send(code);
}));

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: "Not found", success: false });
});

// Centralized error handler
app.use((err, req, res, next) => {
    logger.error({
        requestId: req.id,
        error: err.message,
        stack: err.stack,
        statusCode: err.statusCode || 500,
    });

    if (err.isOperational) {
        return res.status(err.statusCode).json({
            error: err.message,
            success: false,
        });
    }

    // Unexpected errors
    return res.status(500).json({
        error: NODE_ENV === "production" ? "Internal server error" : err.message,
        success: false,
    });
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
const server = app.listen(PORT, () => {
    logger.info(`🚀 CodeAI API running on port ${PORT}`);
    logger.info(`Supported languages: ${allowedLangs.join(", ")}`);
    logger.info(`GROQ API: ${GROQ_API_KEY ? "✅ Configured" : "❌ Not configured"}`);
});

// Handle termination signals
const shutdown = async (signal) => {
    logger.info(`${signal} received. Shutting down gracefully...`);
    server.close(() => {
        logger.info("HTTP server closed.");
        // Close cache or other connections if needed
        codeCache.close();
        process.exit(0);
    });

    // Force shutdown after 10s
    setTimeout(() => {
        logger.error("Forced shutdown after timeout.");
        process.exit(1);
    }, 10000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
    logger.error("Uncaught Exception:", err);
    process.exit(1);
});

module.exports = app; // for testing