/**
 * Segmented capture.
 *
 * The hook now rotates MediaRecorder every SEGMENT_SECONDS so transcription
 * gets a list of separately decodable recordings instead of one blob it has to
 * hold whole. These tests drive the hook on a fake microphone with fake timers,
 * at a miniature segment length so a "long" recording is a few ticks.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

// A 5 second segment and a 20 second cap keep the timings readable; the real
// values are 5 minutes and 3 hours.
jest.mock('../lib/audio', () => ({
  ...jest.requireActual('../lib/audio'),
  SEGMENT_SECONDS: 5,
  maxRecordingSeconds: () => 20,
}));

// eslint-disable-next-line import/first
import { useAudioRecorder } from './useAudioRecorder';

let recorders;

class FakeMediaRecorder {
  static isTypeSupported(type) {
    return type === 'audio/webm;codecs=opus';
  }

  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = options?.mimeType || 'audio/webm';
    this.state = 'inactive';
    this.emitData = true;
    recorders.push(this);
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    // A real MediaRecorder flushes one last dataavailable before onstop.
    if (this.emitData) {
      this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) });
    }
    this.onstop?.();
  }

  pause() {
    this.state = 'paused';
  }

  resume() {
    this.state = 'recording';
  }
}

const fakeStream = () => ({ getTracks: () => [{ stop: () => {} }] });

let container;
let root;
let api;

function Probe(props) {
  api = useAudioRecorder(props);
  return null;
}

/** Advance the recording clock one second at a time, flushing effects between. */
const tickSeconds = async (seconds) => {
  for (let i = 0; i < seconds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
  }
};

const render = async (props = {}) => {
  await act(async () => {
    root.render(<Probe {...props} />);
  });
};

beforeEach(async () => {
  jest.useFakeTimers();
  recorders = [];
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.MediaRecorder = FakeMediaRecorder;
  navigator.mediaDevices = { getUserMedia: jest.fn(async () => fakeStream()) };

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete global.MediaRecorder;
  delete navigator.mediaDevices;
  jest.useRealTimers();
});

it('splits a long recording into one segment per SEGMENT_SECONDS', async () => {
  await render();
  await act(async () => {
    await api.start();
  });

  // Rotations land at 5 s and 10 s; stopping at 12 s banks the third segment.
  await tickSeconds(12);

  let recording;
  await act(async () => {
    recording = await api.stop();
  });

  expect(recording.segments).toHaveLength(3);
  expect(recording.seconds).toBe(12);
  expect(recording.mimeType).toContain('webm');
  // Each segment came from its own recorder, so each is a complete file.
  expect(recorders).toHaveLength(3);
  recording.segments.forEach((segment) => expect(segment.size).toBeGreaterThan(0));
});

it('keeps recording across a rotation without dropping the microphone', async () => {
  await render();
  await act(async () => {
    await api.start();
  });
  await tickSeconds(7);

  // One getUserMedia for the whole recording, however many recorders it used.
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  expect(recorders).toHaveLength(2);
  expect(recorders[1].state).toBe('recording');
  expect(recorders[1].stream).toBe(recorders[0].stream);

  await act(async () => api.stop());
});

it('returns a single segment when the recording is shorter than one', async () => {
  await render();
  await act(async () => {
    await api.start();
  });
  await tickSeconds(3);

  let recording;
  await act(async () => {
    recording = await api.stop();
  });

  expect(recording.segments).toHaveLength(1);
  expect(recording.seconds).toBe(3);
});

it('calls onMaxDuration exactly once, however long the clock keeps running', async () => {
  const onMaxDuration = jest.fn();
  await render({ onMaxDuration });
  await act(async () => {
    await api.start();
  });

  await tickSeconds(25); // five seconds past the 20 s cap

  expect(onMaxDuration).toHaveBeenCalledTimes(1);

  await act(async () => api.stop());
});

it('stops the clock and rotations while paused', async () => {
  await render();
  await act(async () => {
    await api.start();
  });
  await tickSeconds(3);

  await act(async () => api.pause());
  const recordersAtPause = recorders.length;
  await tickSeconds(30);

  expect(recorders).toHaveLength(recordersAtPause); // nothing rotated
  expect(api.seconds).toBe(3);

  await act(async () => api.resume());
  await tickSeconds(3);

  let recording;
  await act(async () => {
    recording = await api.stop();
  });
  expect(recording.seconds).toBe(6);
});

it('reports nothing recorded when the microphone produced no audio', async () => {
  await render();
  await act(async () => {
    await api.start();
  });
  recorders.forEach((recorder) => {
    recorder.emitData = false;
  });
  await tickSeconds(2);

  let recording;
  await act(async () => {
    recording = await api.stop();
  });

  expect(recording).toBeNull();
});

it('throws away segments when a recording is discarded', async () => {
  await render();
  await act(async () => {
    await api.start();
  });
  await tickSeconds(7);

  await act(async () => api.cancel());

  expect(api.seconds).toBe(0);
  expect(api.isRecording).toBe(false);
});
