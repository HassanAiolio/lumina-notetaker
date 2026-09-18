# Lumina Note

> An AI voice notetaker with Google Sign-In, multilingual transcription and a 3D interactive interface.

![License](https://img.shields.io/badge/license-MIT-blue)
![Python](https://img.shields.io/badge/Python-3.11+-green)
![React](https://img.shields.io/badge/React-19-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-latest-teal)

---

## Overview

Lumina Note records your voice — in French, English, Spanish or a dozen other languages —
transcribes it server-side, and uses Google's Gemini models to structure it into clean notes.
It works out whether you recorded a meeting, a lecture, a brainstorm or an interview, and
produces the sections that fit, in the language you actually spoke.

Every account gets its own private space. Notes, transcripts and tags are scoped to the
signed-in user and are never visible to anyone else.

---

## Features

- **Google Sign-In** — one tap, no passwords. Notes are private per account.
- **Records in any supported language** — audio is captured with `MediaRecorder`, so it works
  in Chrome, Firefox and Safari, not only in browsers that ship the Web Speech API.
- **Automatic language detection** — leave the picker on *Auto* and the transcriber identifies
  the language itself; pick one explicitly for short or noisy recordings.
- **Notes in your language** — the summary, the bullets and even the section headings come back
  in the language of the recording. Section keys stay stable underneath so search and export
  keep working.
- **Long recordings** — audio is converted to 16 kHz mono WAV and split at quiet moments into
  chunks, each transcribed with the tail of the previous one for consistent spelling.
- **Fail-safes throughout** — model fallback chain, retries with backoff, a local extraction
  that still produces usable notes when the AI is down, retryable transcription, a downloadable
  copy of the audio, and a draft transcript that survives a page reload.
- **Full transcript kept** — stored alongside every note, searchable and exportable.
- **Search, tag filtering, pagination, Markdown export**
- **3D interactive scene** — a floating notebook, a cursor-tracking pen and a paper airplane on
  note generation. Purely decorative: it is behind an error boundary and the app works without it.

---

## Tech Stack

**Frontend** — React 19 (CRA + CRACO), Tailwind CSS, Framer Motion, Three.js, Axios,
Google Identity Services.

**Backend** — FastAPI, Motor (async MongoDB), httpx, Pydantic v2, PyJWT, google-auth.

**External** — Google Gemini (transcription + structuring), MongoDB Atlas.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│                React Frontend                │
│  MediaRecorder ──► WAV 16 kHz mono ──► chunks│
│  Google Identity Services ──► ID token       │
│  Web Speech API ──► live captions (optional) │
└───────────────────┬──────────────────────────┘
                    │ HTTPS + Bearer token
┌───────────────────▼──────────────────────────┐
│                FastAPI Backend               │
│  POST /api/auth/google  verify ──► app JWT   │
│  POST /api/transcribe   audio ──► text+lang  │
│  POST /api/notes/summarize ──► sections      │
│       └─ model fallback ──► local extraction │
│  /api/notes  CRUD, scoped to the user        │
└───────────────────┬──────────────────────────┘
                    │
┌───────────────────▼──────────────────────────┐
│                MongoDB Atlas                 │
│  users : id, google_sub, email, name         │
│  notes : id, user_id, title, type, language, │
│          sections, labels, raw_transcript,   │
│          tags, source, duration, timestamps  │
└──────────────────────────────────────────────┘
```

---

## Getting Started

### Prerequisites

- Node.js 18+, Python 3.11+
- A [Google AI Studio](https://aistudio.google.com/apikey) API key
- A [MongoDB Atlas](https://mongodb.com/atlas) cluster
- A Google OAuth **Web application** client ID

### 1. Create the Google OAuth client

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. **Create credentials → OAuth client ID → Web application**.
3. Under **Authorised JavaScript origins**, add every origin the frontend is served from:
   `http://localhost:3000` for development, plus your production domain.
   No redirect URI is needed — Sign-In With Google returns the credential in the browser.
4. Copy the client ID into `GOOGLE_CLIENT_ID` on the backend.

### 2. Backend

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env     # then fill it in
python -m uvicorn server:app --reload
```

Required in `backend/.env`:

| Variable | Purpose |
| --- | --- |
| `MONGO_URL` | MongoDB connection string |
| `DB_NAME` | Database name |
| `GEMINI_API_KEY` | Google AI Studio key |
| `GOOGLE_CLIENT_ID` | OAuth Web client ID |
| `JWT_SECRET` | Signs session tokens — **set this in production** |
| `CORS_ORIGINS` | Comma-separated frontend origins |

`.env.example` documents the optional settings: model fallback order, rate limits,
audio and transcript ceilings, and an email allow-list.

### 3. Frontend

```bash
cd frontend
npm install --legacy-peer-deps
cp .env.example .env     # REACT_APP_BACKEND_URL
npm start
```

Open [http://localhost:3000](http://localhost:3000).

> Microphone access requires a secure context. `localhost` counts; a plain-HTTP LAN address
> does not.

### 4. Tests

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest
```

---

## Deployment notes

- **Set `JWT_SECRET`.** Without it the server generates a random secret at boot, so every
  restart signs everyone out.
- **`CORS_ORIGINS` must list your real frontend origin** — no trailing slash.
- **Health checks:** point the platform at `/api/health`, which returns 200 whenever the
  process is alive. `/api/health/ready` returns 503 until the database and both credentials
  are usable — useful for a dashboard, but not as a liveness probe.
- **Free-tier cold starts:** the first request after an idle period can take 20–30 seconds.
  The frontend retries idempotent reads and shows a wake-up screen rather than an error.
- **Gemini quotas:** when the daily quota runs out, summarization falls back to a local
  extraction and the note is flagged in the UI. The transcript is never lost.
- **Adopting old notes:** notes saved before accounts existed have no owner and are invisible.
  Set `LEGACY_OWNER_EMAIL` to an address that has signed in once, restart, and they are
  assigned to that account.

---

## Project structure

```
backend/
├── server.py          # app wiring, routes, middleware
├── config.py          # environment settings
├── db.py              # Mongo client, indexes, legacy migration
├── auth.py            # Google token verification, app JWTs
├── gemini.py          # retries, model fallback, JSON recovery
├── transcription.py   # audio validation, chunking, speech-to-text
├── summarizer.py      # prompting, normalization, offline fallback
├── languages.py       # supported languages + offline detector
├── ratelimit.py       # per-user sliding window
├── models.py          # request/response schemas
└── test_*.py          # unit and API tests

frontend/src/
├── contexts/AuthContext.jsx     # Google Sign-In, session, boot config
├── hooks/
│   ├── useAudioRecorder.js      # MediaRecorder + level meter
│   └── useSpeechRecognition.js  # live captions (best-effort)
├── lib/
│   ├── audio.js                 # decode, resample, WAV, chunking
│   └── notes.js                 # section shapes, labels, Markdown
├── services/api.js              # axios instance, auth, retries
└── components/                  # Recorder, NoteOutput, NoteHistory, SignIn…
```

---

## Key implementation details

### Why transcription moved to the server

The Web Speech API is Chrome-only in practice, needs a language fixed up front, and hands back
text with no audio to check it against. Recording with `MediaRecorder` and transcribing
server-side works everywhere, detects the language on its own, and keeps the audio available
for a retry. The Web Speech API is still used, but only for optional live captions while you
speak — if it fails, nothing is lost.

### Audio conversion

Browsers record WebM/Opus (Chrome) or MP4/AAC (Safari). Rather than depend on container support,
the client decodes locally and re-encodes to 16 kHz mono PCM, then splits long recordings at the
quietest point near each boundary so a cut does not land mid-word.

### Stable keys, localized labels

The model returns English `snake_case` section keys plus a `labels` map holding the same headings
in the transcript's language. The UI shows the labels; search, export and older notes keep
working off the keys.

---

## 3D Models

Sourced from [Sketchfab](https://sketchfab.com) under Creative Commons licences — notebook, pen
and paper airplane, all CC Attribution. See each model's Sketchfab page for full attribution.

---

## License

MIT
