# Document API

Small Express API for uploading text documents and asking questions against an uploaded document id.

## Run

```sh
npm install
npm run vectors:up
npm start
```

The server listens on `http://localhost:3000` by default. Set `PORT` to change it.

Open `http://localhost:3000` for the basic browser page. Enter the value of `API_KEY`, upload a `.txt` file, then ask a question.

The default chat configuration uses local Ollama with `AI_PROVIDER=ollama`. Make sure Ollama is running and the selected `AI_MODEL` is installed. OpenAI is supported with `AI_PROVIDER=openai` and `OPENAI_API_KEY`; Anthropic is supported with `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Uploads use OpenAI `text-embedding-3-small` embeddings, so `OPENAI_API_KEY` is required for uploads and questions regardless of the chat provider. Start the local Qdrant vector store with `npm run vectors:up`. Optionally set `QDRANT_URL` or `QDRANT_COLLECTION` to change the vector store, `AI_API_URL` to override the chat endpoint, `AI_EMBEDDING_API_URL` to override the embeddings endpoint, `AI_MODEL` to choose a chat model, or `AI_EMBEDDING_MODEL` to choose an embeddings model.

## Routes

- `GET /health` returns `{ "status": "ok" }`.
- `POST /upload` accepts `.txt`, `.pdf`, and `.docx` multipart files in the `file` field and returns its generated `id`. PDFs and DOCX files are converted to text before chunking; corrupt or scanned/image-only PDFs return `400`.
- `POST /ask` accepts JSON such as `{ "question": "What is here?", "docId": "..." }`.

`POST /upload` and `POST /ask` require the configured application key in the `x-api-key` header. Requests without a valid key return `401`; requests over the configured rate limit return `429`. Set `API_RATE_LIMIT` and `API_RATE_WINDOW_MS` to customize the per-key/IP limit. Invalid input returns `400`, unknown document ids return `404`, and AI provider failures or timeouts return `500` with a JSON `error` message.

Document metadata and the optional query log are stored in the local SQLite database `documents.db` (`documents` and `queries` tables), while chunk text and vectors are stored in the Qdrant `document_chunks` collection. `/ask` embeds the question, retrieves the four most similar chunks filtered to the requested document, sends only that context and the question to the configured AI provider, and logs the successful answer.

## Test

```sh
npm test
```
