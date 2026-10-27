import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { Ingredient } from '../types/ar';
import { getIngredientById } from '../data/ingredients';
import { SerumScene, applyNearClippingPlaneToXRCamera } from '../ar/scene/SerumScene';
import { takePreloadedSerumModel, LoadedSerumModel } from '../ar/models/SerumModelLoader';
import { ProductStoryTimeline, StoryPhase } from '../ar/animation/ProductStoryTimeline';
import { ImageTrackingController } from '../ar/tracking/ImageTrackingController';
import { EightWallManager } from '../ar/engine/EightWallManager';
import { SurfacePlacementController } from '../ar/tracking/SurfacePlacementController';
import { beginARTraceSession, traceAR } from '../ar/xr/camera-fix';
import { DEBUG_AR_PERF, worldTrackingDebugger } from '../ar/debug/WorldTrackingDebugger';
import { arPerformanceMonitor } from '../ar/debug/ARPerformanceMonitor';
import type { ARCaptureEngine } from '../types/capture';

export interface UseAREngineReturn {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  activeIngredient: Ingredient | null;
  isSimulation: boolean;
  selectedIngredientId: string | null;
  is360Active: boolean;
  storyPhase: StoryPhase;
  showSimPoster: boolean;
  toggleSimPoster: () => void;
  showWaterSpiral: boolean;
  toggleWaterSpiral: () => void;
  openIngredientModal: (ing: Ingredient) => void;
  closeIngredientModal: () => void;
  replaySequence: () => void;
  toggleSimulation: () => void;
  startExperience: () => void;
  hasTargetFound: boolean;
  isCameraLocked: boolean;
  canPlaceOnSurface: boolean;
  placeOnSurface: () => void;
  relockToCamera: () => void;
  worldTrackingStatus: 'NORMAL' | 'LIMITED' | 'SIMULATION';
  surfaceGuidance: string;
  isExperienceReady: boolean;
  isCaptureReady: boolean;
  captureEngine: ARCaptureEngine | null;
  startupError: string | null;
  startupStage: string;
}

function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;

  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (nav.userAgentData?.mobile) return true;

  const userAgent = navigator.userAgent;
  const isPhoneOrTablet = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
  const isIPadInDesktopMode = /Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1;
  return isPhoneOrTablet || isIPadInDesktopMode;
}

export function useAREngine(): UseAREngineReturn {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [activeIngredient, setActiveIngredient] = useState<Ingredient | null>(null);
  const [selectedIngredientId, setSelectedIngredientId] = useState<string | null>(null);
  const [is360Active, setIs360Active] = useState(false);
  const [storyPhase, setStoryPhase] = useState<StoryPhase>('PHASE_1_REVEAL');
  const is360ActiveRef = useRef(false);
  const storyPhaseRef = useRef<StoryPhase>('PHASE_1_REVEAL');

  const [isSimulation, setIsSimulation] = useState(() => {
    if (typeof window !== 'undefined') {
      const p = new URLSearchParams(window.location.search);
      if (p.get('sim') === '1' || p.get('mode') === 'sim') return true;
    }
    return !isMobileDevice();
  });
  const [showSimPoster, setShowSimPoster] = useState(false);
  const [showWaterSpiral, setShowWaterSpiral] = useState(true);
  const [isExperienceReady, setIsExperienceReady] = useState(false);
  const [isCameraVideoReady, setIsCameraVideoReady] = useState(false);
  const [captureEngine, setCaptureEngine] = useState<ARCaptureEngine | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupStage, setStartupStage] = useState('Loading the 3D model…');

  const toggleWaterSpiral = useCallback(() => {
    setShowWaterSpiral((prev) => {
      const next = !prev;
      if (modelRef.current?.waterGroup) {
        modelRef.current.waterGroup.visible = next;
      }
      return next;
    });
  }, []);

  const [hasTargetFound, setHasTargetFound] = useState(isSimulation);
  const [canPlaceOnSurface, setCanPlaceOnSurface] = useState(false);
  const [isCameraLocked, setIsCameraLocked] = useState(true);
  const [worldTrackingStatus, setWorldTrackingStatus] = useState<'NORMAL' | 'LIMITED' | 'SIMULATION'>(
    isSimulation ? 'SIMULATION' : 'LIMITED'
  );
  const [surfaceGuidance, setSurfaceGuidance] = useState('Hold the camera steady over the floor');

  // Engine references kept outside React state for 60fps performance
  const sceneRef = useRef<SerumScene | null>(null);
  const modelRef = useRef<LoadedSerumModel | null>(null);
  const timelineRef = useRef<ProductStoryTimeline | null>(null);
  const trackingRef = useRef<ImageTrackingController | null>(null);
  const surfacePlacementRef = useRef<SurfacePlacementController | null>(null);
  const eightWallRef = useRef<EightWallManager | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const clockRef = useRef(new THREE.Clock());
  const animationDiagnosticFramesRef = useRef(0);
  const modelAnimationStartedRef = useRef(false);

  // User drag-to-rotate state (Phase 6: rotates exclusively the serum bottle)
  const isPointerDownRef = useRef(false);
  const lastPointerXRef = useRef(0);
  const userRotVelRef = useRef(0);
  const pointerDownPosRef = useRef({ x: 0, y: 0 });
  const pointerDownTimeRef = useRef(0);
  const hasDraggedRef = useRef(false);
  const dragPointerIdRef = useRef<number | null>(null);
  const activeTouchPointsRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchDistanceRef = useRef<number | null>(null);
  const pinchUsedRef = useRef(false);
  const suppressClickUntilRef = useRef(0);
  const lastModalOpenTimeRef = useRef(0);

  // Simulation mode tabletop poster reference
  const posterMeshRef = useRef<THREE.Mesh | null>(null);

  const startModelAnimation = useCallback(() => {
    const model = modelRef.current;
    if (modelAnimationStartedRef.current) return;
    modelAnimationStartedRef.current = true;
    if (!model?.mixer) return;

    model.mixer.setTime(0);
    for (const action of model.actions ?? []) {
      action.reset();
      action.play();
    }
    // Apply the first animated pose before the newly visible model is rendered.
    model.mixer.update(0);
  }, []);

  const toggleSimPoster = useCallback(() => {
    if (posterMeshRef.current) {
      const next = !posterMeshRef.current.visible;
      posterMeshRef.current.visible = next;
      setShowSimPoster(next);
    }
  }, []);

  const openIngredientModal = useCallback((ing: Ingredient) => {
    setActiveIngredient(ing);
    setSelectedIngredientId(ing.id);
  }, []);

  const closeIngredientModal = useCallback(() => {
    setActiveIngredient(null);
  }, []);

  const placeOnSurface = useCallback(() => {
    if (surfacePlacementRef.current?.placeProduct()) {
      trackingRef.current?.unlockCamera();
      setIsCameraLocked(false);
      setCanPlaceOnSurface(false);
    }
  }, []);

  const relockToCamera = useCallback(() => {
    surfacePlacementRef.current?.relockToCamera();
    trackingRef.current?.relockCamera();
    setIsCameraLocked(true);
  }, []);

  const replaySequence = useCallback(() => {
    if (!modelAnimationStartedRef.current) return;

    if (timelineRef.current) {
      timelineRef.current.reset();
      timelineRef.current.start();
      setIs360Active(false);
      setStoryPhase('PHASE_1_REVEAL');
    }
    if (modelRef.current?.actions && modelRef.current.actions.length > 0) {
      modelRef.current.actions.forEach((act) => {
        act.reset();
        act.play();
      });
    } else if (modelRef.current?.mixer) {
      modelRef.current.mixer.setTime(0);
    }
  }, []);

  const toggleSimulation = useCallback(() => {
    const next = !isSimulation;
    setIsSimulation(next);
    const url = new URL(window.location.href);
    if (next) {
      url.searchParams.set('sim', '1');
    } else {
      url.searchParams.delete('sim');
    }
    window.location.href = url.toString();
  }, [isSimulation]);

  const isStartingRef = useRef(false);
  const hasLoadedModelRef = useRef(false);

  const startExperience = useCallback(async () => {
    if (!canvasRef.current || isStartingRef.current || hasLoadedModelRef.current || modelRef.current) return;
    isStartingRef.current = true;
    setStartupError(null);
    setStartupStage(isSimulation ? 'Loading the 3D preview…' : 'Loading the 3D model…');
    const canvas = canvasRef.current;
    if (!isSimulation) {
      worldTrackingDebugger.start();
      arPerformanceMonitor.start();
      beginARTraceSession();
      traceAR('SERUM_AR_BOOT_START', { simulation: false });
    }

    try {
      // 1. Initialize Scene & Three.js
      if (!sceneRef.current) {
        sceneRef.current = new SerumScene();
      }
      const serumScene = sceneRef.current;

      // 2. Load 3D Model
      if (!isSimulation) traceAR('SERUM_MODEL_LOAD_START', {});
      const loadedModel = await takePreloadedSerumModel();
      modelRef.current = loadedModel;
      animationDiagnosticFramesRef.current = 0;
      hasLoadedModelRef.current = true;
      if (!isSimulation) {
        traceAR('SERUM_MODEL_READY', {
          normalizedModelWidth: loadedModel.normalizedSize.x,
          modelRoot: loadedModel.modelScene.name || loadedModel.modelScene.type,
          animationActionCount: loadedModel.actions?.length ?? 0,
          productParent: sceneRef.current?.productRoot.name || '(unknown)',
        });
      }

      // Explicitly clear any existing children from userRotationGroup to guarantee zero phantom duplicates
      while (serumScene.userRotationGroup.children.length > 0) {
        const child = serumScene.userRotationGroup.children[0];
        serumScene.userRotationGroup.remove(child);
      }
      serumScene.userRotationGroup.add(loadedModel.modelScene);

      // Disable frustum culling on all meshes of the loaded model
      // so it never vanishes when the camera gets close
      loadedModel.modelScene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          child.frustumCulled = false;
        }
      });

      // 3. Initialize the baked GLB timeline; the old procedural hydration FX is unused.
      timelineRef.current = new ProductStoryTimeline(
        serumScene.userRotationGroup,
        loadedModel.bottleGroup,
        loadedModel.flowerGroup
      );

      trackingRef.current = new ImageTrackingController(
        serumScene.rootAnchor,
        serumScene.productRoot,
        serumScene.worldAnchorGroup,
        loadedModel.normalizedSize.x,
        loadedModel.normalizedSize.y,
        loadedModel.modelScene,
        canvas
      );

      // Use XR8's single ground reference for floor placement.
      surfacePlacementRef.current = new SurfacePlacementController(
        serumScene.scene,
        serumScene.camera,
        serumScene.productRoot,
        serumScene.worldAnchorGroup,
        isSimulation,
        loadedModel.normalizedSize.x,
        loadedModel.normalizedSize.y
      );
      surfacePlacementRef.current.onPlacementChanged = (isPlaced, canPlace, guidance) => {
        setIsCameraLocked(!isPlaced);
        setCanPlaceOnSurface(canPlace);
        if (guidance) setSurfaceGuidance(guidance);
      };
      surfacePlacementRef.current.onPlacementSettled = (placedMatrix) => {
        trackingRef.current?.notifyPlacementSettled(placedMatrix);
      };
      surfacePlacementRef.current.onPlacedTransformChanged = (placedMatrix) => {
        trackingRef.current?.notifyPlacedTransformChanged(placedMatrix);
      };

      // 4. Handle Simulation Mode vs Real 8th Wall AR
      if (isSimulation) {
        setupSimulationMode(serumScene, canvas);
      } else {
        setStartupStage('Starting the AR camera…');
        await setupEightWallAR(canvas, serumScene);
      }
    } catch (err: any) {
      if (!isSimulation) traceAR('SERUM_AR_BOOT_FAILED', { error: String(err) }, 'error');
      hasLoadedModelRef.current = false;
      setIsExperienceReady(false);
      setIsCameraVideoReady(false);
      setCaptureEngine(null);
      setStartupError(err instanceof Error ? err.message : String(err));
    } finally {
      isStartingRef.current = false;
    }
  }, [isSimulation]);

  // Setup Simulation Fallback for Desktop testing
  const setupSimulationMode = (
    sceneObj: SerumScene,
    canvas: HTMLCanvasElement
  ) => {
    sceneObj.initSimRenderer(canvas);
    sceneObj.attachToSimScene();
    // Add 3D Tabletop Poster Mesh (flat on table under pedestal, optional toggle)
    const texLoader = new THREE.TextureLoader();
    texLoader.load('assets/image-target/img_target.png', (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      const targetW = 0.80;
      const posterGeo = new THREE.PlaneGeometry(targetW, targetW * (1402 / 1122));
      const posterMat = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.6,
        metalness: 0.05,
      });
      const posterMesh = new THREE.Mesh(posterGeo, posterMat);
      // Flat on tabletop beneath rock pedestal - matches real AR table orientation without clipping
      posterMesh.rotation.x = -Math.PI / 2;
      posterMesh.position.set(0, -0.002, 0);
      posterMesh.receiveShadow = true;
      posterMesh.visible = false; // Default: clean luxury dark studio with contact shadow
      posterMeshRef.current = posterMesh;
      sceneObj.rootAnchor.add(posterMesh);
    });

    sceneObj.rootAnchor.visible = true;
    surfacePlacementRef.current?.attachToSimScene(sceneObj.scene, sceneObj.camera);
    surfacePlacementRef.current?.setTargetFound(true);
    setHasTargetFound(true);
    trackingRef.current?.lockToCameraAtCenter();
    setIsCameraLocked(true);
    startModelAnimation();
    timelineRef.current?.start();

    // Start Simulation Animation Loop
    const loop = () => {
      animFrameRef.current = requestAnimationFrame(loop);
      renderFrame(true);
    };
    loop();
    setIsExperienceReady(true);
  };

  // Setup Real 8th Wall Camera Tracking
  const setupEightWallAR = async (
    canvas: HTMLCanvasElement,
    sceneObj: SerumScene
  ) => {
    const manager = new EightWallManager();
    eightWallRef.current = manager;

    await manager.startAR(canvas, {
      onCameraStarted: ({ scene, camera, renderer, runtimeVersion, captureEngine: xrCaptureEngine }) => {
        sceneObj.attachToXRScene(scene, camera, renderer);
        surfacePlacementRef.current?.attachToXRScene(scene, camera);
        trackingRef.current?.setCamera(camera);
        setCaptureEngine(xrCaptureEngine);
        worldTrackingDebugger.setSceneObjects({
          scene,
          camera,
          renderer: renderer ?? null,
          targetAnchor: sceneObj.rootAnchor,
          worldAnchor: sceneObj.worldAnchorGroup,
          productRoot: sceneObj.productRoot,
          storyGroup: sceneObj.userRotationGroup,
          bottleGroup: modelRef.current?.bottleGroup ?? null,
          modelRoot: modelRef.current?.modelScene ?? null,
        });
        if (renderer) arPerformanceMonitor.attachRenderer(renderer, runtimeVersion);
      },
      onTargetFound: (pose) => {
        const firstTargetFound = trackingRef.current?.handleImageFound(pose, 0) ?? false;
        if (firstTargetFound) {
          startModelAnimation();
          timelineRef.current?.start();
          manager.disableImageTargets();
          surfacePlacementRef.current?.setTargetFound(true);
          setHasTargetFound(true);
        }
      },
      onTargetUpdated: (pose) => {
        const anchoredNow = trackingRef.current?.handleImageUpdated(pose, 0) ?? false;
        if (anchoredNow) {
          manager.disableImageTargets();
          surfacePlacementRef.current?.setTargetFound(true);
          setHasTargetFound(true);
        }
      },
      onTargetLost: () => trackingRef.current?.handleImageLost(),
      onWorldTrackingStatus: (status, reason) => {
        worldTrackingDebugger.recordTrackingStatus(status, reason ?? 'UNDEFINED');
        trackingRef.current?.setWorldTrackingStatus(status, reason);
        surfacePlacementRef.current?.setTrackingStatus(status, reason ?? 'UNDEFINED');
        setWorldTrackingStatus(status);
      },
      onPipelineState: (state) => worldTrackingDebugger.recordPipelineState(state),
      onPipelineEventPhase: (phase) => {
        if (phase === 'START') worldTrackingDebugger.beginPipelineEvent();
        else worldTrackingDebugger.endPipelineEvent();
      },
      onCameraStatus: (payload, video) => {
        worldTrackingDebugger.recordCameraStatus(payload, video);
        if (DEBUG_AR_PERF) arPerformanceMonitor.recordCameraStatus(payload, video);
        const status = String(payload.status ?? '');
        const videoReady = status === 'hasVideo' || Boolean(video && video.readyState >= 2);
        if (videoReady) {
          setIsCameraVideoReady(true);
          setIsExperienceReady(true);
        } else if (status === 'requesting') {
          setIsCameraVideoReady(false);
          setStartupStage('Allow camera access when your browser asks.');
        } else if (status === 'hasStream') {
          setStartupStage('Opening the camera video…');
        } else if (status === 'failed') {
          setIsCameraVideoReady(false);
          setIsExperienceReady(false);
          setStartupError('Camera access failed. Check browser permissions, then try again.');
        }
      },
      onFrameUpdate: (context) => {
        if (DEBUG_AR_PERF) arPerformanceMonitor.beginTrackingUpdate();
        if (worldTrackingDebugger.isEnabled) worldTrackingDebugger.beginFrame(context);
        const sceneUpdateStartedAt = DEBUG_AR_PERF ? performance.now() : 0;
        try {
          renderFrame(false);
        } finally {
          if (DEBUG_AR_PERF) arPerformanceMonitor.endTrackingUpdate(performance.now() - sceneUpdateStartedAt);
          if (worldTrackingDebugger.isEnabled) worldTrackingDebugger.endFrame();
        }
      },
      onError: (message) => {
        setIsExperienceReady(false);
        setIsCameraVideoReady(false);
        setCaptureEngine(null);
        setStartupError(message);
      },
      onProgress: (stage) => setStartupStage(stage),
    });
  };

  // Master Cinematic Animation Timeline (302 Frames @ 30 FPS = 10.07s):
  // - 0.00s – 0.83s: Hero Intro
  // - 0.83s – 1.17s: Water Emergence
  // - 1.17s – 6.80s: 5.63s Spiral Swirl (gentle graceful slow luxury speed)
  // - 6.80s – 7.53s: Splash Burst & Flung Dissolve
  // - 7.53s – 10.07s: Rock Pedestal Emergence & Organic Flower Blooming
  // - >= 10.07s: Full Bloom Hold, Living Petal Sway & Ingredients Cascade
  const INTRO_DURATION = 10.07;

  // Frame rendering and 60fps DOM projection pipeline
  const renderFrame = (driveRender: boolean) => {
    // Safely enforce 0.01m (1cm) near clipping plane without calling updateProjectionMatrix(),
    // preserving 8th Wall's physical camera calibration matrix so close-ups never jump or distort
    if (sceneRef.current?.camera) {
      applyNearClippingPlaneToXRCamera(sceneRef.current.camera, 0.01);
    }

    trackingRef.current?.inspectWorldAnchor();
    const dt = clockRef.current.getDelta();
    const safeDt = dt > 0.0001 && dt < 0.2 ? dt : 0.016;
    surfacePlacementRef.current?.update(safeDt);
    const scene = sceneRef.current;

    // Keep the ground grid hidden while retaining the placement reticle.
    if (scene && surfacePlacementRef.current) {
      const surface = surfacePlacementRef.current;
      if (surface.hasStablePreview) {
        const p = surface.currentSurfacePosition;
        scene.setPlaneGridPosition(p.x, p.y, p.z);
      }
      scene.setPlaneGridVisible(false);
    }
    const debugStoryBefore = worldTrackingDebugger.captureTransform(scene?.userRotationGroup);
    const debugBottleBefore = worldTrackingDebugger.captureTransform(modelRef.current?.bottleGroup);
    const debugModelBefore = worldTrackingDebugger.captureTransform(modelRef.current?.modelScene);

    // 1. Update Master 6-Phase Story Timeline (1.0x original dynamic speed)
    const story = timelineRef.current?.update(safeDt, isPointerDownRef.current);
    if (scene?.userRotationGroup) {
      worldTrackingDebugger.recordTransformWrite(
        'MODEL',
        'STORY_TIMELINE_TRANSFORM',
        'ProductStoryTimeline.update',
        scene.userRotationGroup,
        debugStoryBefore,
        'Existing story animation updated the model presentation group.',
        { phase: story?.phase ?? null, sequenceTime: story?.sequenceTime ?? 0, deltaTimeSeconds: safeDt }
      );
    }
    if (modelRef.current?.bottleGroup) {
      worldTrackingDebugger.recordTransformWrite(
        'MODEL',
        'BOTTLE_TIMELINE_TRANSFORM',
        'ProductStoryTimeline.update',
        modelRef.current.bottleGroup,
        debugBottleBefore,
        'Existing story animation or user rotation updated the bottle group.',
        { phase: story?.phase ?? null, sequenceTime: story?.sequenceTime ?? 0, userRotationY: timelineRef.current?.userBottleRotY ?? 0 }
      );
    }
    if (story) {
      if (story.is360Active !== is360ActiveRef.current) {
        is360ActiveRef.current = story.is360Active;
        arPerformanceMonitor.recordUiStateDispatch();
        setIs360Active(story.is360Active);
      }
      if (story.phase !== storyPhaseRef.current) {
        storyPhaseRef.current = story.phase;
        arPerformanceMonitor.recordUiStateDispatch();
        setStoryPhase(story.phase);
      }
    }

    // 2. Update Master 3D Cinematic Animation
    if (modelRef.current?.mixer && modelAnimationStartedRef.current) {
      if (story && story.sequenceTime >= INTRO_DURATION) {
        const period = 2.6; // 2.6s natural rhythmic petal sway
        const progress = 0.5 * (1 - Math.cos((story.sequenceTime - INTRO_DURATION) * (2 * Math.PI / period)));
        const targetTime = 10.07 - progress * 0.28; // 9.79s <-> 10.07s (holding full bloom with gentle sway)
        for (const action of modelRef.current.actions ?? []) {
          action.paused = false;
          action.time = targetTime;
        }
        modelRef.current.mixer.update(0);
      } else {
        modelRef.current.mixer.update(safeDt);
      }

      // Lively continuous floating bounce for the 3 ingredient molecules once revealed
      if (story && story.sequenceTime >= 8.95) {
        const src = modelRef.current.sourceScene;
        const floatTime = story.sequenceTime - 8.95;
        const ramp = Math.min(1, floatTime / 0.55);
        const molConfigs: [string, number, number, number][] = [
          ['B5_Controller', 1.05, 0.0, 2.85],
          ['HA_Controller', 0.46, 2.1, 2.65],
          ['VC_Controller', 0.82, 4.2, 3.05],
        ];
        for (const [ctrlName, baseY, phase, freq] of molConfigs) {
          const ctrl = src.getObjectByName(ctrlName);
          if (ctrl && ctrl.scale.x > 0.25) {
            const bounce = Math.sin(floatTime * freq + phase) * 0.068 * ramp;
            const pulse = 1.0 + Math.sin(floatTime * (freq * 1.35) + phase) * 0.038 * ramp;
            ctrl.position.y = baseY + bounce;
            ctrl.scale.setScalar(pulse);
          }
        }
      }
      worldTrackingDebugger.recordTransformWrite(
        'MODEL',
        'MODEL_ANIMATION_TRANSFORM',
        'AnimationMixer.update',
        modelRef.current.modelScene,
        debugModelBefore,
        'Existing GLB animation mixer advanced the loaded model.',
        {
          mixerTime: Number(modelRef.current.mixer.time.toFixed(4)),
          actionCount: modelRef.current.actions?.length ?? 0,
          deltaTimeSeconds: story && story.sequenceTime >= INTRO_DURATION ? 0 : safeDt,
        }
      );
    }

    if (!isSimulation && trackingRef.current?.isWorldAnchored && modelRef.current?.mixer) {
      animationDiagnosticFramesRef.current += 1;
      if (animationDiagnosticFramesRef.current % 60 === 0) {
        traceAR('MODEL_ANIMATION_HEALTH_SAMPLE', {
          trackingState: trackingRef.current.trackingState,
          mixerTime: Number(modelRef.current.mixer.time.toFixed(3)),
          actions: (modelRef.current.actions ?? []).map((action) => ({
            clip: action.getClip().name || '(unnamed)',
            time: Number(action.time.toFixed(3)),
            duration: Number(action.getClip().duration.toFixed(3)),
            enabled: action.enabled,
            paused: action.paused,
            running: action.isRunning(),
            effectiveWeight: Number(action.getEffectiveWeight().toFixed(3)),
            effectiveTimeScale: Number(action.getEffectiveTimeScale().toFixed(3)),
          })),
        });
      }
    }

    // 3. User interactive 360 rotation inertia damping
    if (!isPointerDownRef.current && timelineRef.current) {
      timelineRef.current.userBottleRotY += userRotVelRef.current;
      userRotVelRef.current *= 0.92;
    }

    // 4. Render 3D Scene (if in simulation mode or fallback)
    if (driveRender && sceneRef.current) {
      sceneRef.current.render();
    }
  };

  const findIngredientAtScreenPoint = useCallback((clientX: number, clientY: number): Ingredient | null => {
    const canvas = canvasRef.current;
    const camera = sceneRef.current?.camera;
    const model = modelRef.current;
    if (!canvas || !camera || !model) return null;

    const rect = canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }

    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

    const src = model.sourceScene;
    const items: { ctrl: THREE.Object3D; id: string }[] = [];
    const b5 = src.getObjectByName('B5_Controller');
    const ha = src.getObjectByName('HA_Controller');
    const vc = src.getObjectByName('VC_Controller');
    if (b5) items.push({ ctrl: b5, id: 'b5' });
    if (ha) items.push({ ctrl: ha, id: 'ha' });
    if (vc) items.push({ ctrl: vc, id: 'c' });

    // Only active when visible and scaled up (> 0.15)
    const activeItems = items.filter((item) => item.ctrl.visible && item.ctrl.scale.x > 0.15);
    if (activeItems.length === 0) return null;

    // 1. Raycast against active molecule controllers & children
    const testRoots = activeItems.map((item) => item.ctrl);
    const intersects = raycaster.intersectObjects(testRoots, true);

    if (intersects.length > 0) {
      for (const hit of intersects) {
        let cur: THREE.Object3D | null = hit.object;
        while (cur && cur !== src) {
          if (cur.userData?.ingredientId) {
            const ing = getIngredientById(cur.userData.ingredientId);
            if (ing) return ing;
          }
          if (cur.name === 'B5_Controller' || cur.name.startsWith('B5_')) {
            const ing = getIngredientById('b5');
            if (ing) return ing;
          }
          if (cur.name === 'HA_Controller' || cur.name.startsWith('HA_')) {
            const ing = getIngredientById('ha');
            if (ing) return ing;
          }
          if (cur.name === 'VC_Controller' || cur.name.startsWith('VC_')) {
            const ing = getIngredientById('c');
            if (ing) return ing;
          }
          cur = cur.parent;
        }
      }
    }

    // 2. Fallback: Screen-space proximity check for reliable touch targets on mobile
    const worldPos = new THREE.Vector3();
    let minDistance = 46; // pixel touch radius tolerance
    let matchedIng: Ingredient | null = null;

    for (const { ctrl, id } of activeItems) {
      ctrl.getWorldPosition(worldPos);
      worldPos.project(camera);
      if (worldPos.z > 1) continue; // Behind camera

      const sx = ((worldPos.x + 1) * 0.5) * rect.width + rect.left;
      const sy = ((-worldPos.y + 1) * 0.5) * rect.height + rect.top;
      const d = Math.hypot(clientX - sx, clientY - sy);
      if (d < minDistance) {
        minDistance = d;
        matchedIng = getIngredientById(id) ?? null;
      }
    }

    return matchedIng;
  }, []);

  // Pointer event listeners for interactive 360-degree rotation in Phase 6 and clicking ingredient molecules
  useEffect(() => {
    const touchDistance = (): number => {
      const [a, b] = Array.from(activeTouchPointsRef.current.values());
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };

    const resetGesture = () => {
      activeTouchPointsRef.current.clear();
      pinchDistanceRef.current = null;
      pinchUsedRef.current = false;
      isPointerDownRef.current = false;
      dragPointerIdRef.current = null;
    };

    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('.interactive-ui')) return;
      if (e.pointerType === 'touch' && canvasRef.current?.contains(e.target as Node)) {
        const points = activeTouchPointsRef.current;
        points.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (points.size >= 2) {
          pinchUsedRef.current = true;
          hasDraggedRef.current = true;
          userRotVelRef.current = 0;
          suppressClickUntilRef.current = performance.now() + 500;
          pinchDistanceRef.current = points.size === 2 && surfacePlacementRef.current?.canScalePlacedModel
            ? touchDistance()
            : null;
          if (e.cancelable) e.preventDefault();
          return;
        }
      }
      if (isPointerDownRef.current) return;
      isPointerDownRef.current = true;
      dragPointerIdRef.current = e.pointerId;
      lastPointerXRef.current = e.clientX;
      pointerDownPosRef.current = { x: e.clientX, y: e.clientY };
      pointerDownTimeRef.current = performance.now();
      hasDraggedRef.current = false;
      userRotVelRef.current = 0;
    };

    const onPointerMove = (e: PointerEvent) => {
      const points = activeTouchPointsRef.current;
      if (e.pointerType === 'touch' && points.has(e.pointerId)) {
        points.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinchDistanceRef.current !== null && points.size === 2) {
          const distance = touchDistance();
          if (distance > 0 && pinchDistanceRef.current > 0) {
            surfacePlacementRef.current?.scalePlacedModelBy(distance / pinchDistanceRef.current);
            pinchDistanceRef.current = distance;
          }
          if (e.cancelable) e.preventDefault();
          return;
        }
        if (pinchUsedRef.current || points.size > 1) return;
      }
      if (isPointerDownRef.current && e.pointerId === dragPointerIdRef.current) {
        const dist = Math.hypot(
          e.clientX - pointerDownPosRef.current.x,
          e.clientY - pointerDownPosRef.current.y
        );
        if (dist > 8) {
          hasDraggedRef.current = true;
        }
        const dx = e.clientX - lastPointerXRef.current;
        lastPointerXRef.current = e.clientX;

        // In real AR mode, swipe rotates the bottle in Phase 6. In simulation mode, OrbitControls handles scene inspection.
        if (!isSimulation && timelineRef.current) {
          const delta = dx * 0.009;
          userRotVelRef.current = delta;
          timelineRef.current.userBottleRotY += delta;
        }
      } else {
        // Desktop hover cursor feedback
        if (!isMobileDevice() && canvasRef.current) {
          const hovered = findIngredientAtScreenPoint(e.clientX, e.clientY);
          canvasRef.current.style.cursor = hovered ? 'pointer' : 'default';
        }
      }
    };

    const finishPointer = (e: PointerEvent, cancelled: boolean) => {
      if (e.pointerType === 'touch') {
        activeTouchPointsRef.current.delete(e.pointerId);
        if (pinchUsedRef.current) {
          pinchDistanceRef.current = activeTouchPointsRef.current.size === 2 && surfacePlacementRef.current?.canScalePlacedModel
            ? touchDistance()
            : null;
          hasDraggedRef.current = true;
          suppressClickUntilRef.current = performance.now() + 500;
          isPointerDownRef.current = false;
          dragPointerIdRef.current = null;
          if (activeTouchPointsRef.current.size === 0) pinchUsedRef.current = false;
          return;
        }
      }
      if (!isPointerDownRef.current || e.pointerId !== dragPointerIdRef.current) return;
      isPointerDownRef.current = false;
      dragPointerIdRef.current = null;
      if (cancelled) return;

      const duration = performance.now() - pointerDownTimeRef.current;
      if (!hasDraggedRef.current && duration < 500) {
        const now = performance.now();
        if (now - lastModalOpenTimeRef.current < 250) return;

        const clickedIng = findIngredientAtScreenPoint(e.clientX, e.clientY);
        if (clickedIng) {
          lastModalOpenTimeRef.current = now;
          // Scale pulse reaction on clicked molecule
          const ctrlName =
            clickedIng.id === 'b5' ? 'B5_Controller' :
            clickedIng.id === 'ha' ? 'HA_Controller' : 'VC_Controller';
          const ctrl = modelRef.current?.sourceScene.getObjectByName(ctrlName);
          if (ctrl) {
            ctrl.scale.multiplyScalar(1.22);
          }
          openIngredientModal(clickedIng);
        }
      }
    };
    const onPointerUp = (e: PointerEvent) => finishPointer(e, false);
    const onPointerCancel = (e: PointerEvent) => finishPointer(e, true);

    const onCanvasClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.interactive-ui')) return;
      const now = performance.now();
      if (now < suppressClickUntilRef.current || activeTouchPointsRef.current.size > 0) return;
      if (now - lastModalOpenTimeRef.current < 300) return;
      if (hasDraggedRef.current) return;

      const clickedIng = findIngredientAtScreenPoint(e.clientX, e.clientY);
      if (clickedIng) {
        lastModalOpenTimeRef.current = now;
        openIngredientModal(clickedIng);
        return;
      }

      // Tap to place product when the ground reticle is ready.
      if (isCameraLocked && canPlaceOnSurface) {
        placeOnSurface();
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('click', onCanvasClick);
    window.addEventListener('blur', resetGesture);

    const onResize = () => {
      sceneRef.current?.handleResize();
      trackingRef.current?.handleResize();
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('click', onCanvasClick);
      window.removeEventListener('blur', resetGesture);
      window.removeEventListener('resize', onResize);
      resetGesture();
    };
  }, [canPlaceOnSurface, findIngredientAtScreenPoint, isCameraLocked, isSimulation, openIngredientModal, placeOnSurface]);

  // Start AR on mobile and the interactive 3D preview on desktops automatically.
  useEffect(() => {
    // Deferring one frame lets React StrictMode cancel its development-only
    // setup pass before any camera or WebGL resources are created.
    const startFrame = window.requestAnimationFrame(() => {
      void startExperience();
    });
    return () => window.cancelAnimationFrame(startFrame);
  }, [startExperience]);

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      isStartingRef.current = false;
      hasLoadedModelRef.current = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      trackingRef.current?.dispose();
      surfacePlacementRef.current?.dispose();
      eightWallRef.current?.stopAR();
      worldTrackingDebugger.stop();
      arPerformanceMonitor.stop();
      for (const line of Object.values(modelRef.current?.calloutLines ?? {})) {
        line.geometry.dispose();
        const material = line.material;
        if (Array.isArray(material)) {
          material.forEach((entry) => entry.dispose());
        } else {
          material.dispose();
        }
      }
      sceneRef.current?.dispose();
    };
  }, []);

  return {
    canvasRef,
    activeIngredient,
    isSimulation,
    selectedIngredientId,
    is360Active,
    storyPhase,
    showSimPoster,
    toggleSimPoster,
    showWaterSpiral,
    toggleWaterSpiral,
    openIngredientModal,
    closeIngredientModal,
    replaySequence,
    toggleSimulation,
    startExperience,
    hasTargetFound,
    isCameraLocked,
    canPlaceOnSurface,
    placeOnSurface,
    relockToCamera,
    worldTrackingStatus,
    surfaceGuidance,
    isExperienceReady,
    isCaptureReady: !isSimulation && isExperienceReady && isCameraVideoReady && captureEngine !== null,
    captureEngine,
    startupError,
    startupStage,
  };
}
