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
const previousProvider = process.env.AI_PROVIDER;

test.before(async () => {
  modelServer = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    if (modelMode === 'failure') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'provider failure' }));
      return;
    }
    if (modelMode === 'timeout') return;
    assert.match(payload.messages[1].content, /hello document/);
    assert.match(payload.messages[1].content, /What is in this file\?/);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'The document says hello document.' } }] }));
  });
  await new Promise((resolve) => modelServer.listen(0, resolve));
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.AI_API_URL = `http://127.0.0.1:${modelServer.address().port}`;

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
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_API_URL;
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
    body: form
  });
  assert.equal(uploadResponse.status, 201);
  const uploaded = await uploadResponse.json();
  uploadedDocId = uploaded.id;
  assert.equal(uploaded.filename, 'notes.txt');
  assert.equal(documents.get(uploaded.id).text, 'hello document');

  const askResponse = await fetch(`${baseUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What is in this file?', docId: uploaded.id })
  });
  assert.equal(askResponse.status, 200);
  assert.equal((await askResponse.json()).answer, 'The document says hello document.');
});

test('rejects an upload without a file', async () => {
  const response = await fetch(`${baseUrl}/upload`, {
    method: 'POST'
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /\.txt file is required/);
});

test('rejects an empty question', async () => {
  const response = await fetch(`${baseUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '  ', docId: 'missing' })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'question and docId are required.' });
});

test('returns not found for an invalid document id', async () => {
  const response = await fetch(`${baseUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Question?', docId: 'missing' })
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Document not found.' });
});

test('returns 500 for an AI provider failure', async () => {
  modelMode = 'failure';
  const response = await fetch(`${baseUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Question?', docId: uploadedDocId })
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'AI provider returned HTTP 500.' });
  modelMode = 'success';
});

test('returns 500 when the AI provider times out', async () => {
  modelMode = 'timeout';
  const previousTimeout = process.env.AI_TIMEOUT_MS;
  process.env.AI_TIMEOUT_MS = '20';
  const response = await fetch(`${baseUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Question?', docId: uploadedDocId })
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'AI provider request timed out.' });
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
