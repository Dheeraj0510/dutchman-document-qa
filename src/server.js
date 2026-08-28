const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const documents = require('./database');
require('dotenv').config();

const app = express();
const port = Number(process.env.PORT) || 3000;

async function callModel(documentText, question) {
  const provider = process.env.AI_PROVIDER || 'openai';
  if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'ollama') {
    const error = new Error(`Unsupported AI_PROVIDER: ${provider}.`);
    error.statusCode = 500;
    throw error;
  }

  const apiKey = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  if (provider !== 'ollama' && !apiKey) {
    const keyName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    const error = new Error(`${keyName} is not configured.`);
    error.statusCode = 500;
    throw error;
  }

  const endpoint = process.env.AI_API_URL || (provider === 'ollama'
    ? 'http://127.0.0.1:11434/api/chat'
    : provider === 'anthropic'
      ? 'https://api.anthropic.com/v1/messages'
      : 'https://api.openai.com/v1/chat/completions');
  const headers = { 'content-type': 'application/json' };
  let body;

  if (provider === 'ollama') {
    body = {
      model: process.env.AI_MODEL || 'llama3.2',
      stream: false,
      messages: [
        { role: 'system', content: 'Answer the user question using only the provided document.' },
        { role: 'user', content: `Document:\n${documentText}\n\nQuestion:\n${question}` }
      ]
    };
  } else if (provider === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: process.env.AI_MODEL || 'claude-3-5-haiku-latest',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `Document:\n${documentText}\n\nQuestion:\n${question}` }]
    };
  } else {
    headers.authorization = `Bearer ${apiKey}`;
    body = {
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Answer the user question using only the provided document.' },
        { role: 'user', content: `Document:\n${documentText}\n\nQuestion:\n${question}` }
      ]
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS) || 30000);
  let modelResponse;
  try {
    modelResponse = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (error) {
    const providerError = new Error(error.name === 'AbortError' ? 'AI provider request timed out.' : 'AI provider request failed.');
    providerError.statusCode = 500;
    throw providerError;
  } finally {
    clearTimeout(timeout);
  }

  if (!modelResponse.ok) {
    const error = new Error(`AI provider returned HTTP ${modelResponse.status}.`);
    error.statusCode = 500;
    throw error;
  }

  const result = await modelResponse.json();
  const answer = provider === 'ollama'
    ? result.message?.content
    : provider === 'anthropic'
      ? result.content?.[0]?.text
      : result.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) {
    const error = new Error('AI provider returned an invalid response.');
    error.statusCode = 500;
    throw error;
  }
  return answer.trim();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    const isTextFile = file.mimetype === 'text/plain' || file.originalname.toLowerCase().endsWith('.txt');
    callback(null, isTextFile);
  }
});

app.use(express.json());
app.use(express.static(require('node:path').join(__dirname, '..', 'public')));

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.post('/upload', upload.single('file'), (request, response) => {
  if (!request.file) {
    return response.status(400).json({ error: 'A .txt file is required in the file field.' });
  }

  const id = crypto.randomUUID();
  const text = request.file.buffer.toString('utf8');
  documents.set(id, {
    id,
    filename: request.file.originalname,
    text,
    uploadedAt: new Date().toISOString()
  });

  return response.status(201).json({
    id,
    filename: request.file.originalname,
    characters: text.length
  });
});

app.post('/ask', async (request, response) => {
  const { question, docId } = request.body || {};

  if (typeof question !== 'string' || !question.trim() || typeof docId !== 'string' || !docId.trim()) {
    return response.status(400).json({ error: 'question and docId are required.' });
  }

  const document = documents.get(docId);
  if (!document) {
    return response.status(404).json({ error: 'Document not found.' });
  }

  try {
    const answer = await callModel(document.text, question.trim());
    return response.json({ docId, question: question.trim(), answer, source: { filename: document.filename } });
  } catch (error) {
    return response.status(error.statusCode || 502).json({ error: error.message });
  }
});

app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return response.status(400).json({ error: 'Request body must be valid JSON.' });
  }

  if (error.code === 'LIMIT_FILE_SIZE') {
    return response.status(400).json({ error: 'File must be 5 MB or smaller.' });
  }

  if (error instanceof multer.MulterError || error.message === 'Unexpected field') {
    return response.status(400).json({ error: 'Upload must contain one text file in the file field.' });
  }

  return response.status(error.statusCode || 500).json({ error: error.message || 'Internal server error.' });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Document API listening on port ${port}`);
  });
}

module.exports = { app, documents, callModel };
