import React, { useEffect, useRef } from 'react';
import { createDeskScene } from './deskScene';

/**
 * The scene behind the app: the notebook and pen as one rigged model, with
 * its motion baked in (see deskScene.js and models-src/build_desk.py). While
 * you record the pen writes at the pace of your voice; while the transcript
 * and notes are being made it writes on; when the notes are ready the page
 * folds into a paper airplane and flies off.
 *
 * Rules it follows:
 *  - it stops rendering when it is not on screen or the tab is hidden;
 *  - it respects prefers-reduced-motion by holding a still composition;
 *  - the model is meshopt-compressed, which deskScene registers a decoder for.
 */

const SMALL_VIEWPORT = 768;

export const Scene3D = ({
  isRecording,
  isTranscribing = false,
  isSummarizing,
  airplaneFlying,
  audioLevelRef,
  active = true,
}) => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const deskRef = useRef(null);
  const activeRef = useRef(active);
  const levelRef = useRef(audioLevelRef);
  const flyingRef = useRef(false);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    levelRef.current = audioLevelRef;
  }, [audioLevelRef]);

  useEffect(() => {
    deskRef.current?.setState({ recording: !!isRecording, working: !!(isTranscribing || isSummarizing) });
  }, [isRecording, isTranscribing, isSummarizing]);

  // Only the moment the notes arrive launches the plane, not every render after.
  useEffect(() => {
    if (airplaneFlying && !flyingRef.current) deskRef.current?.launchAirplane();
    flyingRef.current = !!airplaneFlying;
  }, [airplaneFlying]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const smallScreen = window.innerWidth < SMALL_VIEWPORT;
    const pixelRatio = (reduced) => Math.min(window.devicePixelRatio, reduced || smallScreen ? 1 : 1.5);

    let desk;
    try {
      desk = createDeskScene(canvas, {
        smallScreen,
        reducedMotion: reducedMotionQuery.matches,
        // The plane flies over the interface, so the canvas comes up for it.
        onFlight: (flying) => {
          if (containerRef.current) containerRef.current.style.zIndex = flying ? '50' : '0';
        },
      });
    } catch (err) {
      return undefined; // No WebGL: the app is perfectly usable without this.
    }
    deskRef.current = desk;
    desk.setState({ recording: !!isRecording, working: !!(isTranscribing || isSummarizing) });
    desk.setPixelRatio(pixelRatio(reducedMotionQuery.matches));
    desk.layout(window.innerWidth, window.innerHeight);

    const handlePointerMove = (event) => {
      if (event.pointerType === 'touch') return;
      desk.setPointer((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
    };
    if (!coarsePointer) window.addEventListener('pointermove', handlePointerMove, { passive: true });

    // ── Render loop, only while it is worth running ───────────────────────
    let frameId = null;
    let last = performance.now();
    const tick = (now) => {
      frameId = requestAnimationFrame(tick);
      const delta = (now - last) / 1000;
      last = now;
      if (!activeRef.current || document.hidden) return;
      desk.setState({ level: levelRef.current?.current || 0 });
      desk.frame(delta);
    };
    const startLoop = () => {
      if (frameId === null) {
        last = performance.now(); // discard the gap accumulated while paused
        frameId = requestAnimationFrame(tick);
      }
    };
    const stopLoop = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
    };
    startLoop();

    const handleVisibility = () => (document.hidden ? stopLoop() : startLoop());
    document.addEventListener('visibilitychange', handleVisibility);

    let lastWidth = window.innerWidth;
    let lastHeight = window.innerHeight;
    let resizeTimer = null;
    const applyResize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      // Ignore the small height-only changes the address bar produces.
      if (width === lastWidth && Math.abs(height - lastHeight) < 120) return;
      lastWidth = width;
      lastHeight = height;
      desk.layout(width, height);
    };
    const handleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyResize, 150);
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);

    const handleMotionPreference = (event) => {
      desk.setReducedMotion(event.matches);
      desk.setPixelRatio(pixelRatio(event.matches));
    };
    reducedMotionQuery.addEventListener?.('change', handleMotionPreference);

    const handleContextLost = (event) => {
      event.preventDefault();
      stopLoop();
    };
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', startLoop);

    return () => {
      stopLoop();
      document.removeEventListener('visibilitychange', handleVisibility);
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
      if (!coarsePointer) window.removeEventListener('pointermove', handlePointerMove);
      reducedMotionQuery.removeEventListener?.('change', handleMotionPreference);
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', startLoop);
      deskRef.current = null;
      desk.dispose();
    };
    // Created once; state reaches it through the effects above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="canvas-container"
      data-testid="3d-scene"
      aria-hidden="true"
      style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
};
