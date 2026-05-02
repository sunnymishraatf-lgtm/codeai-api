# 🤖 CodeAI API

AI-powered coding assistant API. Ask any programming question, get clean runnable code.

**Live Demo:** Works in browser + curl + any HTTP client.

---

## ✨ Features

- 🧠 **Exact prompt system** — outputs ONLY code, no fluff
- 🌐 **Public API** — deploy and use from anywhere
- 💻 **Browser UI** — beautiful dark theme interface
- 🌀 **curl support** — terminal-friendly raw output
- 🔑 **Free AI** — uses OpenRouter (no credit card needed)
- 🚀 **One-click deploy** — Render, Railway, Vercel ready

---

## 📁 Files

```
codeai-api/
├── server.js           # Express backend + AI integration
├── package.json        # Dependencies
├── public/
│   └── index.html      # Web UI
├── .gitignore
└── README.md
```

---

## 🚀 Quick Start (Local)

### 1. Get Free AI Key

1. Go to: https://openrouter.ai/keys
2. Sign up (free, no credit card)
3. Copy your API key

### 2. Setup Project

```bash
# Extract ZIP
cd codeai-api

# Install dependencies
npm install

# Set API key (Linux/Mac)
export OPENROUTER_API_KEY="sk-or-v1-your-key-here"

# Set API key (Windows PowerShell)
$env:OPENROUTER_API_KEY="sk-or-v1-your-key-here"

# Run server
npm start
```

### 3. Test It

**Browser:**
Open http://localhost:3000

**Terminal (curl):**
```bash
curl -X POST http://localhost:3000/solve/raw \
  -H "Content-Type: application/json" \
  -d '{"question":"wap to print nodes of linked list in java"}'
```

**Terminal (JSON response):**
```bash
curl -X POST http://localhost:3000/solve \
  -H "Content-Type: application/json" \
  -d '{"question":"python list comprehension example"}'
```

---

## 🌍 Deploy to Internet (Free)

### Option 1: Render (Recommended — Free Forever)

1. Push code to GitHub
2. Go to https://render.com
3. Click **New Web Service**
4. Connect your GitHub repo
5. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
6. Add Environment Variable:
   - `OPENROUTER_API_KEY` = your key
7. Click **Deploy**

**Your API is live!** URL: `https://your-app.onrender.com`

### Option 2: Railway (Free Tier)

1. Go to https://railway.app
2. New Project → Deploy from GitHub repo
3. Add variable: `OPENROUTER_API_KEY`
4. Deploy

### Option 3: Vercel (Serverless)

1. Install Vercel CLI: `npm i -g vercel`
2. Run: `vercel`
3. Set environment variable in dashboard

---

## 🔗 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Web UI |
| POST | `/solve` | JSON response with code |
| POST | `/solve/raw` | Plain text code (for curl) |
| GET | `/languages` | List supported languages |

### `/solve` Response Format

```json
{
  "success": true,
  "question": "your question",
  "code": "class Main { ... }",
  "language": "java"
}
```

### `/solve/raw` Response

Plain text code only. Perfect for piping or saving to file:

```bash
curl -X POST https://your-api.com/solve/raw \
  -H "Content-Type: application/json" \
  -d '{"question":"hello world in python"}' > hello.py
```

---

## 💻 Usage Examples

### Java
```bash
curl -X POST https://your-api.com/solve/raw \
  -H "Content-Type: application/json" \
  -d '{"question":"binary search in java"}'
```

### Python
```bash
curl -X POST https://your-api.com/solve/raw \
  -H "Content-Type: application/json" \
  -d '{"question":"read csv file in python"}'
```

### C++
```bash
curl -X POST https://your-api.com/solve/raw \
  -H "Content-Type: application/json" \
  -d '{"question":"bubble sort in cpp"}'
```

### Save to File
```bash
curl -X POST https://your-api.com/solve/raw \
  -H "Content-Type: application/json" \
  -d '{"question":"factorial program in java"}' > Factorial.java
```

---

## 🧠 How the Prompt Works

The exact prompt sent to AI:

```
You are a professional coding assistant.

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
{question}

Output:
<only code>
```

This ensures:
- ✅ No explanations
- ✅ No markdown backticks
- ✅ Just pure runnable code
- ✅ Language auto-detection from question

---

## 🔧 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | ✅ Yes | Your OpenRouter API key |
| `AI_MODEL` | ❌ No | Model to use (default: mistral-7b-instruct:free) |
| `PORT` | ❌ No | Server port (default: 3000) |

---

## 🛠️ Troubleshooting

| Issue | Fix |
|-------|-----|
| `No API key set` | Add `OPENROUTER_API_KEY` environment variable |
| `AI API error 401` | Check your API key is correct |
| `AI API error 429` | Rate limit — wait a minute |
| Slow response | Normal for free tier — takes 5-15 seconds |
| Empty code | Retry — free models are sometimes inconsistent |

---

## 📜 License

Free to use, modify, deploy. Built for developers.
