import { useCallback, useEffect, useRef, useState } from 'react';
import { SEGMENT_SECONDS, maxRecordingSeconds, pickRecorderMimeType } from '../lib/audio';

const LEVEL_BARS = 28;
const METER_FPS = 30;
const MAX_SECONDS = maxRecordingSeconds();

/**
 * Microphone capture via MediaRecorder, with a live level meter.
 *
 * Unlike the Web Speech API this works in every browser that can reach a
 * microphone, and it keeps the actual audio so the server can transcribe it in
 * whatever language was spoken.
 *
 * Audio is captured in segments rather than as one long blob. Every
 * SEGMENT_SECONDS the current MediaRecorder is closed and a new one opened on
 * the same live microphone stream, which yields a list of complete, separately
 * decodable recordings. Transcription can then decode them one at a time and
 * release each before touching the next, instead of having to hold the whole
 * thing in memory at once - the reason an hour-long recording used to fail
 * outright. The cost is a few milliseconds of audio at each rotation.
 */
export const useAudioRecorder = ({ onMaxDuration, levelRef } = {}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState(() => new Array(LEVEL_BARS).fill(0));
  const [error, setError] = useState('');

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const frameRef = useRef(null);
  const timerRef = useRef(null);
  const elapsedRef = useRef(0);
  const segmentsRef = useRef([]);
  const segmentStartedAtRef = useRef(0);
  const rotationRef = useRef(null);
  const stoppingRef = useRef(false);
  const pausedRef = useRef(false);
  const maxFiredRef = useRef(false);
  const lastMeterPaintRef = useRef(0);
  const wakeLockRef = useRef(null);
  const onMaxDurationRef = useRef(onMaxDuration);

  useEffect(() => {
    onMaxDurationRef.current = onMaxDuration;
  }, [onMaxDuration]);

  const isSupported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  /** Open a MediaRecorder for one segment, collecting its data as it arrives. */
  const openSegment = useCallback((stream) => {
    const parts = [];
    const mimeType = pickRecorderMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data?.size > 0) parts.push(event.data);
    };
    recorder.onerror = () => setError('Recording stopped unexpectedly.');
    // A timeslice means a crash or a closed tab still leaves usable audio.
    recorder.start(1000);
    return { recorder, parts };
  }, []);

  /** Close a segment and resolve with its audio, or null if it captured nothing. */
  const closeSegment = useCallback(
    (handle) =>
      new Promise((resolve) => {
        const { recorder, parts } = handle || {};
        if (!recorder || recorder.state === 'inactive') {
          resolve(parts?.length ? new Blob(parts, { type: parts[0].type }) : null);
          return;
        }
        recorder.onstop = () => {
          const type = recorder.mimeType || parts[0]?.type || 'audio/webm';
          resolve(parts.length ? new Blob(parts, { type }) : null);
        };
        try {
          recorder.stop();
        } catch (err) {
          recorder.onstop();
        }
      }),
    [],
  );

  /** Bank the current segment and open the next one, without dropping the stream. */
  const rotateSegment = useCallback(async () => {
    const handle = recorderRef.current;
    const stream = streamRef.current;
    if (!handle || !stream || stoppingRef.current) return;

    segmentStartedAtRef.current = elapsedRef.current;
    recorderRef.current = null;

    const blob = await closeSegment(handle);
    if (blob) segmentsRef.current.push(blob);

    // stop() or cancel() may have run while the old recorder was closing.
    if (stoppingRef.current || !streamRef.current) return;
    try {
      const next = openSegment(streamRef.current);
      if (pausedRef.current) next.recorder.pause();
      recorderRef.current = next;
    } catch (err) {
      setError('Recording stopped unexpectedly.');
    }
  }, [closeSegment, openSegment]);

  const teardown = useCallback(() => {
    if (levelRef) levelRef.current = 0;

    // Let the screen sleep again.
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;

    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
    }
    audioContextRef.current = null;
    analyserRef.current = null;
  }, [levelRef]);

  // Stop the microphone if the component unmounts mid-recording.
  useEffect(() => teardown, [teardown]);

  // The browser silently drops a wake lock when the page is hidden, so it has
  // to be taken again each time the user comes back mid-recording.
  useEffect(() => {
    if (!isRecording) return undefined;
    const reacquire = async () => {
      if (document.visibilityState !== 'visible' || wakeLockRef.current) return;
      try {
        wakeLockRef.current = (await navigator.wakeLock?.request('screen')) || null;
      } catch (err) {
        /* nothing we can do about it */
      }
    };
    document.addEventListener('visibilitychange', reacquire);
    return () => document.removeEventListener('visibilitychange', reacquire);
  }, [isRecording]);

  const runLevelMeter = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = (now) => {
      if (!analyserRef.current) return;
      analyser.getByteTimeDomainData(data);

      let sumSquares = 0;
      for (let i = 0; i < data.length; i += 1) {
        const deviation = (data[i] - 128) / 128;
        sumSquares += deviation * deviation;
      }
      // Perceptual-ish curve: raw RMS barely moves for normal speech.
      const rms = Math.sqrt(sumSquares / data.length);
      const level = Math.min(1, Math.pow(rms * 3.2, 0.7));

      // The 3D scene reads this every frame. Writing it to a ref instead of
      // state keeps the amplitude smooth without re-rendering React at 60 Hz.
      if (levelRef) levelRef.current = level;

      // The bar meter only needs to look alive, so repaint it far less often.
      if (now - lastMeterPaintRef.current > 1000 / METER_FPS) {
        lastMeterPaintRef.current = now;
        setLevels((previous) => [...previous.slice(1), level]);
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [levelRef]);

  /** One second of wall clock: advance the timer, rotate segments, watch the cap. */
  const onTick = useCallback(() => {
    elapsedRef.current += 1;
    setSeconds(elapsedRef.current);

    if (elapsedRef.current >= MAX_SECONDS) {
      // The interval keeps firing until teardown, so fire the callback once.
      if (!maxFiredRef.current) {
        maxFiredRef.current = true;
        onMaxDurationRef.current?.();
      }
      return;
    }

    if (
      !rotationRef.current &&
      elapsedRef.current - segmentStartedAtRef.current >= SEGMENT_SECONDS
    ) {
      rotationRef.current = rotateSegment().finally(() => {
        rotationRef.current = null;
      });
    }
  }, [rotateSegment]);

  const start = useCallback(async () => {
    if (!isSupported) {
      setError('This browser cannot record audio. Use the Text tab instead.');
      return false;
    }

    setError('');
    segmentsRef.current = [];
    segmentStartedAtRef.current = 0;
    elapsedRef.current = 0;
    stoppingRef.current = false;
    pausedRef.current = false;
    maxFiredRef.current = false;
    rotationRef.current = null;
    setSeconds(0);
    setLevels(new Array(LEVEL_BARS).fill(0));

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (err) {
      const message =
        err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
          ? 'Microphone access was blocked. Allow it in your browser settings and try again.'
          : err?.name === 'NotFoundError'
            ? 'No microphone was found on this device.'
            : 'Could not start the microphone. Please try again.';
      setError(message);
      return false;
    }

    streamRef.current = stream;

    try {
      recorderRef.current = openSegment(stream);
    } catch (err) {
      teardown();
      setError('This browser refused to start a recording.');
      return false;
    }

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContextClass();
      // iOS starts every AudioContext suspended. Without this the level meter
      // reads zero for the whole recording, and so does the 3D scene.
      if (context.state === 'suspended') await context.resume();

      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.7;
      context.createMediaStreamSource(stream).connect(analyser);
      audioContextRef.current = context;
      analyserRef.current = analyser;
      runLevelMeter();
    } catch (err) {
      // The level meter is decoration; recording continues without it.
    }

    // A phone that locks its screen suspends the page and cuts the recording
    // short. Not supported everywhere, and not worth failing over if refused.
    try {
      wakeLockRef.current = (await navigator.wakeLock?.request('screen')) || null;
    } catch (err) {
      /* denied, unsupported, or the tab lost focus first */
    }

    timerRef.current = setInterval(onTick, 1000);

    setIsRecording(true);
    setIsPaused(false);
    return true;
  }, [isSupported, onTick, openSegment, runLevelMeter, teardown]);

  /**
   * Stop and resolve with every captured segment, in order, or null if nothing
   * was recorded. `segments` is what the transcription pipeline consumes.
   */
  const stop = useCallback(async () => {
    stoppingRef.current = true;

    // A rotation may be half-way through swapping recorders.
    if (rotationRef.current) {
      try {
        await rotationRef.current;
      } catch (err) {
        /* the segment that failed is simply missing from the list */
      }
    }

    const handle = recorderRef.current;
    recorderRef.current = null;
    if (handle) {
      const blob = await closeSegment(handle);
      if (blob) segmentsRef.current.push(blob);
    }

    const segments = segmentsRef.current;
    const recorded = elapsedRef.current;
    segmentsRef.current = [];

    teardown();
    setIsRecording(false);
    setIsPaused(false);
    setLevels(new Array(LEVEL_BARS).fill(0));

    if (!segments.length) return null;
    return {
      segments,
      seconds: recorded,
      mimeType: segments[0].type || 'audio/webm',
    };
  }, [closeSegment, teardown]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current?.recorder;
    if (recorder?.state !== 'recording') return;
    recorder.pause();
    pausedRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setIsPaused(true);
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current?.recorder;
    if (recorder?.state !== 'paused') return;
    recorder.resume();
    pausedRef.current = false;
    timerRef.current = setInterval(onTick, 1000);
    setIsPaused(false);
  }, [onTick]);

  const cancel = useCallback(async () => {
    await stop();
    segmentsRef.current = [];
    elapsedRef.current = 0;
    setSeconds(0);
  }, [stop]);

  return {
    isSupported,
    isRecording,
    isPaused,
    seconds,
    levels,
    error,
    setError,
    start,
    stop,
    pause,
    resume,
    cancel,
    maxSeconds: MAX_SECONDS,
  };
};
