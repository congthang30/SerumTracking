import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { Ingredient } from '../types/ar';
import { SerumScene } from '../ar/scene/SerumScene';
import { SerumModelLoader, LoadedSerumModel } from '../ar/models/SerumModelLoader';
import { ProductStoryTimeline, StoryPhase } from '../ar/animation/ProductStoryTimeline';
import { HydrationFX } from '../ar/effects/HydrationFX';
import { CalloutProjection } from '../ar/callouts/CalloutProjection';
import { Callout3DBadges } from '../ar/callouts/Callout3DBadges';
import { ImageTrackingController } from '../ar/tracking/ImageTrackingController';
import { EightWallManager } from '../ar/engine/EightWallManager';
import { beginARTraceSession, traceAR } from '../ar/xr/camera-fix';
import { worldTrackingDebugger } from '../ar/debug/WorldTrackingDebugger';

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

  const [isSimulation, setIsSimulation] = useState(() => {
    if (typeof window !== 'undefined') {
      const p = new URLSearchParams(window.location.search);
      if (p.get('sim') === '1' || p.get('mode') === 'sim') return true;
    }
    return !isMobileDevice();
  });
  const [showSimPoster, setShowSimPoster] = useState(false);
  const [showWaterSpiral, setShowWaterSpiral] = useState(true);

  const toggleWaterSpiral = useCallback(() => {
    setShowWaterSpiral((prev) => {
      const next = !prev;
      if (modelRef.current?.waterGroup) {
        modelRef.current.waterGroup.visible = next;
      }
      return next;
    });
  }, []);

  // Engine references kept outside React state for 60fps performance
  const sceneRef = useRef<SerumScene | null>(null);
  const modelRef = useRef<LoadedSerumModel | null>(null);
  const timelineRef = useRef<ProductStoryTimeline | null>(null);
  const hydrationFXRef = useRef<HydrationFX | null>(null);
  const trackingRef = useRef<ImageTrackingController | null>(null);
  const calloutProjRef = useRef<CalloutProjection | null>(null);
  const calloutBadgesRef = useRef<Callout3DBadges | null>(null);
  const eightWallRef = useRef<EightWallManager | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const clockRef = useRef(new THREE.Clock());
  const animationDiagnosticFramesRef = useRef(0);
  const modelAnimationStartedRef = useRef(false);

  // User drag-to-rotate state (Phase 6: rotates exclusively the serum bottle)
  const isPointerDownRef = useRef(false);
  const lastPointerXRef = useRef(0);
  const userRotVelRef = useRef(0);

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
    const canvas = canvasRef.current;
    if (!isSimulation) {
      worldTrackingDebugger.start();
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
      const modelLoader = new SerumModelLoader();
      if (!isSimulation) traceAR('SERUM_MODEL_LOAD_START', {});
      const loadedModel = await modelLoader.load();
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

      // 3. Initialize Timeline Controller (HydrationFX is superseded by baked master GLB)
      const hydrationFX = new HydrationFX();
      hydrationFXRef.current = hydrationFX;

      timelineRef.current = new ProductStoryTimeline(
        serumScene.userRotationGroup,
        loadedModel.bottleGroup,
        hydrationFX
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
      calloutProjRef.current = new CalloutProjection(serumScene.camera);
      calloutBadgesRef.current = new Callout3DBadges(
        loadedModel.bottleGroup,
        serumScene.camera,
        canvas,
        (ing) => openIngredientModal(ing)
      );

      // 4. Handle Simulation Mode vs Real 8th Wall AR
      if (isSimulation) {
        setupSimulationMode(serumScene, canvas);
      } else {
        await setupEightWallAR(canvas, serumScene);
      }
    } catch (err: any) {
      if (!isSimulation) traceAR('SERUM_AR_BOOT_FAILED', { error: String(err) }, 'error');
      hasLoadedModelRef.current = false;
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
    const simEnv = sceneObj.getStudioEnvMap();
    if (simEnv && hydrationFXRef.current) {
      hydrationFXRef.current.setEnvironmentMap(simEnv);
    }
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
    startModelAnimation();
    timelineRef.current?.start();

    // Start Simulation Animation Loop
    const loop = () => {
      animFrameRef.current = requestAnimationFrame(loop);
      renderFrame(true);
    };
    loop();
  };

  // Setup Real 8th Wall Camera Tracking
  const setupEightWallAR = async (
    canvas: HTMLCanvasElement,
    sceneObj: SerumScene
  ) => {
    const manager = new EightWallManager();
    eightWallRef.current = manager;

    await manager.startAR(canvas, {
      onCameraStarted: ({ scene, camera, renderer }) => {
        sceneObj.attachToXRScene(scene, camera, renderer);
        trackingRef.current?.setCamera(camera);
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
        const env = sceneObj.getStudioEnvMap();
        if (env && hydrationFXRef.current) {
          hydrationFXRef.current.setEnvironmentMap(env);
        }
        calloutProjRef.current?.updateCamera(camera);
        calloutBadgesRef.current?.updateCamera(camera);
      },
      onTargetFound: (pose) => {
        const firstTargetFound = trackingRef.current?.handleImageFound(pose, 0) ?? false;
        if (firstTargetFound) {
          startModelAnimation();
          timelineRef.current?.start();
        }
      },
      onTargetUpdated: (pose) => {
        const anchoredNow = trackingRef.current?.handleImageUpdated(pose, 0) ?? false;
        if (anchoredNow) manager.disableImageTargets();
      },
      onTargetLost: () => trackingRef.current?.handleImageLost(),
      onWorldTrackingStatus: (status, reason) => {
        worldTrackingDebugger.recordTrackingStatus(status, reason ?? 'UNDEFINED');
        trackingRef.current?.setWorldTrackingStatus(status, reason);
      },
      onPipelineState: (state) => worldTrackingDebugger.recordPipelineState(state),
      onPipelineEventPhase: (phase) => {
        if (phase === 'START') worldTrackingDebugger.beginPipelineEvent();
        else worldTrackingDebugger.endPipelineEvent();
      },
      onCameraStatus: (payload, video) => worldTrackingDebugger.recordCameraStatus(payload, video),
      onFrameUpdate: (context) => {
        if (worldTrackingDebugger.isEnabled) worldTrackingDebugger.beginFrame(context);
        try {
          renderFrame(false);
        } finally {
          if (worldTrackingDebugger.isEnabled) worldTrackingDebugger.endFrame();
        }
      },
      onError: () => {},
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
    trackingRef.current?.inspectWorldAnchor();
    const scene = sceneRef.current;
    const debugStoryBefore = worldTrackingDebugger.captureTransform(scene?.userRotationGroup);
    const debugBottleBefore = worldTrackingDebugger.captureTransform(modelRef.current?.bottleGroup);
    const debugModelBefore = worldTrackingDebugger.captureTransform(modelRef.current?.modelScene);
    const dt = clockRef.current.getDelta();
    const safeDt = dt > 0.0001 && dt < 0.2 ? dt : 0.016;

    // 1. Update Master 6-Phase Story Timeline (1.0x original dynamic speed)
    const story = timelineRef.current?.update(safeDt);
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
      if (story.is360Active !== is360Active) {
        setIs360Active(story.is360Active);
      }
      if (story.phase !== storyPhase) {
        setStoryPhase(story.phase);
      }
    }

    // 2. Update Master 3D Cinematic Animation
    if (modelRef.current?.mixer && modelAnimationStartedRef.current) {
      if (story && story.sequenceTime >= INTRO_DURATION) {
        const period = 2.6; // 2.6s natural rhythmic petal sway
        const progress = 0.5 * (1 - Math.cos((story.sequenceTime - INTRO_DURATION) * (2 * Math.PI / period)));
        const targetTime = 10.07 - progress * 0.95; // 9.12s <-> 10.07s
        for (const action of modelRef.current.actions ?? []) {
          action.paused = false;
          action.time = targetTime;
        }
        modelRef.current.mixer.update(0);
      } else {
        modelRef.current.mixer.update(safeDt);
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

    // 4. Update 3D Callout Badges locked to GLB 3D lines
    if (story) {
      calloutBadgesRef.current?.update(story.sequenceTime);
    }

    // 6. Render 3D Scene (if in simulation mode or fallback)
    if (driveRender && sceneRef.current) {
      sceneRef.current.render();
    }
  };

  // Pointer event listeners for interactive 360-degree rotation in Phase 6
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('.interactive-ui')) return;
      isPointerDownRef.current = true;
      lastPointerXRef.current = e.clientX;
      userRotVelRef.current = 0;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isPointerDownRef.current) return;
      const dx = e.clientX - lastPointerXRef.current;
      lastPointerXRef.current = e.clientX;

      // In real AR mode, swipe rotates the bottle in Phase 6. In simulation mode, OrbitControls handles scene inspection.
      if (!isSimulation && timelineRef.current) {
        const delta = dx * 0.009;
        userRotVelRef.current = delta;
        timelineRef.current.userBottleRotY += delta;
      }
    };

    const onPointerUp = () => {
      isPointerDownRef.current = false;
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    const onResize = () => {
      sceneRef.current?.handleResize();
      if (sceneRef.current?.camera) {
        calloutProjRef.current?.updateCamera(sceneRef.current.camera);
        calloutBadgesRef.current?.updateCamera(sceneRef.current.camera);
      }
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('resize', onResize);
    };
  }, []);

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
      hydrationFXRef.current?.dispose();
      eightWallRef.current?.stopAR();
      worldTrackingDebugger.stop();
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
  };
}
