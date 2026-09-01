const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { app, callModel } = require('../src/server');
const documents = require('../src/database');

let server;
let modelServer;
let baseUrl;
let modelMode = 'success';
let uploadedDocId;
let storedPoints = [];
const previousProvider = process.env.AI_PROVIDER;
const previousApiKey = process.env.API_KEY;
const testApiKey = 'test-api-key';

test.before(async () => {
  modelServer = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.url.startsWith('/collections/')) {
      if (request.method === 'GET') {
        if (!storedPoints.length) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: { error: 'not found' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ result: { config: { params: { vectors: { size: 2 } } } } }));
        return;
      }
      const payload = JSON.parse(body);
      if (request.url.includes('/points/search')) {
        const docId = payload.filter?.must?.[0]?.match?.value;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ result: storedPoints.filter((point) => point.payload.docId === docId).map((point) => ({ ...point, score: 1 })) }));
        return;
      }
      if (request.url.includes('/points')) {
        storedPoints = payload.points;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ result: { status: 'completed' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: true }));
      return;
    }
    const payload = JSON.parse(body);
    if (payload.input) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ embedding: [payload.input.length, 1] }] }));
      return;
    }
    if (modelMode === 'failure') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'provider failure' }));
      return;
    }
    if (modelMode === 'timeout') return;
    assert.equal(payload.stream, true);
    assert.match(payload.messages[1].content, /hello document/);
    assert.match(payload.messages[1].content, /What is in this file\?/);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'The document says ' } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello document.' } }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => modelServer.listen(0, resolve));
  process.env.AI_PROVIDER = 'openai';
  process.env.API_KEY = testApiKey;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.AI_API_URL = `http://127.0.0.1:${modelServer.address().port}`;
  process.env.AI_EMBEDDING_API_URL = `http://127.0.0.1:${modelServer.address().port}`;
  process.env.QDRANT_URL = `http://127.0.0.1:${modelServer.address().port}`;

  server = app.listen(0);
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(() => {
  documents.clear();
  server.close();
  modelServer.close();
  if (previousProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = previousProvider;
  if (previousApiKey === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = previousApiKey;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_API_URL;
  delete process.env.AI_EMBEDDING_API_URL;
  delete process.env.QDRANT_URL;
});

test('reports health', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('uploads text and asks about the document', async () => {
  const form = new FormData();
  form.append('file', new Blob(['hello document']), 'notes.txt');
  const uploadResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    headers: { 'x-api-key': testApiKey },
    body: form
  });
  assert.equal(uploadResponse.status, 201);
  const uploaded = await uploadResponse.json();
  uploadedDocId = uploaded.id;
  assert.equal(uploaded.filename, 'notes.txt');
  assert.equal(documents.findById(uploaded.id).text, 'hello document');
  assert.equal(uploaded.chunks, 1);
  assert.equal(documents.getChunks(uploaded.id)[0].text, 'hello document');

  const askResponse = await fetch(`${baseUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': testApiKey },
    body: JSON.stringify({ question: 'What is in this file?', docId: uploaded.id })
  });
  assert.equal(askResponse.status, 200);
  const stream = await askResponse.text();
  assert.match(stream, /event: token/);
  assert.match(stream, /The document says/);
  assert.match(stream, /event: done/);
  const doneEvent = stream.split('\n\n').find((event) => event.startsWith('event: done'));
  const answer = JSON.parse(doneEvent.split('\n').find((line) => line.startsWith('data:')).slice(5));
  assert.equal(answer.answer, 'The document says hello document.');
  assert.match(answer.queryId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(answer.chunks, [{ position: 0, text: 'hello document', score: 1 }]);
  assert.deepEqual(documents.getQueries(uploaded.id).map(({ question, answer: loggedAnswer }) => ({ question, answer: loggedAnswer })), [
    { question: 'What is in this file?', answer: 'The document says hello document.' }
  ]);
});

test('rejects an upload without a file', async () => {
  const response = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    headers: { 'x-api-key': testApiKey }
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /\.txt file is required/);
});

test('rejects protected requests without an API key', async () => {
  const response = await fetch(`${baseUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Question?', docId: uploadedDocId })
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'A valid x-api-key header is required.' });
});

test('rejects a corrupt PDF with an extraction error', async () => {
  const form = new FormData();
  form.append('file', new Blob(['not a PDF']), 'broken.pdf');
  const response = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    headers: { 'x-api-key': testApiKey },
    body: form
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Could not extract text from the pdf file/);
});

test('rejects an empty question', async () => {
  const response = await fetch(`${baseUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': testApiKey },
    body: JSON.stringify({ question: '  ', docId: 'missing' })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'question and docId are required.' });
});

test('returns not found for an invalid document id', async () => {
  const response = await fetch(`${baseUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': testApiKey },
    body: JSON.stringify({ question: 'Question?', docId: 'missing' })
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Document not found.' });
});

test('returns 500 for an AI provider failure', async () => {
  modelMode = 'failure';
  const response = await fetch(`${baseUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': testApiKey },
    body: JSON.stringify({ question: 'Question?', docId: uploadedDocId })
  });
  assert.equal(response.status, 200);
  const failureStream = await response.text();
  assert.match(failureStream, /event: error/);
  assert.match(failureStream, /AI provider returned HTTP 500/);
  modelMode = 'success';
});

test('returns 500 when the AI provider times out', async () => {
  modelMode = 'timeout';
  const previousTimeout = process.env.AI_TIMEOUT_MS;
  process.env.AI_TIMEOUT_MS = '20';
  const response = await fetch(`${baseUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': testApiKey },
    body: JSON.stringify({ question: 'Question?', docId: uploadedDocId })
  });
  assert.equal(response.status, 200);
  const timeoutStream = await response.text();
  assert.match(timeoutStream, /event: error/);
  assert.match(timeoutStream, /AI provider request timed out/);
  modelMode = 'success';
  if (previousTimeout === undefined) delete process.env.AI_TIMEOUT_MS;
  else process.env.AI_TIMEOUT_MS = previousTimeout;
});

test('rejects an unsupported AI provider', async () => {
  const previousProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'unknown';
  await assert.rejects(() => callModel('text', 'question'), /Unsupported AI_PROVIDER/);
  process.env.AI_PROVIDER = previousProvider;
});

test('rejects an invalid provider response', async () => {
  const previousUrl = process.env.AI_API_URL;
  process.env.AI_API_URL = `http://127.0.0.1:${modelServer.address().port}`;
  const originalRequestListener = modelServer.listeners('request')[0];
  modelServer.removeListener('request', originalRequestListener);
  modelServer.on('request', (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [] }));
  });

  await assert.rejects(() => callModel('text', 'question'), /invalid response/);

  modelServer.removeAllListeners('request');
  modelServer.on('request', originalRequestListener);
  process.env.AI_API_URL = previousUrl;
});
