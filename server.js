import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

/* =======================
   ✅ FIX: TRUST PROXY
   Required for rate limiting behind reverse proxy
======================= */
app.set('trust proxy', 1);

/* =======================
   MIDDLEWARE
======================= */
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(morgan("combined"));
app.use(express.json());

/* =======================
   ✅ CORS (FRONTEND SAFE)
   ⚠️ Do NOT block browser
======================= */
app.use(
  cors({
    origin: true,          // 🔑 allow all origins
    credentials: true,     // 🔑 required for browser
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  })
);

app.options("*", cors());

/* =======================
   RATE LIMITING
======================= */
app.use(
  "/api/",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
  })
);

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
});

/* =======================
   ENV VARIABLES
======================= */
const MODEL_SERVER_URL = process.env.MODEL_SERVER_URL;
const MODEL_API_KEY = process.env.MODEL_API_KEY || "secret-api-key";
const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL;

/* =======================
   PROMPT ENGINEERING
======================= */
function buildStrictRagPrompt(context, question) {
  return `
You are a legal AI assistant specialized ONLY in Indian Law.

Rules:
- Use ONLY the context provided
- Use ONLY Indian law
- Answer in bullet points
- Do NOT invent section numbers
- Do NOT mention foreign laws

Context:
${context}

Question:
${question}

Answer:
`.trim();
}

function buildHybridLawPrompt(question) {
  return `
You are a legal AI assistant specialized ONLY in Indian Law.

Rules:
- Use your general understanding of Indian law
- Do NOT mention foreign laws
- Do NOT invent IPC sections or punishments
- If unsure, say so clearly
- Answer in bullet points

Question:
${question}

Answer:
`.trim();
}

/* =======================
   MODEL SERVER CALL
======================= */
async function callModelServer(endpoint, data) {
  const response = await axios.post(
    `${MODEL_SERVER_URL}${endpoint}`,
    data,
    {
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": MODEL_API_KEY,
      },
      timeout: 60000,
    }
  );
  return response.data;
}

/* =======================
   RAG RETRIEVAL
======================= */
async function retrieveContext(query) {
  if (!RAG_SERVICE_URL) return "";

  try {
    const res = await axios.post(`${RAG_SERVICE_URL}/retrieve`, {
      query,
      k: 5,
    });
    return res.data.context || "";
  } catch {
    return "";
  }
}

/* =======================
   HEALTH CHECK
======================= */
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    backend: "running",
    timestamp: new Date().toISOString(),
  });
});

/* =======================
   CHAT ENDPOINT
======================= */
app.post("/api/chat", chatLimiter, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const context = await retrieveContext(message.trim());

    let prompt;

    // ✅ Use RAG if available
    if (context && context.trim().length > 30) {
      prompt = buildStrictRagPrompt(context, message.trim());
    }
    // ✅ Otherwise allow Indian-law reasoning
    else {
      prompt = buildHybridLawPrompt(message.trim());
    }

    const modelResponse = await callModelServer("/chat", {
      message: prompt,
      max_length: 400,
      temperature: 0.3,
      top_p: 0.9,
      repetition_penalty: 1.1,
    });

    res.json({
      response: modelResponse.response,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Chat error:", error.message);
    res.status(500).json({
      error: "Failed to generate response",
    });
  }
});

/* =======================
   SIMPLE GENERATE
======================= */
app.post("/api/generate", chatLimiter, async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const modelResponse = await callModelServer("/generate", {
      message: prompt.trim(),
      max_length: 512,
      temperature: 0.7,
      top_p: 0.9,
    });

    res.json({
      response: modelResponse.response,
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(500).json({
      error: "Failed to generate response",
    });
  }
});

/* =======================
   FALLBACK
======================= */
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

/* =======================
   START SERVER
======================= */
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
