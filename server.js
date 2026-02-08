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
   CORS (SAFE)
======================= */
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);

      if (
        origin.includes("localhost") ||
        origin.includes("127.0.0.1") ||
        origin === process.env.FRONTEND_URL ||
        origin === "https://ramprassath.github.io"
      ) {
        return callback(null, true);
      }

      console.warn("CORS blocked origin:", origin);
      return callback(null, false);
    },
    credentials: true,
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
const STRICT_RAG_PROMPT = (context, question) => `
You are a legal AI assistant specialized ONLY in Indian Law.

Rules:
- Use ONLY the provided context
- Use ONLY Indian law
- Answer strictly in bullet points
- Do NOT invent sections
- Do NOT use foreign law

Context:
${context}

Question:
${question}

Answer:
`;

const HYBRID_LAW_PROMPT = (question) => `
You are a legal AI assistant specialized ONLY in Indian Law.

Rules:
- Answer using your general understanding of Indian law
- Do NOT mention US, UK, or foreign law
- Do NOT invent IPC section numbers or punishments
- If unsure, clearly say so
- Answer strictly in bullet points

Question:
${question}

Answer:
`;

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
   CHAT ENDPOINT
======================= */
app.post("/api/chat", chatLimiter, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });

    const context = await retrieveContext(message);

    let prompt;

    // ✅ RAG HIT → strict factual answer
    if (context && context.trim().length > 50) {
      prompt = STRICT_RAG_PROMPT(context, message);
    }
    // 🟡 RAG MISS → allow Indian-law reasoning
    else {
      prompt = HYBRID_LAW_PROMPT(message);
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
  } catch (err) {
    res.status(500).json({
      error: "Chat failed",
      message: err.message,
    });
  }
});

/* =======================
   START SERVER
======================= */
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
