const crypto = require('node:crypto');
const express = require('express');
const { ipKeyGenerator, rateLimit } = require('express-rate-limit');
const multer = require('multer');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const documents = require('./database');
const { insertChunks, searchSimilar } = require('./vectorStore');
require('dotenv').config();

const app = express();
const port = Number(process.env.PORT) || 3000;

const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 80;
const CHUNK_SNIPPET_LENGTH = 500;
const SUPPORTED_FILE_ERROR = 'A .txt, .pdf, or .docx file is required in the file field.';

function requireApiKey(request, response, next) {
  const expectedKey = process.env.API_KEY;
  const providedKey = request.get('x-api-key') || '';
  if (!expectedKey) {
    return response.status(500).json({ error: 'API_KEY is not configured.' });
  }

  const valid = providedKey.length === expectedKey.length
    && crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(expectedKey));
  if (!valid) {
    return response.status(401).json({ error: 'A valid x-api-key header is required.' });
  }
  return next();
}

const apiRateLimit = rateLimit({
  windowMs: Number(process.env.API_RATE_WINDOW_MS) || 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT) || 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (request) => request.get('x-api-key') || ipKeyGenerator(request.ip),
  handler: (_request, response) => response.status(429).json({ error: 'Too many requests. Please try again later.' })
});

function fileType(file) {
  const filename = file.originalname.toLowerCase();
  if (filename.endsWith('.pdf') || file.mimetype === 'application/pdf') return 'pdf';
  if (filename.endsWith('.docx') || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (filename.endsWith('.txt') || file.mimetype === 'text/plain') return 'txt';
  return null;
}

async function extractText(file) {
  const type = fileType(file);
  try {
    if (type === 'txt') return file.buffer.toString('utf8');
    if (type === 'docx') return (await mammoth.extractRawText({ buffer: file.buffer })).value;
    if (type === 'pdf') {
      const parser = new PDFParse({ data: file.buffer });
      try {
        return (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    }
  } catch (error) {
    const extractionError = new Error(`Could not extract text from the ${type || 'uploaded'} file.`);
    extractionError.statusCode = 400;
    throw extractionError;
  }

  const error = new Error(SUPPORTED_FILE_ERROR);
  error.statusCode = 400;
  throw error;
}

function validateExtractedText(text, type) {
  if (typeof text !== 'string' || !text.trim()) {
    const error = new Error(`Could not extract readable text from the ${type} file. Scanned or image-only PDFs are not supported.`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function chunkText(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const chunks = [];
  for (let start = 0; start < words.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
    const chunkWords = words.slice(start, start + CHUNK_SIZE);
    chunks.push({ text: chunkWords.join(' '), position: chunks.length });
    if (start + CHUNK_SIZE >= words.length) break;
  }
  return chunks;
}

async function embedText(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error('OPENAI_API_KEY is not configured for embeddings.');
    error.statusCode = 500;
    throw error;
  }

  const endpoint = process.env.AI_EMBEDDING_API_URL || 'https://api.openai.com/v1/embeddings';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS) || 30000);
  let embeddingResponse;
  try {
    embeddingResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.AI_EMBEDDING_MODEL || 'text-embedding-3-small', input: text }),
      signal: controller.signal
    });
  } catch (error) {
    const providerError = new Error(error.name === 'AbortError' ? 'Embedding provider request timed out.' : 'Embedding provider request failed.');
    providerError.statusCode = 500;
    throw providerError;
  } finally {
    clearTimeout(timeout);
  }

  if (!embeddingResponse.ok) {
    const error = new Error(`Embedding provider returned HTTP ${embeddingResponse.status}.`);
    error.statusCode = 500;
    throw error;
  }
  const result = await embeddingResponse.json();
  const embedding = result.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || !embedding.length || embedding.some((value) => typeof value !== 'number')) {
    const error = new Error('Embedding provider returned an invalid response.');
    error.statusCode = 500;
    throw error;
  }
  return embedding;
}

function cosineSimilarity(left, right) {
  if (left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  return leftMagnitude && rightMagnitude ? dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude)) : 0;
}

async function consumeModelStream(response, provider, onToken) {
  if (!response.body) {
    const error = new Error('AI provider returned an invalid response.');
    error.statusCode = 500;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';

  const processLine = (line) => {
    const data = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!data || data === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    const token = provider === 'anthropic'
      ? event.delta?.type === 'text_delta' ? event.delta.text : ''
      : provider === 'ollama'
        ? event.message?.content || ''
        : event.choices?.[0]?.delta?.content || '';
    if (token) {
      answer += token;
      onToken(token);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) processLine(line);
    if (done) break;
  }
  if (buffer) processLine(buffer);
  if (!answer.trim()) {
    const error = new Error('AI provider returned an invalid response.');
    error.statusCode = 500;
    throw error;
  }
  return answer.trim();
}

async function streamModel(documentText, question, onToken) {
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
      stream: true,
      messages: [
        { role: 'system', content: 'Answer the user question using only the provided document chunks. Reference the chunk position in your answer when useful.' },
        { role: 'user', content: `Document:\n${documentText}\n\nQuestion:\n${question}` }
      ]
    };
  } else if (provider === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: process.env.AI_MODEL || 'claude-3-5-haiku-latest',
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: `Document chunks:\n${documentText}\n\nQuestion:\n${question}\n\nReference the chunk position(s) used when answering.` }]
    };
  } else {
    headers.authorization = `Bearer ${apiKey}`;
    body = {
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      stream: true,
      messages: [
        { role: 'system', content: 'Answer the user question using only the provided document chunks. Reference the chunk position in your answer when useful.' },
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
  }

  if (!modelResponse.ok) {
    const error = new Error(`AI provider returned HTTP ${modelResponse.status}.`);
    error.statusCode = 500;
    throw error;
  }

  try {
    return await consumeModelStream(modelResponse, provider, onToken);
  } finally {
    clearTimeout(timeout);
  }
}

async function callModel(documentText, question) {
  let answer = '';
  return streamModel(documentText, question, (token) => {
    answer += token;
  }).then(() => answer.trim());
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    callback(null, Boolean(fileType(file)));
  }
});

app.use(express.json());
app.use(express.static(require('node:path').join(__dirname, '..', 'public')));

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.use(['/upload', '/ask'], requireApiKey, apiRateLimit);

app.post('/upload', upload.single('file'), async (request, response) => {
  if (!request.file) {
    return response.status(400).json({ error: 'A .txt file is required in the file field.' });
  }

  const id = crypto.randomUUID();
  try {
    const type = fileType(request.file);
    const text = validateExtractedText(await extractText(request.file), type);
    const chunks = chunkText(text);
    const embeddedChunks = await Promise.all(chunks.map(async (chunk) => ({
      ...chunk,
      chunkId: crypto.randomUUID(),
      docId: id,
      embedding: await embedText(chunk.text)
    })));
    await insertChunks(embeddedChunks);
    documents.create({
      id,
      filename: request.file.originalname,
      text,
      uploadedAt: new Date().toISOString()
    }, embeddedChunks);

    return response.status(201).json({
      id,
      filename: request.file.originalname,
      characters: text.length,
      chunks: embeddedChunks.length
    });
  } catch (error) {
    return response.status(error.statusCode || 502).json({ error: error.message });
  }
});

app.post('/ask', async (request, response) => {
  const { question, docId } = request.body || {};

  if (typeof question !== 'string' || !question.trim() || typeof docId !== 'string' || !docId.trim()) {
    return response.status(400).json({ error: 'question and docId are required.' });
  }

  const document = documents.findById(docId);
  if (!document) {
    return response.status(404).json({ error: 'Document not found.' });
  }

  try {
    const questionEmbedding = await embedText(question.trim());
    const relevantChunks = await searchSimilar(questionEmbedding, 4, docId);
    const context = relevantChunks.map((chunk) => `[Chunk ${chunk.position}]\n${chunk.text}`).join('\n\n');
    response.status(200);
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    response.flushHeaders();
    const sendEvent = (event, data) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    sendEvent('sources', relevantChunks.map((chunk) => ({
      position: chunk.position,
      text: chunk.text.length > CHUNK_SNIPPET_LENGTH ? `${chunk.text.slice(0, CHUNK_SNIPPET_LENGTH)}...` : chunk.text,
      score: chunk.score
    })));

    const answer = await streamModel(context, question.trim(), (token) => sendEvent('token', { text: token }));
    const query = {
      id: crypto.randomUUID(),
      docId,
      question: question.trim(),
      answer,
      timestamp: new Date().toISOString()
    };
    documents.logQuery(query);
    sendEvent('done', {
      docId,
      question: query.question,
      answer,
      source: { filename: document.filename },
      queryId: query.id,
      chunks: relevantChunks.map((chunk) => ({
        position: chunk.position,
        text: chunk.text.length > CHUNK_SNIPPET_LENGTH ? `${chunk.text.slice(0, CHUNK_SNIPPET_LENGTH)}...` : chunk.text,
        score: chunk.score
      }))
    });
    return response.end();
  } catch (error) {
    if (response.headersSent) {
      response.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
      return response.end();
    }
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
    return response.status(400).json({ error: SUPPORTED_FILE_ERROR });
  }

  return response.status(error.statusCode || 500).json({ error: error.message || 'Internal server error.' });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Document API listening on port ${port}`);
  });
}

module.exports = { app, documents, callModel, chunkText, cosineSimilarity, embedText, extractText, streamModel };
