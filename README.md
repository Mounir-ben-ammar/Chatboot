# Rules of Golf Chatbot (RAG)

A chatbot that answers questions **only** about `Rules_of_Golf_Simplified.pdf`, citing page numbers. Questions not covered by the document are politely declined.

## Setup

Requires Python 3.14 (3.10+ should work).

```bash
pip install -r backend/requirements.txt
```

Create `backend/.env` (copy `.env.example` from the project root; a `.env` in the project root is also read) with your OpenAI API key and model:

```bash
# backend/.env  (never commit this file; .gitignore excludes .env)
OPENAI_API_KEY=<your key>
OPENAI_MODEL=gpt-4
```

`OPENAI_MODEL` defaults to `gpt-4`. If your key has no access to gpt-4, set it to another chat model such as `gpt-4o-mini`. Environment variables work too and take precedence over `.env`.

Without a key the server still starts; `/api/health` reports `"llm_configured": false` and chat requests return an `error` event explaining what to set.

## Run

```bash
cd backend
uvicorn app:app --reload --port 8000
# or, from the project root:
python backend/app.py
```

Open http://localhost:8000.

## Architecture

```
frontend/  static UI (index.html, styles.css, app.js), served by the backend
backend/
  rag.py   PDF loading (pypdf), chunking, BM25 index, retrieval
  app.py   FastAPI server: static files, /api/health, /api/chat (SSE streaming)
```

1. **Retrieval (`rag.py`)**: at startup the PDF is extracted page by page, cleaned, and split into ~1000-character chunks with ~200 characters of overlap. Each chunk keeps its page number and is prefixed with the rule heading it belongs to (for example `[Rule 27 – Ball Lost or Out of Bounds]`). Chunks are indexed with a small built-in BM25 implementation (no extra dependencies). Each question retrieves the top 4 chunks; for follow-ups, the previous user question is also used to fill in context.
2. **Generation (`app.py`)**: the retrieved excerpts and the question go in the user turn, and a fixed system prompt tells OpenAI's chat model (`OPENAI_MODEL`, default `gpt-4`, temperature 0, at most 800 output tokens) to answer only from the excerpts, cite pages like `(p. 3)`, and decline anything else. The answer is streamed to the browser as Server-Sent Events. Up to the last 6 history messages (each trimmed to 1500 characters, to fit gpt-4's 8K context) are sent so follow-up questions work.

## API

### `GET /`
Serves `frontend/index.html`. The `frontend/` folder is mounted at `/static`.

### `GET /api/health`
```json
{"status":"ok","document":"Rules_of_Golf_Simplified.pdf","pages":22,"chunks":69,"llm_configured":true}
```

### `POST /api/chat`
Request:
```json
{"message": "What happens if my ball is lost?",
 "history": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
```
- `message` empty or whitespace only → `400`; longer than 2000 characters → `400` (`{"detail": "..."}`).

Response: `text/event-stream`. Each event is one `data: <json>` line followed by a blank line, in this order:

1. `{"type":"sources","sources":[{"page":21,"snippet":"..."}]}` (snippet ≤ 200 chars; the list may be empty)
2. zero or more `{"type":"token","text":"..."}`
3. `{"type":"done"}`

On failure at any point: `{"type":"error","message":"..."}`, after which the stream ends.

## Deploy (GitHub Pages + Render)

GitHub Pages only serves static files, so the app is split in two:

| Part | Where | Why |
|---|---|---|
| `frontend/` (landing page + chat widget) | GitHub Pages, `https://mounir-ben-ammar.github.io/Chatboot/` | static HTML/CSS/JS |
| `backend/` (PDF search + OpenAI) | Render (free web service) | runs Python and keeps `OPENAI_API_KEY` secret |

**1. Backend on Render**
1. Sign in at https://render.com with GitHub, then **New → Blueprint** and pick this repository. Render reads `render.yaml`.
2. When asked, paste your OpenAI key into `OPENAI_API_KEY` (it stays in Render, never in git).
3. After the deploy, open `https://<your-service>.onrender.com/api/health`. It should return `"status":"ok"`.
4. If your service URL is not `https://chatboot-api.onrender.com`, update it in `frontend/config.js` and push.

`ALLOWED_ORIGINS` (set in `render.yaml`) lists the sites allowed to call the API; add more origins comma-separated if needed. The free plan sleeps after ~15 min idle, so the first request can take ~1 minute.

**2. Frontend on GitHub Pages**
1. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Every push to `main` that touches `frontend/` runs `.github/workflows/pages.yml` and publishes the site (or run it manually from the **Actions** tab).

Locally nothing changes: `frontend/config.js` uses the same origin unless the page is served from `github.io`.
