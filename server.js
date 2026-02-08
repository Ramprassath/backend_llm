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
   ✅ CORS (FIXED – SAFE)
======================= */
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow server-to-server, Postman, curl, ngrok
      if (!origin) return callback(null, true);

      const allowedOrigins = [
        process.env.FRONTEND_URL,
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "https://ramprassath.github.io",
      ];

      // Allow all localhost for development
      if (
        origin.includes("localhost") ||
        origin.includes("127.0.0.1")
      ) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // ❗ Do NOT throw error (prevents crash)
      console.warn("CORS blocked origin:", origin);
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  })
);

app.options("*", cors());

/* =======================
   RATE LIMITING
======================= */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use("/api/", limiter);

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
   IN-MEMORY CHAT STORE
======================= */
const conversationStore = new Map();

/* =======================
   PROMPT ENGINEERING
======================= */
const SYSTEM_PROMPT = `
You are a legal AI assistant specialized ONLY in Indian Law.

Jurisdiction Rules:
- Use ONLY Indian law (IPC, CrPC, CPC, Constitution of India, Indian Acts).
- Do NOT mention or rely on US law, UK law, or any foreign law.

Knowledge Rules:
- Answer ONLY using the provided context.
- If the answer is not present in the context, say:
"I don't have enough information under Indian law to answer this question."

Formatting Rules:
- Answer STRICTLY in bullet points.
- Maximum 5 bullet points.
- One complete idea per bullet.
- No paragraphs, no extra text.

Do NOT guess.
Do NOT generalize.
`;

function buildRagPrompt(context, question) {
  return `
SYSTEM:
${SYSTEM_PROMPT}

USER:
Context:
${context}

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
   RAG CONTEXT RETRIEVAL
======================= */
async function retrieveContext(query) {
  if (!RAG_SERVICE_URL) return "";

  try {
    const res = await axios.post(`${RAG_SERVICE_URL}/retrieve`, {
      query,
      k: 5,
    });
    return res.data.context || "";
  } catch (err) {
    console.error("RAG retrieval failed:", err.message);
    return "";
  }
}

/* =======================
   HEALTH CHECK
======================= */
app.get("/api/health", async (req, res) => {
  try {
    const modelHealth = await axios.get(`${MODEL_SERVER_URL}/health`, {
      headers: { "X-API-Key": MODEL_API_KEY },
      timeout: 5000,
    });

    res.json({
      status: "healthy",
      backend: "running",
      modelServer: modelHealth.data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      backend: "running",
      modelServer: "unreachable",
      error: error.message,
    });
  }
});

/* =======================
   CHAT ENDPOINT (STRICT RAG)
======================= */
app.post("/api/chat", chatLimiter, async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const session = sessionId || `session_${Date.now()}`;
    let history = conversationStore.get(session) || [];

    /* ---- RAG ---- */
    const context = await retrieveContext(message.trim());

    // 🔒 STRICT MODE: NO CONTEXT = NO ANSWER
    if (!context || !context.trim()) {
      return res.json({
        response:
          "I don't have enough information under Indian law to answer this question.",
        sessionId: session,
        timestamp: new Date().toISOString(),
      });
    }

    /* ---- PROMPT ENGINEERING ---- */
    const engineeredPrompt = buildRagPrompt(
      context,
      message.trim()
    );

    /* ---- MODEL REQUEST ---- */
    const modelRequest = {
      message: engineeredPrompt,
      max_length: 400,
      temperature: 0.2,
      top_p: 0.9,
      repetition_penalty: 1.1,
      conversation_history: history,
    };

    const modelResponse = await callModelServer("/chat", modelRequest);

    history.push({
      user: message.trim(),
      assistant: modelResponse.response,
    });

    if (history.length > 10) history = history.slice(-10);
    conversationStore.set(session, history);

    res.json({
      response: modelResponse.response,
      sessionId: session,
      modelName: modelResponse.model_name,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({
      error: "Failed to generate response",
      message: error.message,
    });
  }
});

/* =======================
   SIMPLE GENERATE (NO RAG)
======================= */
app.post("/api/generate", chatLimiter, async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const modelRequest = {
      message: prompt.trim(),
      max_length: 512,
      temperature: 0.7,
      top_p: 0.9,
    };

    const modelResponse = await callModelServer("/generate", modelRequest);

    res.json({
      response: modelResponse.response,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to generate response",
      message: error.message,
    });
  }
});

/* =======================
   CHAT HISTORY
======================= */
app.get("/api/chat/:sessionId", (req, res) => {
  const history = conversationStore.get(req.params.sessionId) || [];
  res.json({ sessionId: req.params.sessionId, history });
});

app.delete("/api/chat/:sessionId", (req, res) => {
  conversationStore.delete(req.params.sessionId);
  res.json({ message: "Conversation cleared" });
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
  console.log(`🤖 Model server: ${MODEL_SERVER_URL}`);
  console.log(`📚 RAG service: ${RAG_SERVICE_URL}`);
});
