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
 * The pose the notebook settles into while you are recording or a transcript is
 * being made: squared up to the camera so the pen has a page to write on.
 * Add Math.PI to FOCUS_YAW if the book ever settles spine-first.
 */
const FOCUS_YAW = 0;
const FOCUS_PITCH = -0.13;

/** How far the pen leans off the page normal, so it reads as held, not stabbed. */
const WRITING_LEAN = new THREE.Vector3(0.12, -0.55, 0);

/** Shortest-path angle blend, so easing out of a drifting spin does not unwind. */
const lerpAngle = (from, to, t) => {
  const TAU = Math.PI * 2;
  const delta = (((to - from + Math.PI) % TAU) + TAU) % TAU - Math.PI;
  return from + delta * t;
};

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
    // Half-extents of the book in its own space. fit() centres the model on the
    // group origin, so the faces sit at +/- these values.
    const bookHalf = new THREE.Vector3(1.1, 0.62, 0.66);

    const AXIS_VECTORS = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
    ];

    const measureBook = (model) => {
      notebookGroup.updateMatrixWorld(true);
      const toLocal = new THREE.Matrix4().copy(notebookGroup.matrixWorld).invert();
      const box = new THREE.Box3().setFromObject(model).applyMatrix4(toLocal);
      box.getSize(bookHalf);
      bookHalf.multiplyScalar(0.5);
    };

    /** Length of the pen along its barrel, measured once the model has loaded. */
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
      measureBook(model);

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
    let focus = 0;
    const aimPoint = new THREE.Vector3();
    const writeLocal = new THREE.Vector3();
    const pageNormal = new THREE.Vector3(0, 0, 1);
    const faceNormal = new THREE.Vector3();
    const toCamera = new THREE.Vector3();
    let pageSide = 1;
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
      // Writing on a book that is slowly turning cannot look right, so while
      // there is something to write the notebook squares up to the camera and
      // all but stops. It drifts again once the work is done.
      focus += ((recording || working ? 1 : 0) - focus) * approach(2.2, delta);

      notebookGroup.position.x = home.x;
      notebookGroup.position.z = home.z;
      if (reducedMotion) {
        notebookGroup.position.y = home.y;
        notebookGroup.rotation.set(FOCUS_PITCH, FOCUS_YAW, 0);
      } else {
        const idleYaw = Math.sin(elapsed * 0.3) * 0.1 + elapsed * 0.05;
        const idlePitch = Math.sin(elapsed * 0.2) * 0.02;
        notebookGroup.position.y =
          home.y + Math.sin(elapsed * 0.5) * 0.15 * (1 - focus * 0.8);
        notebookGroup.rotation.y = lerpAngle(idleYaw, FOCUS_YAW, focus);
        notebookGroup.rotation.x = THREE.MathUtils.lerp(idlePitch, FOCUS_PITCH, focus);
        notebookGroup.rotation.z = 0;
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
      // The transform above has not been flushed yet and localToWorld reads
      // matrixWorld, so without this the nib trails a frame behind the page.
      notebookGroup.updateMatrixWorld(true);
      notebookGroup.getWorldPosition(notebookWorld);

      if (recording || working) {
        // The stroke is laid out in the notebook's own space and then converted
        // to world, so the nib sits ON the page and travels with the book
        // instead of floating at a fixed distance in front of it.
        const speed = working ? 1.6 : 0.9;
        const sweep = (elapsed * speed) % 3;
        const line = Math.floor(sweep);
        const across = sweep - line;
        // Which face is the camera looking at? Asking every frame means this
        // is right whatever pose the book is in and however the asset was
        // authored - no assumption about which way "front" happens to be.
        // The book is settled while writing, so the choice does not flicker.
        toCamera.copy(camera.position).sub(notebookWorld);
        let facing = 2;
        let facingDot = 0; // starting at -Infinity would never be beaten
        for (let axis = 0; axis < 3; axis += 1) {
          const dot = faceNormal
            .copy(AXIS_VECTORS[axis])
            .transformDirection(notebookGroup.matrixWorld)
            .dot(toCamera);
          if (Math.abs(dot) > Math.abs(facingDot)) {
            facing = axis;
            facingDot = dot;
          }
        }
        pageSide = facingDot >= 0 ? 1 : -1;

        // The two axes left over span the face; the longer one is written along.
        const otherA = (facing + 1) % 3;
        const otherB = (facing + 2) % 3;
        const acrossAxis =
          bookHalf.getComponent(otherA) >= bookHalf.getComponent(otherB) ? otherA : otherB;
        const downAxis = acrossAxis === otherA ? otherB : otherA;

        pageNormal
          .copy(AXIS_VECTORS[facing])
          .transformDirection(notebookGroup.matrixWorld)
          .multiplyScalar(pageSide);

        writeLocal
          .set(0, 0, 0)
          .addScaledVector(AXIS_VECTORS[acrossAxis], (across - 0.5) * bookHalf.getComponent(acrossAxis) * 1.25)
          .addScaledVector(AXIS_VECTORS[downAxis], (0.34 - line * 0.28) * bookHalf.getComponent(downAxis))
          .addScaledVector(
            AXIS_VECTORS[facing],
            pageSide * (bookHalf.getComponent(facing) + penLength * 0.05 + (recording ? smoothedLevel * 0.02 : 0)),
          );
        penTarget.copy(writeLocal);
        notebookGroup.localToWorld(penTarget);
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
      // scene. Writing, it aims into the page along that page's own normal plus
      // a lean, so the nib meets the paper at a natural angle however the book
      // happens to be turned.
      if (recording || working) {
        // Straight into the paper along its own normal, plus a lean so the
        // barrel is not stood on end and foreshortened away.
        aimPoint.copy(penPosition).addScaledVector(pageNormal, -0.7).add(WRITING_LEAN);
      } else {
        aimPoint.copy(notebookWorld);
      }

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
