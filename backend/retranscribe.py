#!/usr/bin/env python
"""Transcribe an audio file from disk, on this machine or through the API.

The web app only transcribes what it records, so a file that is already on disk
- a recording downloaded after a failure, a voice memo, something exported from
elsewhere - has no way in. This is that way in, with two engines:

  local   Whisper running on your own GPU or CPU. Costs nothing, has no rate
          limit, and never sends the audio anywhere. Needs a one-off install
          and a model download; the right choice for anything long.
  gemini  The same pipeline the app uses: 16 kHz mono WAV cut into chunks, each
          transcribed with the tail of the previous one so names and spellings
          stay consistent. Spends API quota - roughly one request per four
          minutes of audio, so an hour costs 16 and three hours cost 45.

    python retranscribe.py lecture.webm                       # local if available
    python retranscribe.py lecture.webm --engine local --language fr
    python retranscribe.py short-memo.m4a --engine gemini

The result is plain text, ready to paste into the app's Text tab for notes.
Needs ffmpeg either way. For the local engine:

    pip install faster-whisper
    pip install nvidia-cublas-cu12 nvidia-cudnn-cu12    # NVIDIA GPUs only
"""
import argparse
import asyncio
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import languages
import transcription
from config import settings
from gemini import GeminiError

# What the browser sends, and what the speech models downsample to anyway.
TARGET_SAMPLE_RATE = 16000

# Fast, accurate, and small enough to sit beside everything else on an 8 GB
# card. Plain "large-v3" is a little better on hard audio and about four times
# slower; "medium" or "small" suit a machine with no usable GPU.
DEFAULT_LOCAL_MODEL = "large-v3-turbo"

# Where winget drops ffmpeg on Windows, since it does not put it on PATH.
WINGET_FFMPEG = (
    Path.home()
    / "AppData/Local/Microsoft/WinGet/Packages"
    / "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
    / "ffmpeg-8.1-full_build/bin/ffmpeg.exe"
)


def find_ffmpeg(explicit: str | None) -> str:
    for candidate in (explicit, shutil.which("ffmpeg"), str(WINGET_FFMPEG)):
        if candidate and Path(candidate).exists():
            return candidate
    sys.exit(
        "ffmpeg not found. Install it, or pass --ffmpeg C:/path/to/ffmpeg.exe\n"
        "  winget install Gyan.FFmpeg      brew install ffmpeg      apt install ffmpeg"
    )


def have_faster_whisper() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


def to_wav(ffmpeg: str, source: Path, workdir: Path, segment_seconds: int | None) -> list[Path]:
    """Decode `source` to 16 kHz mono WAV, optionally cut into equal pieces.

    Whisper does its own segmentation, so the local engine takes one whole file;
    the API engine needs pieces small enough for a single request.
    """
    command = [
        ffmpeg, "-v", "error", "-i", str(source),
        "-ac", "1", "-ar", str(TARGET_SAMPLE_RATE), "-c:a", "pcm_s16le",
    ]
    if segment_seconds:
        command += ["-f", "segment", "-segment_time", str(segment_seconds),
                    str(workdir / "chunk_%04d.wav")]
    else:
        command += [str(workdir / "audio.wav")]

    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"ffmpeg could not read {source.name}:\n{result.stderr.strip()}")

    pieces = sorted(workdir.glob("*.wav"))
    if not pieces:
        sys.exit(f"{source.name} contains no audio.")
    return pieces


def enable_bundled_cuda() -> None:
    """Put pip's NVIDIA DLLs where Windows will actually look for them.

    The nvidia-cublas-cu12 and nvidia-cudnn-cu12 wheels drop their DLLs in
    site-packages/nvidia/*/bin, which nothing searches by default. Without
    this, ctranslate2 imports cleanly and even reports a CUDA device, then
    fails at the first encode with "Library cublas64_12.dll is not found".

    Both mechanisms are needed. add_dll_directory covers dependencies resolved
    when an extension module is imported, but CTranslate2 opens cuBLAS and
    cuDNN lazily at the first encode, through a plain LoadLibrary that ignores
    those directories and walks PATH instead.
    """
    if os.name != "nt" or getattr(enable_bundled_cuda, "_done", False):
        return
    import site

    roots = set(site.getsitepackages())
    user_site = site.getusersitepackages()
    roots.add(user_site if isinstance(user_site, str) else user_site[0])

    found: list[str] = []
    for base in roots:
        for binary_dir in sorted(Path(base).glob("nvidia/*/bin")):
            directory = str(binary_dir)
            found.append(directory)
            try:
                os.add_dll_directory(directory)
            except OSError:
                pass

    if found:
        os.environ["PATH"] = os.pathsep.join(found + [os.environ.get("PATH", "")])
    enable_bundled_cuda._done = True


def pick_device(requested: str) -> tuple[str, str]:
    """(device, compute_type) for faster-whisper, preferring the GPU."""
    enable_bundled_cuda()
    if requested in ("cuda", "cpu"):
        return requested, "float16" if requested == "cuda" else "int8"
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def drop_loops(parts: list[str], limit: int = 2) -> tuple[list[str], int]:
    """Cut a phrase the decoder repeated back to back down to `limit` copies.

    A safety net under the decoding settings, for the loops that still get
    through. Speech really does repeat - "OK. OK." - so only a longer run is
    treated as the model stuttering. This only ever deletes an exact
    consecutive duplicate; it never rewrites or invents anything, so the worst
    case is losing a genuinely thrice-repeated phrase.
    """
    cleaned: list[str] = []
    removed = 0
    for part in parts:
        run = 0
        for previous in reversed(cleaned):
            if previous != part:
                break
            run += 1
        if run >= limit:
            removed += 1
            continue
        cleaned.append(part)
    return cleaned, removed


def transcribe_local(wav: Path, language: str, args: argparse.Namespace) -> tuple[str, str]:
    """Transcribe a whole WAV with Whisper on this machine."""
    enable_bundled_cuda()
    from faster_whisper import WhisperModel

    device, compute_type = pick_device(args.device)
    print(f"Loading {args.model} on {device} ({compute_type})...", flush=True)
    print("The first run downloads the model; later runs use the cache.\n", flush=True)
    model = WhisperModel(args.model, device=device, compute_type=compute_type)

    segments, info = model.transcribe(
        str(wav),
        language=None if language == languages.AUTO else language,
        beam_size=5,
        initial_prompt=args.initial_prompt or None,
        # Whisper's repetition loops come from feeding its own output back in:
        # hitting a quiet stretch, it re-emits the last sentence over and over
        # until the audio picks up again. Conditioning off is the single
        # biggest lever against that. The cost is that it no longer remembers
        # how it spelt a term earlier in the recording, which --initial-prompt
        # covers better anyway, since that vocabulary never drifts.
        condition_on_previous_text=False,
        repetition_penalty=1.1,
        # Skip silence instead of decoding through it.
        vad_filter=True,
        # Deliberately NOT setting hallucination_silence_threshold. It drops a
        # segment that follows a long pause and looks invented, which in a
        # lecture also describes someone who stopped talking to write on the
        # board: at 2.0s it threw away real passages ("c'est nos classes de
        # complexité") to catch loops that conditioning and drop_loops already
        # handle. Losing real speech is the worse failure of the two.
    )
    print(f"Detected {info.language} ({info.language_probability:.0%} confident), "
          f"{info.duration / 60:.1f} minutes.\n", flush=True)

    parts: list[str] = []
    started = time.monotonic()
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        parts.append(text)
        elapsed = time.monotonic() - started
        speed = segment.end / elapsed if elapsed > 0 else 0
        print(f"\r  {segment.end / 60:6.1f} / {info.duration / 60:.1f} min"
              f"   {speed:4.1f}x realtime", end="", flush=True)
    print()

    parts, removed = drop_loops(parts)
    if removed:
        print(f"  dropped {removed} repeated segment(s) the decoder looped on", flush=True)
    return " ".join(parts).strip(), languages.normalize(info.language)


async def transcribe_gemini(chunks: list[Path], language: str) -> tuple[str, str]:
    """Transcribe chunks through the API, chaining context between them."""
    pieces: list[str] = []
    context = ""
    detected = languages.AUTO

    for index, chunk in enumerate(chunks, start=1):
        label = f"[{index}/{len(chunks)}]"
        try:
            result = await transcription.transcribe(
                chunk.read_bytes(),
                "audio/wav",
                # Once the language is known, pin it so later chunks agree.
                language=detected if detected != languages.AUTO else language,
                context=context,
            )
        except (GeminiError, transcription.AudioError) as exc:
            print(f"{label} failed: {exc}", file=sys.stderr, flush=True)
            pieces.append("[...]")
            continue

        text = result["text"].strip()
        if text:
            pieces.append(text)
            context = text
        if detected == languages.AUTO and result["language"] != languages.AUTO:
            detected = result["language"]
        print(f"{label} {len(text):>6} chars  {result['language']}", flush=True)

    return " ".join(pieces).strip(), detected


async def run(args: argparse.Namespace) -> int:
    source = Path(args.audio).expanduser()
    if not source.exists():
        sys.exit(f"No such file: {source}")

    engine = args.engine
    if engine == "auto":
        engine = "local" if have_faster_whisper() else "gemini"

    if engine == "local" and not have_faster_whisper():
        sys.exit(
            "The local engine needs faster-whisper:\n"
            "  pip install faster-whisper\n"
            "  pip install nvidia-cublas-cu12 nvidia-cudnn-cu12   # NVIDIA GPUs only\n"
            "Or pass --engine gemini to use the API instead."
        )
    if engine == "gemini" and not settings.ai_configured:
        sys.exit("No GEMINI_API_KEY in backend/.env - use --engine local instead.")

    ffmpeg = find_ffmpeg(args.ffmpeg)
    destination = Path(args.output) if args.output else source.with_suffix(".txt")
    language = languages.normalize(args.language)

    with tempfile.TemporaryDirectory(prefix="retranscribe-") as tmp:
        workdir = Path(tmp)
        print(f"Converting {source.name} to 16 kHz mono WAV...", flush=True)
        pieces = to_wav(
            ffmpeg, source, workdir,
            None if engine == "local" else args.chunk_seconds,
        )

        if engine == "local":
            transcript, detected = transcribe_local(pieces[0], language, args)
        else:
            print(f"{len(pieces)} chunk(s) of up to {args.chunk_seconds}s, "
                  f"one API request each.\n", flush=True)
            transcript, detected = await transcribe_gemini(pieces, language)

    if not transcript:
        sys.exit("\nNo speech was found in that file.")

    destination.write_text(transcript, encoding="utf-8")
    words = len(transcript.split())
    print(f"\n{len(transcript)} characters, ~{words} words, {detected} -> {destination}")
    if len(transcript) > settings.MAX_TRANSCRIPT_CHARS:
        print(
            f"Warning: longer than MAX_TRANSCRIPT_CHARS ({settings.MAX_TRANSCRIPT_CHARS}); "
            "the app will refuse to summarize it as one note.",
            file=sys.stderr,
        )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog="The local engine costs no API quota and keeps the audio on this machine.",
    )
    parser.add_argument("audio", help="audio file to transcribe (webm, mp3, m4a, wav, ...)")
    parser.add_argument("-o", "--output", help="where to write the transcript (default: alongside the audio)")
    parser.add_argument(
        "--engine",
        choices=("auto", "local", "gemini"),
        default="auto",
        help="auto uses local Whisper when it is installed, otherwise the API",
    )
    parser.add_argument(
        "--language",
        default=languages.AUTO,
        help="BCP-47 code such as fr or en; the default detects it",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_LOCAL_MODEL,
        help=f"local Whisper model (default: {DEFAULT_LOCAL_MODEL}; try large-v3 for accuracy, "
             "small or medium on a machine with no GPU)",
    )
    parser.add_argument(
        "--device",
        choices=("auto", "cuda", "cpu"),
        default="auto",
        help="where to run the local model (default: the GPU when there is one)",
    )
    parser.add_argument(
        "--chunk-seconds",
        type=int,
        default=settings.AUDIO_CHUNK_SECONDS,
        help=f"seconds of audio per API request (default: {settings.AUDIO_CHUNK_SECONDS})",
    )
    parser.add_argument(
        "--initial-prompt",
        default="",
        help="vocabulary to prime the local model with, e.g. the subject and its jargon; "
             "markedly improves technical terms and proper nouns",
    )
    parser.add_argument("--ffmpeg", help="path to ffmpeg, if it is not on PATH")
    args = parser.parse_args()

    if os.name == "nt":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
