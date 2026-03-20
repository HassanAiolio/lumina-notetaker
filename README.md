# Lumina Note

> An AI-powered voice notetaker with a 3D interactive interface, built as a personal project to explore full-stack development, LLM API integration, and real-time browser APIs.

![License](https://img.shields.io/badge/license-MIT-blue)
![Python](https://img.shields.io/badge/Python-3.12+-green)
![React](https://img.shields.io/badge/React-18-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-latest-teal)

---

## Overview

Lumina Note is a full-stack web application that lets users record their voice or paste raw text, then uses Google's Gemini 2.5 Flash model to intelligently structure the content into clean, context-aware notes. The app detects whether the input is a meeting, lecture, brainstorm session, or interview, and generates the most relevant sections accordingly, no rigid templates.

The project was built primarily to get hands-on experience with LLM API integration, async Python backends, and real-time browser APIs, while also exploring 3D rendering in a web context using Three.js.

---

## Features

- **Voice recording** via the Web Speech API with real-time live transcript display
- **AI summarization** using Gemini 2.5 Flash, detects content type and generates dynamic sections (not hardcoded templates)
- **3D interactive scene**, a floating notebook, a pen that follows the cursor and points toward the notebook, floating particles, and a paper airplane animation on note generation
- **MongoDB persistence**, notes are saved and retrievable across sessions
- **Search and tag filtering**, find past notes by keyword or tag
- **Export to Markdown**, download any note as a `.md` file
- **Responsive UI**, dark glassmorphism design built with Tailwind CSS and Framer Motion

---

## Tech Stack

### Frontend
- **React** (Create React App + CRACO)
- **Tailwind CSS** for styling
- **Framer Motion** for UI animations
- **Three.js** for the 3D scene (GLTFLoader, raycasting, animation loop)
- **Web Speech API** for live voice transcription
- **Axios** for API calls

### Backend
- **FastAPI** (Python), async REST API
- **Motor**, async MongoDB driver
- **httpx**, async HTTP client for Gemini API calls
- **Pydantic**, request/response validation
- **Uvicorn**, ASGI server

### External Services
- **Google Gemini 2.5 Flash**, LLM for transcript structuring
- **MongoDB Atlas**, cloud database (free tier)

---

## Architecture

```
┌─────────────────────────────────────┐
│           React Frontend            │
│  Web Speech API → live transcript   │
│  Three.js → 3D interactive scene    │
│  Axios → REST calls to backend      │
└────────────────┬────────────────────┘
                 │ HTTP
┌────────────────▼────────────────────┐
│          FastAPI Backend            │
│  POST /api/notes/summarize          │
│    └─ calls Gemini 2.5 Flash        │
│    └─ parses + returns sections     │
│  POST /api/notes → saves to MongoDB │
│  GET  /api/notes → search + filter  │
└────────────────┬────────────────────┘
                 │
┌────────────────▼────────────────────┐
│         MongoDB Atlas               │
│  notes collection                   │
│  fields: title, type, sections,     │
│          raw_transcript, tags       │
└─────────────────────────────────────┘
```

---

## Getting Started

### Prerequisites
- Node.js 18+
- Python 3.12+
- A [Google AI Studio](https://aistudio.google.com) API key (free)
- A [MongoDB Atlas](https://mongodb.com/atlas) cluster (free tier)

### Backend setup

```bash
cd backend
pip install -r requirements.txt
```

Create `backend/.env`:
```
GEMINI_API_KEY=your_gemini_key_here
MONGO_URL=mongodb+srv://user:password@cluster.mongodb.net/
DB_NAME=lumina
CORS_ORIGINS=http://localhost:3000
```

Start the server:
```bash
python -m uvicorn server:app --reload
```

### Frontend setup

```bash
cd frontend
npm install --legacy-peer-deps
```

Create `frontend/.env`:
```
REACT_APP_BACKEND_URL=http://localhost:8000
```

Start the app:
```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

---

## Project Structure

```
lumina-note/
├── backend/
│   ├── server.py          # FastAPI app, routes, Gemini integration, MongoDB
│   ├── requirements.txt
│   └── .env               # not committed
├── frontend/
│   ├── public/
│   │   └── models/        # 3D GLB model files
│   │       ├── notebook.glb
│   │       ├── pen.glb
│   │       └── paper_airplane.glb
│   └── src/
│       ├── components/
│       │   ├── Canvas3D/
│       │   │   └── Scene3D.jsx    # Three.js scene, animation loop, cursor tracking
│       │   ├── Recorder.jsx       # Mic button, live transcript display
│       │   ├── NoteOutput.jsx     # Dynamic section rendering
│       │   ├── NoteHistory.jsx    # Search, tag filter, saved notes
│       │   └── ExportButton.jsx   # Markdown export
│       ├── hooks/
│       │   └── useSpeechRecognition.js  # Web Speech API wrapper
│       ├── services/
│       │   └── api.js             # Axios calls to backend
│       └── App.js
```

---

## Key Implementation Details

### Dynamic AI sectioning
Rather than hardcoding note sections, the backend prompts Gemini to detect the content type (MEETING, LECTURE, BRAINSTORM, etc.) and return the most relevant sections for that type. The frontend renders whatever sections are returned, fully dynamic, no fixed templates.

### 3D cursor interaction
The pen in the 3D scene uses Three.js raycasting to project the mouse position onto a world-space plane, placing the pen tip exactly at the cursor position. `lookAt` is used to angle the pen body toward the notebook, and velocity-based tilt is applied on top for a natural feel.

### Web Speech API hook
The `useSpeechRecognition` hook separates interim (in-progress) results from final confirmed transcript chunks using `isFinal` on the recognition event, allowing live display without losing confirmed text.

---

## 3D Models

3D models used in this project are sourced from [Sketchfab](https://sketchfab.com) under Creative Commons licenses:

- **Notebook**, CC Attribution
- **Pen**, CC Attribution
- **Paper Airplane**, CC Attribution

Please refer to each model's original Sketchfab page for full attribution and license details.

---

## License

MIT
