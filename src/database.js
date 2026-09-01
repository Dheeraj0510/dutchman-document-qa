const path = require('node:path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'documents.db'));

db.prepare(`
    CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        text TEXT NOT NULL,
        uploaded_at TEXT NOT NULL
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS document_chunks (
        chunk_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        position INTEGER NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS queries (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    )
`).run();

const insertDocument = db.prepare(`
    INSERT INTO documents (id, filename, text, uploaded_at)
    VALUES (@id, @filename, @text, @uploadedAt)
`);
const findDocument = db.prepare('SELECT id, filename, text, uploaded_at AS uploadedAt FROM documents WHERE id = ?');
const insertQuery = db.prepare(`
    INSERT INTO queries (id, doc_id, question, answer, timestamp)
    VALUES (@id, @docId, @question, @answer, @timestamp)
`);
const findQueries = db.prepare(`
    SELECT id, doc_id AS docId, question, answer, timestamp
    FROM queries
    WHERE doc_id = ?
    ORDER BY timestamp
`);
const insertChunk = db.prepare(`
    INSERT INTO document_chunks (chunk_id, doc_id, text, embedding, position)
    VALUES (@chunkId, @docId, @text, @embedding, @position)
`);
const findChunks = db.prepare(`
    SELECT chunk_id AS chunkId, doc_id AS docId, text, embedding, position
    FROM document_chunks
    WHERE doc_id = ?
    ORDER BY position
`);
const deleteDocuments = db.prepare('DELETE FROM documents');
const deleteChunks = db.prepare('DELETE FROM document_chunks');
const deleteQueries = db.prepare('DELETE FROM queries');
const insertDocumentWithChunks = db.transaction((id, document, chunks) => {
    insertDocument.run({
        id,
        filename: document.filename,
        text: document.text,
        uploadedAt: document.uploadedAt
    });
    for (const chunk of chunks) {
        insertChunk.run({
            chunkId: chunk.chunkId,
            docId: id,
            text: chunk.text,
            embedding: JSON.stringify(chunk.embedding),
            position: chunk.position
        });
    }
});

module.exports = {
    create(document, chunks) {
        const id = document.id;
        insertDocumentWithChunks(id, document, chunks);
        return this.get(id);
    },

    findById(id) {
        return findDocument.get(id);
    },

    logQuery(query) {
        insertQuery.run(query);
    },

    getQueries(docId) {
        return findQueries.all(docId);
    },

    getChunks(id) {
        return findChunks.all(id).map((chunk) => ({
            ...chunk,
            embedding: JSON.parse(chunk.embedding)
        }));
    },

    clear() {
        deleteQueries.run();
        deleteChunks.run();
        deleteDocuments.run();
    },

    // Kept as aliases for callers using the original database API.
    set(id, document, chunks) {
        return this.create({ ...document, id }, chunks);
    },

    get(id) {
        return this.findById(id);
    }
};