/**
 * The scene behind the app: one rigged notebook-and-pen model whose motion is
 * baked in Blender (frontend/models-src/build_desk.py), plus particles.
 *
 * Nothing here steers the pen. The model carries one animation timeline, cut
 * into clips by the frame ranges it ships with, and this module only decides
 * which clip plays:
 *
 *   idle  -> to_book -> write (loops) -> to_rest -> idle
 *   fly   on its own, when a set of notes is ready
 *
 * The ink is the one thing worked out here, and even that comes from the
 * model: each ink vertex holds the time the nib passes it, and the material
 * hides whatever the write clip has not reached yet.
 *
 * Plain JS rather than React, so a test page can drive it frame by frame.
 * Every rate is per second, never per frame; the caller decides when to render.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const PARTICLES_DESKTOP = 90;
const PARTICLES_MOBILE = 28;
const CONTENT_MAX_PX = 768; // the app's max-w-3xl column
const HOME_Z = -0.4;

// The model lies flat; tilting it towards the camera turns it into a book on
// a lectern, which shows the page and gives the pen room to move.
const TILT = 0.92;

/** Frame-rate independent easing: the fraction to move this frame. */
const approach = (rate, delta) => 1 - Math.exp(-rate * delta);

/** Hide each ink fragment until the clip reaches the moment it is written. */
function revealInk(mesh, uniform) {
  const geometry = mesh.geometry;
  // The build stores it as the U of the ink's only UV channel.
  const reveal = geometry.getAttribute('uv1') || geometry.getAttribute('uv');
  if (!reveal) return;
  geometry.setAttribute('inkReveal', reveal);
  const material = mesh.material.clone();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uInkTime = uniform;
    shader.vertexShader = `attribute vec2 inkReveal;\nvarying float vReveal;\n${shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vReveal = inkReveal.x;',
    )}`;
    shader.fragmentShader = `uniform float uInkTime;\nvarying float vReveal;\n${shader.fragmentShader.replace(
      'void main() {',
      'void main() {\n  if (vReveal > uInkTime) discard;',
    )}`;
  };
  material.customProgramCacheKey = () => 'lumina-ink';
  mesh.material = material;
}

export function createDeskScene(canvas, options = {}) {
  const {
    url = '/models/desk.glb',
    smallScreen = window.innerWidth < 768,
    onFlight = () => {},
    onReady = () => {},
  } = options;
  let reducedMotion = !!options.reducedMotion;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: window.devicePixelRatio < 2,
    alpha: true,
    powerPreference: 'low-power',
    preserveDrawingBuffer: !!options.preserveDrawingBuffer,
  });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 1.5, 5);

  // A soft studio environment for reflections: lacquer and gold read as
  // flat plastic without something to reflect.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;
  scene.environmentIntensity = 0.55;

  // Sky white, ground violet: fills whatever faces away from the key light,
  // which is most of the paper plane once it is folded.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x7c3aed, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 4, 4);
  scene.add(key);
  // Violet from behind and above: it outlines the dark pen against a dark page.
  const rim = new THREE.SpotLight(0xa78bfa, 26, 14, Math.PI / 5, 0.8);
  rim.position.set(-2, 3.5, -3);
  scene.add(rim);
  const warm = new THREE.PointLight(0xf59e0b, 2.5, 8);
  warm.position.set(1, -1.5, 2);
  scene.add(warm);

  // desk: the layout position and drift. presenter: the lectern tilt.
  const desk = new THREE.Group();
  const presenter = new THREE.Group();
  presenter.rotation.x = TILT;
  desk.add(presenter);
  desk.rotation.order = 'YXZ';
  scene.add(desk);
  rim.target = desk;

  // A soft halo behind the book while it works. A back-faced sphere used to do
  // this, and read as a flat brown disc rather than light.
  const halo = document.createElement('canvas');
  halo.width = halo.height = 128;
  const paint = halo.getContext('2d');
  const gradient = paint.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(245,158,11,0.9)');
  gradient.addColorStop(0.35, 'rgba(245,158,11,0.35)');
  gradient.addColorStop(1, 'rgba(245,158,11,0)');
  paint.fillStyle = gradient;
  paint.fillRect(0, 0, 128, 128);
  const glowTexture = new THREE.CanvasTexture(halo);
  const glowMaterial = new THREE.SpriteMaterial({
    map: glowTexture,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow = new THREE.Sprite(glowMaterial);
  glow.scale.setScalar(4.2);
  glow.position.set(0.1, 0, -0.6);
  glow.renderOrder = -1;
  desk.add(glow);

  // ── Particles ─────────────────────────────────────────────────────────
  const particleCount = smallScreen ? PARTICLES_MOBILE : PARTICLES_DESKTOP;
  const particlePositions = new Float32Array(particleCount * 3);
  const particleSeeds = new Float32Array(particleCount * 3);
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
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  scene.add(new THREE.Points(particleGeometry, particleMaterial));

  // ── Layout ────────────────────────────────────────────────────────────
  // Wide screens put the book in the margin beside the content column, sized
  // to fit it; narrow ones put it behind the text, held back.
  const home = new THREE.Vector3();
  let homeScale = 1;
  let behindContent = false;
  const layout = (width, height) => {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    const halfH = (camera.position.z - HOME_Z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const halfW = halfH * camera.aspect;
    const contentHalf = (Math.min(width, CONTENT_MAX_PX) / width) * halfW;
    const margin = halfW - contentHalf;
    behindContent = margin < 1.25;
    if (behindContent) {
      homeScale = 0.75;
      home.set(0, 0.9, HOME_Z);
    } else {
      homeScale = THREE.MathUtils.clamp(margin / 3.3, 0.4, 0.9);
      home.set(contentHalf + margin * 0.45, 1.25, HOME_Z);
    }
    applyOpacity();
  };

  const applyOpacity = () => {
    if (!model) return;
    model.traverse((object) => {
      if (!object.isMesh) return;
      object.material.transparent = behindContent;
      object.material.opacity = behindContent ? 0.5 : 1;
    });
  };

  // ── Model and clips ───────────────────────────────────────────────────
  let model = null;
  let mixer = null;
  let actions = null;
  let meta = null;
  let planeRoot = null;
  const inkTime = { value: 0 };
  const planeInkTime = { value: 0 };
  let disposed = false;

  const state = { recording: false, working: false, level: 0 };
  let mode = 'idle';
  let current = null;
  let turnFirst = false; // turning away ink left over from the last session
  let frozenInk = 0;
  let lastWriteTime = 0;

  const play = (action, fade) => {
    if (!action) return;
    action.reset();
    action.enabled = true;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    action.play();
    if (current && current !== action) current.crossFadeTo(action, fade, false);
    current = action;
  };

  const startWriting = () => {
    mode = 'writing';
    const write = actions.write;
    // Ink still on the page from last time: turn that page over first rather
    // than wiping it, then the loop carries on onto a fresh one.
    turnFirst = inkTime.value > 0.05;
    frozenInk = inkTime.value;
    play(write, turnFirst ? 0.35 : 0.08);
    if (turnFirst) write.time = meta.write.writing_end;
    lastWriteTime = write.time;
  };

  const startRest = () => {
    mode = 'toRest';
    play(actions.toRest, 0.45);
  };

  const onFinished = (event) => {
    if (!actions) return;
    if (event.action === actions.toBook && mode === 'toBook') startWriting();
    else if (event.action === actions.toRest && mode === 'toRest') {
      mode = 'idle';
      play(actions.idle, 0.3);
    } else if (event.action === actions.fly) {
      planeRoot.visible = false;
      onFlight(false);
    }
  };

  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  loader.load(
    url,
    (gltf) => {
      if (disposed) return;
      model = gltf.scene;
      const rig = model.getObjectByName('LuminaDesk') || model;
      const raw = rig.userData.lumina || model.userData.lumina;
      meta = typeof raw === 'string' ? JSON.parse(raw) : raw;
      presenter.add(model);

      planeRoot = model.getObjectByName('AirplaneRoot');
      if (planeRoot) planeRoot.visible = false;
      const inPlane = (object) => {
        for (let o = object; o; o = o.parent) if (o === planeRoot) return true;
        return false;
      };

      // Found by material and place rather than node name: the optimiser
      // that packs the model is free to rename and regroup mesh nodes.
      model.traverse((object) => {
        if (!object.isMesh) return;
        // Skinned and morphing parts move far from their bind-pose bounds.
        if (object.isSkinnedMesh || object.morphTargetInfluences) object.frustumCulled = false;
        if (object.material?.name === 'Ink') revealInk(object, inPlane(object) ? planeInkTime : inkTime);
      });

      mixer = new THREE.AnimationMixer(model);
      mixer.addEventListener('finished', onFinished);
      const source = gltf.animations[0];
      // A track belongs to the plane if whatever it animates sits under it.
      const isPlane = (track) => {
        const { nodeName } = THREE.PropertyBinding.parseTrackName(track.name);
        const target = THREE.PropertyBinding.findNode(model, nodeName);
        return !!target && inPlane(target);
      };
      const clip = (name, loop, keep) => {
        const [start, end] = meta.ranges[name];
        // A loop's last frame is its first again; a one-shot keeps its last.
        const cut = THREE.AnimationUtils.subclip(source, name, start, loop ? end : end + 1, meta.fps);
        cut.tracks = cut.tracks.filter(keep);
        const action = mixer.clipAction(cut);
        action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        action.clampWhenFinished = !loop;
        return action;
      };
      const book = (track) => !isPlane(track);
      actions = {
        idle: clip('idle', true, book),
        toBook: clip('to_book', false, book),
        write: clip('write', true, book),
        toRest: clip('to_rest', false, book),
        fly: clip('fly', false, isPlane),
      };
      play(actions.idle, 0);
      mixer.update(0);
      applyOpacity();
      onReady();
    },
    undefined,
    (err) => {
      // eslint-disable-next-line no-console
      console.warn('deskScene: could not load the model', err);
    },
  );

  // ── Per frame ─────────────────────────────────────────────────────────
  const pointer = new THREE.Vector2();
  let elapsed = 0;
  let smoothedLevel = 0;
  let focus = 0;

  const updateClips = (delta) => {
    const want = state.recording || state.working;
    if (mode === 'idle' && want) {
      mode = 'toBook';
      play(actions.toBook, 0.25);
    } else if (mode === 'toBook' && !want) {
      startRest();
    } else if (mode === 'toRest' && want) {
      mode = 'toBook';
      play(actions.toBook, 0.3);
    } else if (mode === 'writing') {
      const write = actions.write;
      const t = write.time;
      const wrapped = t < lastWriteTime - 1e-3;
      lastWriteTime = t;
      if (wrapped) turnFirst = false;
      // Speech sets the pace while recording; the work itself is brisker.
      const pace = state.recording ? THREE.MathUtils.clamp(0.6 + smoothedLevel * 1.4, 0.55, 1.5) : 1.2;
      write.setEffectiveTimeScale(pace);
      if (!want) {
        // Mid-turn, let the page land and the pen come back before resting.
        const turning = t >= meta.write.writing_end && !wrapped;
        if (!turning) startRest();
        if (wrapped) inkTime.value = 0;
      }
    }

    if (mode === 'writing') inkTime.value = turnFirst ? frozenInk : actions.write.time;
    mixer.update(reducedMotion ? 0 : delta);
  };

  const frame = (rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    elapsed += delta;
    const rawLevel = state.recording ? state.level : 0;
    smoothedLevel += (rawLevel - smoothedLevel) * approach(state.recording ? 9 : 3, delta);
    focus += ((state.recording || state.working ? 1 : 0) - focus) * approach(2.2, delta);

    // Drift while idle, settle while writing - a turning book is hard to write on.
    const calm = 1 - focus * 0.85;
    const still = reducedMotion ? 0 : 1;
    desk.position.set(home.x, home.y + Math.sin(elapsed * 0.5) * 0.08 * calm * still, home.z);
    desk.rotation.y = (Math.sin(elapsed * 0.3) * 0.12 - 0.28 - pointer.x * 0.1) * calm * still - 0.12 * focus;
    desk.rotation.x = (Math.sin(elapsed * 0.2) * 0.03 + pointer.y * 0.05) * calm * still;
    desk.scale.setScalar(homeScale * (1 + smoothedLevel * 0.03));

    if (mixer && actions) updateClips(delta);

    const glowTarget = state.recording ? 0.12 + smoothedLevel * 0.3 : state.working ? 0.3 : 0;
    glowMaterial.opacity += (glowTarget - glowMaterial.opacity) * approach(3, delta);

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

    renderer.render(scene, camera);
  };

  return {
    frame,
    layout,
    setState(next) {
      Object.assign(state, next);
    },
    setPointer(x, y) {
      pointer.set(x, y);
    },
    setReducedMotion(value) {
      reducedMotion = value;
    },
    setPixelRatio(ratio) {
      renderer.setPixelRatio(ratio);
    },
    /** The finished notes fold into a plane and fly off. */
    launchAirplane() {
      if (!actions || !planeRoot || reducedMotion) return;
      // The written page becomes the plane: its ink moves to the paper that
      // folds, and the page under it is left blank.
      planeInkTime.value = inkTime.value;
      inkTime.value = 0;
      if (mode === 'writing') frozenInk = 0;
      planeRoot.visible = true;
      const fly = actions.fly;
      fly.reset();
      fly.play();
      onFlight(true);
    },
    /** For tests: hold `clip` at `seconds`, with the ink at the same moment. */
    seek(clip, seconds, ink = seconds) {
      if (!actions) return;
      mixer.stopAllAction();
      const action = actions[clip.replace(/_(\w)/g, (_, c) => c.toUpperCase())];
      action.reset();
      action.play();
      action.time = seconds;
      action.paused = true;
      if (clip === 'fly') {
        actions.idle.reset().play();
        planeRoot.visible = true;
        planeInkTime.value = ink;
        inkTime.value = 0;
      } else {
        planeRoot.visible = false;
        inkTime.value = clip === 'write' ? ink : 0;
      }
      mixer.update(0);
    },
    /** For tests: what the clip state machine is doing. */
    get debug() {
      return {
        mode,
        ink: inkTime.value,
        planeInk: planeInkTime.value,
        writeTime: actions?.write.time ?? 0,
        turnFirst,
        flying: !!planeRoot?.visible,
      };
    },
    get camera() {
      return camera;
    },
    get ready() {
      return !!actions;
    },
    dispose() {
      disposed = true;
      mixer?.stopAllAction();
      scene.traverse((object) => {
        object.geometry?.dispose();
        const material = object.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
      glowTexture.dispose();
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
