# Document API

Small Express API for uploading text documents and asking questions against an uploaded document id.

## Run

```sh
npm install
npm start
```

The server listens on `http://localhost:3000` by default. Set `PORT` to change it.

Open `http://localhost:3000` for the basic browser page. Enter the value of `API_KEY`, upload a `.txt` file, then ask a question.

The default configuration uses local Ollama with `AI_PROVIDER=ollama`. Make sure Ollama is running and the selected `AI_MODEL` is installed. OpenAI is supported with `AI_PROVIDER=openai` and `OPENAI_API_KEY`; Anthropic is supported with `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Optionally set `AI_API_URL` to override the provider endpoint and `AI_MODEL` to choose a model.

## Routes

- `GET /health` returns `{ "status": "ok" }`.
- `POST /upload` accepts a `.txt` multipart file in the `file` field and returns its generated `id`.
- `POST /ask` accepts JSON such as `{ "question": "What is here?", "docId": "..." }`.

The frontend-facing routes do not require an application API key. Invalid input returns `400`, unknown document ids return `404`, and AI provider failures or timeouts return `500` with a JSON `error` message.

Documents are stored in the local SQLite database `documents.db`, so they remain available after a process restart. `/ask` sends the retrieved document text and question to the configured AI provider and returns its answer.

## Test

```sh
npm test
```
