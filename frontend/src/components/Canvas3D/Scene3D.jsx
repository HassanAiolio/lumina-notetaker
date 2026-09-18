import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * The scene behind the app. It is decoration, but it is not idle decoration:
 * while you record, the notebook's own page animation is driven by your actual
 * microphone amplitude, and the pen writes while the transcript is being made.
 *
 * Rules it follows:
 *  - every interpolation is per second, not per frame, so a 120 Hz display does
 *    not run the whole scene at double speed;
 *  - it stops rendering when it is not on screen or the tab is hidden;
 *  - it respects prefers-reduced-motion by holding a still composition;
 *  - the models are meshopt-compressed, so the decoder must be registered.
 */

const PARTICLE_COUNT_DESKTOP = 90;
const PARTICLE_COUNT_MOBILE = 28;
const WIDE_VIEWPORT = 1280;
const SMALL_VIEWPORT = 768;

/** Frame-rate independent easing: the fraction to move this frame. */
const approach = (rate, delta) => 1 - Math.exp(-rate * delta);

/**
 * Where the nib points while writing, relative to itself: into the page and
 * downwards. lookAt aims the pen's +Z here, so the barrel trails the opposite
 * way - up and towards the viewer - which both looks like a held pen and keeps
 * the body permanently outside the book.
 */
const WRITING_AIM = new THREE.Vector3(0.22, -0.8, -0.55);

export const Scene3D = ({
  isRecording,
  isTranscribing = false,
  isSummarizing,
  showResult,
  airplaneFlying,
  audioLevelRef,
  active = true,
}) => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const stateRef = useRef({ isRecording: false, isTranscribing: false, isSummarizing: false, showResult: false });
  const activeRef = useRef(active);
  const levelRef = useRef({ current: 0 });

  useEffect(() => {
    stateRef.current = { isRecording, isTranscribing, isSummarizing, showResult };
  }, [isRecording, isTranscribing, isSummarizing, showResult]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    levelRef.current = audioLevelRef || { current: 0 };
  }, [audioLevelRef]);

  // Lift the canvas above the UI only while the airplane crosses the screen.
  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.style.zIndex = airplaneFlying ? '50' : '0';
  }, [airplaneFlying]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = reducedMotionQuery.matches;

    // A phone has no cursor to follow and a battery to protect, so it gets
    // fewer particles, no supersampling and a resting pen.
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const isSmallScreen = window.innerWidth < SMALL_VIEWPORT;
    const particleCount = isSmallScreen ? PARTICLE_COUNT_MOBILE : PARTICLE_COUNT_DESKTOP;
    const maxPixelRatio = reducedMotion || isSmallScreen ? 1 : 1.5;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 1.5, 5);

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: window.devicePixelRatio < 2,
        alpha: true,
        powerPreference: 'low-power',
      });
    } catch (err) {
      return undefined; // No WebGL: the app is perfectly usable without this.
    }

    // Shadows were costing a full depth pass for objects sitting behind an
    // opaque content column, so they are gone.
    renderer.shadowMap.enabled = false;
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));

    const keyLight = new THREE.SpotLight(0xa78bfa, 2, 20, Math.PI / 4, 0.8);
    keyLight.position.set(-3, 4, 2);
    scene.add(keyLight);

    const frontLight = new THREE.PointLight(0xffffff, 1.0, 10);
    frontLight.position.set(0, 1, 2);
    scene.add(frontLight);

    const warmLight = new THREE.PointLight(0xf59e0b, 0.4, 8);
    warmLight.position.set(0, -2, 1);
    scene.add(warmLight);

    const notebookGroup = new THREE.Group();
    const penGroup = new THREE.Group();
    const airplaneGroup = new THREE.Group();
    airplaneGroup.visible = false;
    scene.add(notebookGroup, penGroup, airplaneGroup);

    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const glowSphere = new THREE.Mesh(new THREE.SphereGeometry(1.8, 24, 16), glowMaterial);
    glowSphere.position.set(0, 0.3, 0);
    notebookGroup.add(glowSphere);

    // ── Layout ────────────────────────────────────────────────────────────
    // On a wide screen the content column leaves a real margin, so the
    // notebook is moved into it and the scene becomes visible rather than
    // spending its life behind an opaque card.
    const home = new THREE.Vector3();
    const layout = () => {
      const wide = window.innerWidth >= WIDE_VIEWPORT;
      const aspect = window.innerWidth / window.innerHeight;
      home.set(wide ? Math.min(2.9, aspect * 1.35) : -0.4, wide ? 0.1 : 0, wide ? -0.4 : 0);
      // Behind the text on narrow screens, so hold it back.
      scene.traverse((object) => {
        if (object.isMesh && object.material && object !== glowSphere) {
          object.material.opacity = wide ? 1 : 0.55;
          object.material.transparent = !wide;
        }
      });
    };

    // ── Models ────────────────────────────────────────────────────────────
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    let mixer = null;
    let pageAction = null;
    let disposed = false;
    let notebookSweep = 1.3;
    let penLength = 0.6;

    const fit = (model, targetSize) => {
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = targetSize / Math.max(size.x, size.y, size.z);
      model.scale.setScalar(scale);
      model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
      return scale;
    };

    const load = (path, onLoaded) =>
      loader.load(path, (gltf) => {
        if (disposed) return;
        onLoaded(gltf);
        layout();
      }, undefined, (err) => {
        // eslint-disable-next-line no-console
        console.warn(`Scene3D: could not load ${path}`, err);
      });

    load('/models/notebook.glb', (gltf) => {
      const model = gltf.scene;
      fit(model, 2.2);
      notebookGroup.add(model);
      // The notebook turns about Y, so what the pen must clear is the radius it
      // sweeps in the XZ plane - not its bounding sphere, which is larger in Y
      // and would have let the barrel dip into a corner as the book came round.
      const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      notebookSweep = 0.5 * Math.hypot(size.x, size.z);

      // The model ships a rigged page animation that nothing was playing.
      // We drive its playhead ourselves instead of letting it loop on its own.
      if (gltf.animations?.length) {
        mixer = new THREE.AnimationMixer(model);
        pageAction = mixer.clipAction(gltf.animations[0]);
        pageAction.play();
        pageAction.paused = false;
      }
    });

    const innerPen = new THREE.Group();
    penGroup.add(innerPen);

    load('/models/pen.glb', (gltf) => {
      const model = gltf.scene;
      fit(model, 0.6);
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      penLength = box.max.z - box.min.z;

      // The model's nib is at its local -Z end, and fit() leaves the model
      // centred. Offsetting alone puts the nib at the origin but leaves the
      // BODY pointing along +Z - the same direction lookAt aims at the
      // notebook, so the pen was driven straight through the book.
      //
      // Turning the wrapper by half a turn keeps the nib on the origin and
      // sends the body backwards instead, which is also how a pen is actually
      // held: nib on the page, barrel trailing away towards the viewer.
      model.position.z += penLength / 2;
      innerPen.rotation.y = Math.PI;
      innerPen.add(model);
    });

    load('/models/paper_airplane.glb', (gltf) => {
      fit(gltf.scene, 0.8);
      airplaneGroup.add(gltf.scene);
    });

    // ── Particles: one Points object instead of 50 meshes ─────────────────
    const particlePositions = new Float32Array(particleCount * 3);
    const particleSeeds = new Float32Array(particleCount * 3); // baseX, baseY, phase
    const particleSpeeds = new Float32Array(particleCount);

    for (let i = 0; i < particleCount; i += 1) {
      const x = (Math.random() - 0.5) * 12;
      const y = (Math.random() - 0.5) * 8;
      const z = (Math.random() - 0.5) * 6;
      particlePositions.set([x, y, z], i * 3);
      particleSeeds.set([x, y, Math.random() * Math.PI * 2], i * 3);
      particleSpeeds[i] = Math.random() * 0.5 + 0.2;
    }

    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    const particleMaterial = new THREE.PointsMaterial({
      color: 0x7c3aed,
      size: 0.05,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    const particles = new THREE.Points(particleGeometry, particleMaterial);
    scene.add(particles);

    layout();

    // ── Interaction ───────────────────────────────────────────────────────
    const pointer = new THREE.Vector2(0, 0);
    const raycaster = new THREE.Raycaster();
    const pointerPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -1.5);
    const pointerWorld = new THREE.Vector3();
    let pointerSeen = false;

    const handlePointerMove = (event) => {
      if (event.pointerType === 'touch') return;
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
      pointerSeen = true;
    };
    if (!coarsePointer) {
      window.addEventListener('pointermove', handlePointerMove, { passive: true });
    }

    // ── Animation state ───────────────────────────────────────────────────
    const penPosition = new THREE.Vector3(0, 0, 1.5);
    const penTarget = new THREE.Vector3(0, 0, 1.5);
    const previousPen = new THREE.Vector3(0, 0, 1.5);
    const lookTarget = new THREE.Vector3();
    const notebookWorld = new THREE.Vector3();
    const tilt = { x: 0, z: 0 };
    const MAX_TILT = 0.15;

    let smoothedLevel = 0;
    const aimPoint = new THREE.Vector3();
    let glowTarget = 0;
    let airplaneProgress = 0;
    let airplaneActive = false;
    let wasShowingResult = false;

    const clock = new THREE.Clock();
    let frameId = null;

    const renderFrame = () => {
      // Clamp: coming back from a hidden tab hands us a huge delta.
      const delta = Math.min(clock.getDelta(), 0.1);
      const elapsed = clock.elapsedTime;
      const { isRecording: recording, isTranscribing: transcribing, isSummarizing: summarizing, showResult: hasResult } =
        stateRef.current;
      const working = transcribing || summarizing;

      // Microphone amplitude, eased so the scene breathes rather than jitters.
      const rawLevel = recording ? levelRef.current?.current || 0 : 0;
      smoothedLevel += (rawLevel - smoothedLevel) * approach(recording ? 9 : 3, delta);

      // ── Notebook ────────────────────────────────────────────────────────
      notebookGroup.position.x = home.x;
      notebookGroup.position.z = home.z;
      if (reducedMotion) {
        notebookGroup.position.y = home.y;
        notebookGroup.rotation.set(0, -0.25, 0);
      } else {
        notebookGroup.position.y = home.y + Math.sin(elapsed * 0.5) * 0.15;
        notebookGroup.rotation.y = Math.sin(elapsed * 0.3) * 0.1 + elapsed * 0.05;
        notebookGroup.rotation.x = Math.sin(elapsed * 0.2) * 0.02;
      }
      // Louder speech leans the notebook very slightly towards the viewer.
      const swell = 1 + smoothedLevel * 0.05;
      notebookGroup.scale.setScalar(swell);

      // The pages are what actually react: your voice sets the playback rate.
      if (mixer && pageAction) {
        let rate = 0.04; // idle: an almost imperceptible drift
        if (recording) rate = 0.12 + smoothedLevel * 3.2;
        else if (working) rate = 0.9;
        mixer.update(reducedMotion ? 0 : delta * rate);
      }

      // ── Glow ────────────────────────────────────────────────────────────
      if (recording) glowTarget = 0.12 + smoothedLevel * 0.5;
      else if (summarizing) glowTarget = 0.6;
      else if (hasResult) glowTarget = 0.3;
      else glowTarget = 0;
      glowMaterial.opacity += (glowTarget - glowMaterial.opacity) * approach(3, delta);
      glowSphere.scale.setScalar(1 + smoothedLevel * 0.12);

      // ── Pen ─────────────────────────────────────────────────────────────
      notebookGroup.getWorldPosition(notebookWorld);

      if (recording || working) {
        // Trace lines across the page, so it reads as writing rather than
        // hovering. Recording nudges the stroke with the speaker's volume.
        const speed = working ? 1.6 : 0.9;
        const sweep = (elapsed * speed) % 3;
        const line = Math.floor(sweep);
        const across = sweep - line;
        penTarget.set(
          notebookWorld.x - 0.55 + across * 1.1,
          notebookWorld.y + 0.28 - line * 0.22 + (recording ? smoothedLevel * 0.05 : 0),
          // In front of everything the book sweeps (1.06 covers the slight
          // swell on loud speech), so the pen overlaps the page on screen
          // without ever intersecting it in depth.
          notebookWorld.z + notebookSweep * 1.06 + penLength * 0.35,
        );
      } else if (pointerSeen) {
        raycaster.setFromCamera(pointer, camera);
        if (raycaster.ray.intersectPlane(pointerPlane, pointerWorld)) penTarget.copy(pointerWorld);
      } else {
        penTarget.set(notebookWorld.x + 0.9, notebookWorld.y + 0.2, notebookWorld.z + 1.2);
      }

      previousPen.copy(penPosition);
      penPosition.lerp(penTarget, approach(working ? 8 : 4, delta));
      penGroup.position.copy(penPosition);

      // Idle, the pen aims at the notebook, which is the original charm of the
      // scene. Writing, aiming at the notebook's centre would stand it almost
      // perpendicular to the page and foreshorten it to a dot, so it aims just
      // into the page instead and leans naturally.
      if (recording || working) aimPoint.copy(penPosition).add(WRITING_AIM);
      else aimPoint.copy(notebookWorld);

      lookTarget.lerp(aimPoint, approach(recording || working ? 6 : 3, delta));
      penGroup.lookAt(lookTarget);

      // Velocity-based tilt, converted to a per-second rate.
      const velocityX = (penPosition.x - previousPen.x) / Math.max(delta, 0.001);
      const velocityY = (penPosition.y - previousPen.y) / Math.max(delta, 0.001);
      tilt.z += (-velocityX * 0.35 - tilt.z) * approach(6, delta);
      tilt.x += (velocityY * 0.35 - tilt.x) * approach(6, delta);
      tilt.z = THREE.MathUtils.clamp(tilt.z, -MAX_TILT, MAX_TILT);
      tilt.x = THREE.MathUtils.clamp(tilt.x, -MAX_TILT, MAX_TILT);
      penGroup.rotation.x += tilt.x;
      penGroup.rotation.z += tilt.z;

      // ── Particles ───────────────────────────────────────────────────────
      if (!reducedMotion) {
        const positions = particleGeometry.attributes.position.array;
        const lift = 0.3 + smoothedLevel * 0.55;
        for (let i = 0; i < particleCount; i += 1) {
          const seed = i * 3;
          const speed = particleSpeeds[i];
          const phase = particleSeeds[seed + 2];
          positions[seed] = particleSeeds[seed] + Math.cos(elapsed * speed * 0.5 + phase) * 0.15;
          positions[seed + 1] = particleSeeds[seed + 1] + Math.sin(elapsed * speed + phase) * lift;
        }
        particleGeometry.attributes.position.needsUpdate = true;
      }
      particleMaterial.opacity = 0.35 + smoothedLevel * 0.45;
      particleMaterial.size = 0.05 + smoothedLevel * 0.03;

      // ── Airplane ────────────────────────────────────────────────────────
      if (hasResult && !wasShowingResult && !reducedMotion) {
        airplaneActive = true;
        airplaneProgress = 0;
        airplaneGroup.visible = true;
      }
      wasShowingResult = hasResult;

      if (airplaneActive) {
        airplaneProgress += delta / 2.2; // a fixed 2.2s crossing at any refresh rate
        if (airplaneProgress >= 1) {
          airplaneActive = false;
          airplaneGroup.visible = false;
        } else {
          const p = airplaneProgress;
          airplaneGroup.position.set(-4 + p * 10, Math.sin(p * Math.PI) * 1.5, 3);
          airplaneGroup.rotation.set(-0.2, p * Math.PI * 0.3, -0.1);
        }
      }

      renderer.render(scene, camera);
    };

    // ── Render loop, only while it is worth running ───────────────────────
    const shouldRun = () => activeRef.current && !document.hidden;

    const tick = () => {
      frameId = requestAnimationFrame(tick);
      if (!shouldRun()) return;
      renderFrame();
    };

    const startLoop = () => {
      if (frameId === null) {
        clock.getDelta(); // discard the gap accumulated while paused
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
      // Ignore the small height-only changes the address bar produces; a real
      // rotation or window resize still gets through.
      if (width === lastWidth && Math.abs(height - lastHeight) < 120) return;
      lastWidth = width;
      lastHeight = height;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      layout();
    };

    const handleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyResize, 150);
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);

    const handleMotionPreference = (event) => {
      reducedMotion = event.matches;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, reducedMotion ? 1 : 1.5));
    };
    reducedMotionQuery.addEventListener?.('change', handleMotionPreference);

    const handleContextLost = (event) => {
      event.preventDefault();
      stopLoop();
    };
    const handleContextRestored = () => startLoop();
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);

    return () => {
      disposed = true;
      stopLoop();
      document.removeEventListener('visibilitychange', handleVisibility);
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
      if (!coarsePointer) window.removeEventListener('pointermove', handlePointerMove);
      reducedMotionQuery.removeEventListener?.('change', handleMotionPreference);
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);

      mixer?.stopAllAction();
      scene.traverse((object) => {
        object.geometry?.dispose();
        const material = object.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
      renderer.dispose();
    };
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
