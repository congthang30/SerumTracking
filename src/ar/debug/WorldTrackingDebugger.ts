import * as THREE from 'three';

type DebugCategory = 'SESSION' | 'TRACKING' | 'ANCHOR' | 'MODEL' | 'RENDER' | 'ANALYZER' | 'TEST';
type Confidence = 'CONFIRMED' | 'SUSPECTED' | 'UNKNOWN';

export interface WorldTrackingThresholds {
  translationSpikeM: number;
  rotationSpikeDeg: number;
  accelerationMps2: number;
  angularAccelerationDegPerSec2: number;
  velocityDiscontinuityMps: number;
  compensationSpikeM: number;
  compensationSpikeDeg: number;
  modelJumpM: number;
  modelJumpDeg: number;
  anchorDriftM: number;
  anchorDriftDeg: number;
  frameSpikeMs: number;
  severeFrameMs: number;
  fpsDropBelow: number;
  stableCameraM: number;
  stableCameraDeg: number;
  cameraPoseMismatchM: number;
  cameraPoseMismatchDeg: number;
  cameraVideoStallMs: number;
  cameraDroppedFramesWindowMs: number;
  cameraDroppedFramesThreshold: number;
  cameraPoseJitterWindowMs: number;
  cameraPoseJitterMinSamples: number;
  cameraPoseJitterPathM: number;
  cameraPoseJitterNetM: number;
  cameraPoseJitterPathDeg: number;
  cameraPoseJitterNetDeg: number;
  modelJitterTranslationM: number;
  modelJitterRotationDeg: number;
  modelJitterWindowMs: number;
  modelJitterMinimumSamples: number;
  targetFrameMs: number;
  bridgeSampleEveryFrames: number;
}

export interface TransformSnapshot {
  objectId: string;
  object: string;
  parent: string | null;
  parentId: string | null;
  local: { position: number[]; quaternion: number[]; scale: number[]; matrix: number[] };
  parentWorldMatrix: number[] | null;
  world: { position: number[]; quaternion: number[]; scale: number[]; matrix: number[] };
  cachedWorldMatrix: number[];
  worldMatrixError: number;
  matrixWorldStale: boolean;
  visible: boolean;
}

export interface XR8FrameContext {
  framework?: unknown;
  frameStartResult?: Record<string, unknown>;
  processGpuResult?: Record<string, unknown>;
  processCpuResult?: Record<string, unknown>;
}

interface DebugRecord {
  timestamp: string;
  monotonicMs: number;
  sessionId: string;
  sequenceId: number;
  trackingFrameSequence: number | null;
  xr8FrameId: number | string | null;
  eventName: string;
  category: DebugCategory;
  trackingState: string;
  payload: Record<string, unknown>;
}

interface FrameObjects {
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  renderer: THREE.WebGLRenderer | null;
  targetAnchor: THREE.Object3D | null;
  worldAnchor: THREE.Object3D | null;
  productRoot: THREE.Object3D | null;
  storyGroup: THREE.Object3D | null;
  bottleGroup: THREE.Object3D | null;
  modelRoot: THREE.Object3D | null;
}

interface BlackBoxCapture {
  id: number;
  triggerSequenceId: number;
  triggerEvent: string;
  startedAtMonotonicMs: number;
  endsAtMonotonicMs: number;
  before: DebugRecord[];
  after: DebugRecord[];
  completed: boolean;
}

interface RootCauseReport {
  timestamp: string;
  monotonicMs: number;
  confidence: Confidence;
  hypothesis: string;
  evidenceSequenceIds: number[];
  explanation: string;
}

interface BridgeEnvelope {
  sessionId: string;
  records: DebugRecord[];
}

interface CameraPoseSample {
  at: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

interface CameraVideoSample {
  at: number;
  currentTime: number;
  totalVideoFrames: number | null;
  droppedVideoFrames: number | null;
}

interface ModelJitterSample {
  at: number;
  sequenceId: number;
  translationM: number;
  rotationDeg: number;
  writer: string | null;
  writerSequenceId: number | null;
  compensationRecent: boolean;
  parentChanged: boolean;
}

interface WindowWithWorldDebug extends Window {
  __WORLD_TRACKING_DEBUG__?: {
    setEnabled: (enabled: boolean) => void;
    mark: (label: string) => void;
    setThresholds: (thresholds: Partial<WorldTrackingThresholds>) => void;
    exportJson: () => string;
    download: () => void;
    flush: () => Promise<void>;
  };
  __WORLD_TRACKING_DEBUG_THRESHOLDS__?: Partial<WorldTrackingThresholds>;
}

const DEFAULT_THRESHOLDS: WorldTrackingThresholds = {
  translationSpikeM: 0.35,
  rotationSpikeDeg: 35,
  accelerationMps2: 8,
  angularAccelerationDegPerSec2: 500,
  velocityDiscontinuityMps: 4,
  compensationSpikeM: 0.25,
  compensationSpikeDeg: 20,
  modelJumpM: 0.25,
  modelJumpDeg: 20,
  anchorDriftM: 0.08,
  anchorDriftDeg: 6,
  frameSpikeMs: 50,
  severeFrameMs: 85,
  fpsDropBelow: 20,
  stableCameraM: 0.04,
  stableCameraDeg: 3,
  cameraPoseMismatchM: 0.08,
  cameraPoseMismatchDeg: 5,
  cameraVideoStallMs: 120,
  cameraDroppedFramesWindowMs: 1000,
  cameraDroppedFramesThreshold: 3,
  cameraPoseJitterWindowMs: 1000,
  cameraPoseJitterMinSamples: 12,
  cameraPoseJitterPathM: 0.02,
  cameraPoseJitterNetM: 0.008,
  cameraPoseJitterPathDeg: 4,
  cameraPoseJitterNetDeg: 1.5,
  modelJitterTranslationM: 0.01,
  modelJitterRotationDeg: 0.7,
  modelJitterWindowMs: 1000,
  modelJitterMinimumSamples: 3,
  targetFrameMs: 1000 / 60,
  bridgeSampleEveryFrames: 20,
};

const RING_WINDOW_MS = 10_000;
const MAX_RING_RECORDS = 6_000;
const POST_EVENT_WINDOW_MS = 3_000;
const MAX_ACTIVE_CAPTURES = 3;
const MAX_SAVED_CAPTURES = 5;
const MAX_BRIDGE_QUEUE = 500;
const BRIDGE_FLUSH_INTERVAL_MS = 900;
const BRIDGE_BATCH_LIMIT = 70;
const MATRIX_STALE_EPSILON = 1e-5;
const BRIDGE_ANOMALY_INTERVAL_MS = 500;
const THROTTLED_BRIDGE_EVENTS = new Set([
  'CAMERA_POSE_SPIKE', 'CAMERA_ACCELERATION_SPIKE', 'CAMERA_POSE_MATRIX_MISMATCH',
  'CAMERA_VIDEO_FRAME_STALL', 'CAMERA_VIDEO_DROPPED_FRAMES', 'CAMERA_POSE_JITTER_CANDIDATE',
  'MODEL_FRAME_JITTER',
  'MODEL_WORLD_JUMP', 'UNATTRIBUTED_TRANSFORM_CHANGE', 'ANCHOR_WORLD_DRIFT',
  'FRAME_DELAY', 'FPS_DROP', 'STALE_TRACKING_FRAME_RENDER',
  'CAMERA_POSE_JITTER_CANDIDATE', 'MODEL_FRAME_JITTER',
]);
const IS_DEV_BUILD = Boolean((import.meta as any).env?.DEV);

function round(value: number, places = 5): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function vectorValues(vector: THREE.Vector3): number[] {
  return [round(vector.x), round(vector.y), round(vector.z)];
}

function quaternionValues(quaternion: THREE.Quaternion): number[] {
  return [round(quaternion.x), round(quaternion.y), round(quaternion.z), round(quaternion.w)];
}

function matrixValues(matrix: THREE.Matrix4): number[] {
  return matrix.elements.map((value) => round(value, 6));
}

function maxMatrixDifference(a: THREE.Matrix4, b: THREE.Matrix4): number {
  let maximum = 0;
  for (let index = 0; index < 16; index += 1) {
    maximum = Math.max(maximum, Math.abs(a.elements[index] - b.elements[index]));
  }
  return maximum;
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1)], 2);
}

function findLastValue<T>(values: T[], predicate: (value: T) => boolean): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) return values[index];
  }
  return undefined;
}

function finiteVector(value: any): value is { x: number; y: number; z: number } {
  return value && [value.x, value.y, value.z].every((part) => typeof part === 'number' && Number.isFinite(part));
}

function finiteQuaternion(value: any): value is { x: number; y: number; z: number; w: number } {
  return value && [value.x, value.y, value.z, value.w].every((part) => typeof part === 'number' && Number.isFinite(part));
}

function configuredEnabled(): boolean {
  if (!IS_DEV_BUILD || typeof window === 'undefined') return false;
  const query = new URLSearchParams(window.location.search);
  let storageFlag = false;
  try {
    storageFlag = window.localStorage.getItem('DEBUG_WORLD_TRACKING') === '1';
  } catch {
    // Private browsing may deny localStorage; URL and Vite env remain available.
  }
  return (import.meta as any).env?.VITE_DEBUG_WORLD_TRACKING === 'true' ||
    query.get('debugWorldTracking') === '1' || storageFlag;
}

export const DEBUG_WORLD_TRACKING = configuredEnabled();

function queryThresholds(): Partial<WorldTrackingThresholds> {
  if (typeof window === 'undefined') return {};
  const query = new URLSearchParams(window.location.search);
  const result: Partial<WorldTrackingThresholds> = {};
  (Object.keys(DEFAULT_THRESHOLDS) as Array<keyof WorldTrackingThresholds>).forEach((key) => {
    const value = query.get(`wt${key[0].toUpperCase()}${key.slice(1)}`);
    if (value !== null && Number.isFinite(Number(value)) && Number(value) > 0) {
      result[key] = Number(value);
    }
  });
  return result;
}

function sdkFrameId(context: XR8FrameContext): number | string | null {
  // XR8's public pipeline result documents no frame id. Preserve one only if
  // the runtime actually supplies a plainly named value in frameStartResult.
  const start = context.frameStartResult;
  if (!start) return null;
  for (const key of ['frameId', 'frameID', 'frameNumber', 'frameIndex']) {
    const value = start[key];
    if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string') return value;
  }
  return null;
}

export class WorldTrackingDebugger {
  private enabled = DEBUG_WORLD_TRACKING;
  private sessionId = 'S00000';
  private sequenceId = 0;
  private trackingFrameSequence = 0;
  private currentTrackingFrame: number | null = null;
  private currentXr8FrameId: number | string | null = null;
  private currentTrackingState = 'UNKNOWN';
  private sessionStartedAt = 0;
  private latestFrameUpdateStart = 0;
  private latestRenderAt = 0;
  private currentFrameWasUpdated = false;
  private latestValidRawPoseAt = 0;
  private cameraFrameRateHz: number | null = null;
  private lastRawPose: { position: THREE.Vector3; quaternion: THREE.Quaternion; at: number; velocity: THREE.Vector3 | null; angularVelocityDegPerSec: number | null } | null = null;
  private lastTrackingStatus: { status: string; reason: string } | null = null;
  private lastProjection: { raw: number[] | null; camera: number[] | null } | null = null;
  private lastFrameTimestamp = 0;
  private lastFrameTransforms = new Map<string, TransformSnapshot>();
  private expectedAnchorWorldMatrix: THREE.Matrix4 | null = null;
  private lastWriterByObject = new Map<string, { source: string; reason: string; sequenceId: number; at: number }>();
  private lastTransformBridgeAt = new Map<string, number>();
  private lastBridgeEventAt = new Map<string, number>();
  private frameDeltasMs: number[] = [];
  private cameraDeltas: Array<{ translationM: number; rotationDeg: number; velocityMps: number; accelerationMps2: number | null; at: number; sequenceId: number }> = [];
  private renderCounts = new Map<number, number>();
  private ringRecords: DebugRecord[] = [];
  private captures: BlackBoxCapture[] = [];
  private rootCauseReports: RootCauseReport[] = [];
  private bridgeQueue: DebugRecord[] = [];
  private thresholds: WorldTrackingThresholds = { ...DEFAULT_THRESHOLDS };
  private objects: FrameObjects = {
    scene: null,
    camera: null,
    renderer: null,
    targetAnchor: null,
    worldAnchor: null,
    productRoot: null,
    storyGroup: null,
    bottleGroup: null,
    modelRoot: null,
  };
  private renderer: THREE.WebGLRenderer | null = null;
  private originalRender: THREE.WebGLRenderer['render'] | null = null;
  private wrappedRender: THREE.WebGLRenderer['render'] | null = null;
  private bridgeTimer: number | null = null;
  private pageHideHandler: (() => void) | null = null;
  private lastBridgeAttemptAt = 0;
  private recentAnomalyAt = 0;
  private lastDuplicateRenderFrame = -1;
  private missingRealityActive = false;
  private lastInvalidPoseKey = '';
  private cameraPoseMismatchFrames = 0;
  private cameraPoseMismatchActive = false;
  private activeScenarioLabel = '';
  private cameraVideoElement: HTMLVideoElement | null = null;
  private lastCameraVideoSample: CameraVideoSample | null = null;
  private lastCameraVideoAdvanceAt = 0;
  private cameraVideoStallActive = false;
  private cameraVideoDropSamples: Array<{ at: number; count: number }> = [];
  private cameraVideoDropActive = false;
  private cameraPoseSamples: CameraPoseSample[] = [];
  private cameraPoseJitterActive = false;
  private lastCameraPoseJitterEventAt = 0;
  private modelJitterSamples: ModelJitterSample[] = [];
  private modelJitterActive = false;
  private lastRootCauseSignature = '';
  private staleBeforeRender = new Map<string, { object: string; trackingFrameSequence: number }>();
  private rendererCallActive = false;
  private activePipelineEventRecords: DebugRecord[] | null = null;
  private pendingPipelineEventRecords: DebugRecord[] = [];

  constructor() {
    this.refreshThresholds();
    if (IS_DEV_BUILD && typeof window !== 'undefined') {
      (window as WindowWithWorldDebug).__WORLD_TRACKING_DEBUG__ = {
        setEnabled: (enabled) => this.setEnabled(enabled),
        mark: (label) => this.mark(label),
        setThresholds: (thresholds) => this.setThresholds(thresholds),
        exportJson: () => this.exportJson(),
        download: () => this.download(),
        flush: () => this.flushBridge(),
      };
    }
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public start(): void {
    if (this.sessionStartedAt > 0) this.stop();
    this.sessionStartedAt = performance.now();
    this.sessionId = `S${Date.now().toString(36).slice(-5).toUpperCase()}`;
    this.sequenceId = 0;
    this.trackingFrameSequence = 0;
    this.currentTrackingFrame = null;
    this.currentXr8FrameId = null;
    this.currentTrackingState = 'UNKNOWN';
    this.lastRawPose = null;
    this.lastTrackingStatus = null;
    this.lastProjection = null;
    this.lastFrameTimestamp = 0;
    this.latestValidRawPoseAt = 0;
    this.cameraFrameRateHz = null;
    this.expectedAnchorWorldMatrix = null;
    this.lastFrameTransforms.clear();
    this.frameDeltasMs = [];
    this.cameraDeltas = [];
    this.renderCounts.clear();
    this.lastDuplicateRenderFrame = -1;
    this.missingRealityActive = false;
    this.lastInvalidPoseKey = '';
    this.cameraPoseMismatchFrames = 0;
    this.cameraPoseMismatchActive = false;
    this.activeScenarioLabel = '';
    this.lastCameraVideoSample = null;
    this.lastCameraVideoAdvanceAt = 0;
    this.cameraVideoStallActive = false;
    this.cameraVideoDropSamples = [];
    this.cameraVideoDropActive = false;
    this.cameraPoseSamples = [];
    this.cameraPoseJitterActive = false;
    this.lastCameraPoseJitterEventAt = 0;
    this.modelJitterSamples = [];
    this.modelJitterActive = false;
    this.lastRootCauseSignature = '';
    this.staleBeforeRender.clear();
    this.rendererCallActive = false;
    this.activePipelineEventRecords = null;
    this.pendingPipelineEventRecords = [];
    this.ringRecords = [];
    this.captures = [];
    this.rootCauseReports = [];
    this.bridgeQueue = [];
    this.refreshThresholds();
    if (!this.enabled) {
      if (IS_DEV_BUILD) {
        console.log('[WORLD_AR][DEBUG_DISABLED] Add ?debugWorldTracking=1 to the page URL to print tracking diagnostics in Safari and the Vite terminal.');
      }
      return;
    }

    this.startBridge();
    this.record('SESSION', 'SESSION_STARTED', {
      debugEnabled: true,
      runtime: 'development',
      thresholdConfiguration: this.thresholds,
      sdkCapabilities: {
        publicFrameIdDocumented: false,
        publicPoseTimestampDocumented: false,
        publicTrackingConfidenceDocumented: false,
        trackingStatus: 'reality.trackingStatus and reality.trackingReason',
        framePose: 'processCpuResult.reality.position and rotation',
      },
    }, { bridge: true });
    this.record('TRACKING', 'TRACKING_INITIALIZED', {
      status: 'UNKNOWN',
      detail: 'Waiting for the first XR8 reality pose/status sample.',
    }, { bridge: true });
  }

  public stop(): void {
    if (this.sessionStartedAt === 0) return;
    if (this.enabled) {
      this.record('SESSION', 'SESSION_STOPPED', { elapsedMs: round(performance.now() - this.sessionStartedAt, 1) }, { bridge: true });
      void this.flushBridge();
    }
    this.stopBridge();
    this.restoreRenderer();
    this.objects = { scene: null, camera: null, renderer: null, targetAnchor: null, worldAnchor: null, productRoot: null, storyGroup: null, bottleGroup: null, modelRoot: null };
    this.cameraVideoElement = null;
    this.lastCameraVideoSample = null;
    this.expectedAnchorWorldMatrix = null;
    this.lastFrameTransforms.clear();
    this.lastWriterByObject.clear();
    this.lastTransformBridgeAt.clear();
    this.lastBridgeEventAt.clear();
    this.staleBeforeRender.clear();
    this.pendingPipelineEventRecords = [];
    this.activePipelineEventRecords = null;
    this.sessionStartedAt = 0;
    this.currentTrackingFrame = null;
  }

  public setEnabled(enabled: boolean): void {
    if (!IS_DEV_BUILD || this.enabled === enabled) return;
    if (!enabled) {
      this.record('SESSION', 'DEBUG_DISABLED', {}, { bridge: true });
      void this.flushBridge();
      this.enabled = false;
      this.stopBridge();
      this.restoreRenderer();
      return;
    }
    this.enabled = true;
    if (this.sessionStartedAt === 0) this.start();
    else {
      this.refreshThresholds();
      this.startBridge();
      this.record('SESSION', 'DEBUG_ENABLED', { thresholdConfiguration: this.thresholds }, { bridge: true });
      if (this.objects.renderer) this.attachRenderer(this.objects.renderer);
    }
  }

  public setThresholds(partial: Partial<WorldTrackingThresholds>): void {
    const next = { ...this.thresholds };
    for (const [rawKey, rawValue] of Object.entries(partial)) {
      const key = rawKey as keyof WorldTrackingThresholds;
      if (key in DEFAULT_THRESHOLDS && typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
        next[key] = rawValue;
      }
    }
    this.thresholds = next;
    if (this.enabled) this.record('SESSION', 'THRESHOLDS_CHANGED', { thresholdConfiguration: next }, { bridge: true });
  }

  public mark(label: string): void {
    if (!this.enabled) return;
    const safeLabel = String(label).trim().slice(0, 80) || 'UNNAMED_SCENARIO';
    this.activeScenarioLabel = safeLabel;
    this.cameraPoseSamples = [];
    this.cameraPoseJitterActive = false;
    this.record('TEST', 'SCENARIO_MARKER', { label: safeLabel }, { bridge: true });
  }

  public setSceneObjects(objects: Partial<FrameObjects>): void {
    this.objects = { ...this.objects, ...objects };
    if (this.enabled && objects.renderer) this.attachRenderer(objects.renderer);
  }

  public attachRenderer(renderer: THREE.WebGLRenderer): void {
    if (!this.enabled || this.renderer === renderer) return;
    this.restoreRenderer();
    this.renderer = renderer;
    this.wrapRenderer();
  }

  public recordCameraStatus(payload: Record<string, unknown>, video?: HTMLVideoElement | null): void {
    if (!this.enabled) return;
    if (video !== undefined && video !== this.cameraVideoElement) {
      this.cameraVideoElement = video;
      this.lastCameraVideoSample = null;
      this.lastCameraVideoAdvanceAt = 0;
      this.cameraVideoStallActive = false;
      this.cameraVideoDropSamples = [];
      this.cameraVideoDropActive = false;
    }
    const rate = payload.frameRate;
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 1) this.cameraFrameRateHz = rate;
    this.record('TRACKING', 'CAMERA_STATUS', {
      ...payload,
      effectiveFrameBudgetMs: round(this.frameBudgetMs(), 2),
    }, { bridge: true });
  }

  public recordPipelineState(state: 'PAUSED' | 'RESUMED' | 'DETACHED'): void {
    if (!this.enabled) return;
    this.record('TRACKING', state === 'PAUSED' ? 'XR8_PIPELINE_PAUSED' : state === 'RESUMED' ? 'XR8_PIPELINE_RESUMED' : 'XR8_PIPELINE_DETACHED', {}, { bridge: true, capture: state !== 'DETACHED' });
  }

  public beginPipelineEvent(): void {
    if (!this.enabled) return;
    if (this.activePipelineEventRecords === null) this.activePipelineEventRecords = [];
  }

  public endPipelineEvent(): void {
    if (!this.enabled || this.activePipelineEventRecords === null) return;
    this.pendingPipelineEventRecords.push(...this.activePipelineEventRecords);
    this.activePipelineEventRecords = null;
  }

  public recordTrackingStatus(status: string, reason: string, source = 'reality.trackingstatus event'): void {
    if (!this.enabled) return;
    this.applyTrackingStatus(status, reason, source);
  }

  public beginFrame(context: XR8FrameContext): void {
    if (!this.enabled) return;
    const now = performance.now();
    this.trackingFrameSequence += 1;
    this.currentTrackingFrame = this.trackingFrameSequence;
    this.currentXr8FrameId = sdkFrameId(context);
    for (const record of this.pendingPipelineEventRecords) {
      record.trackingFrameSequence = this.currentTrackingFrame;
      record.xr8FrameId = this.currentXr8FrameId;
    }
    this.pendingPipelineEventRecords = [];
    this.latestFrameUpdateStart = now;
    this.currentFrameWasUpdated = false;

    const reality: any = context.processCpuResult?.reality;
    const rawStatus = typeof reality?.trackingStatus === 'string' ? reality.trackingStatus : null;
    const rawReason = typeof reality?.trackingReason === 'string' ? reality.trackingReason : null;
    if (rawStatus || rawReason) this.applyTrackingStatus(rawStatus ?? this.currentTrackingState, rawReason ?? 'UNSPECIFIED', 'processCpuResult.reality');

    const rawPose = this.captureRawPose(reality, now);
    if (rawPose) this.latestValidRawPoseAt = now;
    const cameraVideoFrame = this.sampleCameraVideo(now);
    const camera = this.objects.camera;
    const cameraSnapshot = camera ? this.captureTransform(camera) : null;
    if (cameraSnapshot?.matrixWorldStale) this.reportMatrixWorldStale(cameraSnapshot, 'before XR8 Three.js render');
    const projection = this.captureProjection(reality, camera);
    const frameDeltaMs = this.lastFrameTimestamp > 0 ? now - this.lastFrameTimestamp : null;
    if (frameDeltaMs !== null && Number.isFinite(frameDeltaMs)) this.frameDeltasMs.push(frameDeltaMs);
    this.frameDeltasMs = this.frameDeltasMs.filter((value) => value >= 0 && value <= 10_000).slice(-600);

    const cameraRawToThreeDelta = this.compareRawPoseToCamera(reality, cameraSnapshot);
    const basePayload = {
      rawTrackingPose: rawPose,
      threeCamera: cameraSnapshot,
      cameraRawToThreeDelta,
      trackingStatus: rawStatus ?? this.currentTrackingState,
      trackingReason: rawReason,
      activeScenarioLabel: this.activeScenarioLabel || null,
      cameraVideoFrame,
      worldPointConfidence: this.worldPointConfidenceSummary(reality?.worldPoints),
      frameStartResultKeys: context.frameStartResult ? Object.keys(context.frameStartResult).slice(0, 20) : [],
      frameDeltaMs: frameDeltaMs === null ? null : round(frameDeltaMs, 2),
      fpsRollingAverage: this.fpsAverage(),
      frameTimeP95Ms: percentile(this.frameDeltasMs, 0.95),
      frameTimeP99Ms: percentile(this.frameDeltasMs, 0.99),
      delayedFramesEstimated: frameDeltaMs === null ? 0 : Math.max(0, Math.floor(frameDeltaMs / this.frameBudgetMs()) - 1),
      projection,
    };
    const frameRecord = this.record('RENDER', 'TRACKING_FRAME', basePayload, {
      trackingFrameSequence: this.currentTrackingFrame,
      xr8FrameId: this.currentXr8FrameId,
      bridge: this.trackingFrameSequence % this.thresholds.bridgeSampleEveryFrames === 0,
    });
    this.lastFrameTimestamp = now;
    this.evaluateCameraPoseMismatch(cameraRawToThreeDelta);

    void frameRecord;
    this.lastProjection = projection ? { raw: projection.rawIntrinsics, camera: projection.threeProjection } : this.lastProjection;
  }

  public endFrame(sceneUpdateEndedAt = performance.now()): void {
    if (!this.enabled || this.currentTrackingFrame === null) return;
    this.currentFrameWasUpdated = true;
    const transformSnapshots: Record<string, TransformSnapshot | null> = {
      targetAnchor: this.captureTransform(this.objects.targetAnchor),
      worldAnchor: this.captureTransform(this.objects.worldAnchor),
      productRoot: this.captureTransform(this.objects.productRoot),
      storyGroup: this.captureTransform(this.objects.storyGroup),
      bottleGroup: this.captureTransform(this.objects.bottleGroup),
      modelRoot: this.captureTransform(this.objects.modelRoot),
    };
    const frameStart = findLastValue(this.ringRecords, (entry) => entry.eventName === 'TRACKING_FRAME' && entry.trackingFrameSequence === this.currentTrackingFrame);
    if (frameStart) {
      frameStart.payload.transformsAfterSceneUpdate = transformSnapshots;
      frameStart.payload.sceneUpdateDurationMs = round(sceneUpdateEndedAt - this.latestFrameUpdateStart, 2);
      frameStart.payload.renderCallsForTrackingFrame = this.renderCounts.get(this.currentTrackingFrame) ?? 0;
      const previousProduct = this.lastFrameTransforms.get('productRoot');
      const currentProduct = transformSnapshots.productRoot;
      if (previousProduct && currentProduct) {
        frameStart.payload.modelFrameDelta = {
          translationM: round(this.arrayDistance(previousProduct.world.position, currentProduct.world.position), 6),
          rotationDeg: this.quaternionDeltaDeg(previousProduct.world.quaternion, currentProduct.world.quaternion),
          parentChanged: previousProduct.parentId !== currentProduct.parentId,
          trackingState: this.currentTrackingState,
        };
      } else {
        frameStart.payload.modelFrameDelta = null;
      }
      this.detectFrameTransformChanges(transformSnapshots);
      const cameraSnapshot = frameStart.payload.threeCamera as TransformSnapshot | null;
      frameStart.payload.modelToCameraRelative = this.modelToCameraRelative(cameraSnapshot, transformSnapshots.productRoot);
      const updateDuration = Number(frameStart.payload.sceneUpdateDurationMs);
      if (updateDuration >= this.thresholds.frameSpikeMs) this.recordFrameDelay(updateDuration, 'SCENE_UPDATE');
    }
    this.renderCounts.forEach((_count, frame) => {
      if (frame < this.currentTrackingFrame! - 120) this.renderCounts.delete(frame);
    });
  }

  public captureTransform(object: THREE.Object3D | null | undefined): TransformSnapshot | null {
    if (!this.enabled || !object) return null;
    return this.snapshotObject(object);
  }

  public recordTransformWrite(
    category: 'ANCHOR' | 'MODEL',
    eventName: string,
    source: string,
    object: THREE.Object3D,
    oldTransform: TransformSnapshot | null,
    reason: string,
    extra: Record<string, unknown> = {}
  ): void {
    if (!this.enabled || !oldTransform) return;
    const next = this.snapshotObject(object);
    const localPositionDeltaM = this.arrayDistance(oldTransform.local.position, next.local.position);
    const worldPositionDeltaM = this.arrayDistance(oldTransform.world.position, next.world.position);
    const worldRotationDeltaDeg = this.quaternionDeltaDeg(oldTransform.world.quaternion, next.world.quaternion);
    const transformChanged = oldTransform.parentId !== next.parentId || this.matrixArrayError(oldTransform.local.matrix, next.local.matrix) > 1e-8;
    const alwaysRecord = eventName === 'WORLD_ANCHOR_ESTABLISHED' || eventName === 'COMPENSATION_ROLLED_BACK' || eventName === 'HANDOFF_ROLLED_BACK';
    if (!transformChanged && !alwaysRecord) return;
    const payload = {
      source,
      oldTransform,
      newTransform: next,
      reason,
      localPositionDeltaM,
      worldPositionDeltaM,
      worldRotationDeltaDeg,
      ...extra,
    };
    const alwaysBridge = [
      'COMPENSATION_APPLIED', 'COMPENSATION_ROLLED_BACK', 'WORLD_ANCHOR_ESTABLISHED', 'HANDOFF_REPARENT', 'HANDOFF_ROLLED_BACK',
    ].includes(eventName);
    const bridgeNow = performance.now();
    const previousBridgeAt = this.lastTransformBridgeAt.get(object.uuid);
    const bridgeSampleDue = previousBridgeAt === undefined || bridgeNow - previousBridgeAt >= 750;
    const bridge = alwaysBridge || bridgeSampleDue;
    if (bridgeSampleDue) this.lastTransformBridgeAt.set(object.uuid, bridgeNow);
    const record = this.record(category, eventName, payload, { capture: true, bridge });
    this.lastWriterByObject.set(object.uuid, { source, reason, sequenceId: record.sequenceId, at: record.monotonicMs });
    if (this.rendererCallActive) {
      this.record('MODEL', 'TRANSFORM_WRITE_DURING_RENDER', {
        source,
        object: object.name || object.type,
        transformWriteSequenceId: record.sequenceId,
        reason,
        trackingFrameSequence: this.currentTrackingFrame,
      }, { capture: true, bridge: true });
    }

    if (eventName === 'WORLD_ANCHOR_ESTABLISHED') {
      this.expectedAnchorWorldMatrix = new THREE.Matrix4().fromArray(next.world.matrix);
    } else if (eventName === 'COMPENSATION_APPLIED' && Array.isArray(extra.compensationMatrix)) {
      const compensation = new THREE.Matrix4().fromArray(extra.compensationMatrix as number[]);
      if (this.expectedAnchorWorldMatrix) this.expectedAnchorWorldMatrix.premultiply(compensation);
    }

    if (eventName === 'COMPENSATION_APPLIED' &&
      (worldPositionDeltaM >= this.thresholds.compensationSpikeM || worldRotationDeltaDeg >= this.thresholds.compensationSpikeDeg)) {
      this.record('ANCHOR', 'COMPENSATION_ANOMALY', {
        source,
        translationM: worldPositionDeltaM,
        rotationDeg: worldRotationDeltaDeg,
        thresholds: { translationM: this.thresholds.compensationSpikeM, rotationDeg: this.thresholds.compensationSpikeDeg },
        relatedSequenceId: record.sequenceId,
        reason,
      }, { capture: true, bridge: true });
    }
    if (eventName === 'COMPENSATION_APPLIED' && this.isTrackingRecoveryRecent(record.monotonicMs)) {
      const recentCompensations = this.ringRecords.filter((entry) => entry.eventName === 'COMPENSATION_APPLIED' && record.monotonicMs - entry.monotonicMs <= 2_500);
      record.payload.compensationCountInRecentWindow = recentCompensations.length;
      if (recentCompensations.length >= 2) {
        this.addRootCause('SUSPECTED', 'Anchor compensation continued changing after tracking recovery.', recentCompensations.map((entry) => entry.sequenceId), `${recentCompensations.length} compensation writes were measured within 2.5 seconds of the recovery window.`);
      }
    }
  }

  public recordEvent(category: DebugCategory, eventName: string, payload: Record<string, unknown>, options: { capture?: boolean; bridge?: boolean } = {}): void {
    if (!this.enabled) return;
    this.record(category, eventName, payload, options);
  }

  public exportJson(): string {
    const now = performance.now();
    const records = this.ringRecords.filter((record) => now - record.monotonicMs <= RING_WINDOW_MS);
    return JSON.stringify({
      schemaVersion: 1,
      sessionId: this.sessionId,
      exportedAt: new Date().toISOString(),
      exportedMonotonicMs: round(now, 2),
      rollingWindowMs: RING_WINDOW_MS,
      thresholds: this.thresholds,
      sdkCapabilities: {
        xr8FrameId: 'not documented by the current public pipeline callback; captured only if explicitly present in frameStartResult',
        poseTimestamp: 'not exposed in processCpuResult.reality documentation; callback monotonic time is recorded instead',
        trackingConfidence: 'no overall confidence is exposed in reality; worldPoints confidence summary is recorded only when supplied',
      },
      recentRecords: records,
      blackBoxCaptures: this.captures.map((capture) => ({
        id: capture.id,
        triggerSequenceId: capture.triggerSequenceId,
        triggerEvent: capture.triggerEvent,
        startedAtMonotonicMs: capture.startedAtMonotonicMs,
        endsAtMonotonicMs: capture.endsAtMonotonicMs,
        completed: capture.completed,
        before: capture.before,
        after: capture.after,
      })),
      rootCauseReports: this.rootCauseReports,
    }, null, 2);
  }

  public download(): void {
    if (!this.enabled || typeof document === 'undefined') return;
    const blob = new Blob([this.exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `world-tracking-${this.sessionId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  public async flushBridge(): Promise<void> {
    if (!this.enabled || this.bridgeQueue.length === 0 || typeof fetch === 'undefined') return;
    const records: DebugRecord[] = [];
    for (const candidate of this.bridgeQueue.slice(0, BRIDGE_BATCH_LIMIT)) {
      const proposed = [...records, candidate];
      const proposedSize = new TextEncoder().encode(JSON.stringify({ sessionId: this.sessionId, records: proposed })).byteLength;
      if (proposedSize > 48 * 1024 && records.length > 0) break;
      if (proposedSize > 48 * 1024) break;
      records.push(candidate);
    }
    if (records.length === 0) {
      this.bridgeQueue.shift();
      return;
    }
    this.bridgeQueue.splice(0, records.length);
    const envelope: BridgeEnvelope = { sessionId: this.sessionId, records };
    const body = JSON.stringify(envelope);
    const startedAt = performance.now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch('/__world_tracking_debug', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: body.length < 60_000,
        });
        if (!response.ok) throw new Error(`bridge status ${response.status}`);
        this.lastBridgeAttemptAt = performance.now();
        if (this.lastBridgeAttemptAt - startedAt > 100) {
          // Transport is asynchronous; this only records latency in the next batch.
          this.record('RENDER', 'DEBUG_BRIDGE_SLOW', { elapsedMs: round(this.lastBridgeAttemptAt - startedAt, 1) }, { bridge: false });
        }
        return;
      } catch {
        if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 180 * (attempt + 1)));
      }
    }
    this.bridgeQueue = [...records, ...this.bridgeQueue].slice(-MAX_BRIDGE_QUEUE);
  }

  private refreshThresholds(): void {
    const supplied = typeof window === 'undefined' ? {} : (window as WindowWithWorldDebug).__WORLD_TRACKING_DEBUG_THRESHOLDS__ ?? {};
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...queryThresholds(), ...supplied };
  }

  private startBridge(): void {
    if (!this.enabled || typeof window === 'undefined' || this.bridgeTimer !== null) return;
    this.bridgeTimer = window.setInterval(() => { void this.flushBridge(); }, BRIDGE_FLUSH_INTERVAL_MS);
    this.pageHideHandler = () => { void this.flushBridge(); };
    window.addEventListener('pagehide', this.pageHideHandler);
  }

  private stopBridge(): void {
    if (this.bridgeTimer !== null) {
      window.clearInterval(this.bridgeTimer);
      this.bridgeTimer = null;
    }
    if (this.pageHideHandler) {
      window.removeEventListener('pagehide', this.pageHideHandler);
      this.pageHideHandler = null;
    }
  }

  private record(
    category: DebugCategory,
    eventName: string,
    payload: Record<string, unknown>,
    options: { trackingFrameSequence?: number | null; xr8FrameId?: number | string | null; bridge?: boolean; capture?: boolean } = {}
  ): DebugRecord {
    const monotonicMs = performance.now();
    const record: DebugRecord = {
      timestamp: new Date().toISOString(),
      monotonicMs: round(monotonicMs, 3),
      sessionId: this.sessionId,
      sequenceId: ++this.sequenceId,
      trackingFrameSequence: options.trackingFrameSequence === undefined ? this.currentTrackingFrame : options.trackingFrameSequence,
      xr8FrameId: options.xr8FrameId === undefined ? this.currentXr8FrameId : options.xr8FrameId,
      eventName,
      category,
      trackingState: this.currentTrackingState,
      payload,
    };
    this.ringRecords.push(record);
    if (this.activePipelineEventRecords) this.activePipelineEventRecords.push(record);
    this.pruneRing(monotonicMs);
    this.updateCaptures(record);
    if (options.bridge && this.shouldBridgeEvent(category, eventName, monotonicMs)) {
      this.enqueueBridge(record);
      if (IS_DEV_BUILD && typeof console !== 'undefined') {
        const frame = record.xr8FrameId ?? record.trackingFrameSequence ?? '-';
        const diagnosticPayload = {
          ...record.payload,
          sequenceId: record.sequenceId,
          monotonicMs: record.monotonicMs,
          xr8FrameId: record.xr8FrameId,
          trackingFrameSequence: record.trackingFrameSequence,
          trackingState: record.trackingState,
        };
        console.log(
          `[WORLD_AR][${record.sessionId}][${record.timestamp}][F${frame}][${record.category}][${record.eventName}] ${JSON.stringify(diagnosticPayload)}`
        );
      }
    }
    if (options.capture) this.startCaptureFor(record);
    return record;
  }

  private pruneRing(now: number): void {
    const threshold = now - RING_WINDOW_MS;
    while (this.ringRecords.length > 0 && (this.ringRecords[0].monotonicMs < threshold || this.ringRecords.length > MAX_RING_RECORDS)) {
      this.ringRecords.shift();
    }
  }

  private enqueueBridge(record: DebugRecord): void {
    if (this.bridgeQueue.length >= MAX_BRIDGE_QUEUE) this.bridgeQueue.shift();
    this.bridgeQueue.push(record);
  }

  private shouldBridgeEvent(category: DebugCategory, eventName: string, now: number): boolean {
    if (!THROTTLED_BRIDGE_EVENTS.has(eventName)) return true;
    const key = `${category}:${eventName}`;
    const previous = this.lastBridgeEventAt.get(key);
    if (previous !== undefined && now - previous < BRIDGE_ANOMALY_INTERVAL_MS) return false;
    this.lastBridgeEventAt.set(key, now);
    return true;
  }

  private startCaptureFor(record: DebugRecord): void {
    if (!this.isCaptureEvent(record.eventName)) return;
    const now = record.monotonicMs;
    const duplicate = this.captures.find((capture) => capture.triggerEvent === record.eventName && now - capture.startedAtMonotonicMs < 750);
    if (duplicate) return;
    const before = this.ringRecords.filter((entry) => now - entry.monotonicMs <= RING_WINDOW_MS);
    const capture: BlackBoxCapture = {
      id: (this.captures[this.captures.length - 1]?.id ?? 0) + 1,
      triggerSequenceId: record.sequenceId,
      triggerEvent: record.eventName,
      startedAtMonotonicMs: Math.max(0, now - RING_WINDOW_MS),
      endsAtMonotonicMs: now + POST_EVENT_WINDOW_MS,
      before: [...before],
      after: [],
      completed: false,
    };
    this.captures.push(capture);
    const active = this.captures.filter((item) => !item.completed);
    while (active.length > MAX_ACTIVE_CAPTURES) {
      const oldest = active.shift();
      if (oldest) oldest.completed = true;
    }
    while (this.captures.length > MAX_SAVED_CAPTURES) this.captures.shift();
  }

  private updateCaptures(record: DebugRecord): void {
    for (const capture of this.captures) {
      if (capture.completed || record.monotonicMs <= capture.startedAtMonotonicMs || record.sequenceId === capture.triggerSequenceId) continue;
      if (record.monotonicMs <= capture.endsAtMonotonicMs) capture.after.push(record);
      else capture.completed = true;
    }
  }

  private isCaptureEvent(eventName: string): boolean {
    return [
      'TRACKING_LOST', 'TRACKING_RECOVERED', 'CAMERA_POSE_INVALID', 'CAMERA_POSE_SPIKE',
      'CAMERA_ACCELERATION_SPIKE', 'CAMERA_POSE_MATRIX_MISMATCH', 'CAMERA_VIDEO_FRAME_STALL',
      'CAMERA_VIDEO_DROPPED_FRAMES', 'CAMERA_POSE_JITTER_CANDIDATE', 'MODEL_FRAME_JITTER',
      'MODEL_WORLD_JUMP', 'COMPENSATION_ANOMALY', 'FRAME_DELAY',
      'FPS_DROP', 'DUPLICATE_RENDER', 'RENDER_WITHOUT_TRACKING_UPDATE', 'ORIGIN_SHIFT_SUSPECTED', 'ANCHOR_WORLD_DRIFT',
    ].includes(eventName);
  }

  private applyTrackingStatus(status: string, reason: string, source: string): void {
    const normalized = status === 'NORMAL' || status === 'LIMITED' ? status : String(status || 'UNKNOWN');
    const previous = this.lastTrackingStatus;
    if (!previous) {
      this.currentTrackingState = normalized;
      this.lastTrackingStatus = { status: normalized, reason };
      this.record('TRACKING', normalized === 'NORMAL' && reason !== 'INITIALIZING' ? 'TRACKING_READY' : 'TRACKING_STATE_INITIAL', {
        status: normalized, reason, source,
      }, { bridge: true });
      return;
    }
    if (previous.status === normalized && previous.reason === reason) return;
    this.currentTrackingState = normalized;
    this.lastTrackingStatus = { status: normalized, reason };
    const recovered = previous.status !== 'NORMAL' && normalized === 'NORMAL' && reason !== 'INITIALIZING';
    const lost = previous.status === 'NORMAL' && normalized !== 'NORMAL';
    this.record('TRACKING', recovered ? 'TRACKING_RECOVERED' : lost ? 'TRACKING_LOST' : 'TRACKING_STATUS_CHANGED', {
      previousStatus: previous.status,
      previousReason: previous.reason,
      status: normalized,
      reason,
      source,
    }, { bridge: true, capture: lost || recovered });
    if (recovered) this.analyzeRecovery();
  }

  private captureRawPose(reality: any, now: number): Record<string, unknown> | null {
    if (!reality) {
      if (!this.missingRealityActive) {
        this.missingRealityActive = true;
        this.record('TRACKING', 'XR8_REALITY_DATA_MISSING', {
          trackingStatus: this.currentTrackingState,
          poseTimestamp: null,
          detail: 'No processCpuResult.reality object was present for this pipeline update.',
        }, { bridge: true, capture: true });
      }
      return null;
    }
    this.missingRealityActive = false;
    const position = reality?.position;
    const rotation = reality?.rotation;
    if (!finiteVector(position) || !finiteQuaternion(rotation)) {
      const hasReality = Boolean(reality);
      const eventKey = `${hasReality}:${Boolean(position)}:${Boolean(rotation)}`;
      if (hasReality && this.lastInvalidPoseKey !== eventKey) {
        this.lastInvalidPoseKey = eventKey;
        this.record('TRACKING', 'CAMERA_POSE_INVALID', {
          hasPosition: Boolean(position),
          hasRotation: Boolean(rotation),
          trackingStatus: reality?.trackingStatus ?? null,
          trackingReason: reality?.trackingReason ?? null,
          poseTimestamp: null,
        }, { bridge: true, capture: true });
      }
      return null;
    }
    this.lastInvalidPoseKey = '';
    const quaternion = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
    const quaternionLength = quaternion.length();
    if (!Number.isFinite(quaternionLength) || quaternionLength < 1e-6) {
      this.record('TRACKING', 'CAMERA_POSE_INVALID', { reason: 'zero_length_quaternion', quaternion: quaternionValues(quaternion) }, { bridge: true, capture: true });
      return null;
    }
    quaternion.normalize();
    const positionVector = new THREE.Vector3(position.x, position.y, position.z);
    const previous = this.lastRawPose;
    const previousVelocity = previous?.velocity ?? null;
    let velocity: THREE.Vector3 | null = null;
    let translationDeltaM: number | null = null;
    let rotationDeltaDeg: number | null = null;
    let speedMps: number | null = null;
    let accelerationMps2: number | null = null;
    let angularAccelerationDegPerSec2: number | null = null;
    let velocityDiscontinuityMps: number | null = null;
    let elapsedMs: number | null = null;
    if (previous) {
      elapsedMs = now - previous.at;
      const seconds = elapsedMs / 1000;
      translationDeltaM = positionVector.distanceTo(previous.position);
      rotationDeltaDeg = THREE.MathUtils.radToDeg(quaternion.angleTo(previous.quaternion));
      if (seconds > 0 && seconds < 2) {
        velocity = positionVector.clone().sub(previous.position).multiplyScalar(1 / seconds);
        speedMps = velocity.length();
        const angularVelocity = rotationDeltaDeg / seconds;
        if (previous.angularVelocityDegPerSec !== null) {
          angularAccelerationDegPerSec2 = Math.abs(angularVelocity - previous.angularVelocityDegPerSec) / seconds;
        }
        if (previousVelocity) {
          accelerationMps2 = velocity.distanceTo(previousVelocity) / seconds;
          velocityDiscontinuityMps = velocity.distanceTo(previousVelocity);
        }
      }
    }
    const result = {
      position: vectorValues(positionVector),
      quaternion: quaternionValues(quaternion),
      poseTimestamp: null,
      callbackMonotonicMs: round(now, 3),
      trackingStatus: reality.trackingStatus ?? null,
      trackingReason: reality.trackingReason ?? null,
      translationDeltaM: translationDeltaM === null ? null : round(translationDeltaM, 5),
      rotationDeltaDeg: rotationDeltaDeg === null ? null : round(rotationDeltaDeg, 3),
      elapsedMs: elapsedMs === null ? null : round(elapsedMs, 2),
      linearVelocityMps: velocity ? vectorValues(velocity) : null,
      speedMps: speedMps === null ? null : round(speedMps, 3),
      angularVelocityDegPerSec: rotationDeltaDeg !== null && elapsedMs && elapsedMs > 0 ? round(rotationDeltaDeg * 1000 / elapsedMs, 2) : null,
      angularAccelerationDegPerSec2: angularAccelerationDegPerSec2 === null ? null : round(angularAccelerationDegPerSec2, 2),
      accelerationMps2: accelerationMps2 === null ? null : round(accelerationMps2, 2),
      velocityDiscontinuityMps: velocityDiscontinuityMps === null ? null : round(velocityDiscontinuityMps, 2),
      poseDiscontinuity: false,
    };
    const angularVelocityDegPerSec = rotationDeltaDeg !== null && elapsedMs && elapsedMs > 0
      ? rotationDeltaDeg * 1000 / elapsedMs
      : null;
    this.lastRawPose = { position: positionVector, quaternion, at: now, velocity, angularVelocityDegPerSec };
    this.sampleStationaryCameraPose(positionVector, quaternion, now);
    if (translationDeltaM !== null && rotationDeltaDeg !== null && speedMps !== null) {
      this.cameraDeltas.push({
        translationM: translationDeltaM,
        rotationDeg: rotationDeltaDeg,
        velocityMps: speedMps,
        accelerationMps2,
        at: now,
        sequenceId: this.sequenceId + 1,
      });
      this.cameraDeltas = this.cameraDeltas.filter((sample) => now - sample.at <= RING_WINDOW_MS).slice(-600);
    }
    const possibleSpike = translationDeltaM !== null && rotationDeltaDeg !== null && elapsedMs !== null && elapsedMs < 250 && (
      (translationDeltaM >= this.thresholds.translationSpikeM &&
        (velocityDiscontinuityMps === null || velocityDiscontinuityMps >= this.thresholds.velocityDiscontinuityMps || this.isTrackingRecoveryRecent(now))) ||
      (rotationDeltaDeg >= this.thresholds.rotationSpikeDeg && elapsedMs < 250)
    );
    const accelerationSpike = (accelerationMps2 !== null && accelerationMps2 >= this.thresholds.accelerationMps2) ||
      (angularAccelerationDegPerSec2 !== null && angularAccelerationDegPerSec2 >= this.thresholds.angularAccelerationDegPerSec2);
    if (possibleSpike) {
      result.poseDiscontinuity = true;
      this.record('TRACKING', 'CAMERA_POSE_SPIKE', {
        ...result,
        statusTransitionRecent: this.isTrackingRecoveryRecent(now),
        interpretation: 'Pose delta exceeds configurable threshold; movement intent cannot be inferred from one sample.',
        thresholds: {
          translationSpikeM: this.thresholds.translationSpikeM,
          rotationSpikeDeg: this.thresholds.rotationSpikeDeg,
          velocityDiscontinuityMps: this.thresholds.velocityDiscontinuityMps,
        },
      }, { bridge: true, capture: true });
      this.analyzeCameraSpike();
    }
    if (accelerationSpike) {
      this.record('TRACKING', 'CAMERA_ACCELERATION_SPIKE', {
        accelerationMps2: accelerationMps2 === null ? null : round(accelerationMps2, 2),
        angularAccelerationDegPerSec2: angularAccelerationDegPerSec2 === null ? null : round(angularAccelerationDegPerSec2, 2),
        velocityDiscontinuityMps: velocityDiscontinuityMps === null ? null : round(velocityDiscontinuityMps, 2),
        translationDeltaM,
        rotationDeltaDeg,
        interpretation: 'Single-frame candidate; compare adjacent samples and scenario marker before attributing to tracking.',
      }, { bridge: true, capture: true });
    }
    return result;
  }

  private sampleStationaryCameraPose(position: THREE.Vector3, quaternion: THREE.Quaternion, now: number): void {
    const stationaryScenario = this.activeScenarioLabel.toUpperCase().includes('STATIONARY');
    if (!stationaryScenario) {
      this.cameraPoseSamples = [];
      this.cameraPoseJitterActive = false;
      return;
    }

    this.cameraPoseSamples.push({ at: now, position: position.clone(), quaternion: quaternion.clone() });
    this.cameraPoseSamples = this.cameraPoseSamples
      .filter((sample) => now - sample.at <= this.thresholds.cameraPoseJitterWindowMs)
      .slice(-240);
    if (this.cameraPoseSamples.length < this.thresholds.cameraPoseJitterMinSamples) return;

    const first = this.cameraPoseSamples[0];
    const last = this.cameraPoseSamples[this.cameraPoseSamples.length - 1];
    let translationPathM = 0;
    let rotationPathDeg = 0;
    for (let index = 1; index < this.cameraPoseSamples.length; index += 1) {
      const previous = this.cameraPoseSamples[index - 1];
      const current = this.cameraPoseSamples[index];
      translationPathM += current.position.distanceTo(previous.position);
      rotationPathDeg += THREE.MathUtils.radToDeg(previous.quaternion.angleTo(current.quaternion));
    }
    const netTranslationM = first.position.distanceTo(last.position);
    const netRotationDeg = THREE.MathUtils.radToDeg(first.quaternion.angleTo(last.quaternion));
    const translationOscillation = translationPathM >= this.thresholds.cameraPoseJitterPathM &&
      netTranslationM <= this.thresholds.cameraPoseJitterNetM;
    const rotationOscillation = rotationPathDeg >= this.thresholds.cameraPoseJitterPathDeg &&
      netRotationDeg <= this.thresholds.cameraPoseJitterNetDeg;

    if (!translationOscillation && !rotationOscillation) {
      this.cameraPoseJitterActive = false;
      return;
    }
    if (this.cameraPoseJitterActive && now - this.lastCameraPoseJitterEventAt < 1000) return;
    this.cameraPoseJitterActive = true;
    this.lastCameraPoseJitterEventAt = now;
    const record = this.record('TRACKING', 'CAMERA_POSE_JITTER_CANDIDATE', {
      scenario: this.activeScenarioLabel,
      sampleCount: this.cameraPoseSamples.length,
      windowMs: round(last.at - first.at, 1),
      translationPathM: round(translationPathM, 5),
      netTranslationM: round(netTranslationM, 5),
      rotationPathDeg: round(rotationPathDeg, 3),
      netRotationDeg: round(netRotationDeg, 3),
      translationOscillation,
      rotationOscillation,
      thresholds: {
        pathM: this.thresholds.cameraPoseJitterPathM,
        netM: this.thresholds.cameraPoseJitterNetM,
        pathDeg: this.thresholds.cameraPoseJitterPathDeg,
        netDeg: this.thresholds.cameraPoseJitterNetDeg,
      },
      interpretation: 'Pose oscillation candidate during the marked stationary scenario; physical hand motion and SLAM pose noise cannot be separated from pose telemetry alone.',
    }, { capture: true, bridge: true });
    this.addRootCause(
      'SUSPECTED',
      'Camera tracking pose oscillated during a marked stationary scenario.',
      [record.sequenceId],
      'The raw XR8 pose traveled beyond the configured path threshold while ending near its starting pose. This confirms oscillatory pose samples, not whether the device itself moved or SLAM introduced the motion.'
    );
  }

  private sampleCameraVideo(now: number): Record<string, unknown> | null {
    const video = this.cameraVideoElement;
    if (!video) return null;

    const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : null;
    let totalVideoFrames: number | null = null;
    let droppedVideoFrames: number | null = null;
    let qualityApiAvailable = false;
    try {
      const videoWithQuality = video as HTMLVideoElement & { getVideoPlaybackQuality?: () => VideoPlaybackQuality };
      if (typeof videoWithQuality.getVideoPlaybackQuality === 'function') {
        const quality = videoWithQuality.getVideoPlaybackQuality();
        totalVideoFrames = Number.isFinite(quality.totalVideoFrames) ? quality.totalVideoFrames : null;
        droppedVideoFrames = Number.isFinite(quality.droppedVideoFrames) ? quality.droppedVideoFrames : null;
        qualityApiAvailable = true;
      }
    } catch {
      // Video quality counters are optional and may be unavailable in Safari.
    }

    const previous = this.lastCameraVideoSample;
    const mediaFrameIntervalMs = previous && currentTime !== null && currentTime > previous.currentTime + 0.0001
      ? round((currentTime - previous.currentTime) * 1000, 2)
      : null;
    const mediaTimeAdvanced = mediaFrameIntervalMs !== null;
    const videoTimeReset = Boolean(previous && currentTime !== null && currentTime + 0.0001 < previous.currentTime);

    let deltaTotalVideoFrames: number | null = null;
    let deltaDroppedVideoFrames: number | null = null;
    if (previous && totalVideoFrames !== null && previous.totalVideoFrames !== null && totalVideoFrames >= previous.totalVideoFrames) {
      deltaTotalVideoFrames = totalVideoFrames - previous.totalVideoFrames;
    }
    if (previous && droppedVideoFrames !== null && previous.droppedVideoFrames !== null && droppedVideoFrames >= previous.droppedVideoFrames) {
      deltaDroppedVideoFrames = droppedVideoFrames - previous.droppedVideoFrames;
      if (deltaDroppedVideoFrames > 0) this.cameraVideoDropSamples.push({ at: now, count: deltaDroppedVideoFrames });
    } else if (previous && droppedVideoFrames !== null && previous.droppedVideoFrames !== null && droppedVideoFrames < previous.droppedVideoFrames) {
      this.cameraVideoDropSamples = [];
      this.cameraVideoDropActive = false;
    }
    const videoFrameAdvanced = mediaTimeAdvanced || videoTimeReset || (deltaTotalVideoFrames !== null && deltaTotalVideoFrames > 0);
    if (this.lastCameraVideoAdvanceAt === 0 || videoFrameAdvanced) this.lastCameraVideoAdvanceAt = now;
    this.cameraVideoDropSamples = this.cameraVideoDropSamples.filter((sample) => now - sample.at <= this.thresholds.cameraDroppedFramesWindowMs);
    const droppedFramesInWindow = this.cameraVideoDropSamples.reduce((sum, sample) => sum + sample.count, 0);

    const videoIsPlaying = !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    const videoTimeStallMs = this.lastCameraVideoAdvanceAt > 0 ? now - this.lastCameraVideoAdvanceAt : 0;
    if (videoIsPlaying && videoTimeStallMs >= this.thresholds.cameraVideoStallMs && !this.cameraVideoStallActive) {
      this.cameraVideoStallActive = true;
      const record = this.record('TRACKING', 'CAMERA_VIDEO_FRAME_STALL', {
        currentTimeSeconds: currentTime,
        videoTimeStallMs: round(videoTimeStallMs, 1),
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        thresholdMs: this.thresholds.cameraVideoStallMs,
        interpretation: 'The XR8 video element currentTime stopped advancing while playback remained active; this indicates a video presentation stall, not necessarily a camera sensor failure.',
      }, { capture: true, bridge: true });
      this.analyzeCameraVideoStutter(record);
    } else if (videoFrameAdvanced && this.cameraVideoStallActive) {
      this.cameraVideoStallActive = false;
      this.record('TRACKING', 'CAMERA_VIDEO_FRAME_RESUMED', {
        currentTimeSeconds: currentTime,
        mediaFrameIntervalMs,
        totalVideoFrames,
        droppedVideoFrames,
      }, { bridge: true });
    }

    if (droppedFramesInWindow >= this.thresholds.cameraDroppedFramesThreshold && !this.cameraVideoDropActive) {
      this.cameraVideoDropActive = true;
      const record = this.record('TRACKING', 'CAMERA_VIDEO_DROPPED_FRAMES', {
        droppedFramesInWindow,
        windowMs: this.thresholds.cameraDroppedFramesWindowMs,
        totalVideoFrames,
        droppedVideoFrames,
        qualityApiAvailable,
        interpretation: 'Browser video-element counters report dropped frames; they do not identify whether capture, decode, or presentation caused the drop.',
      }, { capture: true, bridge: true });
      this.analyzeCameraVideoStutter(record);
    } else if (droppedFramesInWindow < this.thresholds.cameraDroppedFramesThreshold && this.cameraVideoDropActive) {
      this.cameraVideoDropActive = false;
      this.record('TRACKING', 'CAMERA_VIDEO_DROPS_CLEARED', {
        droppedFramesInWindow,
        windowMs: this.thresholds.cameraDroppedFramesWindowMs,
        totalVideoFrames,
        droppedVideoFrames,
      }, { bridge: true });
    }

    this.lastCameraVideoSample = {
      at: now,
      currentTime: currentTime ?? previous?.currentTime ?? 0,
      totalVideoFrames,
      droppedVideoFrames,
    };
    return {
      currentTimeSeconds: currentTime,
      mediaFrameIntervalMs,
      videoTimeStallMs: round(videoTimeStallMs, 1),
      totalVideoFrames,
      droppedVideoFrames,
      deltaTotalVideoFrames,
      deltaDroppedVideoFrames,
      droppedFramesInWindow,
      droppedFramesWindowMs: this.thresholds.cameraDroppedFramesWindowMs,
      qualityApiAvailable,
      readyState: video.readyState,
      paused: video.paused,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    };
  }

  private compareRawPoseToCamera(reality: any, camera: TransformSnapshot | null): Record<string, unknown> | null {
    if (!reality || !camera || !finiteVector(reality.position) || !finiteQuaternion(reality.rotation)) return null;
    const rawPosition = new THREE.Vector3(reality.position.x, reality.position.y, reality.position.z);
    const rawQuaternion = new THREE.Quaternion(reality.rotation.x, reality.rotation.y, reality.rotation.z, reality.rotation.w).normalize();
    const threePosition = new THREE.Vector3(...camera.world.position as [number, number, number]);
    const threeQuaternion = new THREE.Quaternion(...camera.world.quaternion as [number, number, number, number]);
    return {
      translationErrorM: round(rawPosition.distanceTo(threePosition), 6),
      rotationErrorDeg: round(THREE.MathUtils.radToDeg(rawQuaternion.angleTo(threeQuaternion)), 5),
      rawPoseMatchesThreeCamera: rawPosition.distanceTo(threePosition) < 1e-4 && rawQuaternion.angleTo(threeQuaternion) < 1e-4,
    };
  }

  private evaluateCameraPoseMismatch(comparison: Record<string, unknown> | null): void {
    if (!comparison) {
      this.cameraPoseMismatchFrames = 0;
      this.cameraPoseMismatchActive = false;
      return;
    }
    const translationErrorM = Number(comparison.translationErrorM);
    const rotationErrorDeg = Number(comparison.rotationErrorDeg);
    const mismatched = translationErrorM >= this.thresholds.cameraPoseMismatchM ||
      rotationErrorDeg >= this.thresholds.cameraPoseMismatchDeg;
    if (!mismatched) {
      this.cameraPoseMismatchFrames = 0;
      this.cameraPoseMismatchActive = false;
      return;
    }
    this.cameraPoseMismatchFrames += 1;
    if (this.cameraPoseMismatchFrames < 3 || this.cameraPoseMismatchActive) return;
    this.cameraPoseMismatchActive = true;
    const record = this.record('RENDER', 'CAMERA_POSE_MATRIX_MISMATCH', {
      ...comparison,
      consecutiveFrames: this.cameraPoseMismatchFrames,
      thresholds: {
        translationM: this.thresholds.cameraPoseMismatchM,
        rotationDeg: this.thresholds.cameraPoseMismatchDeg,
      },
      interpretation: 'Persistent raw XR8 pose versus Three.js camera world-pose difference; coordinate mapping or update order requires review.',
    }, { capture: true, bridge: true });
    this.addRootCause(
      'SUSPECTED',
      'XR8 raw camera pose and Three.js camera world pose differ persistently.',
      [record.sequenceId],
      'The measured pose discrepancy exceeded configurable bounds for at least three consecutive XR8 updates. Verify coordinate conventions and pipeline update order before attributing it to render synchronization.'
    );
  }

  private captureProjection(reality: any, camera: THREE.Camera | null): Record<string, any> | null {
    if (!camera) return null;
    const raw = Array.isArray(reality?.intrinsics) && reality.intrinsics.length === 16 && reality.intrinsics.every(Number.isFinite)
      ? reality.intrinsics.map((value: number) => round(value, 7))
      : null;
    const cameraMatrix = matrixValues(camera.projectionMatrix);
    const previous = this.lastProjection;
    const rawChanged = Boolean(raw && previous?.raw && this.matrixArrayError(raw, previous.raw) > 1e-6);
    const cameraChanged = Boolean(previous?.camera && this.matrixArrayError(cameraMatrix, previous.camera) > 1e-6);
    if (rawChanged || cameraChanged) {
      this.record('RENDER', 'PROJECTION_MATRIX_CHANGED', {
        rawIntrinsicsChanged: rawChanged,
        threeProjectionChanged: cameraChanged,
        rawIntrinsics: raw,
        threeProjection: cameraMatrix,
        frame: this.currentTrackingFrame,
      }, { bridge: false });
    }
    return { rawIntrinsics: raw, threeProjection: cameraMatrix, rawChanged, cameraChanged };
  }

  private worldPointConfidenceSummary(points: unknown): Record<string, unknown> | null {
    if (!Array.isArray(points) || points.length === 0) return null;
    const confidences = points.map((point: any) => point?.confidence).filter((value: unknown): value is number => typeof value === 'number' && Number.isFinite(value));
    if (confidences.length === 0) return { worldPointCount: points.length, confidenceSamples: 0 };
    return {
      worldPointCount: points.length,
      confidenceSamples: confidences.length,
      confidenceMin: round(Math.min(...confidences), 4),
      confidenceMean: round(confidences.reduce((sum: number, value: number) => sum + value, 0) / confidences.length, 4),
      confidenceMax: round(Math.max(...confidences), 4),
      source: 'XR8 reality.worldPoints[].confidence; not overall tracking confidence',
    };
  }

  private detectFrameTransformChanges(transforms: Record<string, TransformSnapshot | null>): void {
    const anchorSnapshot = transforms.worldAnchor;
    if (anchorSnapshot && this.expectedAnchorWorldMatrix) {
      const actual = new THREE.Matrix4().fromArray(anchorSnapshot.world.matrix);
      const expectedPosition = new THREE.Vector3();
      const expectedQuaternion = new THREE.Quaternion();
      const expectedScale = new THREE.Vector3();
      this.expectedAnchorWorldMatrix.decompose(expectedPosition, expectedQuaternion, expectedScale);
      const actualPosition = new THREE.Vector3(...anchorSnapshot.world.position as [number, number, number]);
      const actualQuaternion = new THREE.Quaternion(...anchorSnapshot.world.quaternion as [number, number, number, number]);
      const translationM = expectedPosition.distanceTo(actualPosition);
      const rotationDeg = THREE.MathUtils.radToDeg(expectedQuaternion.angleTo(actualQuaternion));
      const matrixError = maxMatrixDifference(actual, this.expectedAnchorWorldMatrix);
      if (translationM >= this.thresholds.anchorDriftM || rotationDeg >= this.thresholds.anchorDriftDeg) {
        const writer = this.lastWriterByObject.get(this.objects.worldAnchor?.uuid ?? '');
        const driftRecord = this.record('ANCHOR', 'ANCHOR_WORLD_DRIFT', {
          translationFromExpectedM: round(translationM, 5),
          rotationFromExpectedDeg: round(rotationDeg, 4),
          matrixError: round(matrixError, 8),
          expectedWorldMatrix: matrixValues(this.expectedAnchorWorldMatrix),
          actualWorldMatrix: anchorSnapshot.world.matrix,
          latestTransformWriter: writer ?? null,
          thresholds: { translationM: this.thresholds.anchorDriftM, rotationDeg: this.thresholds.anchorDriftDeg },
        }, { capture: true, bridge: true });
        this.analyzeAnchorDrift(driftRecord, writer ?? null);
      }
    }

    for (const [key, current] of Object.entries(transforms)) {
      if (!current) continue;
      if (current.matrixWorldStale) this.reportMatrixWorldStale(current, 'after scene update, before renderer');
      else this.staleBeforeRender.delete(current.objectId);
      const previous = this.lastFrameTransforms.get(key);
      this.lastFrameTransforms.set(key, current);
      if (!previous) continue;
      const localMatrixDelta = this.matrixArrayError(previous.local.matrix, current.local.matrix);
      const parentChanged = previous.parentId !== current.parentId;
      const writer = this.lastWriterByObject.get(current.objectId);
      const writerRecent = Boolean(writer && performance.now() - writer.at <= 100);
      if ((localMatrixDelta > 1e-5 || parentChanged) && !writerRecent &&
        (key === 'targetAnchor' || key === 'worldAnchor' || key === 'productRoot' || key === 'storyGroup' || key === 'bottleGroup' || key === 'modelRoot')) {
        const positionDeltaM = this.arrayDistance(previous.world.position, current.world.position);
        const rotationDeltaDeg = this.quaternionDeltaDeg(previous.world.quaternion, current.world.quaternion);
        if (positionDeltaM >= this.thresholds.modelJumpM || rotationDeltaDeg >= this.thresholds.modelJumpDeg || parentChanged) {
          const unexpected = this.record('MODEL', 'UNATTRIBUTED_TRANSFORM_CHANGE', {
            object: current.object,
            source: 'UNKNOWN_WRITER',
            oldTransform: previous,
            newTransform: current,
            localMatrixDeltaMax: round(localMatrixDelta, 8),
            positionDeltaM: round(positionDeltaM, 5),
            rotationDeltaDeg: round(rotationDeltaDeg, 4),
            parentChanged,
            reason: 'Transform changed between XR8 update samples without a matching instrumented writer event.',
          }, { capture: true, bridge: true });
          this.addRootCause('SUSPECTED', 'A tracked model transform changed without a matching instrumented writer.', [unexpected.sequenceId], 'The frame snapshots confirm the transform delta, but the code path that wrote it was not observed by the registered instrumentation points.');
        }
      }
      if (key !== 'productRoot') continue;
      const translationM = this.arrayDistance(previous.world.position, current.world.position);
      const rotationDeg = this.quaternionDeltaDeg(previous.world.quaternion, current.world.quaternion);
      this.sampleModelFrameJitter(translationM, rotationDeg, current, writerRecent && writer ? writer : null, parentChanged, performance.now());
      if (translationM < this.thresholds.modelJumpM && rotationDeg < this.thresholds.modelJumpDeg) continue;
      const record = this.record('MODEL', 'MODEL_WORLD_JUMP', {
        object: current.object,
        translationM,
        rotationDeg,
        oldTransform: previous,
        newTransform: current,
        writer: writerRecent ? writer : null,
        parentChanged,
        matrixWorldStale: current.matrixWorldStale,
        trackingState: this.currentTrackingState,
      }, { capture: true, bridge: true });
      this.analyzeModelJump(record, translationM, rotationDeg);
    }
  }

  private sampleModelFrameJitter(
    translationM: number,
    rotationDeg: number,
    current: TransformSnapshot,
    writer: { source: string; reason: string; sequenceId: number; at: number } | null,
    parentChanged: boolean,
    now: number
  ): void {
    const moved = translationM >= this.thresholds.modelJitterTranslationM ||
      rotationDeg >= this.thresholds.modelJitterRotationDeg || parentChanged;
    if (moved) {
      const compensationRecent = this.ringRecords.some((entry) =>
        entry.eventName === 'COMPENSATION_APPLIED' && now - entry.monotonicMs <= this.thresholds.modelJitterWindowMs
      );
      this.modelJitterSamples.push({
        at: now,
        sequenceId: findLastValue(this.ringRecords, (entry) =>
          entry.eventName === 'TRACKING_FRAME' && entry.trackingFrameSequence === this.currentTrackingFrame
        )?.sequenceId ?? this.sequenceId,
        translationM,
        rotationDeg,
        writer: writer?.source ?? null,
        writerSequenceId: writer?.sequenceId ?? null,
        compensationRecent,
        parentChanged,
      });
    }
    this.modelJitterSamples = this.modelJitterSamples.filter((sample) => now - sample.at <= this.thresholds.modelJitterWindowMs).slice(-240);
    const samples = this.modelJitterSamples;
    if (samples.length < this.thresholds.modelJitterMinimumSamples) {
      this.modelJitterActive = false;
      return;
    }
    if (this.modelJitterActive) return;

    this.modelJitterActive = true;
    const recentCamera = this.cameraDeltas.filter((sample) => now - sample.at <= this.thresholds.modelJitterWindowMs);
    const cameraStable = recentCamera.length >= 3 && recentCamera.every((sample) =>
      sample.translationM <= this.thresholds.stableCameraM && sample.rotationDeg <= this.thresholds.stableCameraDeg
    );
    const compensationCount = this.ringRecords.filter((entry) =>
      entry.eventName === 'COMPENSATION_APPLIED' && now - entry.monotonicMs <= this.thresholds.modelJitterWindowMs
    ).length;
    const maxTranslationM = Math.max(...samples.map((sample) => sample.translationM));
    const maxRotationDeg = Math.max(...samples.map((sample) => sample.rotationDeg));
    const record = this.record('MODEL', 'MODEL_FRAME_JITTER', {
      object: current.object,
      sampleCount: samples.length,
      windowMs: this.thresholds.modelJitterWindowMs,
      maxTranslationDeltaM: round(maxTranslationM, 6),
      maxRotationDeltaDeg: round(maxRotationDeg, 4),
      cameraStable,
      cameraSampleCount: recentCamera.length,
      compensationCountInWindow: compensationCount,
      recentWriters: [...new Set(samples.map((sample) => sample.writer).filter(Boolean))],
      parentChangedInSamples: samples.some((sample) => sample.parentChanged),
      trackingState: this.currentTrackingState,
      currentTransform: current,
      thresholds: {
        translationM: this.thresholds.modelJitterTranslationM,
        rotationDeg: this.thresholds.modelJitterRotationDeg,
        minimumSamples: this.thresholds.modelJitterMinimumSamples,
      },
      interpretation: compensationCount > 0
        ? 'ProductRoot world transform changed repeatedly near anchor compensation writes; inspect compensation records before attributing visible jitter to an independent model writer.'
        : cameraStable
          ? 'ProductRoot world transform changed repeatedly while raw camera pose samples stayed within stability bounds.'
          : 'ProductRoot world transform changed repeatedly while camera motion was also present; compare raw pose, anchor writer, and render timing.',
    }, { capture: true, bridge: true });
    this.addRootCause(
      'SUSPECTED',
      cameraStable && compensationCount === 0
        ? 'ProductRoot world transform changed repeatedly while camera pose was stable.'
        : 'ProductRoot world transform changed repeatedly within the analysis window.',
      [record.sequenceId, ...samples.slice(-this.thresholds.modelJitterMinimumSamples).flatMap((sample) => [
        sample.sequenceId,
        ...(sample.writerSequenceId === null ? [] : [sample.writerSequenceId]),
      ])],
      compensationCount > 0
        ? `${compensationCount} anchor compensation writes occurred in the same ${this.thresholds.modelJitterWindowMs} ms window; this pattern is measured but does not prove the compensation is incorrect.`
        : `Observed ${samples.length} ProductRoot world-transform deltas in ${this.thresholds.modelJitterWindowMs} ms; compare source writer and tracking state to determine whether tracking or app transforms caused them.`
    );
  }

  private recordFrameDelay(frameMs: number, source: string): void {
    this.record('RENDER', 'FRAME_DELAY', {
      frameMs: round(frameMs, 2),
      source,
      fpsRollingAverage: this.fpsAverage(),
      frameTimeP95Ms: percentile(this.frameDeltasMs, 0.95),
      frameTimeP99Ms: percentile(this.frameDeltasMs, 0.99),
      droppedFramesEstimated: Math.max(0, Math.floor(frameMs / this.frameBudgetMs()) - 1),
      effectiveFrameBudgetMs: round(this.frameBudgetMs(), 2),
      thresholdMs: this.thresholds.frameSpikeMs,
    }, { capture: true, bridge: true });
    if ((this.fpsAverage() ?? 60) <= this.thresholds.fpsDropBelow || frameMs >= this.thresholds.severeFrameMs) {
      this.record('RENDER', 'FPS_DROP', {
        fpsRollingAverage: this.fpsAverage(),
        frameMs: round(frameMs, 2),
        thresholdFps: this.thresholds.fpsDropBelow,
      }, { capture: true, bridge: true });
      this.analyzeFrameDelay();
    }
  }

  private wrapRenderer(): void {
    const renderer = this.renderer;
    if (!this.enabled || !renderer || this.originalRender) return;
    const original = renderer.render;
    const owner = this;
    const wrapped: THREE.WebGLRenderer['render'] = function (this: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
      if (!owner.enabled || (owner.objects.scene && scene !== owner.objects.scene) || (owner.objects.camera && camera !== owner.objects.camera)) {
        original.call(this, scene, camera);
        return;
      }
      owner.onRenderStart(camera);
      const startedAt = performance.now();
      owner.rendererCallActive = true;
      try {
        original.call(this, scene, camera);
      } finally {
        owner.rendererCallActive = false;
        owner.onRenderEnd(camera, performance.now() - startedAt);
      }
    };
    this.originalRender = original;
    this.wrappedRender = wrapped;
    renderer.render = wrapped;
  }

  private restoreRenderer(): void {
    if (this.renderer && this.originalRender && this.renderer.render === this.wrappedRender) {
      this.renderer.render = this.originalRender;
    }
    this.renderer = null;
    this.originalRender = null;
    this.wrappedRender = null;
  }

  private onRenderStart(camera: THREE.Camera): void {
    const now = performance.now();
    const frame = this.currentTrackingFrame;
    if (frame === null) return;
    const count = (this.renderCounts.get(frame) ?? 0) + 1;
    this.renderCounts.set(frame, count);
    const frameStart = findLastValue(this.ringRecords, (entry) => entry.eventName === 'TRACKING_FRAME' && entry.trackingFrameSequence === frame);
    const renderUpdateGapMs = this.latestFrameUpdateStart > 0 ? now - this.latestFrameUpdateStart : null;
    const cameraSnapshot = this.snapshotObject(camera);
    const cameraPoseAgeMs = this.latestFrameUpdateStart > 0 ? now - this.latestFrameUpdateStart : null;
    const renderRecord = this.record('RENDER', 'RENDER_START', {
      trackingFrameSequence: frame,
      xr8FrameId: this.currentXr8FrameId,
      renderIndexForTrackingFrame: count,
      cameraPoseAgeMs: cameraPoseAgeMs === null ? null : round(cameraPoseAgeMs, 2),
      frameUpdateCompletedBeforeRender: this.currentFrameWasUpdated,
      renderUpdateGapMs: renderUpdateGapMs === null ? null : round(renderUpdateGapMs, 2),
      cameraBeforeRendererMatrixUpdate: cameraSnapshot,
      cameraMatrixWasStale: cameraSnapshot.matrixWorldStale,
    }, { trackingFrameSequence: frame, xr8FrameId: this.currentXr8FrameId, bridge: false });
    if (frameStart) {
      frameStart.payload.renderCallsForTrackingFrame = count;
      frameStart.payload.renderSequenceId = renderRecord.sequenceId;
      frameStart.payload.renderUsedSameTrackingFrame = this.currentFrameWasUpdated && frameStart.trackingFrameSequence === frame;
    }
    if (!this.currentFrameWasUpdated) {
      this.record('RENDER', 'MODEL_UPDATE_ORDER_ANOMALY', {
        trackingFrameSequence: frame,
        frameUpdateCompletedBeforeRender: false,
      }, { capture: true, bridge: true });
    }
  }

  private onRenderEnd(camera: THREE.Camera, durationMs: number): void {
    const now = performance.now();
    const frame = this.currentTrackingFrame;
    if (frame === null) return;
    const count = this.renderCounts.get(frame) ?? 0;
    const cameraSnapshot = this.snapshotObject(camera);
    const entry = this.record('RENDER', 'RENDER_COMPLETE', {
      trackingFrameSequence: frame,
      renderIndexForTrackingFrame: count,
      renderDurationMs: round(durationMs, 2),
      cameraAfterRendererMatrixUpdate: cameraSnapshot,
      cameraMatrixWorldErrorBeforeAfter: this.findFrameStartCameraError(frame),
    }, { trackingFrameSequence: frame, xr8FrameId: this.currentXr8FrameId, bridge: false });
    this.latestRenderAt = now;
    const observedObjects = [
      this.objects.camera,
      this.objects.targetAnchor,
      this.objects.worldAnchor,
      this.objects.productRoot,
      this.objects.storyGroup,
      this.objects.bottleGroup,
      this.objects.modelRoot,
    ];
    for (const [objectId, stale] of this.staleBeforeRender) {
      if (stale.trackingFrameSequence !== frame) continue;
      const object = observedObjects.find((candidate) => candidate?.uuid === objectId);
      const afterRender = object ? this.snapshotObject(object) : null;
      this.record('RENDER', afterRender && !afterRender.matrixWorldStale ? 'MATRIX_WORLD_REFRESHED_BY_RENDERER' : 'MATRIX_WORLD_STILL_STALE_AFTER_RENDER', {
        object: stale.object,
        trackingFrameSequence: frame,
        afterRender,
      }, { bridge: false });
      this.staleBeforeRender.delete(objectId);
    }
    if (durationMs >= this.thresholds.frameSpikeMs) this.recordFrameDelay(durationMs, 'THREE_RENDER');
    if (count > 1 && this.lastDuplicateRenderFrame !== frame) {
      this.lastDuplicateRenderFrame = frame;
      const duplicate = this.record('RENDER', 'DUPLICATE_RENDER', {
        trackingFrameSequence: frame,
        renderCallsForTrackingFrame: count,
        evidence: 'renderer.render was observed more than once before the next XR8 onUpdate callback',
      }, { capture: true, bridge: true });
      this.addRootCause('CONFIRMED', 'Multiple Three.js render calls used one XR8 tracking frame.', [entry.sequenceId, duplicate.sequenceId], 'The existing renderer was called multiple times with the same local XR8 update sequence.');
    }
    const poseAgeMs = this.latestValidRawPoseAt > 0 ? now - this.latestValidRawPoseAt : null;
    if (poseAgeMs !== null && poseAgeMs > this.frameBudgetMs() * 2.5) {
      this.record('RENDER', 'STALE_TRACKING_FRAME_RENDER', {
        trackingFrameSequence: frame,
        poseAgeMs: round(poseAgeMs, 2),
        thresholdMs: round(this.frameBudgetMs() * 2.5, 2),
        renderSequenceId: entry.sequenceId,
      }, { capture: true, bridge: true });
    }
  }

  private findFrameStartCameraError(frame: number): number | null {
    const entry = findLastValue(this.ringRecords, (item) => item.eventName === 'TRACKING_FRAME' && item.trackingFrameSequence === frame);
    const snapshot = entry?.payload.threeCamera as TransformSnapshot | null | undefined;
    return snapshot ? snapshot.worldMatrixError : null;
  }

  private snapshotObject(object: THREE.Object3D): TransformSnapshot {
    const localMatrix = object.matrixAutoUpdate
      ? new THREE.Matrix4().compose(object.position, object.quaternion, object.scale)
      : object.matrix.clone();
    const worldMatrix = this.computeWorldMatrix(object);
    const parentWorld = object.parent ? this.computeWorldMatrix(object.parent) : null;
    const cachedWorld = object.matrixWorld.clone();
    const worldPosition = new THREE.Vector3();
    const worldQuaternion = new THREE.Quaternion();
    const worldScale = new THREE.Vector3();
    worldMatrix.decompose(worldPosition, worldQuaternion, worldScale);
    return {
      objectId: object.uuid,
      object: object.name || object.type,
      parent: object.parent ? object.parent.name || object.parent.type : null,
      parentId: object.parent?.uuid ?? null,
      local: {
        position: vectorValues(object.position),
        quaternion: quaternionValues(object.quaternion),
        scale: vectorValues(object.scale),
        matrix: matrixValues(localMatrix),
      },
      parentWorldMatrix: parentWorld ? matrixValues(parentWorld) : null,
      world: {
        position: vectorValues(worldPosition),
        quaternion: quaternionValues(worldQuaternion),
        scale: vectorValues(worldScale),
        matrix: matrixValues(worldMatrix),
      },
      cachedWorldMatrix: matrixValues(cachedWorld),
      worldMatrixError: round(maxMatrixDifference(worldMatrix, cachedWorld), 8),
      matrixWorldStale: maxMatrixDifference(worldMatrix, cachedWorld) > MATRIX_STALE_EPSILON,
      visible: object.visible,
    };
  }

  private reportMatrixWorldStale(snapshot: TransformSnapshot, phase: string): void {
    const frame = this.currentTrackingFrame;
    if (frame === null) return;
    const previous = this.staleBeforeRender.get(snapshot.objectId);
    if (previous?.trackingFrameSequence === frame) return;
    this.staleBeforeRender.set(snapshot.objectId, { object: snapshot.object, trackingFrameSequence: frame });
    this.record('RENDER', 'MATRIX_WORLD_STALE_BEFORE_RENDER', {
      object: snapshot.object,
      parent: snapshot.parent,
      phase,
      trackingFrameSequence: frame,
      computedWorldMatrix: snapshot.world.matrix,
      cachedWorldMatrix: snapshot.cachedWorldMatrix,
      matrixError: snapshot.worldMatrixError,
    }, { bridge: false });
  }

  private computeWorldMatrix(object: THREE.Object3D): THREE.Matrix4 {
    const ancestors: THREE.Object3D[] = [];
    let current: THREE.Object3D | null = object;
    while (current) {
      ancestors.push(current);
      current = current.parent;
    }
    const result = new THREE.Matrix4();
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
      const node = ancestors[index];
      const local = node.matrixAutoUpdate
        ? new THREE.Matrix4().compose(node.position, node.quaternion, node.scale)
        : node.matrix;
      result.multiply(local);
    }
    return result;
  }

  private modelToCameraRelative(camera: TransformSnapshot | null | undefined, model: TransformSnapshot | null | undefined): Record<string, unknown> | null {
    if (!camera || !model) return null;
    const cameraWorld = new THREE.Matrix4().fromArray(camera.world.matrix);
    const modelWorld = new THREE.Matrix4().fromArray(model.world.matrix);
    const relative = cameraWorld.clone().invert().multiply(modelWorld);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    relative.decompose(position, quaternion, scale);
    return {
      position: vectorValues(position),
      quaternion: quaternionValues(quaternion),
      scale: vectorValues(scale),
      matrix: matrixValues(relative),
    };
  }

  private isTrackingRecoveryRecent(now: number): boolean {
    const recovery = findLastValue(this.ringRecords, (entry) => entry.eventName === 'TRACKING_RECOVERED');
    return Boolean(recovery && now - recovery.monotonicMs <= 2_000);
  }

  private analyzeRecovery(): void {
    const now = performance.now();
    const recent = this.ringRecords.filter((entry) => now - entry.monotonicMs <= 2_500);
    const cameraSpike = findLastValue(recent, (entry) => entry.eventName === 'CAMERA_POSE_SPIKE');
    const modelJump = findLastValue(recent, (entry) => entry.eventName === 'MODEL_WORLD_JUMP');
    const compensation = recent.filter((entry) => entry.eventName === 'COMPENSATION_APPLIED');
    if (cameraSpike && modelJump) {
      const report = this.addRootCause('SUSPECTED', 'SLAM recovery or coordinate-origin discontinuity may explain the camera and model jump.', [cameraSpike.sequenceId, modelJump.sequenceId], 'Tracking recovered within the same short timeline as a camera pose spike and a model world-space jump. XR8 does not expose an origin-shift transform here.');
      this.record('TRACKING', 'ORIGIN_SHIFT_SUSPECTED', { rootCauseReport: report }, { capture: true, bridge: true });
    }
    if (compensation.length >= 2) {
      this.addRootCause('SUSPECTED', 'Repeated anchor compensation occurred around tracking recovery.', compensation.map((entry) => entry.sequenceId), `${compensation.length} compensation writes were recorded near recovery. Compare their timestamps to the recovery marker to determine whether they preceded or followed it.`);
    }
  }

  private analyzeCameraSpike(): void {
    const now = performance.now();
    const recent = this.ringRecords.filter((entry) => now - entry.monotonicMs <= 2_500);
    const recovery = findLastValue(recent, (entry) => entry.eventName === 'TRACKING_RECOVERED');
    const modelJump = findLastValue(recent, (entry) => entry.eventName === 'MODEL_WORLD_JUMP');
    const spike = findLastValue(recent, (entry) => entry.eventName === 'CAMERA_POSE_SPIKE');
    if (recovery && modelJump && spike) {
      this.addRootCause('SUSPECTED', 'SLAM recovery or coordinate-origin discontinuity may explain the camera and model jump.', [recovery.sequenceId, spike.sequenceId, modelJump.sequenceId], 'Status recovery, raw camera pose spike, and model world-space movement are correlated; correlation alone does not prove an origin shift.');
      this.record('TRACKING', 'ORIGIN_SHIFT_SUSPECTED', { recoverySequenceId: recovery.sequenceId, cameraSpikeSequenceId: spike.sequenceId, modelJumpSequenceId: modelJump.sequenceId }, { capture: true, bridge: true });
    }
  }

  private analyzeModelJump(record: DebugRecord, translationM: number, rotationDeg: number): void {
    const now = record.monotonicMs;
    const recentCamera = this.cameraDeltas.filter((sample) => now - sample.at <= 1_000);
    const cameraStable = recentCamera.length > 0 && recentCamera.every((sample) => sample.translationM <= this.thresholds.stableCameraM && sample.rotationDeg <= this.thresholds.stableCameraDeg);
    const writer = record.payload.writer as { source?: string; sequenceId?: number } | null;
    if (cameraStable) {
      const report = this.addRootCause('SUSPECTED', 'Camera pose is stable while the anchored model moved; inspect the anchor, parent chain, and transform writer.', [record.sequenceId, ...(writer?.sequenceId ? [writer.sequenceId] : [])], `Model delta was ${round(translationM, 4)} m / ${round(rotationDeg, 2)} degrees while recent camera samples stayed within configured stability bounds.`);
      if (writer?.source?.includes('rebaseWorldAnchor')) {
        this.addRootCause('SUSPECTED', 'The model jump follows a camera-frame anchor compensation write.', [record.sequenceId, writer.sequenceId ?? record.sequenceId], 'A compensation writer is directly recorded near the model delta, but that alone does not establish whether the compensation was erroneous.');
      }
      void report;
    } else {
      const recovery = findLastValue(this.ringRecords, (entry) => entry.eventName === 'TRACKING_RECOVERED' && now - entry.monotonicMs <= 2_500);
      const spike = findLastValue(this.ringRecords, (entry) => entry.eventName === 'CAMERA_POSE_SPIKE' && now - entry.monotonicMs <= 2_500);
      if (recovery && spike) {
        const report = this.addRootCause('SUSPECTED', 'Tracking recovery and camera pose discontinuity are correlated with the model jump.', [recovery.sequenceId, spike.sequenceId, record.sequenceId], 'This is consistent with a tracking origin change, but XR8 exposes no origin-change matrix to confirm it.');
        this.record('TRACKING', 'ORIGIN_SHIFT_SUSPECTED', { rootCauseReport: report }, { capture: true, bridge: true });
      }
    }
  }

  private analyzeAnchorDrift(record: DebugRecord, writer: { source: string; reason: string; sequenceId: number; at: number } | null): void {
    if (writer?.source.includes('rebaseWorldAnchor')) {
      this.addRootCause('SUSPECTED', 'Anchor drift followed a measured camera-frame compensation write.', [record.sequenceId, writer.sequenceId], 'The recorded anchor differs from the expected matrix after accounting for logged compensation. Inspect the compensation matrix and verification error; the measurement does not prove the compensation was wrong.');
      return;
    }
    this.addRootCause('SUSPECTED', 'The anchor world matrix moved beyond the expected transform without a matching compensation record.', [record.sequenceId, ...(writer ? [writer.sequenceId] : [])], 'The expected-versus-actual anchor matrix delta is measured directly. An external transform writer or coordinate-frame change is possible; neither is proven by this sample.');
  }

  private analyzeFrameDelay(): void {
    const frame = findLastValue(this.ringRecords, (entry) => entry.eventName === 'TRACKING_FRAME');
    if (!frame) return;
    const previous = findLastValue(this.ringRecords, (entry) => entry.eventName === 'TRACKING_FRAME' && entry.sequenceId < frame.sequenceId);
    if (!previous) {
      this.addRootCause('UNKNOWN', 'Frame delay observed; there is not yet a preceding transform sample for comparison.', [frame.sequenceId], 'Timing is measured, but camera and model stability around the event cannot be established from one frame.');
      return;
    }
    const cameraNow = frame.payload.rawTrackingPose as Record<string, unknown> | null;
    const cameraBefore = previous.payload.rawTrackingPose as Record<string, unknown> | null;
    const transformsNow = frame.payload.transformsAfterSceneUpdate as Record<string, TransformSnapshot | null> | undefined;
    const transformsBefore = previous.payload.transformsAfterSceneUpdate as Record<string, TransformSnapshot | null> | undefined;
    const modelNow = transformsNow?.productRoot;
    const modelBefore = transformsBefore?.productRoot;
    const cameraPositionDelta = cameraNow?.position && cameraBefore?.position
      ? this.arrayDistance(cameraNow.position as number[], cameraBefore.position as number[])
      : Infinity;
    const cameraRotationDelta = cameraNow?.quaternion && cameraBefore?.quaternion
      ? this.quaternionDeltaDeg(cameraNow.quaternion as number[], cameraBefore.quaternion as number[])
      : Infinity;
    const modelPositionDelta = modelNow && modelBefore ? this.arrayDistance(modelNow.world.position, modelBefore.world.position) : Infinity;
    const modelRotationDelta = modelNow && modelBefore ? this.quaternionDeltaDeg(modelNow.world.quaternion, modelBefore.world.quaternion) : Infinity;
    const stable = cameraPositionDelta <= this.thresholds.stableCameraM && cameraRotationDelta <= this.thresholds.stableCameraDeg &&
      modelPositionDelta <= this.thresholds.stableCameraM && modelRotationDelta <= this.thresholds.stableCameraDeg;
    if (stable) {
      this.addRootCause('SUSPECTED', 'Frame timing degraded while the sampled camera and anchored model transforms were stable.', [previous.sequenceId, frame.sequenceId], 'A render or scene-update timing spike is confirmed; a CPU, GPU, browser, or thermal cause remains unverified.');
    } else {
      this.addRootCause('UNKNOWN', 'Frame delay observed with camera or model movement in the same sample window.', [previous.sequenceId, frame.sequenceId], `Measured adjacent deltas: camera ${round(cameraPositionDelta, 4)} m / ${round(cameraRotationDelta, 2)} deg; model ${round(modelPositionDelta, 4)} m / ${round(modelRotationDelta, 2)} deg.`);
    }
  }

  private analyzeCameraVideoStutter(record: DebugRecord): void {
    const recentModelJitter = findLastValue(this.ringRecords, (entry) =>
      entry.eventName === 'MODEL_FRAME_JITTER' && record.monotonicMs - entry.monotonicMs <= this.thresholds.modelJitterWindowMs
    );
    const recentFrameDelay = findLastValue(this.ringRecords, (entry) =>
      entry.eventName === 'FRAME_DELAY' && record.monotonicMs - entry.monotonicMs <= this.thresholds.modelJitterWindowMs
    );
    this.addRootCause(
      'SUSPECTED',
      recentModelJitter
        ? 'Camera video frame stutter coincided with ProductRoot transform jitter.'
        : 'Camera video element reported stutter without a nearby ProductRoot transform jitter event.',
      [record.sequenceId, ...(recentModelJitter ? [recentModelJitter.sequenceId] : []), ...(recentFrameDelay ? [recentFrameDelay.sequenceId] : [])],
      recentModelJitter
        ? 'Video frame counters/timing and anchor transform changes overlap in time; compare the camera pose and compensation records to determine which signal led.'
        : recentFrameDelay
          ? 'The video element reported frame stutter near an XR8/Three frame delay, while no ProductRoot jitter event was present in the analysis window.'
          : 'The video element reported frame stutter, while no ProductRoot jitter event was present in the analysis window. This does not prove the camera sensor was the source.'
    );
  }

  private addRootCause(confidence: Confidence, hypothesis: string, evidenceSequenceIds: number[], explanation: string): RootCauseReport {
    const report: RootCauseReport = {
      timestamp: new Date().toISOString(),
      monotonicMs: round(performance.now(), 3),
      confidence,
      hypothesis,
      evidenceSequenceIds: [...new Set(evidenceSequenceIds)],
      explanation,
    };
    this.rootCauseReports.push(report);
    if (this.rootCauseReports.length > 100) this.rootCauseReports.shift();
    const signature = `${confidence}:${hypothesis}`;
    if (signature !== this.lastRootCauseSignature || report.monotonicMs - this.recentAnomalyAt > 1000) {
      this.lastRootCauseSignature = signature;
      this.recentAnomalyAt = report.monotonicMs;
      this.record('ANALYZER', 'ROOT_CAUSE_HYPOTHESIS', report as unknown as Record<string, unknown>, { bridge: true });
    }
    return report;
  }

  private fpsAverage(): number | null {
    const recent = this.frameDeltasMs.slice(-120).filter((delta) => delta > 0);
    if (recent.length === 0) return null;
    const mean = recent.reduce((sum, delta) => sum + delta, 0) / recent.length;
    return mean > 0 ? round(1000 / mean, 1) : null;
  }

  private frameBudgetMs(): number {
    return this.cameraFrameRateHz
      ? Math.max(this.thresholds.targetFrameMs, 1000 / this.cameraFrameRateHz)
      : this.thresholds.targetFrameMs;
  }

  private arrayDistance(a: number[], b: number[]): number {
    return Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
  }

  private quaternionDeltaDeg(a: number[], b: number[]): number {
    if (a.length < 4 || b.length < 4) return 0;
    const qa = new THREE.Quaternion(a[0], a[1], a[2], a[3]);
    const qb = new THREE.Quaternion(b[0], b[1], b[2], b[3]);
    return round(THREE.MathUtils.radToDeg(qa.angleTo(qb)), 3);
  }

  private matrixArrayError(a: number[], b: number[]): number {
    if (a.length !== b.length) return Infinity;
    let maximum = 0;
    for (let index = 0; index < a.length; index += 1) maximum = Math.max(maximum, Math.abs(a[index] - b[index]));
    return maximum;
  }
}

export const worldTrackingDebugger = new WorldTrackingDebugger();
