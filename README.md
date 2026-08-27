# Document API

Small Express API for uploading text documents and asking questions against an uploaded document id.

## Run

```sh
npm install
npm start
```

The server listens on `http://localhost:3000` by default. Set `PORT` to change it.

## Routes

- `GET /health` returns `{ "status": "ok" }`.
- `POST /upload` accepts a `.txt` multipart file in the `file` field and returns its generated `id`.
- `POST /ask` accepts JSON such as `{ "question": "What is here?", "docId": "..." }`.

Documents are held in memory and are lost when the process stops. The `/ask` response currently confirms document availability; it is the integration point for a model or search layer.

## Test

```sh
npm test
```
