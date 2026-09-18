import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Web Speech API wrapper used only for live captions while recording.
 *
 * The transcript that actually gets saved comes from the server, which can
 * detect the language and works in every browser. This hook is decoration: if
 * it is unsupported, blocked, or fights the recorder for the microphone, it
 * disables itself quietly and nothing is lost.
 */
export const useSpeechRecognition = () => {
  const [captions, setCaptions] = useState('');
  const [interim, setInterim] = useState('');
  const [isActive, setIsActive] = useState(false);

  const recognitionRef = useRef(null);
  const finalRef = useRef('');
  const wantsToRunRef = useRef(false);
  const restartsRef = useRef(0);

  const isSupported =
    typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  const cleanup = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch (err) {
      /* already stopped */
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(
    (locale = 'en-US') => {
      if (!isSupported) return;

      cleanup();
      finalRef.current = '';
      restartsRef.current = 0;
      setCaptions('');
      setInterim('');
      wantsToRunRef.current = true;

      const spawn = () => {
        if (!wantsToRunRef.current) return;

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = locale;

        recognition.onresult = (event) => {
          let interimText = '';
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const result = event.results[i];
            if (result.isFinal) {
              finalRef.current += `${result[0].transcript.trim()} `;
            } else {
              interimText += result[0].transcript;
            }
          }
          setCaptions(finalRef.current);
          setInterim(interimText);
        };

        recognition.onerror = (event) => {
          // 'no-speech' and 'aborted' are routine; the rest mean captions are
          // not going to work here, so stop trying rather than loop.
          if (event.error !== 'no-speech' && event.error !== 'aborted') {
            wantsToRunRef.current = false;
            setIsActive(false);
          }
        };

        recognition.onend = () => {
          // Chrome ends the session after a pause. Restart while we still want
          // captions, with a ceiling so a hard failure cannot spin forever.
          if (wantsToRunRef.current && restartsRef.current < 200) {
            restartsRef.current += 1;
            setTimeout(spawn, 250);
          } else {
            setIsActive(false);
          }
        };

        try {
          recognition.start();
          recognitionRef.current = recognition;
          setIsActive(true);
        } catch (err) {
          wantsToRunRef.current = false;
          setIsActive(false);
        }
      };

      spawn();
    },
    [cleanup, isSupported],
  );

  const stop = useCallback(() => {
    wantsToRunRef.current = false;
    cleanup();
    setIsActive(false);
    setInterim('');
  }, [cleanup]);

  const reset = useCallback(() => {
    finalRef.current = '';
    setCaptions('');
    setInterim('');
  }, []);

  return { captions, interim, isActive, isSupported, start, stop, reset };
};
