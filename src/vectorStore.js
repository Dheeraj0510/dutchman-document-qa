function qdrantUrl() {
  return process.env.QDRANT_URL || 'http://127.0.0.1:6333';
}

function collectionName() {
  return process.env.QDRANT_COLLECTION || 'document_chunks';
}

async function qdrantRequest(path, options = {}) {
  const response = await fetch(`${qdrantUrl()}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  if (!response.ok) {
    const error = new Error(`Qdrant returned HTTP ${response.status}.`);
    error.statusCode = 500;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

async function ensureCollection(vectorSize) {
  try {
    const collection = await qdrantRequest(`/collections/${encodeURIComponent(collectionName())}`);
    const configuredSize = collection.result?.config?.params?.vectors?.size;
    if (configuredSize && configuredSize !== vectorSize) {
      const error = new Error(`Qdrant collection vector size is ${configuredSize}, but embeddings have size ${vectorSize}.`);
      error.statusCode = 500;
      throw error;
    }
  } catch (error) {
    if (!String(error.message).includes('HTTP 404')) throw error;
    await qdrantRequest(`/collections/${encodeURIComponent(collectionName())}`, {
      method: 'PUT',
      body: JSON.stringify({ vectors: { size: vectorSize, distance: 'Cosine' } })
    });
  }
}

async function insertChunks(chunks) {
  if (!chunks.length) return;
  await ensureCollection(chunks[0].embedding.length);
  await qdrantRequest(`/collections/${encodeURIComponent(collectionName())}/points?wait=true`, {
    method: 'PUT',
    body: JSON.stringify({
      points: chunks.map((chunk) => ({
        id: chunk.chunkId,
        vector: chunk.embedding,
        payload: {
          chunkId: chunk.chunkId,
          docId: chunk.docId,
          text: chunk.text,
          position: chunk.position
        }
      }))
    })
  });
}

async function searchSimilar(queryEmbedding, k, docId) {
  await ensureCollection(queryEmbedding.length);
  const filter = docId ? { must: [{ key: 'docId', match: { value: docId } }] } : undefined;
  const result = await qdrantRequest(`/collections/${encodeURIComponent(collectionName())}/points/search`, {
    method: 'POST',
    body: JSON.stringify({ vector: queryEmbedding, limit: k, with_payload: true, filter })
  });
  return (result.result || []).map((match) => ({
    chunkId: match.payload?.chunkId,
    docId: match.payload?.docId,
    text: match.payload?.text,
    position: match.payload?.position,
    score: match.score
  }));
}

module.exports = { insertChunks, searchSimilar };