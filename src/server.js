const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const app = express();
const port = Number(process.env.PORT) || 3000;
const documents = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    const isTextFile = file.mimetype === 'text/plain' || file.originalname.toLowerCase().endsWith('.txt');
    callback(null, isTextFile);
  }
});

app.use(express.json());

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

app.post('/ask', (request, response) => {
  const { question, docId } = request.body || {};

  if (typeof question !== 'string' || !question.trim() || typeof docId !== 'string' || !docId.trim()) {
    return response.status(400).json({ error: 'question and docId are required.' });
  }

  const document = documents.get(docId);
  if (!document) {
    return response.status(404).json({ error: 'Document not found.' });
  }

  return response.json({
    docId,
    question: question.trim(),
    answer: `Document ${document.filename} is available and contains ${document.text.length} characters.`,
    source: { filename: document.filename }
  });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Document API listening on port ${port}`);
  });
}

module.exports = { app, documents };
