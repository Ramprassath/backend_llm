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
app.use(helmet());
app.use(morgan("combined"));
app.use(express.json());

app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || "*",
      "https://ramprassath.github.io",
      "http://localhost:5173", // For local development
    ],
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  })
);

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
   CHAT ENDPOINT (RAG)
======================= */
app.post("/api/chat", chatLimiter, async (req, res) => {
  try {
    const { message, sessionId, options = {} } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const session = sessionId || `session_${Date.now()}`;
    let history = conversationStore.get(session) || [];

    /* ---- RAG ---- */
    const context = await retrieveContext(message.trim());

    const augmentedPrompt = context
      ? `You are a legal assistant.
Answer ONLY using the context below.

Context:
${context}

Question:
${message.trim()}

Answer:`
      : message.trim();

    /* ---- MODEL REQUEST ---- */
    const modelRequest = {
      message: augmentedPrompt,
      max_length: options.maxLength || 512,
      temperature: options.temperature || 0.7,
      top_p: options.topP || 0.9,
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
   SIMPLE GENERATE
======================= */
app.post("/api/generate", chatLimiter, async (req, res) => {
  try {
    const { prompt, options = {} } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const modelRequest = {
      message: prompt.trim(),
      max_length: options.maxLength || 512,
      temperature: options.temperature || 0.7,
      top_p: options.topP || 0.9,
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
   FALLBACKS
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
