import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json());

// CORS configuration
const corsOptions = {
  origin: process.env.FRONTEND_URL || '*', // Update with your frontend URL in production
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Stricter rate limit for chat endpoint
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: 'Too many chat requests, please slow down.'
});

// Model server configuration
const MODEL_SERVER_URL = process.env.MODEL_SERVER_URL || 'https://nonreversed-soulfully-olga.ngrok-free.dev';
const MODEL_API_KEY = process.env.MODEL_API_KEY || 'secret-api-key';

// Store conversation history in memory (use Redis/DB for production)
const conversationStore = new Map();

// Helper function to call model server
async function callModelServer(endpoint, data) {
  try {
    const response = await axios.post(
      `${MODEL_SERVER_URL}${endpoint}`,
      data,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': MODEL_API_KEY
        },
        timeout: 60000 // 60 second timeout
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error calling model server:', error.message);
    if (error.response) {
      throw new Error(error.response.data.detail || 'Model server error');
    }
    throw new Error('Failed to connect to model server');
  }
}

// Routes

// Health check
app.get('/api/health', async (req, res) => {
  try {
    // Check if model server is accessible
    const modelHealth = await axios.get(`${MODEL_SERVER_URL}/health`, {
      headers: { 'X-API-Key': MODEL_API_KEY },
      timeout: 5000
    });
    
    res.json({
      status: 'healthy',
      backend: 'running',
      modelServer: modelHealth.data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      backend: 'running',
      modelServer: 'unreachable',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Chat endpoint
app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const { message, sessionId, options = {} } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get or create conversation history
    const session = sessionId || `session_${Date.now()}`;
    let history = conversationStore.get(session) || [];

    // Prepare request for model server
    const modelRequest = {
      message: message.trim(),
      max_length: options.maxLength || 512,
      temperature: options.temperature || 0.7,
      top_p: options.topP || 0.9,
      conversation_history: history
    };

    // Call model server
    const modelResponse = await callModelServer('/chat', modelRequest);

    // Update conversation history
    history.push({
      user: message.trim(),
      assistant: modelResponse.response
    });

    // Keep only last 10 exchanges to prevent memory issues
    if (history.length > 10) {
      history = history.slice(-10);
    }
    conversationStore.set(session, history);

    // Send response
    res.json({
      response: modelResponse.response,
      sessionId: session,
      modelName: modelResponse.model_name,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'Failed to generate response',
      message: error.message
    });
  }
});

// Simple generate endpoint (without history)
app.post('/api/generate', chatLimiter, async (req, res) => {
  try {
    const { prompt, options = {} } = req.body;

    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const modelRequest = {
      message: prompt.trim(),
      max_length: options.maxLength || 512,
      temperature: options.temperature || 0.7,
      top_p: options.topP || 0.9
    };

    const modelResponse = await callModelServer('/generate', modelRequest);

    res.json({
      response: modelResponse.response,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Generate error:', error);
    res.status(500).json({
      error: 'Failed to generate response',
      message: error.message
    });
  }
});

// Clear conversation history
app.delete('/api/chat/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  conversationStore.delete(sessionId);
  res.json({ message: 'Conversation cleared', sessionId });
});

// Get conversation history
app.get('/api/chat/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const history = conversationStore.get(sessionId) || [];
  res.json({ sessionId, history });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Backend server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🤖 Model server: ${MODEL_SERVER_URL}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});
