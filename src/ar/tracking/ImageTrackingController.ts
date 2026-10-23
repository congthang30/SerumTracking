import * as THREE from 'three';
import { ImagePose } from '../../types/ar';
import { logger } from '../../utils/logger';
import { isARTraceEnabled, reportCameraDiagnostic, traceAR } from '../xr/camera-fix';

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
  private worldTrackingNormal = false;
  private worldTrackingStatus: 'NORMAL' | 'LIMITED' = 'LIMITED';
  private worldTrackingReason = 'INITIALIZING';
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
    anchorPosition: THREE.Vector3;
    anchorQuaternion: THREE.Quaternion;
    anchorScale: THREE.Vector3;
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
  private imageUpdateCount = 0;
  private lastStabilityDelta = { position: 0, rotation: 0, scale: 0, width: 0 };

  private static readonly Z_AXIS = new THREE.Vector3(0, 0, 1);
  private static readonly MATRIX_ELEMENTS = 16;

  private static smoothingAlpha(cutoffHz: number, dt: number): number {
    const safeCutoff = Math.max(0.01, cutoffHz);
    const tau = 1 / (2 * Math.PI * safeCutoff);
    return dt / (dt + tau);
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
    const changed = status !== this.worldTrackingStatus || reason !== this.worldTrackingReason;
    const trackingReady = status === 'NORMAL' && reason !== 'INITIALIZING';
    const normalChanged = trackingReady !== this.worldTrackingNormal;
    this.worldTrackingStatus = status;
    this.worldTrackingReason = reason;
    this.worldTrackingNormal = trackingReady;

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
    }
  }

  /** Returns true only for the first image detection in this AR session. */
  public handleImageFound(pose: ImagePose, rotationDeg = 0): boolean {
    if (this.ignoreImageEvent('imagefound')) return false;
    if (!this.isValidPose(pose)) {
      traceAR('IMAGE_FOUND_IGNORED', { reason: 'invalid pose' }, 'warn');
      logger.log('warn', '[AR_ANCHOR] Ignored invalid imagefound pose.');
      return false;
    }

    const firstDetection = !this.hasSeenTarget;
    this.hasSeenTarget = true;
    this.isTracked = true;
    this.transitionTo('STABILIZING', 'image target found');
    this.applyPose(pose, rotationDeg, !this.hasPose);
    this.setTargetVisibility(true, 'image target found');
    this.resetStabilityWindow(pose);
    this.sampleCameraPose('imagefound');
    traceAR('IMAGE_FOUND', {
      target: pose.name,
      firstDetection,
      state: this.state,
      worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
      pose: this.poseDescription(pose),
      targetParent: this.targetGroup.parent?.name || '(none)',
      productParent: this.productRoot.parent?.name || '(none)',
      cameraPosition: this.cameraWorldPosition(),
    });
    this.onFound?.(pose);
    return firstDetection;
  }

  /** Image poses control the model only while it is still stabilizing. */
  public handleImageUpdated(pose: ImagePose, rotationDeg = 0): boolean {
    if (this.ignoreImageEvent('imageupdated')) return false;
    if (this.state !== 'STABILIZING' || !this.isValidPose(pose)) return false;

    this.isTracked = true;
    this.applyPose(pose, rotationDeg, false);
    this.setTargetVisibility(true, 'image target pose updated');
    this.onUpdated?.(pose);
    this.sampleCameraPose('imageupdated');
    this.imageUpdateCount += 1;

    const now = performance.now();
    const poseStable = this.isPoseStable(pose, now);
    const cameraPoseSettled = now >= this.cameraPoseStableAfter;
    const blockedBy = !this.worldTrackingNormal
      ? 'world tracking not ready'
      : !cameraPoseSettled
        ? 'camera pose settling after discontinuity'
        : !poseStable
          ? 'image pose not stable'
          : '';
    if (this.imageUpdateCount % 30 === 0) this.reportStabilityProgress(poseStable, blockedBy);
    if (!poseStable || !this.worldTrackingNormal || !cameraPoseSettled) {
      return false;
    }
    if (!this.isWorldCameraPoseValid()) {
      this.logHandoffFailure('XR8 camera pose is not valid yet.');
      if (this.imageUpdateCount % 30 === 0) this.reportStabilityProgress(poseStable, 'camera pose invalid');
      return false;
    }
    if (this.lastHandoffReadyTraceAt === 0 || now - this.lastHandoffReadyTraceAt >= 1000) {
      this.lastHandoffReadyTraceAt = now;
      traceAR('HANDOFF_READY', {
        imageUpdates: this.imageUpdateCount,
        stableSamples: this.stableSamples,
        stableMs: Math.round(now - this.stableSince),
        worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
        cameraPoseSettled,
        cameraPosition: this.cameraWorldPosition(),
      });
    }
    return this.detachIntoWorldAnchor();
  }

  /** Poster loss never hides or resets the last visible model pose. */
  public handleImageLost(): void {
    if (this.ignoreImageEvent('imagelost')) return;
    if (!this.hasSeenTarget) return;

    this.isTracked = false;
    const stableElapsedMs = this.stableSince > 0 ? performance.now() - this.stableSince : 0;
    traceAR('IMAGE_LOST', {
      state: this.state,
      worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
      stableSamples: `${this.stableSamples}/${ImageTrackingController.STABLE_SAMPLE_COUNT}`,
      stableMs: Math.round(stableElapsedMs),
      productParent: this.productRoot.parent?.name || '(none)',
      productVisible: this.productRoot.visible,
      targetVisible: this.targetGroup.visible,
      action: this.state === 'ANCHORED' ? 'ignored after anchor' : 'retain last pose; wait for target reacquisition',
    }, 'warn');
    reportCameraDiagnostic(
      'Anchor stabilization',
      `paused: target lost; state=${this.state}; samples=${this.stableSamples}/${ImageTrackingController.STABLE_SAMPLE_COUNT}; world=${this.worldTrackingStatus}/${this.worldTrackingReason}`
    );
    this.resetStabilityWindow();
    this.transitionTo('STABILIZING', 'image target lost; retaining last pose');
    this.sampleCameraPose('imagelost');
    this.onLost?.();
  }

  /**
   * Called from the existing XR frame loop. It diagnoses visibility, parent,
   * and world-matrix writes after handoff without changing the model.
   */
  public inspectWorldAnchor(): void {
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
      modelCenterWorld: this.vectorDescription(modelBoundsCenter),
      cameraDistanceToModelM: Number(cameraDistance.toFixed(4)),
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
      anchorPosition: anchorPosition.clone(),
      anchorQuaternion: anchorQuaternion.clone(),
      anchorScale: productScale.clone(),
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
   * status but no origin-change matrix in this runtime. During LIMITED only,
   * a >1m pose jump in one frame is treated as a coordinate-frame change and
   * the world anchor is transformed by the same camera-frame delta.
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
        const shouldRebase = this.worldTrackingStatus === 'LIMITED' &&
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
      return false;
    }

    this.expectedWorldMatrix = this.productRoot.matrixWorld.clone();
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
      originalParent.add(this.productRoot);
      this.productRoot.position.copy(originalPosition);
      this.productRoot.quaternion.copy(originalQuaternion);
      this.productRoot.scale.copy(originalScale);
      this.productRoot.updateMatrix();
      this.productRoot.updateWorldMatrix(true, true);
      this.worldAnchorGroup.visible = oldWorldAnchorVisibility;
      traceAR('HANDOFF_ROLLED_BACK', {
        reason: 'world transform verification failed after reparent',
        maxMatrixError: finalError,
        parentRestored: this.productRoot.parent === originalParent,
      }, 'error');
      this.logHandoffFailure(`World transform verification failed after reparent (max error ${finalError.toExponential(2)}).`);
      return false;
    }

    this.expectedWorldMatrix = capturedWorldMatrix;
    this.worldAnchorGroup.visible = true;
    this.isTracked = true;
    this.handoffFailureLogged = false;
    this.lastHandoffFailureReason = '';
    this.resetStabilityWindow();
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
    this.tmpTargetQuat.copy(pose.quaternion).normalize();

    if (rotationDeg !== 0) {
      const rad = (rotationDeg * Math.PI) / 180;
      this.tmpRotZ.setFromAxisAngle(ImageTrackingController.Z_AXIS, rad);
      this.tmpTargetQuat.multiply(this.tmpRotZ);
    }

    const s = pose.scale;
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
      const modelScale = Math.min(widthFitScale, heightFitScale);
      this.productRoot.scale.setScalar(modelScale);
    }
    // The loader places the product's base at Y=0. Move it down by half its
    // fitted height so the complete composition is centered over the poster.
    const fittedHeight = this.normalizedModelHeight * this.productRoot.scale.y;
    const productOffsetY = -fittedHeight / 2;

    const now = performance.now();
    if (!this.hasPose || instant) {
      this.targetGroup.position.copy(pose.position);
      this.targetGroup.quaternion.copy(this.tmpTargetQuat);
      this.targetGroup.scale.setScalar(s);
      this.seedPoseFilter(pose.position, this.tmpTargetQuat, s, now);
      this.productRoot.position.set(0, productOffsetY, 0);
      this.productRoot.rotation.x = targetRotX;
      this.hasPose = true;
      return;
    }

    const elapsed = (now - this.lastPoseTimestamp) / 1000;
    if (!Number.isFinite(elapsed) || elapsed > 0.45) {
      this.targetGroup.position.copy(pose.position);
      this.targetGroup.quaternion.copy(this.tmpTargetQuat);
      this.targetGroup.scale.setScalar(s);
      this.seedPoseFilter(pose.position, this.tmpTargetQuat, s, now);
    } else {
      const dt = THREE.MathUtils.clamp(elapsed, 1 / 240, 0.25);
      this.tmpPositionDelta.subVectors(pose.position, this.previousRawPosition);
      this.tmpPositionVelocity.copy(this.tmpPositionDelta).multiplyScalar(1 / dt);
      const velocityAlpha = ImageTrackingController.smoothingAlpha(1.0, dt);
      this.filteredPositionVelocity.lerp(this.tmpPositionVelocity, velocityAlpha);
      const positionCutoff = 0.85 + 2.5 * this.filteredPositionVelocity.length();
      this.targetGroup.position.lerp(pose.position, ImageTrackingController.smoothingAlpha(positionCutoff, dt));

      const angularVelocity = this.previousRawQuaternion.angleTo(this.tmpTargetQuat) / dt;
      this.filteredAngularVelocity = THREE.MathUtils.lerp(this.filteredAngularVelocity, angularVelocity, velocityAlpha);
      const rotationCutoff = 0.75 + 1.2 * this.filteredAngularVelocity;
      this.targetGroup.quaternion.slerp(this.tmpTargetQuat, ImageTrackingController.smoothingAlpha(rotationCutoff, dt));

      const scaleVelocity = Math.abs(s - this.previousRawScale) / dt;
      this.filteredScaleVelocity = THREE.MathUtils.lerp(this.filteredScaleVelocity, scaleVelocity, velocityAlpha);
      const scaleCutoff = 0.45 + 1.2 * this.filteredScaleVelocity;
      const scaleAlpha = ImageTrackingController.smoothingAlpha(scaleCutoff, dt);
      this.targetGroup.scale.setScalar(THREE.MathUtils.lerp(this.targetGroup.scale.x, s, scaleAlpha));
    }

    this.storeRawPose(pose.position, this.tmpTargetQuat, s, now);
    this.productRoot.position.set(0, productOffsetY, 0);
    this.productRoot.rotation.x = targetRotX;
  }

  private seedPoseFilter(position: THREE.Vector3, quaternion: THREE.Quaternion, scale: number, timestamp: number): void {
    this.filteredPositionVelocity.set(0, 0, 0);
    this.filteredAngularVelocity = 0;
    this.filteredScaleVelocity = 0;
    this.storeRawPose(position, quaternion, scale, timestamp);
  }

  private storeRawPose(position: THREE.Vector3, quaternion: THREE.Quaternion, scale: number, timestamp: number): void {
    this.previousRawPosition.copy(position);
    this.previousRawQuaternion.copy(quaternion);
    this.previousRawScale = scale;
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
  }

  private transitionTo(next: TrackingState, reason: string): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
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
    if (this.state !== 'ANCHORED') return false;
    if (!this.loggedIgnoredEvents.has(eventName)) {
      this.loggedIgnoredEvents.add(eventName);
      traceAR('IMAGE_EVENT_IGNORED_AFTER_ANCHOR', {
        event: eventName,
        state: this.state,
        productParent: this.productRoot.parent?.name || '(none)',
        worldTracking: `${this.worldTrackingStatus}/${this.worldTrackingReason}`,
      });
      logger.log('info', `[AR_ANCHOR] Ignoring ${eventName}; ProductRoot is detached from ImageTargetAnchor.`);
    }
    return true;
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
