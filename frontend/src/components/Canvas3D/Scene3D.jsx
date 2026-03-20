import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';

export const Scene3D = ({ isRecording, isSummarizing, showResult, airplaneFlying }) => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const stateRef = useRef({ isRecording: false, isSummarizing: false, showResult: false });

  useEffect(() => {
    stateRef.current = { isRecording, isSummarizing, showResult };
  }, [isRecording, isSummarizing, showResult]);

  // Boost z-index when airplane is flying so it appears above all UI
  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.style.zIndex = airplaneFlying ? '50' : '0';
  }, [airplaneFlying]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 1.5, 5);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));

    const spotLight = new THREE.SpotLight(0xa78bfa, 2, 20, Math.PI / 4, 0.8);
    spotLight.position.set(-3, 4, 2);
    spotLight.castShadow = true;
    scene.add(spotLight);

    const pointLight = new THREE.PointLight(0xffffff, 1.0, 10);
    pointLight.position.set(0, 1, 2);
    scene.add(pointLight);

    const fillLight = new THREE.PointLight(0xf59e0b, 0.4, 8);
    fillLight.position.set(0, -2, 1);
    scene.add(fillLight);

    const notebookGroup = new THREE.Group();
    const penGroup      = new THREE.Group();
    const airplaneGroup = new THREE.Group();

    notebookGroup.position.set(-0.5, 0, 0);
    airplaneGroup.visible = false;

    scene.add(notebookGroup);
    scene.add(penGroup);
    scene.add(airplaneGroup);

    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0,
      side: THREE.BackSide,
    });
    const glowSphere = new THREE.Mesh(new THREE.SphereGeometry(1.8, 32, 32), glowMat);
    glowSphere.position.set(0, 0.3, 0);
    notebookGroup.add(glowSphere);

    const loader = new GLTFLoader();

    const loadModel = (path, onLoaded) => {
      loader.load(
        path,
        (gltf) => {
          const model = gltf.scene;
          model.traverse((child) => {
            if (child.isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          onLoaded(model);
        },
        undefined,
        (err) => console.error(`Failed to load ${path}:`, err)
      );
    };

    const normalizeModel = (model, targetSize) => {
      const box    = new THREE.Box3().setFromObject(model);
      const size   = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale  = targetSize / Math.max(size.x, size.y, size.z);
      model.scale.setScalar(scale);
      model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
    };

    loadModel('/models/notebook.glb', (model) => {
      normalizeModel(model, 2.2);
      notebookGroup.children
        .filter((c) => c !== glowSphere)
        .forEach((c) => notebookGroup.remove(c));
      notebookGroup.add(model);
    });

    const innerPen = new THREE.Group();
    penGroup.add(innerPen);

    loadModel('/models/pen.glb', (model) => {
      normalizeModel(model, 0.6);
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const halfLen = (box.max.z - box.min.z) / 2;
      model.position.z += halfLen;
      innerPen.children.forEach((c) => innerPen.remove(c));
      innerPen.add(model);
    });

    loadModel('/models/paper_airplane.glb', (model) => {
      normalizeModel(model, 0.8);
      airplaneGroup.children.forEach((c) => airplaneGroup.remove(c));
      airplaneGroup.add(model);
    });

    const particleGeo  = new THREE.SphereGeometry(0.02, 8, 8);
    const particleMat  = new THREE.MeshBasicMaterial({ color: 0x7c3aed, transparent: true, opacity: 0.5 });
    const particleData = [];

    for (let i = 0; i < 50; i++) {
      const mesh = new THREE.Mesh(particleGeo, particleMat);
      const px = (Math.random() - 0.5) * 10;
      const py = (Math.random() - 0.5) * 8;
      const pz = (Math.random() - 0.5) * 6;
      mesh.position.set(px, py, pz);
      scene.add(mesh);
      particleData.push({
        mesh,
        baseX: px,
        baseY: py,
        speed:  Math.random() * 0.5 + 0.2,
        offset: Math.random() * Math.PI * 2,
      });
    }

    const mouse     = new THREE.Vector2(0, 0);
    const raycaster = new THREE.Raycaster();
    const plane     = new THREE.Plane(new THREE.Vector3(0, 0, 1), -1.5);
    const worldPos  = new THREE.Vector3();

    const handleMouseMove = (e) => {
      mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    };
    window.addEventListener('mousemove', handleMouseMove);

    const penPos           = new THREE.Vector3(0, 0, 1.5);
    const penTargetPos     = new THREE.Vector3(0, 0, 1.5);
    const prevPenPos       = new THREE.Vector3(0, 0, 1.5);
    const smoothLookAt     = new THREE.Vector3(-0.5, 0, 0);
    const notebookWorldPos = new THREE.Vector3();
    const tilt             = { x: 0, z: 0 };
    const maxTilt          = 0.15;

    let airplaneProgress = 0;
    let airplaneActive   = false;
    let prevShowResult   = false;

    const startTime = Date.now();
    const getT = () => (Date.now() - startTime) / 1000;

    let animId;

    const animate = () => {
      animId = requestAnimationFrame(animate);

      const t = getT();
      const { isRecording, isSummarizing, showResult } = stateRef.current;

      notebookGroup.position.y = Math.sin(t * 0.5) * 0.15;
      notebookGroup.rotation.y = Math.sin(t * 0.3) * 0.1 + t * 0.05;
      notebookGroup.rotation.x = Math.sin(t * 0.2) * 0.02;

      const targetOpacity = isSummarizing ? 0.6 : showResult ? 0.3 : 0;
      glowMat.opacity += (targetOpacity - glowMat.opacity) * 0.05;

      raycaster.setFromCamera(mouse, camera);
      if (raycaster.ray.intersectPlane(plane, worldPos)) {
        penTargetPos.copy(worldPos);
      }

      if (isRecording) {
        penTargetPos.x += Math.sin(t * 6) * 0.06;
        penTargetPos.y += Math.cos(t * 4) * 0.03;
      }

      prevPenPos.copy(penPos);
      penPos.lerp(penTargetPos, 0.06);
      penGroup.position.copy(penPos);

      const vx = penPos.x - prevPenPos.x;
      const vy = penPos.y - prevPenPos.y;

      notebookGroup.getWorldPosition(notebookWorldPos);
      smoothLookAt.lerp(notebookWorldPos, 0.05);
      penGroup.lookAt(smoothLookAt);

      tilt.z += (-vx * 20 - tilt.z) * 0.1;
      tilt.x += ( vy * 20 - tilt.x) * 0.1;
      tilt.z = Math.max(-maxTilt, Math.min(maxTilt, tilt.z));
      tilt.x = Math.max(-maxTilt, Math.min(maxTilt, tilt.x));

      penGroup.rotation.x += tilt.x;
      penGroup.rotation.z += tilt.z;

      for (const p of particleData) {
        p.mesh.position.y = p.baseY + Math.sin(t * p.speed + p.offset) * 0.3;
        p.mesh.position.x = p.baseX + Math.cos(t * p.speed * 0.5 + p.offset) * 0.15;
      }

      if (showResult && !prevShowResult) {
        airplaneActive   = true;
        airplaneProgress = 0;
        airplaneGroup.visible = true;
      }
      prevShowResult = showResult;

      if (airplaneActive) {
        airplaneProgress += 0.008;
        if (airplaneProgress >= 1) {
          airplaneActive = false;
          airplaneGroup.visible = false;
        } else {
          const p = airplaneProgress;
          // Fly across the full screen in the foreground (z=3, close to camera)
          airplaneGroup.position.set(-4 + p * 10, Math.sin(p * Math.PI) * 1.5, 3);
          airplaneGroup.rotation.set(-0.2, p * Math.PI * 0.3, -0.1);
        }
      }

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="canvas-container"
      data-testid="3d-scene"
      style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
};