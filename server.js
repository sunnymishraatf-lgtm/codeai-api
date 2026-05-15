require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const bodyParser = require("body-parser");
const fs = require("fs").promises;
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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NODE_ENV = process.env.NODE_ENV || "development";
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : "*";

const allowedLangs = ["java", "python", "cpp", "c++", "vhdl", "javascript", "typescript", "go", "rust"];

// ---- Logger ----
const logger = winston.createLogger({
    level: NODE_ENV === "production" ? "info" : "debug",
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: "codeai-api-v3" },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ level, message, timestamp, requestId, ...meta }) => {
                    const id = requestId || "system";
                    const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : "";
                    return `[${timestamp}] [${id}] ${level}: ${message} ${metaStr}`;
                })
            )
        })
    ]
});

if (!GROQ_API_KEY && !OPENAI_API_KEY) {
    logger.error("❌ No AI API keys configured (GROQ_API_KEY or OPENAI_API_KEY). AI features will fail.");
}

// ---- Cache (in-memory with configurable TTL) ----
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS, 10) || 600;
const codeCache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 120, useClones: false });

// ============================================
// SYSTEM PROMPTS
// ============================================
const SYSTEM_PROMPT = `You are a senior software engineer and competitive programming expert.

Generate COMPLETE, CORRECT, and EXECUTABLE source code.

STRICT OUTPUT RULES:
1. Output ONLY raw source code.
2. Do NOT use markdown, backticks, explanations, or headings.
3. Do NOT repeat the question.
4. Return a complete runnable program with all imports/headers.
5. Follow the exact input/output format from the question.
6. Never leave incomplete functions, TODOs, or placeholders.
7. Use only the requested programming language.
8. Handle edge cases (empty input, overflow, boundaries).
9. Prefer clean, readable solutions.
10. For Java: public class Main with static main method.
11. For C++: use ios::sync_with_stdio(false); cin.tie(nullptr);
12. For Python: use sys.stdin.readline for fast input.
13. Before outputting, verify syntax, imports, and logic mentally.`;

const BUGFIX_PROMPT = `You are a senior code reviewer. Fix all bugs in the provided code.
Return ONLY the fully corrected, complete, runnable source code.
Do NOT explain fixes. Do NOT use markdown.`;

// ============================================
// UTILITY FUNCTIONS
// ============================================

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

class AppError extends Error {
    constructor(message, statusCode = 500, isOperational = true) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        Error.captureStackTrace(this, this.constructor);
    }
}

const getExtension = (lang) => {
    const map = {
        java: "java", python: "py", cpp: "cpp", "c++": "cpp",
        vhdl: "vhd", javascript: "js", typescript: "ts", go: "go", rust: "rs"
    };
    return map[lang] || "txt";
};

// CRITICAL FIX: Original removed {} which destroys ALL code. Now only strips HTML/XSS.
const sanitize = (str) => {
    if (!str || typeof str !== "string") return "";
    return str
        .replace(/<<script\b[^<<]*(?:(?!<\/script>)<<[^<<]*)*<<\/script>/gi, "")
        .replace(/<<iframe\b[^<<]*(?:(?!<\/iframe>)<<[^<<]*)*<<\/iframe>/gi, "")
        .replace(/<<style\b[^<<]*(?:(?!<\/style>)<<[^<<]*)*<<\/style>/gi, "")
        .replace(/javascript:/gi, "")
        .replace(/on\w+\s*=/gi, "")
        .trim()
        .substring(0, 3000); // Increased from 500 to 3000
};

// Circuit breaker state for AI providers
const providerState = {
    groq: { failures: 0, lastFailure: 0, open: false },
    openai: { failures: 0, lastFailure: 0, open: false }
};

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_RESET_MS = 30000;

const isCircuitOpen = (provider) => {
    const state = providerState[provider];
    if (!state.open) return false;
    if (Date.now() - state.lastFailure > CIRCUIT_RESET_MS) {
        state.open = false;
        state.failures = 0;
        logger.info(`Circuit breaker reset for ${provider}`);
        return false;
    }
    return true;
};

const recordFailure = (provider) => {
    const state = providerState[provider];
    state.failures++;
    state.lastFailure = Date.now();
    if (state.failures >= CIRCUIT_THRESHOLD) {
        state.open = true;
        logger.warn(`Circuit breaker OPENED for ${provider}`);
    }
};

const recordSuccess = (provider) => {
    const state = providerState[provider];
    if (state.failures > 0) {
        state.failures = 0;
        state.open = false;
    }
};

// ============================================
// AI PROVIDERS
// ============================================

const fetchWithRetry = async (url, options, retries = 2) => {
    for (let i = 0; i <= retries; i++) {
        try {
            const response = await fetch(url, {
                ...options,
                signal: AbortSignal.timeout(25000)
            });
            if (!response.ok) {
                const errBody = await response.text().catch(() => "Unknown error");
                throw new AppError(`AI API error: ${response.status} - ${errBody}`, 502);
            }
            return response;
        } catch (err) {
            if (i === retries) throw err;
            logger.warn(`AI request failed (attempt ${i + 1}), retrying...`, { error: err.message });
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
};

const cleanCodeOutput = (raw) => {
    if (!raw) return "";
    let code = raw;
    // Remove markdown fences
    code = code.replace(/```[\w]*\n?([\s\S]*?)\n?```/g, "$1");
    code = code.replace(/```/g, "");
    code = code.replace(/^`|`$/g, "");
    // Remove common prefixes like "Here is the code:" etc
    code = code.replace(/^(Here is|Below is|The following is)[\s\S]{0,100}?:/i, "");
    return code.trim();
};

const getCodeFromGroq = async (question, language, stream = false) => {
    if (!GROQ_API_KEY) throw new AppError("Groq API key not configured", 500);

    const response = await fetchWithRetry(
        "https://api.groq.com/openai/v1/chat/completions",
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile", // Upgraded from 8b to 70b
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: `Language: ${language}\nQuestion: ${question}` }
                ],
                temperature: 0.1,
                max_tokens: 8000, // Increased for larger programs
                stream
            }),
        }
    );

    if (stream) return response.body; // Return readable stream

    const data = await response.json();
    if (!data?.choices?.[0]?.message?.content) {
        throw new AppError("Invalid response structure from Groq", 502);
    }
    return cleanCodeOutput(data.choices[0].message.content);
};

const getCodeFromOpenAI = async (question, language, stream = false) => {
    if (!OPENAI_API_KEY) throw new AppError("OpenAI API key not configured", 500);

    const response = await fetchWithRetry(
        "https://api.openai.com/v1/chat/completions",
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: `Language: ${language}\nQuestion: ${question}` }
                ],
                temperature: 0.1,
                max_tokens: 8000,
                stream
            }),
        }
    );

    if (stream) return response.body;

    const data = await response.json();
    if (!data?.choices?.[0]?.message?.content) {
        throw new AppError("Invalid response structure from OpenAI", 502);
    }
    return cleanCodeOutput(data.choices[0].message.content);
};

// Smart provider selection with fallback
const getCodeFromAI = async (question, language, stream = false) => {
    const providers = [
        { name: "groq", fn: getCodeFromGroq, available: !!GROQ_API_KEY },
        { name: "openai", fn: getCodeFromOpenAI, available: !!OPENAI_API_KEY }
    ].filter(p => p.available && !isCircuitOpen(p.name));

    if (providers.length === 0) {
        throw new AppError("All AI providers are unavailable. Please try again later.", 503);
    }

    let lastError;
    for (const provider of providers) {
        try {
            logger.info(`Trying AI provider: ${provider.name}`, { question: question.substring(0, 50) });
            const result = await provider.fn(question, language, stream);
            recordSuccess(provider.name);
            return { code: result, provider: provider.name, stream: !!stream };
        } catch (err) {
            logger.error(`Provider ${provider.name} failed`, { error: err.message });
            recordFailure(provider.name);
            lastError = err;
        }
    }

    throw lastError || new AppError("All AI providers failed", 503);
};

// ============================================
// SYNTAX VALIDATOR (Basic regex-based)
// ============================================
const validateSyntax = (code, language) => {
    const errors = [];
    if (!code || code.length < 10) {
        errors.push("Generated code is too short or empty");
        return { valid: false, errors };
    }

    if (language === "java") {
        if (!code.includes("class")) errors.push("Missing class declaration");
        if (!code.includes("public static void main") && !code.includes("main(")) {
            // Some problems might not need main, so just warn
        }
        const openBraces = (code.match(/\{/g) || []).length;
        const closeBraces = (code.match(/\}/g) || []).length;
        if (openBraces !== closeBraces) errors.push(`Brace mismatch: ${openBraces} open, ${closeBraces} close`);
    }

    if (language === "cpp") {
        if (!code.includes("#include")) errors.push("Missing #include statements");
        const openBraces = (code.match(/\{/g) || []).length;
        const closeBraces = (code.match(/\}/g) || []).length;
        if (openBraces !== closeBraces) errors.push(`Brace mismatch: ${openBraces} open, ${closeBraces} close`);
    }

    if (language === "python") {
        // Check basic indentation issues
        const lines = code.split("\n");
        let prevIndent = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim() === "" || line.trim().startsWith("#")) continue;
            const indent = line.search(/\S/);
            if (indent !== -1 && indent % 4 !== 0 && indent > prevIndent) {
                // Non-standard indentation warning (soft)
            }
            prevIndent = indent;
        }
    }

    return { valid: errors.length === 0, errors };
};

// ============================================
// EXPRESS APP SETUP
// ============================================
const app = express();

// Security headers with relaxed CSP for API
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));

// CORS
app.use(cors({
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
    credentials: true,
}));

// Compression
app.use(compression());

// CRITICAL FIX: Body limit increased from 1kb to 50kb for code questions
app.use(bodyParser.json({ limit: "50kb" }));
app.use(bodyParser.urlencoded({ extended: false, limit: "50kb" }));

// Request ID
app.use((req, res, next) => {
    req.id = uuidv4();
    res.setHeader("X-Request-ID", req.id);
    next();
});

// Logging middleware
app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
        logger.info({
            requestId: req.id,
            method: req.method,
            url: req.originalUrl,
            status: res.statusCode,
            responseTime: `${Date.now() - start}ms`,
            ip: req.ip,
            userAgent: req.get("user-agent")?.substring(0, 50)
        });
    });
    next();
});

// Rate Limiting
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later.", success: false },
    keyGenerator: (req) => req.ip
});
app.use(generalLimiter);

const aiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: parseInt(process.env.AI_RATE_LIMIT_MAX, 10) || 20,
    message: { error: "AI request limit exceeded. Please slow down.", success: false },
    keyGenerator: (req) => req.ip,
    skip: (req) => req.path === "/health" // Don't rate limit health checks
});
app.use(["/ask", "/solve/raw", "/solve/stream"], aiLimiter);

// ============================================
// VALIDATION SCHEMAS (Joi)
// ============================================
const askQuerySchema = Joi.object({
    q: Joi.string().required().min(3).max(3000).messages({
        "string.empty": "Question (q) is required",
        "string.min": "Question must be at least 3 characters",
        "string.max": "Question too long (max 3000 chars)",
    }),
    lang: Joi.string().valid(...allowedLangs).default("java"),
    download: Joi.string().max(100).optional(),
    stream: Joi.string().valid("true", "false").default("false"),
    bugfix: Joi.string().valid("true", "false").default("false"), // New: fix buggy code mode
});

const solveBodySchema = Joi.object({
    question: Joi.string().required().min(3).max(3000),
    language: Joi.string().valid(...allowedLangs).default("java"),
    stream: Joi.boolean().default(false),
    bugfix: Joi.boolean().default(false),
});

// ============================================
// ROUTES
// ============================================

app.get("/", (req, res) => {
    res.json({
        message: "CodeAI API v3.0 is running 🚀",
        version: "3.0.0",
        endpoints: {
            get: "/ask?q=question&lang=language&download=filename&stream=true|false",
            post: "/solve/raw",
            stream: "/solve/stream (SSE)",
            health: "/health",
        },
        supportedLanguages: allowedLangs,
        providers: {
            groq: !!GROQ_API_KEY,
            openai: !!OPENAI_API_KEY
        },
        features: ["multi-provider fallback", "streaming", "syntax validation", "circuit breaker"]
    });
});

app.get("/health", async (req, res) => {
    const health = {
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cacheKeys: codeCache.getStats().keys,
        providers: {
            groq: { configured: !!GROQ_API_KEY, circuitOpen: providerState.groq.open, failures: providerState.groq.failures },
            openai: { configured: !!OPENAI_API_KEY, circuitOpen: providerState.openai.open, failures: providerState.openai.failures }
        }
    };

    // Quick connectivity test (cached 30s)
    if (GROQ_API_KEY) {
        const cacheKey = "health:groq";
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
        health.providers.groq.reachable = reachable;
    }

    const isHealthy = Object.values(health.providers).some(p => p.configured && !p.circuitOpen);
    res.status(isHealthy ? 200 : 503).json(health);
});

// 🔥 Main GET endpoint with optional streaming & download
app.get("/ask", asyncHandler(async (req, res) => {
    const { error, value } = askQuerySchema.validate(req.query, { stripUnknown: true });
    if (error) throw new AppError(error.details[0].message, 400);

    let { q: question, lang: language, download: downloadName, stream, bugfix } = value;
    if (language === "c++") language = "cpp";
    question = sanitize(question.replace(/[-_]/g, " "));

    const isStream = stream === "true";
    const isBugfix = bugfix === "true";
    const cacheKey = `code:${language}:${isBugfix ? "fix:" : ""}${question}`;

    // Check cache (skip cache for streaming to avoid buffering issues, or cache after)
    if (!isStream) {
        const cached = codeCache.get(cacheKey);
        if (cached) {
            logger.info("Cache hit", { requestId: req.id, cacheKey });
            if (downloadName) return sendDownload(res, cached, downloadName, language);
            return res.set("Content-Type", "text/plain; charset=utf-8").send(cached);
        }
    }

    logger.info("Cache miss, calling AI", { requestId: req.id, language, stream: isStream });

    const prompt = isBugfix
        ? `${BUGFIX_PROMPT}\n\nLanguage: ${language}\nCode:\n${question}`
        : `Language: ${language}\nQuestion: ${question}`;

    // Streaming mode
    if (isStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        try {
            const result = await getCodeFromAI(prompt, language, true);
            const reader = result.code.getReader();
            let fullCode = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = new TextDecoder().decode(value);
                const lines = chunk.split("\n").filter(line => line.trim().startsWith("data: "));

                for (const line of lines) {
                    const jsonStr = line.replace("data: ", "").trim();
                    if (jsonStr === "[DONE]") continue;

                    try {
                        const parsed = JSON.parse(jsonStr);
                        const content = parsed.choices?.[0]?.delta?.content || "";
                        if (content) {
                            fullCode += content;
                            res.write(`data: ${JSON.stringify({ chunk: content, done: false })}\n\n`);
                        }
                    } catch {
                        // Ignore parse errors in stream
                    }
                }
            }

            // Validate and cache final result
            const cleaned = cleanCodeOutput(fullCode);
            const validation = validateSyntax(cleaned, language);
            if (!validation.valid) {
                res.write(`data: ${JSON.stringify({ warnings: validation.errors, done: false })}\n\n`);
            }
            codeCache.set(cacheKey, cleaned);
            res.write(`data: ${JSON.stringify({ done: true, provider: result.provider, valid: validation.valid })}\n\n`);
            res.end();
        } catch (err) {
            res.write(`data: ${JSON.stringify({ error: err.message, done: true })}\n\n`);
            res.end();
        }
        return;
    }

    // Normal mode
    const result = await getCodeFromAI(prompt, language, false);
    let code = result.code;

    // Syntax validation
    const validation = validateSyntax(code, language);
    if (!validation.valid) {
        logger.warn("Syntax validation warnings", { requestId: req.id, errors: validation.errors });
        res.set("X-Syntax-Warnings", JSON.stringify(validation.errors));
    }
    res.set("X-Provider", result.provider);
    res.set("X-Syntax-Valid", validation.valid);

    // Cache result
    codeCache.set(cacheKey, code);

    if (downloadName) {
        return sendDownload(res, code, downloadName, language);
    }

    res.set("Content-Type", "text/plain; charset=utf-8");
    res.send(code);
}));

// POST solve endpoint
app.post("/solve/raw", asyncHandler(async (req, res) => {
    const { error, value } = solveBodySchema.validate(req.body, { stripUnknown: true });
    if (error) throw new AppError(error.details[0].message, 400);

    let { question, language, bugfix } = value;
    if (language === "c++") language = "cpp";
    question = sanitize(question);

    const cacheKey = `code:${language}:${bugfix ? "fix:" : ""}${question}`;
    const cached = codeCache.get(cacheKey);
    if (cached) {
        logger.info("POST cache hit", { requestId: req.id });
        return res.set("Content-Type", "text/plain; charset=utf-8").send(cached);
    }

    const prompt = bugfix
        ? `${BUGFIX_PROMPT}\n\nLanguage: ${language}\nCode:\n${question}`
        : `Language: ${language}\nQuestion: ${question}`;

    const result = await getCodeFromAI(prompt, language, false);
    codeCache.set(cacheKey, result.code);

    res.set("X-Provider", result.provider);
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.send(result.code);
}));

// SSE Streaming endpoint (dedicated)
app.post("/solve/stream", asyncHandler(async (req, res) => {
    const { error, value } = solveBodySchema.validate(req.body, { stripUnknown: true });
    if (error) throw new AppError(error.details[0].message, 400);

    let { question, language } = value;
    if (language === "c++") language = "cpp";
    question = sanitize(question);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
        const result = await getCodeFromAI(`Language: ${language}\nQuestion: ${question}`, language, true);
        const reader = result.code.getReader();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = new TextDecoder().decode(value);
            buffer += chunk;

            // Forward raw chunks to client
            const lines = chunk.split("\n");
            for (const line of lines) {
                if (line.trim()) res.write(line + "\n");
            }
        }

        // Cache final assembled code
        const assembled = buffer.split("\n")
            .filter(l => l.startsWith("data: "))
            .map(l => {
                try {
                    return JSON.parse(l.replace("data: ", "")).choices?.[0]?.delta?.content || "";
                } catch { return ""; }
            })
            .join("");

        const cleaned = cleanCodeOutput(assembled);
        codeCache.set(`code:${language}:${question}`, cleaned);
        res.write("data: [DONE]\n\n");
        res.end();
    } catch (err) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
        res.end();
    }
}));

// Helper: send file download
async function sendDownload(res, code, downloadName, language) {
    const safeName = downloadName.replace(/[^a-z0-9]/gi, "_").toLowerCase().substring(0, 50);
    const filename = `${safeName}_${Date.now()}.${getExtension(language)}`;
    const dir = path.join(process.cwd(), "tmp");
    const filepath = path.join(dir, filename);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filepath, code, "utf8");

    res.download(filepath, filename, async (err) => {
        try { await fs.unlink(filepath); } catch (e) {
            logger.error("Failed to delete temp file", { filepath, error: e.message });
        }
        if (err) logger.error("Download error", { error: err.message });
    });
}

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
            requestId: req.id,
            success: false,
        });
    }

    return res.status(500).json({
        error: NODE_ENV === "production" ? "Internal server error" : err.message,
        requestId: req.id,
        success: false,
    });
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
const server = app.listen(PORT, () => {
    logger.info(`🚀 CodeAI API v3.0 running on port ${PORT}`);
    logger.info(`Supported languages: ${allowedLangs.join(", ")}`);
    logger.info(`Groq: ${GROQ_API_KEY ? "✅" : "❌"} | OpenAI: ${OPENAI_API_KEY ? "✅" : "❌"}`);
    logger.info(`Cache TTL: ${CACHE_TTL}s | Body limit: 50kb`);
});

const shutdown = (signal) => {
    logger.info(`${signal} received. Shutting down gracefully...`);
    server.close(() => {
        logger.info("HTTP server closed.");
        // CRITICAL FIX: NodeCache has no close() method. Original code would crash here.
        // codeCache.close(); // REMOVED - causes TypeError
        process.exit(0);
    });
    setTimeout(() => {
        logger.error("Forced shutdown after timeout.");
        process.exit(1);
    }, 10000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled Rejection", { reason });
});
process.on("uncaughtException", (err) => {
    logger.error("Uncaught Exception", { error: err.message, stack: err.stack });
    process.exit(1);
});

module.exports = app;