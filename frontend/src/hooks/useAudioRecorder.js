import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_RECORDING_SECONDS, pickRecorderMimeType } from '../lib/audio';

const LEVEL_BARS = 28;
const METER_FPS = 30;

/**
 * Microphone capture via MediaRecorder, with a live level meter.
 *
 * Unlike the Web Speech API this works in every browser that can reach a
 * microphone, and it keeps the actual audio so the server can transcribe it in
 * whatever language was spoken.
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
  const chunksRef = useRef([]);
  const lastMeterPaintRef = useRef(0);
  const onMaxDurationRef = useRef(onMaxDuration);

  useEffect(() => {
    onMaxDurationRef.current = onMaxDuration;
  }, [onMaxDuration]);

  const isSupported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  const teardown = useCallback(() => {
    if (levelRef) levelRef.current = 0;
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

  const start = useCallback(async () => {
    if (!isSupported) {
      setError('This browser cannot record audio. Use the Text tab instead.');
      return false;
    }

    setError('');
    chunksRef.current = [];
    elapsedRef.current = 0;
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
      const mimeType = pickRecorderMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data?.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => setError('Recording stopped unexpectedly.');
      // A timeslice means a crash or a closed tab still leaves usable audio.
      recorder.start(1000);
      recorderRef.current = recorder;
    } catch (err) {
      teardown();
      setError('This browser refused to start a recording.');
      return false;
    }

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContextClass();
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

    timerRef.current = setInterval(() => {
      elapsedRef.current += 1;
      setSeconds(elapsedRef.current);
      if (elapsedRef.current >= MAX_RECORDING_SECONDS) onMaxDurationRef.current?.();
    }, 1000);

    setIsRecording(true);
    setIsPaused(false);
    return true;
  }, [isSupported, runLevelMeter, teardown]);

  /** Stop and resolve with the recorded audio, or null if nothing was captured. */
  const stop = useCallback(
    () =>
      new Promise((resolve) => {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state === 'inactive') {
          teardown();
          setIsRecording(false);
          setIsPaused(false);
          resolve(null);
          return;
        }

        recorder.onstop = () => {
          const type = recorder.mimeType || chunksRef.current[0]?.type || 'audio/webm';
          const blob = chunksRef.current.length ? new Blob(chunksRef.current, { type }) : null;
          chunksRef.current = [];
          recorderRef.current = null;
          teardown();
          setIsRecording(false);
          setIsPaused(false);
          setLevels(new Array(LEVEL_BARS).fill(0));
          resolve(blob && blob.size > 0 ? blob : null);
        };

        try {
          recorder.stop();
        } catch (err) {
          recorder.onstop();
        }
      }),
    [teardown],
  );

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state !== 'recording') return;
    recorder.pause();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setIsPaused(true);
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state !== 'paused') return;
    recorder.resume();
    timerRef.current = setInterval(() => {
      elapsedRef.current += 1;
      setSeconds(elapsedRef.current);
      if (elapsedRef.current >= MAX_RECORDING_SECONDS) onMaxDurationRef.current?.();
    }, 1000);
    setIsPaused(false);
  }, []);

  const cancel = useCallback(async () => {
    await stop();
    chunksRef.current = [];
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
  };
};
