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

const insertDocument = db.prepare(`
    INSERT INTO documents (id, filename, text, uploaded_at)
    VALUES (@id, @filename, @text, @uploadedAt)
`);
const findDocument = db.prepare('SELECT id, filename, text, uploaded_at AS uploadedAt FROM documents WHERE id = ?');
const deleteDocuments = db.prepare('DELETE FROM documents');

module.exports = {
    set(id, document) {
        insertDocument.run({
            id,
            filename: document.filename,
            text: document.text,
            uploadedAt: document.uploadedAt
        });
    },

    get(id) {
        return findDocument.get(id);
    },

    clear() {
        deleteDocuments.run();
    }
};