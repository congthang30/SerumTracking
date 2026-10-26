import * as THREE from 'three';
import { ImagePose } from '../../types/ar';
import { logger } from '../../utils/logger';
import { isARTraceEnabled, reportCameraDiagnostic, traceAR } from '../xr/camera-fix';
import { worldTrackingDebugger } from '../debug/WorldTrackingDebugger';

type TrackingState = 'SCANNING' | 'STABILIZING' | 'ANCHORED';

export class ImageTrackingController {
  private static readonly MODEL_TARGET_COVERAGE = 0.8;
  private static readonly STABLE_POSITION_DELTA = 0.02;
  private static readonly STABLE_ROTATION_DELTA = THREE.MathUtils.degToRad(2);
  private static readonly STABLE_SCALE_DELTA = 0.03;
  private static readonly STABLE_WIDTH_DELTA = 0.03;
  private static readonly STABLE_DURATION_MS = 650;
  private static readonly STABLE_SAMPLE_COUNT = 12;
  private static readonly MATRIX_ERROR_TOLERANCE = 1e-5;
  private static readonly ORIGIN_SHIFT_REBASE_DISTANCE_M = 1;
  private static readonly ORIGIN_SHIFT_REBASE_ROTATION_DEG = 120;
  private static readonly MAX_POSE_DELTA_SECONDS = 0.1;
  private static readonly REACQUIRE_DELTA_SECONDS = 1 / 30;
  private static readonly MAX_REACQUIRE_POSITION_SPEED_MPS = 1.5;
  private static readonly MAX_REACQUIRE_ROTATION_SPEED_RAD_PER_SEC = 3.5;
  private static readonly MAX_REACQUIRE_SCALE_SPEED_PER_SEC = 0.75;

  private targetGroup: THREE.Group;
  private productRoot: THREE.Group;
  private worldAnchorGroup: THREE.Group;
  private diagnosticModelRoot: THREE.Object3D | null;
  private diagnosticCanvas: HTMLCanvasElement | null;
  private normalizedModelWidth: number;
  private normalizedModelHeight: number;
  private camera: THREE.Camera | null = null;
  private state: TrackingState = 'SCANNING';
  private hasSeenTarget = false;
  private hasPose = false;
  private isTracked = false;
  private isCameraLocked = false;
  private isCentering = false;
  private centerStartTime = 0;
  private centerDurationMs = 400;
  private readonly centerStartPos = new THREE.Vector3();
  private readonly centerStartQuat = new THREE.Quaternion();
  private readonly centerStartScale = new THREE.Vector3();
  private readonly targetCenterPos = new THREE.Vector3();
  private readonly targetCenterQuat = new THREE.Quaternion();
  private readonly targetCenterScale = new THREE.Vector3();
  private worldTrackingNormal = false;
  private worldTrackingStatus: 'NORMAL' | 'LIMITED' = 'LIMITED';
  private worldTrackingReason = 'INITIALIZING';
  private worldTrackingRecoveryUntil = 0;
  private expectedWorldMatrix: THREE.Matrix4 | null = null;
  private handoffFailureLogged = false;
  private lastHandoffFailureReason = '';
  private lastHandoffAttemptTraceAt = 0;
  private lastHandoffReadyTraceAt = 0;
  private integrityWarning = '';
  private anchorDiagnosticFrames = 0;
  private hasPreviousAnchorCameraSample = false;
  private previousAnchorCameraPosition = new THREE.Vector3();
  private previousAnchorCameraQuaternion = new THREE.Quaternion();
  private previousAnchorCameraMatrix = new THREE.Matrix4();
  private currentAnchorCameraPosition = new THREE.Vector3();
  private currentAnchorCameraQuaternion = new THREE.Quaternion();
  private currentAnchorCameraMatrix = new THREE.Matrix4();
  private diagnosticSerumWorldPosition = new THREE.Vector3();
  private previousAnchorCameraSampleAt = 0;
  private peakAnchorCameraPositionStep = 0;
  private peakAnchorCameraRotationStep = 0;
  private previousCameraVelocity = new THREE.Vector3();
  private hasPreviousCameraVelocity = false;
  private peakCameraSpeedMps = 0;
  private peakCameraAccelerationMps2 = 0;
  private peakCameraRotationRateDegPerSec = 0;
  private anchorDiagnosticWindowStartedAt = 0;
  private previousVisualSample: {
    distanceM: number;
    worldScale: THREE.Vector3;
    projectedWidthPx: number;
    projectedHeightPx: number;
    projectedBoundsFullyInsideViewport: boolean;
    projectedCenterX: number | null;
    projectedCenterY: number | null;
    cameraPosition: THREE.Vector3;
    anchorPosition: THREE.Vector3;
    anchorQuaternion: THREE.Quaternion;
    anchorScale: THREE.Vector3;
    sampledAt: number;
  } | null = null;
  private loggedIgnoredEvents = new Set<string>();
  private lastCameraSample = {
    timestamp: 0,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
  };

  // Existing image-pose filter, used only before the one-time handoff.
  private lastPoseTimestamp = 0;
  private previousRawPosition = new THREE.Vector3();
  private filteredPositionVelocity = new THREE.Vector3();
  private previousRawQuaternion = new THREE.Quaternion();
  private filteredAngularVelocity = 0;
  private previousRawScale = 1;
  private filteredScaleVelocity = 0;
  private previousRawProductScale = 1;
  private filteredProductScaleVelocity = 0;
  private tmpPositionVelocity = new THREE.Vector3();
  private tmpPositionDelta = new THREE.Vector3();
  private tmpTargetQuat = new THREE.Quaternion();
  private tmpRotZ = new THREE.Quaternion();
  private stableReferencePosition = new THREE.Vector3();
  private stableReferenceQuaternion = new THREE.Quaternion();
  private stableReferenceScale = 1;
  private stableReferenceWidth: number | undefined;
  private stableSince = 0;
  private stableSamples = 0;
  private cameraPoseStableAfter = 0;
  private cameraPoseDiscontinuityAt = 0;
  private imageUpdateCount = 0;
  private lastPoseSmoothingSampleAt = 0;
  private lastApproachSampleAt = 0;
  private worldLockEstablishedAt: number | null = null;
  private readonly imagePoseSmoothingDisabled: boolean;
  private lastStabilityDelta = { position: 0, rotation: 0, scale: 0, width: 0 };

  private static readonly Z_AXIS = new THREE.Vector3(0, 0, 1);
  private static readonly MATRIX_ELEMENTS = 16;

  private static smoothingAlpha(lambdaPerSecond: number, dt: number): number {
    return 1 - Math.exp(-Math.max(0.01, lambdaPerSecond) * dt);
  }

  public onFound?: (pose: ImagePose) => void;
  public onUpdated?: (pose: ImagePose) => void;
  public onLost?: () => void;

  constructor(
    targetGroup: THREE.Group,
    productRoot: THREE.Group,
    worldAnchorGroup: THREE.Group,
    normalizedModelWidth = 0.58,
    normalizedModelHeight = 0.58,
    diagnosticModelRoot: THREE.Object3D | null = null,
    diagnosticCanvas: HTMLCanvasElement | null = null
  ) {
    this.targetGroup = targetGroup;
    this.productRoot = productRoot;
    this.worldAnchorGroup = worldAnchorGroup;
    this.normalizedModelWidth = normalizedModelWidth;
    this.normalizedModelHeight = normalizedModelHeight;
    this.diagnosticModelRoot = diagnosticModelRoot;
    this.diagnosticCanvas = diagnosticCanvas;
    // Diagnostic A/B switch for image-pose filtering; world-locked transforms are unaffected.
    this.imagePoseSmoothingDisabled = worldTrackingDebugger.isEnabled &&
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('debugImagePoseSmoothing') === '0';
    this.setTargetVisibility(false, 'controller initialized');
    this.worldAnchorGroup.visible = false;
    traceAR('CONTROLLER_READY', {
      state: this.state,
      targetGroup: this.targetGroup.name || this.targetGroup.type,
      targetParent: this.targetGroup.parent?.name || this.targetGroup.parent?.type || '(none)',
      productParent: this.productRoot.parent?.name || this.productRoot.parent?.type || '(none)',
      worldAnchor: this.worldAnchorGroup.name || this.worldAnchorGroup.type,
      worldAnchorParent: this.worldAnchorGroup.parent?.name || this.worldAnchorGroup.parent?.type || '(none)',
    });
  }

  public get isTracking(): boolean {
    return this.isTracked;
  }

  public get isWorldAnchored(): boolean {
    return this.state === 'ANCHORED';
  }

  public get isLockedToCamera(): boolean {
    return this.isCameraLocked;
  }

  public get trackingState(): TrackingState {
    return this.state;
  }

  public setCamera(camera: THREE.Camera): void {
    this.camera = camera;
    this.sampleCameraPose('camera-ready');
    traceAR('XR_CAMERA_READY', {
      camera: camera.name || camera.type,
      position: this.cameraWorldPosition(),
      matrixWorldValid: this.isWorldCameraPoseValid(),
    });
  }

  public setWorldTrackingStatus(status: 'NORMAL' | 'LIMITED', reason = 'UNDEFINED'): void {
    const now = performance.now();
    const changed = status !== this.worldTrackingStatus || reason !== this.worldTrackingReason;
    const trackingReady = status === 'NORMAL' && reason !== 'INITIALIZING';
    const normalChanged = trackingReady !== this.worldTrackingNormal;
    this.worldTrackingStatus = status;
    this.worldTrackingReason = reason;
    this.worldTrackingNormal = trackingReady;
    if (normalChanged && trackingReady) {
      // XR8 can shift the camera origin while SLAM hands off from initialization.
      this.worldTrackingRecoveryUntil = now + 1500;
    } else if (!trackingReady) {
      this.worldTrackingRecoveryUntil = 0;
    }

    if (normalChanged && this.state !== 'ANCHORED') this.resetStabilityWindow();
    this.sampleCameraPose('trackingstatus');

    if (changed) {
      reportCameraDiagnostic('World Tracking', `${status}; reason=${reason}; anchorReady=${trackingReady}`);
      traceAR('WORLD_TRACKING_STATUS', {
        status,
        reason,
        anchorReady: trackingReady,
        state: this.state,
        imageTracked: this.isTracked,
        cameraPosition: this.cameraWorldPosition(),
      }, trackingReady ? 'info' : 'warn');
      logger.log(
        trackingReady ? 'info' : 'warn',
        `[AR_ANCHOR] World Tracking ${status} (${reason}); anchorReady=${trackingReady}; state=${this.state}; camera=${this.cameraWorldPosition()}`
      );
      worldTrackingDebugger.recordEvent('TRACKING', 'WORLD_TRACKING_STATUS', {
        status,
        reason,
        anchorReady: trackingReady,
        imageTracked: this.isTracked,
        trackingState: this.state,
        cameraWorldPosition: this.cameraWorldPosition(),
      }, { bridge: true });
    }
  }

  /** Returns true only for the first image detection in this AR session. */
  public handleImageFound(pose: ImagePose, rotationDeg = 0): boolean {
    if (this.isCameraLocked || this.state === 'ANCHORED') return false;
    if (this.ignoreImageEvent('imagefound')) return false;
    if (!this.isValidPose(pose)) {
      traceAR('IMAGE_FOUND_IGNORED', { reason: 'invalid pose' }, 'warn');
      logger.log('warn', '[AR_ANCHOR] Ignored invalid imagefound pose.');
      return false;
    }

    const firstDetection = !this.hasSeenTarget;
    this.hasSeenTarget = true;
    this.isTracked = true;
    this.sampleCameraPose('imagefound');
    this.applyPose(pose, rotationDeg, true);
    this.setTargetVisibility(true, 'image target found');
    this.resetStabilityWindow(pose);
    worldTrackingDebugger.recordEvent('TRACKING', 'IMAGE_TARGET_DETECTED', {
      target: pose.name,
      rawPosition: [pose.position.x, pose.position.y, pose.position.z],
      rawQuaternion: [pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w],
      rawScale: pose.scale,
      scaledWidth: pose.scaledWidth ?? null,
      scaledHeight: pose.scaledHeight ?? null,
      trackingState: this.state,
      productParent: this.productRoot.parent?.name || '(none)',
    }, { bridge: true });
    this.recordApproachDiagnostics();

    // Image Tracking → Camera-Locked: Detach from Image Target and lock directly to AR Camera
    this.detachIntoCamera();

    traceAR('IMAGE_FOUND', {
      target: pose.name,
      firstDetection,
      state: this.state,
      isCameraLocked: this.isCameraLocked,
      worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
      pose: this.poseDescription(pose),
      targetParent: this.targetGroup.parent?.name || '(none)',
      productParent: this.productRoot.parent?.name || '(none)',
      cameraPosition: this.cameraWorldPosition(),
    });
    this.onFound?.(pose);
    return firstDetection;
  }

  /** Once camera-locked, image poses are completely ignored to avoid conflicts. */
  public handleImageUpdated(pose: ImagePose, rotationDeg = 0): boolean {
    if (this.isCameraLocked || this.state === 'ANCHORED') return false;
    if (this.ignoreImageEvent('imageupdated')) return false;
    if (!this.isValidPose(pose)) return false;

    this.isTracked = true;
    this.sampleCameraPose('imageupdated');
    this.applyPose(pose, rotationDeg, true);
    this.setTargetVisibility(true, 'image target pose updated');
    this.onUpdated?.(pose);
    return this.detachIntoCamera();
  }

  /** Poster loss never hides or resets the model once locked to camera. */
  public handleImageLost(): void {
    if (this.isCameraLocked || this.state === 'ANCHORED') {
      // In Camera-Locked mode, the model stays locked to camera; poster loss has zero effect
      return;
    }
    if (this.ignoreImageEvent('imagelost')) return;
    if (!this.hasSeenTarget) return;

    this.isTracked = false;
    worldTrackingDebugger.recordEvent('TRACKING', 'IMAGE_TARGET_LOST', {
      trackingState: this.state,
      worldTrackingStatus: this.worldTrackingStatus,
      worldTrackingReason: this.worldTrackingReason,
      productParent: this.productRoot.parent?.name || '(none)',
      action: 'retain last valid image pose',
    }, { bridge: true });
    this.recordApproachDiagnostics();
    this.onLost?.();
  }

  /**
   * Called from the existing XR frame loop. It diagnoses visibility, parent,
   * and world-matrix writes after handoff without changing the model.
   */
  public inspectWorldAnchor(): void {
    if (this.isCameraLocked) {
      if (this.isCentering) {
        const elapsed = performance.now() - this.centerStartTime;
        const t = Math.min(1, Math.max(0, elapsed / this.centerDurationMs));
        // Cubic ease-out: smooth deceleration into dead center
        const ease = 1 - Math.pow(1 - t, 3);

        this.productRoot.position.lerpVectors(this.centerStartPos, this.targetCenterPos, ease);
        this.productRoot.quaternion.slerpQuaternions(this.centerStartQuat, this.targetCenterQuat, ease);
        this.productRoot.scale.lerpVectors(this.centerStartScale, this.targetCenterScale, ease);
        this.productRoot.updateMatrix();

        if (t >= 1) {
          this.productRoot.position.copy(this.targetCenterPos);
          this.productRoot.quaternion.copy(this.targetCenterQuat);
          this.productRoot.scale.copy(this.targetCenterScale);
          this.productRoot.updateMatrix();
          this.isCentering = false;
          logger.log('info', '[AR_ANCHOR] 🎯 Centering transition complete. Model is locked dead-center in screen.');
        }
      }
      return;
    }
    if (!this.isWorldAnchored || !this.expectedWorldMatrix) return;

    this.monitorAnchorCameraPose();
    this.productRoot.updateWorldMatrix(true, false);
    const matrixError = this.maxMatrixDifference(this.productRoot.matrixWorld, this.expectedWorldMatrix);
    const hiddenAncestor = this.firstHiddenAncestor(this.productRoot);
    const fault = this.productRoot.parent !== this.worldAnchorGroup
      ? `ProductRoot parent changed to ${this.productRoot.parent?.name ?? '(none)'}`
      : hiddenAncestor
        ? `${hiddenAncestor.name || hiddenAncestor.type} is hidden`
        : matrixError > ImageTrackingController.MATRIX_ERROR_TOLERANCE
          ? `ProductRoot world matrix changed (max error ${matrixError.toExponential(2)})`
          : '';

    if (fault && fault !== this.integrityWarning) {
      reportCameraDiagnostic('Anchor integrity', fault);
      logger.log('error', `[AR_ANCHOR] Anchored model integrity violation: ${fault}`);
    }
    this.integrityWarning = fault;
    this.reportAnchorFrameDiagnostics(fault, matrixError);
    this.recordApproachDiagnostics();
  }

  private reportAnchorFrameDiagnostics(fault: string, matrixError: number): void {
    if (!isARTraceEnabled() || !this.camera) return;
    const cameraPosition = this.currentAnchorCameraPosition;

    if (this.anchorDiagnosticWindowStartedAt === 0) this.anchorDiagnosticWindowStartedAt = performance.now();
    this.anchorDiagnosticFrames += 1;
    if (this.anchorDiagnosticFrames < 30) return;

    const now = performance.now();
    const windowDurationMs = now - this.anchorDiagnosticWindowStartedAt;
    const diagnostics = this.collectModelCameraDiagnostics(matrixError, windowDurationMs);
    const projectedSize = diagnostics.projectedSizeCssPx as { width: number; height: number } | null;
    reportCameraDiagnostic(
      'Anchor integrity',
      `${fault || 'OK'}; parent=${this.productRoot.parent?.name ?? '(none)'}; worldError=${matrixError.toExponential(2)}; modelScale=${diagnostics.modelWorldScale ?? 'n/a'}; screen=${projectedSize ? `${projectedSize.width}x${projectedSize.height}px` : 'n/a'}; distance=${diagnostics.cameraDistanceToModelM ?? 'n/a'}m; camera peaks=${this.peakCameraSpeedMps.toFixed(2)}m/s, ${this.peakCameraRotationRateDegPerSec.toFixed(1)}deg/s, accel=${this.peakCameraAccelerationMps2.toFixed(1)}m/s²; camera=${this.vectorDescription(cameraPosition)}`
    );
    traceAR('MODEL_CAMERA_HEALTH_SAMPLE', {
      ...diagnostics,
      sampleFrames: this.anchorDiagnosticFrames,
      sampleWindowMs: Math.round(windowDurationMs),
      estimatedFps: windowDurationMs > 0 ? Number((this.anchorDiagnosticFrames * 1000 / windowDurationMs).toFixed(1)) : null,
      result: fault || 'OK',
      worldMatrixError: matrixError,
      cameraPeakTranslation30FramesM: this.peakAnchorCameraPositionStep,
      cameraPeakRotation30FramesDeg: THREE.MathUtils.radToDeg(this.peakAnchorCameraRotationStep),
      cameraPeakSpeedMps: this.peakCameraSpeedMps,
      cameraPeakAccelerationMps2: this.peakCameraAccelerationMps2,
      cameraPeakRotationRateDegPerSec: this.peakCameraRotationRateDegPerSec,
    }, fault ? 'error' : 'info');
    this.anchorDiagnosticFrames = 0;
    this.anchorDiagnosticWindowStartedAt = now;
    this.peakAnchorCameraPositionStep = 0;
    this.peakAnchorCameraRotationStep = 0;
    this.peakCameraSpeedMps = 0;
    this.peakCameraAccelerationMps2 = 0;
    this.peakCameraRotationRateDegPerSec = 0;
  }

  /** Low-rate approach telemetry; sampled from existing image/XR callbacks only. */
  private recordApproachDiagnostics(): void {
    const now = performance.now();
    if (!worldTrackingDebugger.isEnabled || !this.camera || !this.diagnosticModelRoot ||
      now - this.lastApproachSampleAt < 1000) return;
    this.lastApproachSampleAt = now;
    const processingStartedAt = performance.now();

    this.camera.updateWorldMatrix(true, false);
    this.camera.getWorldPosition(this.currentAnchorCameraPosition);
    this.camera.getWorldQuaternion(this.currentAnchorCameraQuaternion);
    this.productRoot.updateWorldMatrix(true, false);
    const matrixError = this.state === 'ANCHORED' && this.expectedWorldMatrix
      ? this.maxMatrixDifference(this.productRoot.matrixWorld, this.expectedWorldMatrix)
      : null;
    const sampleWindowMs = this.previousVisualSample
      ? now - this.previousVisualSample.sampledAt
      : 0;
    const diagnostics = this.collectModelCameraDiagnostics(matrixError ?? 0, sampleWindowMs);
    const perspectiveCamera = this.camera as THREE.PerspectiveCamera;
    const productWriter = worldTrackingDebugger.getLastTransformWriter(this.productRoot);
    const anchorWriter = worldTrackingDebugger.getLastTransformWriter(this.worldAnchorGroup);

    this.productRoot.getWorldPosition(this.diagnosticSerumWorldPosition);
    worldTrackingDebugger.recordEvent('MODEL', 'WORLD_APPROACH_SAMPLE', {
      ...diagnostics,
      sampleMonotonicMs: Number(now.toFixed(1)),
      approachSampleIntervalMs: sampleWindowMs > 0 ? Number(sampleWindowMs.toFixed(1)) : null,
      approachSampleRateHz: sampleWindowMs > 0 ? Number((1000 / sampleWindowMs).toFixed(1)) : null,
      diagnosticProcessingMs: Number((performance.now() - processingStartedAt).toFixed(2)),
      trackingMode: this.state === 'ANCHORED' ? 'WORLD_LOCKED' : 'IMAGE_TRACKING',
      imageTrackingDetected: this.isTracked,
      worldTrackingStatus: this.worldTrackingStatus,
      worldTrackingReason: this.worldTrackingReason,
      productParent: this.productRoot.parent?.name || '(none)',
      targetParent: this.targetGroup.parent?.name || '(none)',
      worldAnchorParent: this.worldAnchorGroup.parent?.name || '(none)',
      cameraWorldPosition: this.vectorDescription(this.currentAnchorCameraPosition),
      cameraWorldQuaternion: this.quaternionDescription(this.currentAnchorCameraQuaternion),
      serumWorldPosition: this.vectorDescription(this.diagnosticSerumWorldPosition),
      serumWorldScale: this.vectorDescription(this.productRoot.getWorldScale(new THREE.Vector3())),
      cameraFovDeg: perspectiveCamera.isPerspectiveCamera ? perspectiveCamera.fov : null,
      cameraNear: perspectiveCamera.isPerspectiveCamera ? perspectiveCamera.near : null,
      cameraFar: perspectiveCamera.isPerspectiveCamera ? perspectiveCamera.far : null,
      cameraZoom: perspectiveCamera.isPerspectiveCamera ? perspectiveCamera.zoom : null,
      cameraProjectionMatrix: this.camera.projectionMatrix.toArray(),
      worldMatrixError: matrixError === null ? null : Number(matrixError.toExponential(3)),
      latestProductTransformWriter: productWriter
        ? { ...productWriter, ageMs: Number((now - productWriter.at).toFixed(1)) }
        : null,
      latestWorldAnchorTransformWriter: anchorWriter
        ? { ...anchorWriter, ageMs: Number((now - anchorWriter.at).toFixed(1)) }
        : null,
      worldLockEstablishedAtMonotonicMs: this.worldLockEstablishedAt === null
        ? null
        : Number(this.worldLockEstablishedAt.toFixed(1)),
      worldLockAgeMs: this.worldLockEstablishedAt === null
        ? null
        : Number((now - this.worldLockEstablishedAt).toFixed(1)),
      imagePoseSmoothingEnabled: !this.imagePoseSmoothingDisabled,
    }, { bridge: true });
  }

  private collectModelCameraDiagnostics(matrixError: number, windowDurationMs: number): Record<string, unknown> {
    const camera = this.camera;
    const modelRoot = this.diagnosticModelRoot;
    if (!camera || !modelRoot) {
      return {
        state: this.state,
        worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
        productParent: this.productRoot.parent?.name || '(none)',
        worldAnchorParent: this.worldAnchorGroup.parent?.name || '(none)',
        productVisible: this.productRoot.visible,
        worldAnchorVisible: this.worldAnchorGroup.visible,
        hiddenAncestor: this.firstHiddenAncestor(this.productRoot)?.name || null,
        worldMatrixError: matrixError,
        cameraPosition: this.vectorDescription(this.currentAnchorCameraPosition),
        diagnosticsUnavailable: 'model root was not supplied',
      };
    }

    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(this.currentAnchorCameraPosition);
    modelRoot.updateWorldMatrix(true, true);
    this.productRoot.updateWorldMatrix(true, false);
    const modelScale = modelRoot.getWorldScale(new THREE.Vector3());
    const productScale = this.productRoot.getWorldScale(new THREE.Vector3());
    const anchorPosition = this.productRoot.getWorldPosition(new THREE.Vector3());
    const anchorQuaternion = this.productRoot.getWorldQuaternion(new THREE.Quaternion());
    const modelBounds = new THREE.Box3().setFromObject(modelRoot);
    const modelBoundsSize = modelBounds.isEmpty() ? new THREE.Vector3() : modelBounds.getSize(new THREE.Vector3());
    const modelBoundsCenter = modelBounds.isEmpty() ? modelRoot.getWorldPosition(new THREE.Vector3()) : modelBounds.getCenter(new THREE.Vector3());
    const cameraDistance = this.currentAnchorCameraPosition.distanceTo(modelBoundsCenter);
    const sampleAt = performance.now();

    const projection = this.projectModelBounds(modelBounds);
    const scaleChange = this.previousVisualSample
      ? this.vectorRatio(modelScale, this.previousVisualSample.worldScale)
      : null;
    const canCompareProjectedSize = Boolean(
      projection?.fullyInsideViewport && this.previousVisualSample?.projectedBoundsFullyInsideViewport
    );
    const apparentWidthRatio = canCompareProjectedSize && projection && this.previousVisualSample && this.previousVisualSample.projectedWidthPx > 0
      ? projection.widthPx / this.previousVisualSample.projectedWidthPx
      : null;
    const apparentHeightRatio = canCompareProjectedSize && projection && this.previousVisualSample && this.previousVisualSample.projectedHeightPx > 0
      ? projection.heightPx / this.previousVisualSample.projectedHeightPx
      : null;
    const expectedPerspectiveRatio = this.previousVisualSample && cameraDistance > 1e-6
      ? (this.previousVisualSample.distanceM / cameraDistance) * (scaleChange?.x ?? 1)
      : null;
    const anchorTransformDelta = this.previousVisualSample
      ? {
          translationM: Number(anchorPosition.distanceTo(this.previousVisualSample.anchorPosition).toFixed(5)),
          rotationDeg: Number(THREE.MathUtils.radToDeg(anchorQuaternion.angleTo(this.previousVisualSample.anchorQuaternion)).toFixed(4)),
          scaleRatio: this.vectorRatio(productScale, this.previousVisualSample.anchorScale),
        }
      : null;
    const cameraMovementSincePreviousSample = this.previousVisualSample
      ? this.currentAnchorCameraPosition.distanceTo(this.previousVisualSample.cameraPosition)
      : null;
    const cameraDistanceDeltaSincePreviousSample = this.previousVisualSample
      ? cameraDistance - this.previousVisualSample.distanceM
      : null;
    const projectedCenterDeltaPx = projection && projection.centerX !== null && projection.centerY !== null &&
      this.previousVisualSample && this.previousVisualSample.projectedCenterX !== null &&
      this.previousVisualSample.projectedCenterY !== null && this.diagnosticCanvas
      ? {
          x: Number(((projection.centerX - this.previousVisualSample.projectedCenterX) * this.diagnosticCanvas.getBoundingClientRect().width).toFixed(1)),
          y: Number(((projection.centerY - this.previousVisualSample.projectedCenterY) * this.diagnosticCanvas.getBoundingClientRect().height).toFixed(1)),
        }
      : null;

    let meshCount = 0;
    let hiddenMeshCount = 0;
    let frustumOutsideMeshEstimateCount = 0;
    const cameraViewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const cameraFrustum = new THREE.Frustum().setFromProjectionMatrix(cameraViewProjection, camera.coordinateSystem);
    modelRoot.traverse((object) => {
      if (!(object as THREE.Mesh).isMesh) return;
      meshCount += 1;
      if (!object.visible) {
        hiddenMeshCount += 1;
        return;
      }
      if (object.frustumCulled && !cameraFrustum.intersectsObject(object as THREE.Mesh)) {
        frustumOutsideMeshEstimateCount += 1;
      }
    });

    const sample = {
      state: this.state,
      worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
      productParent: this.productRoot.parent?.name || '(none)',
      modelParent: modelRoot.parent?.name || '(none)',
      worldAnchorParent: this.worldAnchorGroup.parent?.name || '(none)',
      productVisible: this.productRoot.visible,
      modelVisible: modelRoot.visible,
      worldAnchorVisible: this.worldAnchorGroup.visible,
      hiddenAncestor: this.firstHiddenAncestor(modelRoot)?.name || null,
      worldMatrixError: matrixError,
      anchorWorldPosition: this.vectorDescription(anchorPosition),
      anchorWorldQuaternion: this.quaternionDescription(anchorQuaternion),
      anchorTransformDeltaSincePreviousSample: anchorTransformDelta,
      productWorldScale: this.vectorDescription(productScale),
      modelWorldScale: this.vectorDescription(modelScale),
      modelWorldScaleRatioSincePreviousSample: scaleChange,
      modelBoundsWorldM: this.vectorDescription(modelBoundsSize),
      cameraPosition: this.vectorDescription(this.currentAnchorCameraPosition),
      cameraMovementSincePreviousSampleM: cameraMovementSincePreviousSample === null
        ? null
        : Number(cameraMovementSincePreviousSample.toFixed(4)),
      modelCenterWorld: this.vectorDescription(modelBoundsCenter),
      cameraDistanceToModelM: Number(cameraDistance.toFixed(4)),
      cameraDistanceDeltaSincePreviousSampleM: cameraDistanceDeltaSincePreviousSample === null
        ? null
        : Number(cameraDistanceDeltaSincePreviousSample.toFixed(4)),
      sampleIntervalMs: this.previousVisualSample
        ? Number((sampleAt - this.previousVisualSample.sampledAt).toFixed(1))
        : null,
      projectedSizeCssPx: projection ? { width: Number(projection.widthPx.toFixed(1)), height: Number(projection.heightPx.toFixed(1)) } : null,
      projectedCenterViewport: projection && projection.centerX !== null && projection.centerY !== null
        ? { x: Number(projection.centerX.toFixed(4)), y: Number(projection.centerY.toFixed(4)) }
        : null,
      projectedBoundsIntersectsViewport: projection?.intersectsViewport ?? null,
      projectedBoundsFullyInsideViewport: projection?.fullyInsideViewport ?? null,
      projectedCenterDeltaCssPxSincePreviousSample: projectedCenterDeltaPx,
      projectedBoundsVisibleFraction: projection ? Number(projection.visibleFraction.toFixed(4)) : null,
      projectedBoundsViewportCoverage: projection ? Number(projection.viewportCoverage.toFixed(4)) : null,
      projectedBoundsInFrontOfCamera: projection?.inFront ?? null,
      apparentSizeRatioSincePreviousSample: apparentWidthRatio === null || apparentHeightRatio === null
        ? null
        : { width: Number(apparentWidthRatio.toFixed(4)), height: Number(apparentHeightRatio.toFixed(4)) },
      perspectiveAndScaleExpectedSizeRatio: expectedPerspectiveRatio === null ? null : Number(expectedPerspectiveRatio.toFixed(4)),
      perspectiveAdjustedWidthRatio: apparentWidthRatio === null || expectedPerspectiveRatio === null || Math.abs(expectedPerspectiveRatio) < 1e-6
        ? null
        : Number((apparentWidthRatio / expectedPerspectiveRatio).toFixed(4)),
      meshCount,
      hiddenMeshCount,
      meshOutsideCameraFrustumEstimateCount: frustumOutsideMeshEstimateCount,
      viewportCssPx: this.diagnosticCanvas
        ? { width: Math.round(this.diagnosticCanvas.getBoundingClientRect().width), height: Math.round(this.diagnosticCanvas.getBoundingClientRect().height) }
        : null,
      windowDurationMs: Math.round(windowDurationMs),
    };

    this.previousVisualSample = {
      distanceM: cameraDistance,
      worldScale: modelScale.clone(),
      projectedWidthPx: projection?.widthPx ?? 0,
      projectedHeightPx: projection?.heightPx ?? 0,
      projectedBoundsFullyInsideViewport: projection?.fullyInsideViewport ?? false,
      projectedCenterX: projection?.centerX ?? null,
      projectedCenterY: projection?.centerY ?? null,
      cameraPosition: this.currentAnchorCameraPosition.clone(),
      anchorPosition: anchorPosition.clone(),
      anchorQuaternion: anchorQuaternion.clone(),
      anchorScale: productScale.clone(),
      sampledAt: sampleAt,
    };
    return sample;
  }

  private projectModelBounds(bounds: THREE.Box3): {
    widthPx: number;
    heightPx: number;
    centerX: number | null;
    centerY: number | null;
    visibleFraction: number;
    viewportCoverage: number;
    inFront: boolean;
    intersectsViewport: boolean;
    fullyInsideViewport: boolean;
  } | null {
    const canvas = this.diagnosticCanvas;
    const camera = this.camera;
    if (!canvas || !camera || bounds.isEmpty()) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    camera.updateWorldMatrix(true, false);
    const min = bounds.min;
    const max = bounds.max;
    const perspectiveCamera = camera as THREE.PerspectiveCamera;
    const near = perspectiveCamera.isPerspectiveCamera ? perspectiveCamera.near : 0.01;
    const far = perspectiveCamera.isPerspectiveCamera ? perspectiveCamera.far : Infinity;
    const cameraCorners: THREE.Vector3[] = [];
    const projectedPoints: THREE.Vector3[] = [];
    const addProjectedPoint = (point: THREE.Vector3) => {
      const projected = point.clone().applyMatrix4(camera.projectionMatrix);
      if (Number.isFinite(projected.x) && Number.isFinite(projected.y) && Number.isFinite(projected.z)) {
        projectedPoints.push(projected);
      }
    };

    for (let ix = 0; ix < 2; ix += 1) {
      for (let iy = 0; iy < 2; iy += 1) {
        for (let iz = 0; iz < 2; iz += 1) {
          cameraCorners.push(new THREE.Vector3(
            ix === 0 ? min.x : max.x,
            iy === 0 ? min.y : max.y,
            iz === 0 ? min.z : max.z
          ).applyMatrix4(camera.matrixWorldInverse));
        }
      }
    }

    // Clip the 3D box against the camera near/far planes before perspective
    // division. Projecting a corner behind the camera or at the near plane
    // produces enormous and misleading pixel sizes.
    for (const point of cameraCorners) {
      const depth = -point.z;
      if (depth >= near && depth <= far) addProjectedPoint(point);
    }
    for (let index = 0; index < cameraCorners.length; index += 1) {
      for (const bit of [1, 2, 4]) {
        if ((index & bit) !== 0) continue;
        const a = cameraCorners[index];
        const b = cameraCorners[index | bit];
        const depthA = -a.z;
        const depthB = -b.z;
        for (const planeDepth of [near, far]) {
          const crossesPlane = (depthA < planeDepth && depthB > planeDepth) ||
            (depthB < planeDepth && depthA > planeDepth);
          if (!crossesPlane || !Number.isFinite(planeDepth)) continue;
          const t = (planeDepth - depthA) / (depthB - depthA);
          const intersection = a.clone().lerp(b, t);
          intersection.z = -planeDepth;
          addProjectedPoint(intersection);
        }
      }
    }

    if (projectedPoints.length === 0) {
      return {
        widthPx: 0,
        heightPx: 0,
        centerX: null,
        centerY: null,
        visibleFraction: 0,
        viewportCoverage: 0,
        inFront: false,
        intersectsViewport: false,
        fullyInsideViewport: false,
      };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of projectedPoints) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }

    const rawWidth = Math.max(0, maxX - minX);
    const rawHeight = Math.max(0, maxY - minY);
    const clippedMinX = Math.max(minX, -1);
    const clippedMaxX = Math.min(maxX, 1);
    const clippedMinY = Math.max(minY, -1);
    const clippedMaxY = Math.min(maxY, 1);
    const visibleWidth = Math.max(0, clippedMaxX - clippedMinX);
    const visibleHeight = Math.max(0, clippedMaxY - clippedMinY);
    const totalArea = rawWidth * rawHeight;
    const visibleFraction = totalArea > 1e-8 ? (visibleWidth * visibleHeight) / totalArea : 0;
    const centerWorld = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
    const centerCamera = centerWorld.applyMatrix4(camera.matrixWorldInverse);
    const centerDepth = -centerCamera.z;
    let centerX: number | null = null;
    let centerY: number | null = null;
    if (centerDepth >= near && centerDepth <= far) {
      const projectedCenter = centerCamera.applyMatrix4(camera.projectionMatrix);
      if (Number.isFinite(projectedCenter.x) && Number.isFinite(projectedCenter.y)) {
        centerX = projectedCenter.x * 0.5 + 0.5;
        centerY = 0.5 - projectedCenter.y * 0.5;
      }
    }
    return {
      widthPx: visibleWidth * rect.width / 2,
      heightPx: visibleHeight * rect.height / 2,
      centerX,
      centerY,
      visibleFraction,
      viewportCoverage: (visibleWidth * visibleHeight) / 4,
      inFront: projectedPoints.length > 0,
      intersectsViewport: visibleWidth > 0 && visibleHeight > 0,
      fullyInsideViewport: minX >= -1 && maxX <= 1 && minY >= -1 && maxY <= 1,
    };
  }

  private vectorRatio(current: THREE.Vector3, previous: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(
      Math.abs(previous.x) > 1e-8 ? current.x / previous.x : 1,
      Math.abs(previous.y) > 1e-8 ? current.y / previous.y : 1,
      Math.abs(previous.z) > 1e-8 ? current.z / previous.z : 1
    );
  }

  /**
   * Detects impossible camera pose jumps after handoff. XR8 exposes tracking
   * status but no origin-change matrix in this runtime. During LIMITED or just
   * after SLAM recovers, a >1m pose jump in one frame is treated as a possible
   * coordinate-frame change and the world anchor follows the camera-frame delta.
   */
  private monitorAnchorCameraPose(): void {
    if (!this.camera || !this.isWorldCameraPoseValid()) {
      this.hasPreviousAnchorCameraSample = false;
      return;
    }

    this.currentAnchorCameraMatrix.copy(this.camera.matrixWorld);
    this.camera.getWorldPosition(this.currentAnchorCameraPosition);
    this.camera.getWorldQuaternion(this.currentAnchorCameraQuaternion);
    const now = performance.now();

    if (this.hasPreviousAnchorCameraSample) {
      const elapsedMs = now - this.previousAnchorCameraSampleAt;
      const translationStep = this.currentAnchorCameraPosition.distanceTo(this.previousAnchorCameraPosition);
      const rotationStep = this.currentAnchorCameraQuaternion.angleTo(this.previousAnchorCameraQuaternion);
      this.peakAnchorCameraPositionStep = Math.max(this.peakAnchorCameraPositionStep, translationStep);
      this.peakAnchorCameraRotationStep = Math.max(this.peakAnchorCameraRotationStep, rotationStep);

      const isShortStep = elapsedMs > 0 && elapsedMs < 120;
      const isPoseDiscontinuity = translationStep > 0.35 || rotationStep > THREE.MathUtils.degToRad(35);
      if (isShortStep && !isPoseDiscontinuity) {
        const elapsedSeconds = elapsedMs / 1000;
        const velocity = this.currentAnchorCameraPosition.clone().sub(this.previousAnchorCameraPosition).multiplyScalar(1 / elapsedSeconds);
        const speed = velocity.length();
        this.peakCameraSpeedMps = Math.max(this.peakCameraSpeedMps, speed);
        this.peakCameraRotationRateDegPerSec = Math.max(
          this.peakCameraRotationRateDegPerSec,
          THREE.MathUtils.radToDeg(rotationStep / elapsedSeconds)
        );
        if (this.hasPreviousCameraVelocity) {
          this.peakCameraAccelerationMps2 = Math.max(
            this.peakCameraAccelerationMps2,
            velocity.distanceTo(this.previousCameraVelocity) / elapsedSeconds
          );
        }
        this.previousCameraVelocity.copy(velocity);
        this.hasPreviousCameraVelocity = true;
      } else {
        this.hasPreviousCameraVelocity = false;
      }
      if (isShortStep && isPoseDiscontinuity) {
        const trackingRecoveryWindowActive = now <= this.worldTrackingRecoveryUntil;
        const shouldRebase = (this.worldTrackingStatus === 'LIMITED' || trackingRecoveryWindowActive) &&
          (translationStep >= ImageTrackingController.ORIGIN_SHIFT_REBASE_DISTANCE_M ||
            rotationStep >= THREE.MathUtils.degToRad(ImageTrackingController.ORIGIN_SHIFT_REBASE_ROTATION_DEG));

        const rebased = shouldRebase && this.rebaseWorldAnchorForCameraFrameShift(
          this.previousAnchorCameraMatrix,
          this.currentAnchorCameraMatrix,
          translationStep,
          rotationStep,
          elapsedMs
        );

        traceAR(rebased ? 'WORLD_ANCHOR_REBASED_AFTER_CAMERA_FRAME_SHIFT' : 'WORLD_CAMERA_POSE_DISCONTINUITY_AFTER_ANCHOR', {
          translationM: translationStep,
          rotationDeg: THREE.MathUtils.radToDeg(rotationStep),
          elapsedMs,
          cameraPositionBefore: this.vectorDescription(this.previousAnchorCameraPosition),
          cameraPositionAfter: this.vectorDescription(this.currentAnchorCameraPosition),
          worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
          productParent: this.productRoot.parent?.name || '(none)',
          action: rebased
            ? 'rebase world anchor by newCameraWorld * inverse(oldCameraWorld)'
            : 'retain world anchor; discontinuity is not a confirmed origin shift',
          reason: shouldRebase
            ? (rebased ? 'catastrophic pose jump while world tracking LIMITED' : 'anchor rebase failed matrix validation')
            : 'below safe origin-shift rebase threshold or tracking is not LIMITED',
          limitation: 'inferred from camera pose continuity; XR8 exposes no origin-change transform here',
        }, 'warn');
      }
    }

    this.previousAnchorCameraPosition.copy(this.currentAnchorCameraPosition);
    this.previousAnchorCameraQuaternion.copy(this.currentAnchorCameraQuaternion);
    this.previousAnchorCameraMatrix.copy(this.currentAnchorCameraMatrix);
    this.previousAnchorCameraSampleAt = now;
    this.hasPreviousAnchorCameraSample = true;
  }

  private rebaseWorldAnchorForCameraFrameShift(
    oldCameraWorld: THREE.Matrix4,
    newCameraWorld: THREE.Matrix4,
    translationStep: number,
    rotationStep: number,
    elapsedMs: number
  ): boolean {
    const parent = this.worldAnchorGroup.parent;
    if (!parent || this.productRoot.parent !== this.worldAnchorGroup) return false;
    const debugAnchorBefore = worldTrackingDebugger.captureTransform(this.worldAnchorGroup);
    const debugProductBefore = worldTrackingDebugger.captureTransform(this.productRoot);

    parent.updateWorldMatrix(true, false);
    this.worldAnchorGroup.updateWorldMatrix(true, false);
    this.productRoot.updateWorldMatrix(true, true);

    const parentDeterminant = parent.matrixWorld.determinant();
    const oldCameraDeterminant = oldCameraWorld.determinant();
    const cameraDeterminant = newCameraWorld.determinant();
    if (!Number.isFinite(parentDeterminant) || Math.abs(parentDeterminant) < 1e-10 ||
      !Number.isFinite(oldCameraDeterminant) || Math.abs(oldCameraDeterminant) < 1e-10 ||
      !Number.isFinite(cameraDeterminant) || Math.abs(cameraDeterminant) < 1e-10) {
      return false;
    }

    const oldProductWorld = this.productRoot.matrixWorld.clone();
    const worldFrameDelta = newCameraWorld.clone().multiply(oldCameraWorld.clone().invert());
    const rebasedAnchorWorld = worldFrameDelta.clone().multiply(this.worldAnchorGroup.matrixWorld);
    const rebasedAnchorLocal = parent.matrixWorld.clone().invert().multiply(rebasedAnchorWorld);
    const nextPosition = new THREE.Vector3();
    const nextQuaternion = new THREE.Quaternion();
    const nextScale = new THREE.Vector3();
    rebasedAnchorLocal.decompose(nextPosition, nextQuaternion, nextScale);
    const reconstructedAnchorLocal = new THREE.Matrix4().compose(nextPosition, nextQuaternion, nextScale);
    const decompositionError = this.maxMatrixDifference(rebasedAnchorLocal, reconstructedAnchorLocal);

    if (!this.isFiniteVector(nextPosition) || !this.isFiniteQuaternion(nextQuaternion) ||
      !this.isFiniteVector(nextScale) || Math.abs(nextScale.x * nextScale.y * nextScale.z) < 1e-12 ||
      decompositionError > ImageTrackingController.MATRIX_ERROR_TOLERANCE) {
      return false;
    }

    const oldAnchorWorld = this.worldAnchorGroup.matrixWorld.clone();
    this.worldAnchorGroup.position.copy(nextPosition);
    this.worldAnchorGroup.quaternion.copy(nextQuaternion);
    this.worldAnchorGroup.scale.copy(nextScale);
    this.worldAnchorGroup.updateMatrix();
    this.worldAnchorGroup.updateWorldMatrix(true, true);
    this.productRoot.updateWorldMatrix(true, true);

    const expectedNewProductWorld = worldFrameDelta.clone().multiply(oldProductWorld);
    const matrixError = this.maxMatrixDifference(this.productRoot.matrixWorld, expectedNewProductWorld);
    if (!Number.isFinite(matrixError) || matrixError > ImageTrackingController.MATRIX_ERROR_TOLERANCE) {
      const restoreLocal = parent.matrixWorld.clone().invert().multiply(oldAnchorWorld);
      restoreLocal.decompose(this.worldAnchorGroup.position, this.worldAnchorGroup.quaternion, this.worldAnchorGroup.scale);
      this.worldAnchorGroup.updateMatrix();
      this.worldAnchorGroup.updateWorldMatrix(true, true);
      this.productRoot.updateWorldMatrix(true, true);
      worldTrackingDebugger.recordTransformWrite(
        'ANCHOR',
        'COMPENSATION_ROLLED_BACK',
        'ImageTrackingController.rebaseWorldAnchorForCameraFrameShift',
        this.worldAnchorGroup,
        debugAnchorBefore,
        'Product world matrix verification failed; restore previous anchor transform.',
        {
          attemptedCompensationMatrix: worldFrameDelta.toArray(),
          attemptedProductWorldMatrix: expectedNewProductWorld.toArray(),
          verificationError: matrixError,
          translationStepM: translationStep,
          rotationStepDeg: THREE.MathUtils.radToDeg(rotationStep),
        }
      );
      return false;
    }

    this.expectedWorldMatrix = this.productRoot.matrixWorld.clone();
    worldTrackingDebugger.recordTransformWrite(
      'ANCHOR',
      'COMPENSATION_APPLIED',
      'ImageTrackingController.rebaseWorldAnchorForCameraFrameShift',
      this.worldAnchorGroup,
      debugAnchorBefore,
      'Rebase anchor by camera frame delta after a large pose discontinuity while tracking is LIMITED or in recovery window.',
      {
        compensationMatrix: worldFrameDelta.toArray(),
        oldCameraWorldMatrix: oldCameraWorld.toArray(),
        newCameraWorldMatrix: newCameraWorld.toArray(),
        productWorldBefore: oldProductWorld.toArray(),
        productWorldAfter: this.productRoot.matrixWorld.toArray(),
        productWorldDeltaFromCompensation: this.productRoot.matrixWorld.clone().multiply(oldProductWorld.clone().invert()).toArray(),
        productTransformBefore: debugProductBefore,
        productTransformAfter: worldTrackingDebugger.captureTransform(this.productRoot),
        matrixVerificationError: matrixError,
        translationStepM: translationStep,
        rotationStepDeg: THREE.MathUtils.radToDeg(rotationStep),
        elapsedMs,
        trackingStatus: this.worldTrackingStatus,
        trackingReason: this.worldTrackingReason,
      }
    );
    traceAR('WORLD_ANCHOR_FRAME_REBASE_DETAILS', {
      translationM: translationStep,
      rotationDeg: THREE.MathUtils.radToDeg(rotationStep),
      elapsedMs,
      oldAnchorWorld: this.transformDescription(oldAnchorWorld),
      newAnchorWorld: this.transformDescription(this.worldAnchorGroup.matrixWorld),
      productWorldMatrixError: matrixError,
      cameraRelativePosePreserved: true,
    });
    logger.log(
      'warn',
      `[AR_ANCHOR] Rebased world anchor after an impossible LIMITED camera pose jump (${translationStep.toFixed(2)}m/${THREE.MathUtils.radToDeg(rotationStep).toFixed(1)}deg in ${elapsedMs.toFixed(0)}ms); matrixError=${matrixError.toExponential(2)}`
    );
    return true;
  }

  /**
   * Image Tracking → Camera-Locked:
   * Detaches ProductRoot from ImageTargetAnchor / WorldAnchor and attaches it
   * directly to the AR Camera, fixing its relative transform in front of the camera.
   * Completely stops any further tracking updates to eliminate jitter, drift, and conflicts.
   */
  public detachIntoCamera(): boolean {
    if (this.isCameraLocked) return true;
    if (!this.camera) {
      logger.log('warn', '[AR_ANCHOR] Cannot lock to AR camera: camera reference is missing.');
      return false;
    }

    const originalParent = this.productRoot.parent;
    if (!originalParent) {
      logger.log('warn', '[AR_ANCHOR] ProductRoot has no parent.');
      return false;
    }

    // 1. Ensure camera is part of the scene graph so its children are traversed by WebGLRenderer
    const scene = this.targetGroup.parent || (this.camera as any).parent;
    if (scene && this.camera.parent !== scene) {
      scene.add(this.camera);
    }

    // 2. Ensure all world matrices are fully up to date before reparenting
    this.targetGroup.updateWorldMatrix(true, true);
    this.productRoot.updateWorldMatrix(true, true);
    this.camera.updateWorldMatrix(true, true);

    const capturedWorldMatrix = this.productRoot.matrixWorld.clone();
    const debugProductBefore = worldTrackingDebugger.captureTransform(this.productRoot);

    // 3. Attach productRoot directly to the camera while maintaining its exact world transform
    this.camera.attach(this.productRoot);

    // 4. Update and verify matrix consistency
    this.productRoot.updateMatrix();
    this.productRoot.updateWorldMatrix(true, true);

    const finalError = this.maxMatrixDifference(this.productRoot.matrixWorld, capturedWorldMatrix);

    // 5. Hide old image target and world anchor groups; keep productRoot visible
    this.targetGroup.visible = false;
    this.worldAnchorGroup.visible = false;
    this.productRoot.visible = true;

    // 6. Set state to ANCHORED (Camera-Locked)
    this.isCameraLocked = true;
    this.state = 'ANCHORED';
    this.isTracked = true;
    this.hasPose = true;
    this.expectedWorldMatrix = capturedWorldMatrix;

    // 7. Initialize smooth cubic-ease-out centering transition to dead center of camera view
    this.centerStartPos.copy(this.productRoot.position);
    this.centerStartQuat.copy(this.productRoot.quaternion).normalize();
    this.centerStartScale.copy(this.productRoot.scale);

    this.getOptimalCenterTransform(this.targetCenterPos, this.targetCenterQuat, this.targetCenterScale);

    this.isCentering = true;
    this.centerStartTime = performance.now();
    this.centerDurationMs = 400;

    worldTrackingDebugger.recordTransformWrite(
      'MODEL',
      'CAMERA_LOCK_ATTACHED',
      'ImageTrackingController.detachIntoCamera',
      this.productRoot,
      debugProductBefore,
      'Attached ProductRoot directly to AR Camera while preserving its exact world transform.',
      {
        oldParent: originalParent.name || originalParent.type,
        newParent: this.camera.name || this.camera.type,
        localPosition: this.productRoot.position.toArray(),
        localQuaternion: this.productRoot.quaternion.toArray(),
        localScale: this.productRoot.scale.toArray(),
        worldMatrixError: finalError,
      }
    );

    traceAR('CAMERA_LOCK_ESTABLISHED', {
      cameraPosition: this.cameraWorldPosition(),
      productLocalPosition: this.vectorDescription(this.productRoot.position),
      productLocalScale: this.vectorDescription(this.productRoot.scale),
      worldMatrixError: finalError,
      parent: this.productRoot.parent?.name || '(none)',
    });

    reportCameraDiagnostic(
      'Camera-Locked AR',
      `Locked to AR camera; pos=${this.vectorDescription(this.productRoot.position)}; scale=${this.vectorDescription(this.productRoot.scale)}; error=${finalError.toExponential(2)}`
    );

    logger.log(
      'info',
      `[AR_ANCHOR] 🔒 Image Tracking → Camera-Locked complete! Model is attached to AR camera; matrixError=${finalError.toExponential(2)}`
    );

    return true;
  }

  /**
   * Computes device-aspect-aware target transform so the serum model and all 3
   * active ingredient badges remain centered and fully visible within screen bounds.
   */
  public getOptimalCenterTransform(
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
    outScale: THREE.Vector3
  ): void {
    const width = typeof window !== 'undefined' ? window.innerWidth : 390;
    const height = typeof window !== 'undefined' ? window.innerHeight : 844;
    const aspect = width / Math.max(1, height);

    if (aspect < 1.0) {
      // Mobile portrait mode:
      // Scale dynamically tuned so side badges (HA and Vitamin C) have comfortable margin as the model rotates
      const baseScale = 0.76;
      const scaleMultiplier = Math.min(1.0, Math.max(0.85, aspect / 0.52));
      const s = baseScale * scaleMultiplier;

      // Position: x=0 (exact horizontal center), y=-0.16 (bottle center at screen center with 1.25x model size), z=-1.14
      outPos.set(0, -0.16 * (s / 0.76), -1.14);
      // Down-pitch angle (~6.4°) matching luxury commercial hero view
      outQuat.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(6.4), 0, 0, 'YXZ')).normalize();
      outScale.set(s, s, s);
    } else {
      // Landscape mode (desktop simulation / tablet landscape):
      const s = 0.95;
      outPos.set(0, -0.18, -1.08);
      outQuat.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(6.4), 0, 0, 'YXZ')).normalize();
      outScale.set(s, s, s);
    }
  }

  /**
   * Called on window resize / orientation change to keep the model centered and appropriately scaled.
   */
  public handleResize(): void {
    if (!this.isCameraLocked || !this.camera) return;
    this.getOptimalCenterTransform(this.targetCenterPos, this.targetCenterQuat, this.targetCenterScale);
    if (!this.isCentering) {
      this.productRoot.position.copy(this.targetCenterPos);
      this.productRoot.quaternion.copy(this.targetCenterQuat);
      this.productRoot.scale.copy(this.targetCenterScale);
      this.productRoot.updateMatrix();
    }
  }

  /**
   * Immediately snaps to camera-locked centered state (useful for simulations and testing).
   */
  public lockToCameraAtCenter(): void {
    if (this.detachIntoCamera()) {
      this.getOptimalCenterTransform(this.targetCenterPos, this.targetCenterQuat, this.targetCenterScale);
      this.productRoot.position.copy(this.targetCenterPos);
      this.productRoot.quaternion.copy(this.targetCenterQuat);
      this.productRoot.scale.copy(this.targetCenterScale);
      this.productRoot.updateMatrix();
      this.isCentering = false;
    }
  }

  private detachIntoWorldAnchor(): boolean {
    if (this.state === 'ANCHORED') return true;
    const originalParent = this.productRoot.parent;
    const now = performance.now();
    if (this.lastHandoffAttemptTraceAt === 0 || now - this.lastHandoffAttemptTraceAt >= 1000) {
      this.lastHandoffAttemptTraceAt = now;
      traceAR('HANDOFF_ATTEMPT', {
        state: this.state,
        imageUpdates: this.imageUpdateCount,
        targetParent: this.targetGroup.parent?.name || '(none)',
        productParent: originalParent?.name || '(none)',
        worldAnchorParent: this.worldAnchorGroup.parent?.name || '(none)',
        worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
      });
    }
    if (!originalParent || originalParent !== this.targetGroup) {
      this.logHandoffFailure(`ProductRoot has unexpected parent ${originalParent?.name ?? '(none)'}.`);
      return false;
    }
    if (!this.worldAnchorGroup.parent || this.worldAnchorGroup.parent !== this.targetGroup.parent) {
      this.logHandoffFailure('Image target and world anchor are not attached to the same XR scene.');
      return false;
    }
    if (!this.productRoot.matrixAutoUpdate) {
      this.logHandoffFailure('ProductRoot has matrixAutoUpdate disabled; refusing an unsafe TRS handoff.');
      return false;
    }

    // Update both chains before capturing the exact displayed product transform.
    this.targetGroup.updateWorldMatrix(true, true);
    this.productRoot.updateWorldMatrix(true, true);
    this.worldAnchorGroup.updateWorldMatrix(true, false);
    const debugProductBefore = worldTrackingDebugger.captureTransform(this.productRoot);
    const debugAnchorBefore = worldTrackingDebugger.captureTransform(this.worldAnchorGroup);
    const capturedWorldMatrix = this.productRoot.matrixWorld.clone();
    const originalPosition = this.productRoot.position.clone();
    const originalQuaternion = this.productRoot.quaternion.clone();
    const originalScale = this.productRoot.scale.clone();
    const oldWorldAnchorVisibility = this.worldAnchorGroup.visible;

    const determinant = this.worldAnchorGroup.matrixWorld.determinant();
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) {
      this.logHandoffFailure('World anchor parent matrix is singular.');
      return false;
    }

    const inverseAnchorWorld = this.worldAnchorGroup.matrixWorld.clone().invert();
    const newLocalMatrix = inverseAnchorWorld.multiply(capturedWorldMatrix);
    const newPosition = new THREE.Vector3();
    const newQuaternion = new THREE.Quaternion();
    const newScale = new THREE.Vector3();
    newLocalMatrix.decompose(newPosition, newQuaternion, newScale);
    const recomposedLocalMatrix = new THREE.Matrix4().compose(newPosition, newQuaternion, newScale);
    const reconstructedWorldMatrix = this.worldAnchorGroup.matrixWorld.clone().multiply(recomposedLocalMatrix);
    const decompositionError = this.maxMatrixDifference(reconstructedWorldMatrix, capturedWorldMatrix);

    if (!this.isFiniteVector(newPosition) || !this.isFiniteQuaternion(newQuaternion) ||
      !this.isFiniteVector(newScale) || Math.abs(newScale.x * newScale.y * newScale.z) < 1e-12 ||
      decompositionError > ImageTrackingController.MATRIX_ERROR_TOLERANCE) {
      this.logHandoffFailure(
        `World matrix cannot be represented by position/quaternion/scale (max error ${decompositionError.toExponential(2)}).`
      );
      return false;
    }

    const before = this.transformDescription(capturedWorldMatrix);
    traceAR('HANDOFF_CAPTURED_WORLD_TRANSFORM', {
      sourceParent: originalParent.name,
      worldTransform: before,
      targetLocalPosition: this.vectorDescription(this.productRoot.position),
      targetLocalQuaternion: this.quaternionDescription(this.productRoot.quaternion),
      targetLocalScale: this.vectorDescription(this.productRoot.scale),
      worldAnchorLocalPosition: this.vectorDescription(this.worldAnchorGroup.position),
      cameraPosition: this.cameraWorldPosition(),
    });
    logger.log(
      'info',
      `[AR_ANCHOR] Detaching model; state=${this.state}; parent=${originalParent.name}; world=${before}; camera=${this.cameraWorldPosition()}`
    );

    this.worldAnchorGroup.add(this.productRoot);
    this.productRoot.position.copy(newPosition);
    this.productRoot.quaternion.copy(newQuaternion);
    this.productRoot.scale.copy(newScale);
    this.productRoot.updateMatrix();
    this.productRoot.updateWorldMatrix(true, true);

    const finalError = this.maxMatrixDifference(this.productRoot.matrixWorld, capturedWorldMatrix);
    if (finalError > ImageTrackingController.MATRIX_ERROR_TOLERANCE) {
      const attemptedWorldMatrix = this.productRoot.matrixWorld.toArray();
      originalParent.add(this.productRoot);
      this.productRoot.position.copy(originalPosition);
      this.productRoot.quaternion.copy(originalQuaternion);
      this.productRoot.scale.copy(originalScale);
      this.productRoot.updateMatrix();
      this.productRoot.updateWorldMatrix(true, true);
      this.worldAnchorGroup.visible = oldWorldAnchorVisibility;
      worldTrackingDebugger.recordTransformWrite(
        'MODEL',
        'HANDOFF_ROLLED_BACK',
        'ImageTrackingController.detachIntoWorldAnchor',
        this.productRoot,
        debugProductBefore,
        'World-matrix verification failed after reparent; restore original parent and local TRS.',
        {
          attemptedParent: this.worldAnchorGroup.name || this.worldAnchorGroup.type,
          restoredParent: originalParent.name || originalParent.type,
          attemptedWorldMatrix,
          capturedWorldMatrix: capturedWorldMatrix.toArray(),
          verificationError: finalError,
        }
      );
      traceAR('HANDOFF_ROLLED_BACK', {
        reason: 'world transform verification failed after reparent',
        maxMatrixError: finalError,
        parentRestored: this.productRoot.parent === originalParent,
      }, 'error');
      this.logHandoffFailure(`World transform verification failed after reparent (max error ${finalError.toExponential(2)}).`);
      return false;
    }

    this.expectedWorldMatrix = capturedWorldMatrix;
    worldTrackingDebugger.recordTransformWrite(
      'MODEL',
      'HANDOFF_REPARENT',
      'ImageTrackingController.detachIntoWorldAnchor',
      this.productRoot,
      debugProductBefore,
      'Reparent ProductRoot from ImageTargetAnchor to SerumWorldAnchor while preserving its captured world matrix.',
      {
        oldParent: originalParent.name || originalParent.type,
        newParent: this.worldAnchorGroup.name || this.worldAnchorGroup.type,
        capturedWorldMatrix: capturedWorldMatrix.toArray(),
        finalWorldMatrix: this.productRoot.matrixWorld.toArray(),
        worldMatrixError: finalError,
        anchorTransformBefore: debugAnchorBefore,
      }
    );
    worldTrackingDebugger.recordTransformWrite(
      'ANCHOR',
      'WORLD_ANCHOR_ESTABLISHED',
      'ImageTrackingController.detachIntoWorldAnchor',
      this.worldAnchorGroup,
      debugAnchorBefore,
      'Establish diagnostic world-anchor reference after verified image-to-world handoff.',
      {
        capturedProductWorldMatrix: capturedWorldMatrix.toArray(),
        productTransformAfter: worldTrackingDebugger.captureTransform(this.productRoot),
        worldMatrixError: finalError,
      }
    );
    this.worldAnchorGroup.visible = true;
    this.isTracked = true;
    this.handoffFailureLogged = false;
    this.lastHandoffFailureReason = '';
    this.resetStabilityWindow();
    this.worldLockEstablishedAt = performance.now();
    this.transitionTo('ANCHORED', 'world matrix verified after reparent');
    logger.log(
      'info',
      `[AR_ANCHOR] Handoff verified; parent=${this.productRoot.parent?.name}; world=${this.transformDescription(this.productRoot.matrixWorld)}; maxMatrixError=${finalError.toExponential(2)}`
    );
    reportCameraDiagnostic(
      'World Anchor',
      `ANCHORED; parent=${this.productRoot.parent?.name}; ${this.transformDescription(this.productRoot.matrixWorld)}; matrixError=${finalError.toExponential(2)}`
    );
    traceAR('HANDOFF_SUCCESS', {
      state: this.state,
      oldParent: originalParent.name,
      newParent: this.productRoot.parent?.name || '(none)',
      worldTransform: this.transformDescription(this.productRoot.matrixWorld),
      localTransform: `position=${this.vectorDescription(this.productRoot.position)} quaternion=${this.quaternionDescription(this.productRoot.quaternion)} scale=${this.vectorDescription(this.productRoot.scale)}`,
      maxMatrixError: finalError,
      cameraPosition: this.cameraWorldPosition(),
      imageEventsNowIgnored: true,
    });
    worldTrackingDebugger.recordEvent('ANCHOR', 'IMAGE_TO_WORLD_LOCKED', {
      establishedAtMonotonicMs: Number(this.worldLockEstablishedAt.toFixed(1)),
      oldParent: originalParent.name || originalParent.type,
      newParent: this.productRoot.parent?.name || '(none)',
      worldPosition: this.vectorDescription(this.productRoot.getWorldPosition(this.diagnosticSerumWorldPosition)),
      worldScale: this.vectorDescription(this.productRoot.getWorldScale(new THREE.Vector3())),
      worldMatrixError: Number(finalError.toExponential(3)),
      imageTrackingCallbacksIgnoredAfterHandoff: true,
    }, { bridge: true });
    this.recordApproachDiagnostics();
    return true;
  }

  private isWorldCameraPoseValid(): boolean {
    if (!this.camera) return false;
    this.camera.updateWorldMatrix(true, false);
    const elements = this.camera.matrixWorld.elements;
    if (!elements.every(Number.isFinite) || Math.abs(this.camera.matrixWorld.determinant()) < 1e-10) return false;
    const quaternion = this.camera.getWorldQuaternion(new THREE.Quaternion());
    return this.isFiniteQuaternion(quaternion) && quaternion.lengthSq() > 0.5;
  }

  private isValidPose(pose: ImagePose): boolean {
    return !!pose && this.isFiniteVector(pose.position) && this.isFiniteQuaternion(pose.quaternion) &&
      pose.quaternion.lengthSq() > 0.5 && Number.isFinite(pose.scale) && pose.scale > 0 &&
      (pose.scaledWidth === undefined || (Number.isFinite(pose.scaledWidth) && pose.scaledWidth > 0));
  }

  private isPoseStable(pose: ImagePose, now: number): boolean {
    if (this.stableSamples === 0) {
      this.resetStabilityWindow(pose, now);
      return false;
    }

    const positionDelta = this.stableReferencePosition.distanceTo(pose.position);
    const rotationDelta = this.stableReferenceQuaternion.angleTo(pose.quaternion);
    const scaleDelta = this.relativeDelta(this.stableReferenceScale, pose.scale);
    const widthDelta = pose.scaledWidth === undefined || this.stableReferenceWidth === undefined
      ? 0
      : this.relativeDelta(this.stableReferenceWidth, pose.scaledWidth);
    this.lastStabilityDelta = {
      position: positionDelta,
      rotation: rotationDelta,
      scale: scaleDelta,
      width: widthDelta,
    };

    const stable = positionDelta <= ImageTrackingController.STABLE_POSITION_DELTA &&
      rotationDelta <= ImageTrackingController.STABLE_ROTATION_DELTA &&
      scaleDelta <= ImageTrackingController.STABLE_SCALE_DELTA &&
      widthDelta <= ImageTrackingController.STABLE_WIDTH_DELTA;

    if (!stable) {
      this.resetStabilityWindow(pose, now);
      return false;
    }

    this.stableSamples += 1;
    return this.stableSamples >= ImageTrackingController.STABLE_SAMPLE_COUNT &&
      now - this.stableSince >= ImageTrackingController.STABLE_DURATION_MS;
  }

  private relativeDelta(reference: number, value: number): number {
    if (!Number.isFinite(reference) || !Number.isFinite(value)) return Infinity;
    return Math.abs(value - reference) / Math.max(Math.abs(reference), 1e-6);
  }

  private resetStabilityWindow(pose?: ImagePose, now = performance.now()): void {
    if (!pose) {
      this.stableSince = 0;
      this.stableSamples = 0;
      this.stableReferenceWidth = undefined;
      return;
    }

    this.stableReferencePosition.copy(pose.position);
    this.stableReferenceQuaternion.copy(pose.quaternion);
    this.stableReferenceScale = pose.scale;
    this.stableReferenceWidth = pose.scaledWidth;
    this.stableSince = now;
    this.stableSamples = 1;
  }

  /** Applies the existing 8th Wall image pose and upright model fit. */
  private applyPose(pose: ImagePose, rotationDeg = 0, instant = false): void {
    const applyStartedAt = performance.now();
    const debugTargetBefore = worldTrackingDebugger.captureTransform(this.targetGroup);
    const debugProductBefore = worldTrackingDebugger.captureTransform(this.productRoot);
    this.tmpTargetQuat.copy(pose.quaternion).normalize();

    if (rotationDeg !== 0) {
      const rad = (rotationDeg * Math.PI) / 180;
      this.tmpRotZ.setFromAxisAngle(ImageTrackingController.Z_AXIS, rad);
      this.tmpTargetQuat.multiply(this.tmpRotZ);
    }

    const s = pose.scale;
    let targetProductScale = this.productRoot.scale.x;
    // Keep the model's local Y axis inside the image plane (local XY).
    // A 90-degree X rotation points the bottle out of the image instead.
    const targetRotX = 0;

    if (typeof pose.scaledWidth === 'number' && pose.scaledWidth > 0 && this.normalizedModelWidth > 0) {
      const widthFitScale = (pose.scaledWidth * ImageTrackingController.MODEL_TARGET_COVERAGE) /
        this.normalizedModelWidth;
      const heightFitScale = typeof pose.scaledHeight === 'number' && pose.scaledHeight > 0 &&
        this.normalizedModelHeight > 0
        ? (pose.scaledHeight * ImageTrackingController.MODEL_TARGET_COVERAGE) / this.normalizedModelHeight
        : Infinity;
      targetProductScale = Math.min(widthFitScale, heightFitScale);
    }

    const now = performance.now();
    const elapsed = (now - this.lastPoseTimestamp) / 1000;
    const stalePoseSample = !Number.isFinite(elapsed) || elapsed > 0.45;
    const rawPositionStepM = this.hasPose ? pose.position.distanceTo(this.previousRawPosition) : null;
    const rawRotationStepDeg = this.hasPose
      ? THREE.MathUtils.radToDeg(this.previousRawQuaternion.angleTo(this.tmpTargetQuat))
      : null;
    const possibleCoordinateFrameReset = this.hasPose && stalePoseSample &&
      this.cameraPoseDiscontinuityAt > this.lastPoseTimestamp &&
      (this.worldTrackingStatus === 'LIMITED' || now <= this.worldTrackingRecoveryUntil);
    const resetFilter = this.imagePoseSmoothingDisabled || !this.hasPose || instant || !Number.isFinite(elapsed) || elapsed <= 0 || possibleCoordinateFrameReset;
    let effectiveDt = 0;
    let positionAlpha = 1;
    let rotationAlpha = 1;
    let imageScaleAlpha = 1;
    let productScaleAlpha = 1;
    let positionLambda = 0;
    let rotationLambda = 0;
    let imageScaleLambda = 0;
    let productScaleLambda = 0;
    let poseWriteReason = 'Image target pose updated with adaptive exponential smoothing.';

    if (resetFilter) {
      this.targetGroup.position.copy(pose.position);
      this.targetGroup.quaternion.copy(this.tmpTargetQuat);
      this.targetGroup.scale.setScalar(s);
      this.productRoot.scale.setScalar(targetProductScale);
      this.seedPoseFilter(pose.position, this.tmpTargetQuat, s, targetProductScale, now);
      this.hasPose = true;
      if (this.imagePoseSmoothingDisabled) {
        poseWriteReason = 'Debug override: image-pose smoothing disabled; apply each valid target pose directly for controlled comparison.';
      } else if (possibleCoordinateFrameReset) {
        poseWriteReason = 'Image pose filter re-seeded after a camera pose discontinuity during world-tracking recovery; interpolation across a possible coordinate-frame change is unsafe.';
      } else if (!Number.isFinite(elapsed) || elapsed <= 0) {
        poseWriteReason = 'Image pose filter re-seeded because the previous sample interval was invalid.';
      } else {
        poseWriteReason = 'Initial or explicitly instant image-target pose; no temporal smoothing was applied.';
      }
    } else {
      const reacquiredAfterGap = stalePoseSample;
      effectiveDt = reacquiredAfterGap
        ? ImageTrackingController.REACQUIRE_DELTA_SECONDS
        : THREE.MathUtils.clamp(elapsed, 1 / 240, ImageTrackingController.MAX_POSE_DELTA_SECONDS);
      if (reacquiredAfterGap) {
        // Do not let the long lost interval produce an unbounded velocity and a one-frame snap.
        this.filteredPositionVelocity.set(0, 0, 0);
        this.filteredAngularVelocity = 0;
        this.filteredScaleVelocity = 0;
        this.filteredProductScaleVelocity = 0;
      }

      this.tmpPositionDelta.subVectors(pose.position, this.previousRawPosition);
      this.tmpPositionVelocity.copy(this.tmpPositionDelta).multiplyScalar(1 / effectiveDt);
      if (reacquiredAfterGap && this.tmpPositionVelocity.length() > ImageTrackingController.MAX_REACQUIRE_POSITION_SPEED_MPS) {
        this.tmpPositionVelocity.setLength(ImageTrackingController.MAX_REACQUIRE_POSITION_SPEED_MPS);
      }
      const velocityAlpha = ImageTrackingController.smoothingAlpha(2 * Math.PI, effectiveDt);
      this.filteredPositionVelocity.lerp(this.tmpPositionVelocity, velocityAlpha);
      const positionSpeed = Math.max(0, this.filteredPositionVelocity.length() - 0.025);
      const positionCutoffHz = 0.85 + 2.5 * positionSpeed;
      positionLambda = 2 * Math.PI * positionCutoffHz;
      positionAlpha = ImageTrackingController.smoothingAlpha(positionLambda, effectiveDt);
      this.targetGroup.position.lerp(pose.position, positionAlpha);

      let angularVelocity = this.previousRawQuaternion.angleTo(this.tmpTargetQuat) / effectiveDt;
      if (reacquiredAfterGap) angularVelocity = Math.min(angularVelocity, ImageTrackingController.MAX_REACQUIRE_ROTATION_SPEED_RAD_PER_SEC);
      this.filteredAngularVelocity = THREE.MathUtils.lerp(this.filteredAngularVelocity, angularVelocity, velocityAlpha);
      const angularSpeed = Math.max(0, this.filteredAngularVelocity - THREE.MathUtils.degToRad(2));
      const rotationCutoffHz = 0.75 + 1.2 * angularSpeed;
      rotationLambda = 2 * Math.PI * rotationCutoffHz;
      rotationAlpha = ImageTrackingController.smoothingAlpha(rotationLambda, effectiveDt);
      this.targetGroup.quaternion.slerp(this.tmpTargetQuat, rotationAlpha);

      let scaleVelocity = Math.abs(s - this.previousRawScale) / effectiveDt;
      if (reacquiredAfterGap) scaleVelocity = Math.min(scaleVelocity, ImageTrackingController.MAX_REACQUIRE_SCALE_SPEED_PER_SEC);
      this.filteredScaleVelocity = THREE.MathUtils.lerp(this.filteredScaleVelocity, scaleVelocity, velocityAlpha);
      const imageScaleSpeed = Math.max(0, this.filteredScaleVelocity - 0.01);
      const imageScaleCutoffHz = 0.45 + 1.2 * imageScaleSpeed;
      imageScaleLambda = 2 * Math.PI * imageScaleCutoffHz;
      imageScaleAlpha = ImageTrackingController.smoothingAlpha(imageScaleLambda, effectiveDt);
      this.targetGroup.scale.setScalar(THREE.MathUtils.lerp(this.targetGroup.scale.x, s, imageScaleAlpha));

      let productScaleVelocity = Math.abs(targetProductScale - this.previousRawProductScale) / effectiveDt;
      if (reacquiredAfterGap) productScaleVelocity = Math.min(productScaleVelocity, ImageTrackingController.MAX_REACQUIRE_SCALE_SPEED_PER_SEC);
      this.filteredProductScaleVelocity = THREE.MathUtils.lerp(this.filteredProductScaleVelocity, productScaleVelocity, velocityAlpha);
      const productScaleSpeed = Math.max(0, this.filteredProductScaleVelocity - 0.01);
      const productScaleCutoffHz = 0.85 + 1.2 * productScaleSpeed;
      productScaleLambda = 2 * Math.PI * productScaleCutoffHz;
      productScaleAlpha = ImageTrackingController.smoothingAlpha(productScaleLambda, effectiveDt);
      this.productRoot.scale.setScalar(THREE.MathUtils.lerp(this.productRoot.scale.x, targetProductScale, productScaleAlpha));
      if (reacquiredAfterGap) poseWriteReason = 'Image pose reacquired in the same XR scene; filter velocities were reset and the pose is being eased from the last valid transform.';
    }

    this.storeRawPose(pose.position, this.tmpTargetQuat, s, targetProductScale, now);
    // Keep the existing fitted-height centering rule tied to the filtered fit scale.
    const fittedHeight = this.normalizedModelHeight * this.productRoot.scale.y;
    this.productRoot.position.set(0, -fittedHeight / 2, 0);
    this.productRoot.rotation.x = targetRotX;

    const smoothingDiagnostics = {
      rawIntervalSeconds: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
      poseEventRateFps: Number.isFinite(elapsed) && elapsed > 0 ? 1 / elapsed : null,
      rawPositionStepM,
      rawRotationStepDeg,
      deltaTimeSeconds: effectiveDt,
      effectiveInputFps: effectiveDt > 0 ? 1 / effectiveDt : null,
      positionAlpha,
      rotationAlpha,
      imageScaleAlpha,
      productScaleAlpha,
      positionLambdaPerSecond: positionLambda,
      rotationLambdaPerSecond: rotationLambda,
      imageScaleLambdaPerSecond: imageScaleLambda,
      productScaleLambdaPerSecond: productScaleLambda,
      reacquiredAfterGap: stalePoseSample && !resetFilter,
      possibleCoordinateFrameReset,
      imagePoseSmoothingEnabled: !this.imagePoseSmoothingDisabled,
      worldTrackingStatus: this.worldTrackingStatus,
      worldTrackingReason: this.worldTrackingReason,
      processingMs: performance.now() - applyStartedAt,
    };
    this.recordPoseTransformWrites(debugTargetBefore, debugProductBefore, pose, rotationDeg, poseWriteReason, smoothingDiagnostics);
    this.recordPoseSmoothingSample(pose, this.tmpTargetQuat, targetProductScale, smoothingDiagnostics, now);
  }

  private recordPoseTransformWrites(
    targetBefore: ReturnType<typeof worldTrackingDebugger.captureTransform>,
    productBefore: ReturnType<typeof worldTrackingDebugger.captureTransform>,
    pose: ImagePose,
    rotationDeg: number,
    reason: string,
    smoothingDiagnostics: Record<string, unknown>
  ): void {
    const posePayload = {
      targetName: pose.name,
      rawPosition: [pose.position.x, pose.position.y, pose.position.z],
      rawQuaternion: [pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w],
      rawScale: pose.scale,
      scaledWidth: pose.scaledWidth ?? null,
      scaledHeight: pose.scaledHeight ?? null,
      rotationDeg,
      smoothedPosition: [this.targetGroup.position.x, this.targetGroup.position.y, this.targetGroup.position.z],
      smoothedQuaternion: [this.targetGroup.quaternion.x, this.targetGroup.quaternion.y, this.targetGroup.quaternion.z, this.targetGroup.quaternion.w],
      smoothedImageScale: this.targetGroup.scale.x,
      targetProductScale: this.previousRawProductScale,
      smoothedProductScale: this.productRoot.scale.x,
      imagePoseSmoothingEnabled: !this.imagePoseSmoothingDisabled,
      smoothing: smoothingDiagnostics,
    };
    worldTrackingDebugger.recordTransformWrite(
      'ANCHOR',
      'IMAGE_TARGET_POSE_APPLIED',
      'ImageTrackingController.applyPose',
      this.targetGroup,
      targetBefore,
      reason,
      posePayload
    );
    worldTrackingDebugger.recordTransformWrite(
      'MODEL',
      'PRODUCT_IMAGE_FIT_APPLIED',
      'ImageTrackingController.applyPose',
      this.productRoot,
      productBefore,
      'Set ProductRoot fit scale, vertical centering offset, and upright X rotation from the smoothed image-target dimensions.',
      { ...posePayload, poseWriteReason: reason }
    );
  }

  private recordPoseSmoothingSample(
    pose: ImagePose,
    targetQuaternion: THREE.Quaternion,
    targetProductScale: number,
    smoothing: Record<string, unknown>,
    timestamp: number
  ): void {
    if (!worldTrackingDebugger.isEnabled || timestamp - this.lastPoseSmoothingSampleAt < 1000) return;
    this.lastPoseSmoothingSampleAt = timestamp;
    worldTrackingDebugger.recordEvent('ANCHOR', 'IMAGE_POSE_SMOOTHING_SAMPLE', {
      target: pose.name,
      trackingState: this.state,
      detected: this.isTracked,
      rawPosition: [pose.position.x, pose.position.y, pose.position.z],
      rawQuaternion: [pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w],
      correctedTargetQuaternion: [targetQuaternion.x, targetQuaternion.y, targetQuaternion.z, targetQuaternion.w],
      smoothedPosition: [this.targetGroup.position.x, this.targetGroup.position.y, this.targetGroup.position.z],
      smoothedQuaternion: [this.targetGroup.quaternion.x, this.targetGroup.quaternion.y, this.targetGroup.quaternion.z, this.targetGroup.quaternion.w],
      rawImageScale: pose.scale,
      smoothedImageScale: this.targetGroup.scale.x,
      targetProductScale,
      smoothedProductScale: this.productRoot.scale.x,
      imagePoseSmoothingEnabled: !this.imagePoseSmoothingDisabled,
      scaledWidth: pose.scaledWidth ?? null,
      scaledHeight: pose.scaledHeight ?? null,
      ...smoothing,
      poseConfidence: null,
      poseConfidenceAvailable: false,
      poseConfidenceNote: 'XR8 image-target pose events do not expose a per-target confidence value.',
    }, { bridge: true });
  }

  private seedPoseFilter(
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    scale: number,
    productScale: number,
    timestamp: number
  ): void {
    this.filteredPositionVelocity.set(0, 0, 0);
    this.filteredAngularVelocity = 0;
    this.filteredScaleVelocity = 0;
    this.filteredProductScaleVelocity = 0;
    this.storeRawPose(position, quaternion, scale, productScale, timestamp);
  }

  private storeRawPose(position: THREE.Vector3, quaternion: THREE.Quaternion, scale: number, productScale: number, timestamp: number): void {
    this.previousRawPosition.copy(position);
    this.previousRawQuaternion.copy(quaternion);
    this.previousRawScale = scale;
    this.previousRawProductScale = productScale;
    this.lastPoseTimestamp = timestamp;
  }

  private resetPoseFilter(): void {
    this.lastPoseTimestamp = 0;
    this.previousRawPosition.set(0, 0, 0);
    this.filteredPositionVelocity.set(0, 0, 0);
    this.previousRawQuaternion.identity();
    this.filteredAngularVelocity = 0;
    this.previousRawScale = 1;
    this.filteredScaleVelocity = 0;
    this.previousRawProductScale = 1;
    this.filteredProductScaleVelocity = 0;
  }

  private transitionTo(next: TrackingState, reason: string): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    worldTrackingDebugger.recordEvent('ANCHOR', 'ANCHOR_STATE_CHANGED', {
      previous,
      next,
      reason,
      imageTracked: this.isTracked,
      worldTrackingStatus: this.worldTrackingStatus,
      worldTrackingReason: this.worldTrackingReason,
      targetParent: this.targetGroup.parent?.name || this.targetGroup.parent?.type || null,
      productParent: this.productRoot.parent?.name || this.productRoot.parent?.type || null,
    }, { bridge: true });
    reportCameraDiagnostic('Anchor state', `${previous} -> ${next}; ${reason}`);
    traceAR('ANCHOR_STATE', {
      previous,
      next,
      reason,
      imageTracked: this.isTracked,
      worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
      productParent: this.productRoot.parent?.name || '(none)',
    });
    logger.log('info', `[AR_ANCHOR] ${previous} -> ${next}: ${reason}; camera=${this.cameraWorldPosition()}`);
  }

  private reportStabilityProgress(poseStable: boolean, blockedBy = ''): void {
    const elapsedMs = this.stableSince > 0 ? performance.now() - this.stableSince : 0;
    const cameraValid = this.isWorldCameraPoseValid();
    const message = `updates=${this.imageUpdateCount}; state=${this.state}; samples=${this.stableSamples}/${ImageTrackingController.STABLE_SAMPLE_COUNT}; stableMs=${elapsedMs.toFixed(0)}/${ImageTrackingController.STABLE_DURATION_MS}; poseStable=${poseStable}; world=${this.worldTrackingStatus}/${this.worldTrackingReason}; cameraValid=${cameraValid}; blockedBy=${blockedBy || 'pose/world stability'}; dPos=${this.lastStabilityDelta.position.toFixed(4)}m dRot=${THREE.MathUtils.radToDeg(this.lastStabilityDelta.rotation).toFixed(2)}deg dScale=${this.lastStabilityDelta.scale.toFixed(4)} dWidth=${this.lastStabilityDelta.width.toFixed(4)}`;
    reportCameraDiagnostic('Anchor stabilization', message);
    traceAR('STABILIZATION_PROGRESS', {
      imageUpdates: this.imageUpdateCount,
      state: this.state,
      stableSamples: `${this.stableSamples}/${ImageTrackingController.STABLE_SAMPLE_COUNT}`,
      stableMs: Math.round(elapsedMs),
      requiredStableMs: ImageTrackingController.STABLE_DURATION_MS,
      poseStable,
      worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
      cameraValid,
      cameraPoseSettled: performance.now() >= this.cameraPoseStableAfter,
      cameraPoseSettleRemainingMs: Math.max(0, Math.round(this.cameraPoseStableAfter - performance.now())),
      blockedBy: blockedBy || (!this.worldTrackingNormal ? 'world tracking not ready' : poseStable ? 'none' : 'pose deltas exceed thresholds'),
      deltaPositionM: this.lastStabilityDelta.position,
      deltaRotationDeg: THREE.MathUtils.radToDeg(this.lastStabilityDelta.rotation),
      deltaScale: this.lastStabilityDelta.scale,
      deltaWidth: this.lastStabilityDelta.width,
    }, poseStable && this.worldTrackingNormal && cameraValid ? 'info' : 'warn');
    logger.log('info', `[AR_ANCHOR] ${message}`);
  }

  private setTargetVisibility(visible: boolean, reason: string): void {
    if (this.targetGroup.visible === visible) return;
    this.targetGroup.visible = visible;
    traceAR('IMAGE_ANCHOR_VISIBILITY', {
      visible,
      reason,
      state: this.state,
      productParent: this.productRoot.parent?.name || '(none)',
    }, visible ? 'info' : 'warn');
    logger.log(
      visible ? 'info' : 'warn',
      `[AR_ANCHOR] ImageTargetAnchor visibility=${visible} (${reason}); state=${this.state}`
    );
  }

  private ignoreImageEvent(eventName: string): boolean {
    if (this.isCameraLocked || this.state === 'ANCHORED') {
      if (!this.loggedIgnoredEvents.has(eventName)) {
        this.loggedIgnoredEvents.add(eventName);
        traceAR('IMAGE_EVENT_IGNORED_AFTER_ANCHOR', {
          event: eventName,
          state: this.state,
          isCameraLocked: this.isCameraLocked,
          productParent: this.productRoot.parent?.name || '(none)',
          worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
        });
        logger.log('info', `[AR_ANCHOR] Ignoring ${eventName}; ProductRoot is Camera-Locked to AR Camera.`);
      }
      return true;
    }
    return false;
  }

  private logHandoffFailure(reason: string): void {
    if (this.handoffFailureLogged && this.lastHandoffFailureReason === reason) return;
    this.handoffFailureLogged = true;
    this.lastHandoffFailureReason = reason;
    reportCameraDiagnostic('Anchor handoff', `DEFERRED; ${reason}; state=${this.state}`);
    traceAR('HANDOFF_DEFERRED', {
      reason,
      state: this.state,
      imageUpdates: this.imageUpdateCount,
      worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
      cameraValid: this.isWorldCameraPoseValid(),
      productParent: this.productRoot.parent?.name || '(none)',
    }, 'warn');
    logger.log('warn', `[AR_ANCHOR] Handoff deferred; continuing image tracking. ${reason}`);
  }

  private sampleCameraPose(source: string): void {
    if (!this.isWorldCameraPoseValid() || !this.camera) return;
    const now = performance.now();
    const position = this.camera.getWorldPosition(new THREE.Vector3());
    const quaternion = this.camera.getWorldQuaternion(new THREE.Quaternion());
    const elapsed = now - this.lastCameraSample.timestamp;

    if (this.lastCameraSample.timestamp > 0 && elapsed > 0 && elapsed < 120) {
      const distance = position.distanceTo(this.lastCameraSample.position);
      const rotation = quaternion.angleTo(this.lastCameraSample.quaternion);
      if (distance > 0.35 || rotation > THREE.MathUtils.degToRad(35)) {
        this.cameraPoseDiscontinuityAt = now;
        this.cameraPoseStableAfter = Math.max(
          this.cameraPoseStableAfter,
          now + ImageTrackingController.STABLE_DURATION_MS
        );
        if (this.state === 'STABILIZING') this.resetStabilityWindow();
        traceAR('CAMERA_POSE_DISCONTINUITY', {
          source,
          translationM: distance,
          rotationDeg: THREE.MathUtils.radToDeg(rotation),
          elapsedMs: elapsed,
          handoffHoldMs: ImageTrackingController.STABLE_DURATION_MS,
          stabilityWindowReset: this.state === 'STABILIZING',
          cameraPosition: this.vectorDescription(position),
          worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
        }, 'warn');
        logger.log(
          'warn',
          `[AR_ANCHOR] Possible camera/world-origin discontinuity at ${source}: ${distance.toFixed(2)}m, ${THREE.MathUtils.radToDeg(rotation).toFixed(1)}deg in ${elapsed.toFixed(0)}ms; camera=${this.vectorDescription(position)}`
        );
      }
    }

    this.lastCameraSample.timestamp = now;
    this.lastCameraSample.position.copy(position);
    this.lastCameraSample.quaternion.copy(quaternion);
  }

  private cameraWorldPosition(): string {
    if (!this.camera || !this.isWorldCameraPoseValid()) return 'unavailable';
    return this.vectorDescription(this.camera.getWorldPosition(new THREE.Vector3()));
  }

  private transformDescription(matrix: THREE.Matrix4): string {
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    return `position=${this.vectorDescription(position)} quaternion=${this.quaternionDescription(quaternion)} scale=${this.vectorDescription(scale)}`;
  }

  private poseDescription(pose: ImagePose): string {
    return `position=${this.vectorDescription(pose.position)} quaternion=${this.quaternionDescription(pose.quaternion)} scale=${pose.scale.toFixed(4)} scaledWidth=${pose.scaledWidth?.toFixed(4) ?? 'n/a'}`;
  }

  private quaternionDescription(quaternion: THREE.Quaternion): string {
    return `(${quaternion.x.toFixed(4)},${quaternion.y.toFixed(4)},${quaternion.z.toFixed(4)},${quaternion.w.toFixed(4)})`;
  }

  private vectorDescription(vector: THREE.Vector3): string {
    return `(${vector.x.toFixed(4)},${vector.y.toFixed(4)},${vector.z.toFixed(4)})`;
  }

  private firstHiddenAncestor(object: THREE.Object3D): THREE.Object3D | null {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (!current.visible) return current;
      current = current.parent;
    }
    return null;
  }

  private maxMatrixDifference(left: THREE.Matrix4, right: THREE.Matrix4): number {
    let maxDifference = 0;
    for (let i = 0; i < ImageTrackingController.MATRIX_ELEMENTS; i += 1) {
      maxDifference = Math.max(maxDifference, Math.abs(left.elements[i] - right.elements[i]));
    }
    return maxDifference;
  }

  private isFiniteVector(value: THREE.Vector3): boolean {
    return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
  }

  private isFiniteQuaternion(value: THREE.Quaternion): boolean {
    return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z) && Number.isFinite(value.w);
  }

  public dispose(): void {
    traceAR('TRACKING_CONTROLLER_DISPOSE', {
      state: this.state,
      productParent: this.productRoot.parent?.name || '(none)',
      imageUpdates: this.imageUpdateCount,
    });
    this.camera = null;
    this.expectedWorldMatrix = null;
    this.lastCameraSample.timestamp = 0;
  }
}
