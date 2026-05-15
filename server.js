const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const readline = require("readline");
const util = require("util");

const execPromise = util.promisify(exec);

// ============================================
// CONFIG
// ============================================
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const PORT = process.env.PORT || 3000;
const allowedLangs = ["java", "python", "cpp", "c++", "vhdl"];
const TEMP_DIR = path.join(__dirname, "temp");
const MAX_FIX_ATTEMPTS = 3;

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ============================================
// TERMINAL COLORS
// ============================================
const C = {
    r: "\x1b[0m",
    b: "\x1b[1m",
    g: "\x1b[32m",
    red: "\x1b[31m",
    y: "\x1b[33m",
    c: "\x1b[36m",
    m: "\x1b[35m"
};

// ============================================
// PROMPT BUILDERS (Enhanced for perfect executables)
// ============================================
function buildPrompt(question, language = "java") {
    const rules = {
        java: "Use EXACTLY 'public class Main' with 'public static void main(String[] args)'. Include imports.",
        python: "Complete script. Use 'if __name__ == \"__main__\":' when appropriate. Standard libs only.",
        cpp: "Use 'int main()'. Include headers like <bits/stdc++.h> or specific ones. End with 'return 0;'.",
        vhdl: "Complete ENTITY + ARCHITECTURE. Include LIBRARY ieee; USE ieee.std_logic_1164.ALL;"
    };

    return `You are an expert coding assistant.

CRITICAL RULES:
- Output ONLY the complete runnable code
- NO explanations, NO markdown fences (\`\`\`), NO extra text
- Must be a standalone program that compiles and runs immediately
- ${rules[language] || "Write complete executable code."}
- Language: ${language}

User Request:
${question}

Output:
`;
}

function buildFixPrompt(brokenCode, language, errorMsg = "") {
    return `You are an expert coding assistant.

Fix the following ${language} code. Output ONLY the corrected complete code.

CRITICAL RULES:
- Output ONLY fixed complete code
- NO explanations, NO markdown, NO comments about changes
- Must compile and run successfully
- Preserve original intent unless it causes the bug

Broken Code:
${brokenCode}

${errorMsg ? `Error Message:\n${errorMsg}\n` : ""}Output:
`;
}

// ============================================
// HELPERS
// ============================================
function getExtension(lang) {
    switch (lang) {
        case "java": return "java";
        case "python": return "py";
        case "cpp": case "c++": return "cpp";
        case "vhdl": return "vhd";
        default: return "txt";
    }
}

function cleanCode(code) {
    return code
        .replace(/```[a-zA-Z]*\n?/g, "")
        .replace(/```/g, "")
        .replace(/^\s*[\r\n]/gm, "")
        .trim();
}

function saveTempCode(code, language) {
    const ext = getExtension(language);
    const filename = language === "java" ? "Main.java" : `temp_${Date.now()}.${ext}`;
    const filepath = path.join(TEMP_DIR, filename);
    fs.writeFileSync(filepath, code);
    return filepath;
}

function cleanupTemp(filepath) {
    try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch (e) {}
}

// ============================================
// COMPILER / RUNNER
// ============================================
async function compileAndRun(filepath, language) {
    const basename = path.basename(filepath, path.extname(filepath));
    const dirname = path.dirname(filepath);

    try {
        if (language === "java") {
            const { stderr: cErr } = await execPromise(`javac "${filepath}"`, { cwd: dirname, timeout: 15000 });
            if (cErr && cErr.includes("error")) return { success: false, error: cErr };
            const { stdout, stderr } = await execPromise(`java -cp "${dirname}" ${basename}`, { timeout: 10000 });
            return { success: true, output: stdout || stderr };

        } else if (language === "cpp" || language === "c++") {
            const outFile = path.join(dirname, basename + (process.platform === "win32" ? ".exe" : ""));
            const { stderr: cErr } = await execPromise(`g++ -std=c++17 "${filepath}" -o "${outFile}"`, { timeout: 20000 });
            if (cErr && cErr.includes("error")) return { success: false, error: cErr };
            const { stdout, stderr } = await execPromise(`"${outFile}"`, { timeout: 10000 });
            cleanupTemp(outFile);
            return { success: true, output: stdout || stderr };

        } else if (language === "python") {
            const py = process.platform === "win32" ? "python" : "python3";
            const { stdout, stderr } = await execPromise(`${py} "${filepath}"`, { timeout: 10000 });
            return { success: true, output: stdout || stderr };

        } else if (language === "vhdl") {
            try {
                await execPromise(`ghdl -a "${filepath}"`, { timeout: 15000 });
                return { success: true, output: "VHDL analysis passed." };
            } catch (e) {
                return { success: false, error: e.stderr || e.message };
            }
        }
        return { success: false, error: "Execution not supported for this language" };
    } catch (err) {
        return { success: false, error: err.stderr || err.message || "Execution failed/timeout" };
    }
}

// ============================================
// AI CALL
// ============================================
async function getCodeFromAI(prompt) {
    if (!GROQ_API_KEY) throw new Error("No GROQ_API_KEY set in environment.");

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1
        })
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`AI API error: ${response.status} - ${err}`);
    }

    const data = await response.json();
    return cleanCode(data.choices[0].message.content);
}

// ============================================
// AUTO-FIX LOOP (Self-Healing Code Generator)
// ============================================
async function generateVerifiedCode(question, language, maxAttempts = MAX_FIX_ATTEMPTS) {
    let lastCode = null;
    let lastError = null;
    let filepath = null;

    for (let i = 0; i < maxAttempts; i++) {
        const prompt = lastError
            ? buildFixPrompt(lastCode, language, lastError)
            : buildPrompt(question, language);

        let code = await getCodeFromAI(prompt);
        lastCode = code;

        // Force Java class name to Main so file matches
        if (language === "java") {
            lastCode = code.replace(/public\s+class\s+\w+/, "public class Main");
        }

        filepath = saveTempCode(lastCode, language);
        const result = await compileAndRun(filepath, language);

        if (result.success) {
            return { code: lastCode, output: result.output, attempts: i + 1, success: true, filepath };
        }

        lastError = result.error;
        cleanupTemp(filepath);
    }

    return { code: lastCode, error: lastError, attempts: maxAttempts, success: false, filepath };
}

async function fixBrokenCode(brokenCode, language, errorMsg = "") {
    const prompt = buildFixPrompt(brokenCode, language, errorMsg);
    const fixed = await getCodeFromAI(prompt);

    if (language === "java") {
        fixed.replace(/public\s+class\s+\w+/, "public class Main");
    }

    const filepath = saveTempCode(fixed, language);
    const result = await compileAndRun(filepath, language);

    return {
        code: fixed,
        verified: result.success,
        output: result.output,
        error: result.error,
        filepath
    };
}

// ============================================
// EXPRESS ROUTES
// ============================================
const app = express();
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.text({ limit: "10mb" }));

app.get("/", (req, res) => {
    res.json({
        message: "CodeAI Ultimate API 🚀",
        endpoints: {
            ask: "GET /ask?q=...&lang=...&download=...&verify=true",
            solve: "POST /solve/raw",
            fix: "GET /fix?code=...&lang=...&error=...",
            fixRaw: "POST /fix/raw"
        },
        cli: "Run with: node server.js --cli"
    });
});

// 🔥 ENHANCED /ask
app.get("/ask", async (req, res) => {
    let question = req.query.q;
    let language = (req.query.lang || "java").toLowerCase();
    const downloadName = req.query.download;
    const verify = req.query.verify === "true";
    const execMode = req.query.exec === "true";

    if (!question) return res.status(400).json({ error: "Question required. Use ?q=..." });

    question = question.replace(/[-_]/g, " ");
    if (language === "c++") language = "cpp";
    if (!allowedLangs.includes(language)) return res.status(400).json({ error: "Unsupported language" });

    try {
        let result;
        if (verify || execMode) {
            result = await generateVerifiedCode(question, language);
        } else {
            const code = await getCodeFromAI(buildPrompt(question, language));
            result = { code, success: true, attempts: 1 };
        }

        if (downloadName) {
            const safe = downloadName.replace(/[^a-z0-9]/gi, "_").toLowerCase();
            const filename = language === "java" ? "Main.java" : `${safe}.${getExtension(language)}`;
            const filepath = path.join(__dirname, filename);
            fs.writeFileSync(filepath, result.code);
            res.download(filepath, filename, () => { try { fs.unlinkSync(filepath); } catch(e){} });
        } else if (execMode) {
            res.json({
                code: result.code,
                verified: result.success,
                attempts: result.attempts,
                execution: {
                    success: result.success,
                    output: result.output || null,
                    error: result.error || null
                }
            });
        } else {
            res.type("text/plain");
            if (verify && !result.success) {
                res.send(`⚠️ Code (attempts: ${result.attempts})\n\n${result.code}\n\n❌ Error:\n${result.error}`);
            } else {
                res.send(result.code);
            }
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST solve
app.post("/solve/raw", async (req, res) => {
    const question = req.body.question;
    let language = (req.body.language || "java").toLowerCase();

    if (!question) return res.status(400).send("Error: Question required");
    if (language === "c++") language = "cpp";
    if (!allowedLangs.includes(language)) return res.status(400).send("Error: Unsupported language");

    try {
        const code = await getCodeFromAI(buildPrompt(question, language));
        res.type("text/plain").send(code);
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

// 🔧 NEW: GET /fix
app.get("/fix", async (req, res) => {
    let code = req.query.code;
    let language = (req.query.lang || "java").toLowerCase();
    let errorMsg = req.query.error || "";

    if (!code) return res.status(400).json({ error: "Code required. Use ?code=..." });

    if (language === "c++") language = "cpp";
    if (!allowedLangs.includes(language)) return res.status(400).json({ error: "Unsupported language" });

    try {
        const result = await fixBrokenCode(code, language, errorMsg);
        res.type("text/plain");
        const status = result.verified ? "✅ Fixed & Verified" : "⚠️ Fixed (unverified)";
        res.send(`${status}\n\n${result.code}\n\n${result.error ? `Error:\n${result.error}` : ""}`);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 🔧 NEW: POST /fix/raw
app.post("/fix/raw", async (req, res) => {
    const code = req.body.code || req.body;
    let language = (req.body.language || "java").toLowerCase();
    const errorMsg = req.body.error || "";

    if (!code) return res.status(400).send("Error: Code required");

    if (language === "c++") language = "cpp";
    if (!allowedLangs.includes(language)) return res.status(400).send("Error: Unsupported language");

    try {
        const result = await fixBrokenCode(code, language, errorMsg);
        res.type("text/plain");
        const status = result.verified ? "✅ Fixed & Verified" : "⚠️ Fixed (unverified)";
        res.send(`${status}\n\n${result.code}\n\n${result.error ? `Error:\n${result.error}` : ""}`);
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

// ============================================
// CLI MODE (Interactive Terminal)
// ============================================
function startCLI() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${C.c}codeai>${C.r} `
    });

    console.log(`${C.b}${C.g}
   ██████╗ ██████╗ ██████╗ ███████╗ █████╗ ██╗
  ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗██║
  ██║     ██║   ██║██║  ██║█████╗  ███████║██║
  ██║     ██║   ██║██║  ██║██╔══╝  ██╔══██║██║
  ╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║███████╗
   ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚══════╝
  ${C.r}`);
    console.log(`${C.y}Interactive Code Generator & Auto-Fixer${C.r}\n`);
    console.log(`${C.b}Commands:${C.r}`);
    console.log(`  ${C.c}ask${C.r} "question" [lang]   Generate code`);
    console.log(`  ${C.c}verify${C.r} "question" [lang]  Generate + auto-compile + fix`);
    console.log(`  ${C.c}fix${C.r} [lang]              Paste broken code (end with 'END')`);
    console.log(`  ${C.c}fixfile${C.r} <file> [lang]   Fix code from file`);
    console.log(`  ${C.c}run${C.r} <file> [lang]       Compile & run existing file`);
    console.log(`  ${C.c}server${C.r}                  Start API server instead`);
    console.log(`  ${C.c}help${C.r}                    Show help`);
    console.log(`  ${C.c}exit${C.r}                    Quit\n`);

    rl.prompt();

    rl.on("line", async (line) => {
        const input = line.trim();
        const args = input.split(/\s+/);
        const cmd = args[0].toLowerCase();

        if (cmd === "exit" || cmd === "quit") {
            console.log(`${C.g}Goodbye! 👋${C.r}`);
            process.exit(0);

        } else if (cmd === "help") {
            console.log(`ask "question" [lang]  → Generate code (default: java)`);
            console.log(`verify "q" [lang]      → Generate + compile + auto-fix until it works`);
            console.log(`fix [lang]             → Multi-line paste mode. Type END when done`);
            console.log(`fixfile file.java      → Read broken code from file and fix it`);
            console.log(`run file.java [lang]   → Compile & run a file`);
            console.log(`server                 → Start the Express API server`);

        } else if (cmd === "server") {
            console.log(`${C.y}Starting API server on port ${PORT}...${C.r}`);
            app.listen(PORT, () => {
                console.log(`${C.g}Server running at http://localhost:${PORT}${C.r}`);
            });
            return;

        } else if (cmd === "ask" || cmd === "verify") {
            const isVerify = cmd === "verify";
            const rest = input.slice(cmd.length).trim();
            let question, lang = "java";

            // Parse: ask "question here" java
            const match = rest.match(/^"(.+)"(?:\s+(\w+))?$/);
            if (match) {
                question = match[1];
                if (match[2]) lang = match[2].toLowerCase();
            } else {
                // Try last word as language
                const parts = rest.split(" ");
                const last = parts[parts.length - 1].toLowerCase();
                if (allowedLangs.includes(last) || last === "c++") {
                    lang = last === "c++" ? "cpp" : last;
                    question = parts.slice(0, -1).join(" ");
                } else {
                    question = rest;
                }
            }

            if (!question) {
                console.log(`${C.red}Usage: ${cmd} "your question" [language]${C.r}`);
                rl.prompt();
                return;
            }

            if (lang === "c++") lang = "cpp";
            if (!allowedLangs.includes(lang)) lang = "java";

            console.log(`${C.y}⏳ ${isVerify ? "Verifying" : "Generating"} ${lang} code...${C.r}`);

            try {
                let result;
                if (isVerify) {
                    result = await generateVerifiedCode(question, lang);
                } else {
                    const code = await getCodeFromAI(buildPrompt(question, lang));
                    result = { code, success: true, attempts: 1 };
                }

                const filename = lang === "java" ? "Main.java" : `output.${getExtension(lang)}`;
                fs.writeFileSync(path.join(__dirname, filename), result.code);

                console.log(`\n${C.g}✅ ${isVerify ? "Verified" : "Generated"} (attempts: ${result.attempts})${C.r}`);
                console.log(`${C.c}📁 Saved: ${filename}${C.r}`);
                if (result.output) {
                    console.log(`${C.g}⚡ Output:${C.r}\n${result.output}`);
                } else if (result.error) {
                    console.log(`${C.red}❌ Error:${C.r}\n${result.error}`);
                }

                console.log(`\n${C.b}--- CODE ---${C.r}`);
                console.log(result.code);
                console.log(`${C.b}------------${C.r}\n`);

                if (!isVerify) {
                    rl.question(`${C.y}Run this code now? (y/n): ${C.r}`, async (ans) => {
                        if (ans.toLowerCase() === "y" || ans.toLowerCase() === "yes") {
                            const fpath = path.join(__dirname, filename);
                            const run = await compileAndRun(fpath, lang);
                            if (run.success) {
                                console.log(`\n${C.g}⚡ Output:${C.r}\n${run.output}`);
                            } else {
                                console.log(`\n${C.red}❌ Run Error:${C.r}\n${run.error}`);
                                console.log(`${C.y}Tip: Use 'verify' command to auto-fix${C.r}`);
                            }
                        }
                        rl.prompt();
                    });
                    return;
                }

            } catch (err) {
                console.log(`${C.red}Error: ${err.message}${C.r}`);
            }

        } else if (cmd === "fix") {
            let lang = args[1] || "java";
            if (lang === "c++") lang = "cpp";
            if (!allowedLangs.includes(lang)) lang = "java";

            console.log(`${C.y}Paste your broken ${lang} code. Type 'END' on its own line when done:${C.r}`);
            rl.pause();

            const codeRl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const lines = [];

            const onLine = (ln) => {
                if (ln.trim() === "END") {
                    codeRl.close();
                    codeRl.removeListener("line", onLine);
                    const broken = lines.join("\n");
                    rl.resume();

                    if (!broken.trim()) {
                        console.log(`${C.red}No code provided${C.r}`);
                        rl.prompt();
                        return;
                    }

                    console.log(`${C.y}🔧 Fixing...${C.r}`);
                    fixBrokenCode(broken, lang).then(result => {
                        const outFile = lang === "java" ? "FixedMain.java" : `fixed.${getExtension(lang)}`;
                        fs.writeFileSync(outFile, result.code);
                        console.log(`\n${C.g}✅ Fixed code saved: ${outFile}${C.r}`);
                        if (result.verified) {
                            console.log(`${C.g}✅ Verified! Output:${C.r}\n${result.output}`);
                        } else {
                            console.log(`${C.red}⚠️ Still has issues:${C.r}\n${result.error}`);
                        }
                        console.log(`\n${C.b}--- FIXED ---${C.r}`);
                        console.log(result.code);
                        console.log(`${C.b}-------------${C.r}\n`);
                        rl.prompt();
                    }).catch(err => {
                        console.log(`${C.red}Fix Error: ${err.message}${C.r}`);
                        rl.prompt();
                    });
                } else {
                    lines.push(ln);
                }
            };

            codeRl.on("line", onLine);
            return;

        } else if (cmd === "fixfile") {
            if (args.length < 2) {
                console.log(`${C.red}Usage: fixfile <filename> [language]${C.r}`);
            } else {
                const file = args[1];
                let lang = args[2] || path.extname(file).slice(1);
                if (lang === "c++" || lang === "cpp") lang = "cpp";
                else if (lang === "py") lang = "python";
                else if (lang === "vhd") lang = "vhdl";
                else if (lang === "java") lang = "java";
                else lang = "java";

                if (!fs.existsSync(file)) {
                    console.log(`${C.red}File not found: ${file}${C.r}`);
                } else {
                    const broken = fs.readFileSync(file, "utf8");
                    console.log(`${C.y}🔧 Fixing ${file}...${C.r}`);
                    try {
                        const result = await fixBrokenCode(broken, lang);
                        const outFile = `fixed_${path.basename(file)}`;
                        fs.writeFileSync(outFile, result.code);
                        console.log(`${C.g}✅ Saved: ${outFile}${C.r}`);
                        if (result.verified) console.log(`${C.g}Verified!${C.r}`);
                        else console.log(`${C.red}Issues: ${result.error}${C.r}`);
                    } catch (err) {
                        console.log(`${C.red}Error: ${err.message}${C.r}`);
                    }
                }
            }

        } else if (cmd === "run") {
            if (args.length < 2) {
                console.log(`${C.red}Usage: run <filename> [language]${C.r}`);
            } else {
                const file = args[1];
                let lang = args[2];
                if (!lang) {
                    const ext = path.extname(file).slice(1);
                    if (ext === "java") lang = "java";
                    else if (ext === "cpp" || ext === "c++") lang = "cpp";
                    else if (ext === "py") lang = "python";
                    else if (ext === "vhd") lang = "vhdl";
                    else lang = "java";
                }
                if (lang === "c++") lang = "cpp";

                if (!fs.existsSync(file)) {
                    console.log(`${C.red}File not found: ${file}${C.r}`);
                } else {
                    const code = fs.readFileSync(file, "utf8");
                    const fpath = saveTempCode(code, lang);
                    const result = await compileAndRun(fpath, lang);
                    if (result.success) {
                        console.log(`${C.g}⚡ Output:${C.r}\n${result.output}`);
                    } else {
                        console.log(`${C.red}❌ Error:${C.r}\n${result.error}`);
                        console.log(`${C.y}Tip: Use 'fixfile ${file}' to auto-repair${C.r}`);
                    }
                    cleanupTemp(fpath);
                }
            }

        } else if (cmd) {
            console.log(`${C.red}Unknown: ${cmd}. Type 'help'.${C.r}`);
        }

        rl.prompt();
    });
}

// ============================================
// STARTUP
// ============================================
if (process.argv.includes("--cli")) {
    if (!GROQ_API_KEY) {
        console.log(`${C.red}❌ Set GROQ_API_KEY environment variable first!${C.r}`);
        console.log(`   export GROQ_API_KEY="your_key_here"`);
        process.exit(1);
    }
    startCLI();
} else {
    app.listen(PORT, () => {
        console.log("=================================");
        console.log("   🚀 CodeAI API (ULTIMATE VERSION)");
        console.log("=================================");
        console.log(`Port: ${PORT}`);
        console.log(`CLI:  node server.js --cli`);
        console.log(`Endpoints:`);
        console.log(`  GET  /ask?q=...&lang=...&verify=true&exec=true`);
        console.log(`  POST /solve/raw`);
        console.log(`  GET  /fix?code=...&lang=...&error=...`);
        console.log(`  POST /fix/raw`);
    });
}