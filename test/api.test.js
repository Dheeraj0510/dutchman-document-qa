const assert = require('node:assert/strict');
const test = require('node:test');
const { app, documents } = require('../src/server');

let server;
let baseUrl;

test.before(() => {
  server = app.listen(0);
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(() => {
  documents.clear();
  server.close();
});

test('reports health', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('uploads text and asks about the document', async () => {
  const form = new FormData();
  form.append('file', new Blob(['hello document']), 'notes.txt');
  const uploadResponse = await fetch(`${baseUrl}/upload`, { method: 'POST', body: form });
  assert.equal(uploadResponse.status, 201);
  const uploaded = await uploadResponse.json();
  assert.equal(uploaded.filename, 'notes.txt');

  const askResponse = await fetch(`${baseUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What is in this file?', docId: uploaded.id })
  });
  assert.equal(askResponse.status, 200);
  assert.match((await askResponse.json()).answer, /notes\.txt/);
});
