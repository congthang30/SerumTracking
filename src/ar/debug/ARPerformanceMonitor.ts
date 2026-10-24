import * as THREE from 'three';
import { DEBUG_AR_PERF, worldTrackingDebugger } from './WorldTrackingDebugger';
import { BADGE_MIPMAPS_ENABLED } from '../callouts/Callout3DBadges';

const PERF_SAMPLE_INTERVAL_MS = 2_000;
const IS_DEV_BUILD = Boolean((import.meta as any).env?.DEV);

interface VideoQualitySnapshot {
  at: number;
  totalFrames: number;
  droppedFrames: number;
}

function round(value: number | null, places = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function summarize(values: number[]): { averageMs: number; p95Ms: number; maxMs: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const averageMs = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    averageMs: round(averageMs) ?? 0,
    p95Ms: round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]) ?? 0,
    maxMs: round(sorted[sorted.length - 1]) ?? 0,
  };
}

function performanceMemory(): Record<string, number | null> {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
  }).memory;
  const megabytes = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value)
    ? round(value / (1024 * 1024))
    : null;
  return {
    usedJsHeapMb: megabytes(memory?.usedJSHeapSize),
    totalJsHeapMb: megabytes(memory?.totalJSHeapSize),
    jsHeapLimitMb: megabytes(memory?.jsHeapSizeLimit),
  };
}

/** Low-rate measurements around the existing XR8 update and Three.js render callbacks. */
export class ARPerformanceMonitor {
  private readonly enabled = DEBUG_AR_PERF;
  private active = false;
  private renderer: THREE.WebGLRenderer | null = null;
  private xr8RuntimeVersion = 'unknown';
  private readonly rendererSize = new THREE.Vector2();
  private readonly rendererDrawingBufferSize = new THREE.Vector2();
  private originalRender: THREE.WebGLRenderer['render'] | null = null;
  private wrappedRender: THREE.WebGLRenderer['render'] | null = null;
  private windowStartedAt = 0;
  private lastRenderStartedAt = 0;
  private lastTrackingUpdateEndedAt = 0;
  private trackingUpdates = 0;
  private renders = 0;
  private framesOver333Ms = 0;
  private framesOver50Ms = 0;
  private drawCallsTotal = 0;
  private trianglesTotal = 0;
  private latestDrawCalls: number | null = null;
  private latestTriangles: number | null = null;
  private latestRendererMemory: { geometries: number | null; textures: number | null; programs: number | null } | null = null;
  private frameIntervalsMs: number[] = [];
  private renderCpuMs: number[] = [];
  private sceneUpdateCpuMs: number[] = [];
  private trackingToRenderMs: number[] = [];
  private reportedCameraFrameRate: number | null = null;
  private cameraVideo: HTMLVideoElement | null = null;
  private previousVideoQuality: VideoQualitySnapshot | null = null;
  private lastReportedFrameSequence = 0;

  public start(): void {
    if (!this.enabled || !IS_DEV_BUILD) return;
    if (this.active) this.stop();
    this.active = true;
    this.windowStartedAt = performance.now();
    this.lastRenderStartedAt = 0;
    this.lastTrackingUpdateEndedAt = 0;
    this.lastReportedFrameSequence = 0;
    this.resetWindowCounters();
  }

  public stop(): void {
    this.active = false;
    this.restoreRenderer();
    this.cameraVideo = null;
    this.previousVideoQuality = null;
  }

  public get isEnabled(): boolean {
    return this.active;
  }

  public beginTrackingUpdate(): void {
    if (!this.active) return;
    this.trackingUpdates += 1;
  }

  public endTrackingUpdate(sceneUpdateDurationMs: number): void {
    if (!this.active) return;
    this.lastTrackingUpdateEndedAt = performance.now();
    if (Number.isFinite(sceneUpdateDurationMs) && sceneUpdateDurationMs >= 0) {
      this.sceneUpdateCpuMs.push(sceneUpdateDurationMs);
    }
  }

  public recordUiStateDispatch(): void {
    if (this.active) this.uiStateDispatches += 1;
  }

  public recordCameraStatus(payload: Record<string, unknown>, video?: HTMLVideoElement | null): void {
    if (!this.active) return;
    const frameRate = payload.frameRate;
    this.reportedCameraFrameRate = typeof frameRate === 'number' && Number.isFinite(frameRate) ? frameRate : null;
    if (video !== undefined && video !== this.cameraVideo) {
      this.cameraVideo = video;
      this.previousVideoQuality = null;
    }
  }

  public attachRenderer(renderer: THREE.WebGLRenderer, runtimeVersion = 'unknown'): void {
    if (!this.active) return;
    this.xr8RuntimeVersion = runtimeVersion;
    if (this.renderer === renderer) return;
    this.restoreRenderer();
    this.renderer = renderer;
    const original = renderer.render;
    const owner = this;
    const wrapped: THREE.WebGLRenderer['render'] = function (
      this: THREE.WebGLRenderer,
      scene: THREE.Scene,
      camera: THREE.Camera
    ): void {
      if (!owner.active || this !== owner.renderer) {
        original.call(this, scene, camera);
        return;
      }

      const startedAt = performance.now();
      const info = this.info;
      const restoreAutoReset = info.autoReset;
      const callsBefore = info.render.calls;
      const trianglesBefore = info.render.triangles;
      if (restoreAutoReset) info.autoReset = false;
      try {
        original.call(this, scene, camera);
      } finally {
        const finishedAt = performance.now();
        const drawCalls = Math.max(0, info.render.calls - callsBefore);
        const triangles = Math.max(0, info.render.triangles - trianglesBefore);
        const rendererMemory = {
          geometries: Number.isFinite(info.memory.geometries) ? info.memory.geometries : null,
          textures: Number.isFinite(info.memory.textures) ? info.memory.textures : null,
          programs: Array.isArray(info.programs) ? info.programs.length : null,
        };

        // Preserve Three.js' default auto-reset behavior while reading the frame counters.
        if (restoreAutoReset) {
          info.reset();
          info.autoReset = true;
        }
        owner.onRendered(startedAt, finishedAt - startedAt, drawCalls, triangles, rendererMemory);
      }
    };
    this.originalRender = original;
    this.wrappedRender = wrapped;
    renderer.render = wrapped;
  }

  private uiStateDispatches = 0;

  private onRendered(
    startedAt: number,
    renderDurationMs: number,
    drawCalls: number,
    triangles: number,
    rendererMemory: { geometries: number | null; textures: number | null; programs: number | null }
  ): void {
    if (this.lastRenderStartedAt > 0) {
      const frameMs = startedAt - this.lastRenderStartedAt;
      if (Number.isFinite(frameMs) && frameMs >= 0) {
        this.frameIntervalsMs.push(frameMs);
        if (frameMs > 33.3) this.framesOver333Ms += 1;
        if (frameMs > 50) this.framesOver50Ms += 1;
      }
    }
    this.lastRenderStartedAt = startedAt;
    this.renderCpuMs.push(renderDurationMs);
    this.renders += 1;
    this.drawCallsTotal += drawCalls;
    this.trianglesTotal += triangles;
    this.latestDrawCalls = drawCalls;
    this.latestTriangles = triangles;
    this.latestRendererMemory = rendererMemory;
    if (this.lastTrackingUpdateEndedAt > 0 && startedAt >= this.lastTrackingUpdateEndedAt) {
      this.trackingToRenderMs.push(startedAt - this.lastTrackingUpdateEndedAt);
    }

    const now = performance.now();
    if (now - this.windowStartedAt >= PERF_SAMPLE_INTERVAL_MS) this.emitSample(now);
  }

  private emitSample(now: number): void {
    const renderer = this.renderer;
    const windowMs = now - this.windowStartedAt;
    const frameStats = summarize(this.frameIntervalsMs);
    const renderStats = summarize(this.renderCpuMs);
    const sceneUpdateStats = summarize(this.sceneUpdateCpuMs);
    const trackingToRenderStats = summarize(this.trackingToRenderMs);
    const video = this.sampleVideoQuality(now);
    const canvas = renderer?.domElement;
    let webglAntialias: boolean | null = null;
    if (renderer) {
      try {
        webglAntialias = renderer.getContext().getContextAttributes()?.antialias ?? null;
      } catch {
        webglAntialias = null;
      }
      renderer.getSize(this.rendererSize);
      renderer.getDrawingBufferSize(this.rendererDrawingBufferSize);
    }
    const payload = {
      windowMs: round(windowMs),
      renderCallFps: windowMs > 0 ? round(this.renders * 1000 / windowMs, 1) : null,
      trackingCallbackHz: windowMs > 0 ? round(this.trackingUpdates * 1000 / windowMs, 1) : null,
      frameTimeMs: frameStats,
      framesOver33_3Ms: this.framesOver333Ms,
      framesOver50Ms: this.framesOver50Ms,
      sceneUpdateCpuMs: sceneUpdateStats,
      rendererCpuSubmissionMs: renderStats,
      trackingUpdateEndToRenderStartMs: trackingToRenderStats,
      renderCallsPerFrame: this.renders > 0 ? round(this.renders / Math.max(1, this.trackingUpdates), 2) : null,
      virtualDrawCalls: this.latestDrawCalls,
      averageVirtualDrawCalls: this.renders > 0 ? round(this.drawCallsTotal / this.renders, 1) : null,
      virtualTriangles: this.latestTriangles,
      averageVirtualTriangles: this.renders > 0 ? round(this.trianglesTotal / this.renders, 1) : null,
      rendererMemoryCounts: this.latestRendererMemory,
      runtimeXr8Version: this.xr8RuntimeVersion,
      badgeTextureFiltering: BADGE_MIPMAPS_ENABLED ? 'mipmap' : 'legacy-no-mipmap',
      webglAntialias,
      webglMaxSamplesAvailable: renderer?.capabilities.maxSamples ?? null,
      devicePixelRatio: typeof window !== 'undefined' ? round(window.devicePixelRatio) : null,
      rendererPixelRatio: renderer ? round(renderer.getPixelRatio()) : null,
      rendererLogicalSize: renderer ? {
        width: this.rendererSize.x,
        height: this.rendererSize.y,
      } : null,
      rendererDrawingBufferSize: renderer ? {
        width: this.rendererDrawingBufferSize.x,
        height: this.rendererDrawingBufferSize.y,
      } : null,
      drawingBuffer: canvas ? {
        width: canvas.width,
        height: canvas.height,
        pixels: canvas.width * canvas.height,
        cssWidth: canvas.clientWidth,
        cssHeight: canvas.clientHeight,
      } : null,
      cameraVideo: video,
      jsMemory: performanceMemory(),
      gpuFrameTimeMs: null,
      gpuTiming: 'not measured; renderer CPU submission time does not include asynchronous GPU execution',
      documentVisibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
      uiStateDispatches: this.uiStateDispatches,
    };

    worldTrackingDebugger.recordPerformanceSample(payload, this.lastReportedFrameSequence + this.trackingUpdates);
    this.lastReportedFrameSequence += this.trackingUpdates;
    this.windowStartedAt = now;
    this.resetWindowCounters();
  }

  private sampleVideoQuality(now: number): Record<string, unknown> {
    const video = this.cameraVideo;
    const base = {
      reportedCaptureFrameRate: this.reportedCameraFrameRate,
      presentedVideoFrameRate: null as number | null,
      droppedVideoFramesDelta: null as number | null,
      qualityApiAvailable: false,
      videoWidth: video?.videoWidth ?? null,
      videoHeight: video?.videoHeight ?? null,
    };
    if (!video) {
      return base;
    }

    try {
      const qualityVideo = video as HTMLVideoElement & {
        getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number };
      };
      if (typeof qualityVideo.getVideoPlaybackQuality !== 'function') {
        this.previousVideoQuality = null;
        return base;
      }
      const quality = qualityVideo.getVideoPlaybackQuality();
      const totalFrames = quality.totalVideoFrames;
      const droppedFrames = quality.droppedVideoFrames;
      if (!Number.isFinite(totalFrames) || !Number.isFinite(droppedFrames)) {
        this.previousVideoQuality = null;
        return base;
      }

      const previous = this.previousVideoQuality;
      const elapsedMs = previous ? now - previous.at : 0;
      const result = {
        ...base,
        qualityApiAvailable: true,
        totalVideoFrames: totalFrames,
        totalDroppedVideoFrames: droppedFrames,
        presentedVideoFrameRate: previous && elapsedMs > 0 && totalFrames >= previous.totalFrames
          ? round((totalFrames - previous.totalFrames) * 1000 / elapsedMs, 1)
          : null,
        droppedVideoFramesDelta: previous && droppedFrames >= previous.droppedFrames
          ? droppedFrames - previous.droppedFrames
          : null,
      };
      this.previousVideoQuality = { at: now, totalFrames, droppedFrames };
      return result;
    } catch {
      this.previousVideoQuality = null;
      return base;
    }
  }

  private resetWindowCounters(): void {
    this.trackingUpdates = 0;
    this.renders = 0;
    this.framesOver333Ms = 0;
    this.framesOver50Ms = 0;
    this.drawCallsTotal = 0;
    this.trianglesTotal = 0;
    this.latestDrawCalls = null;
    this.latestTriangles = null;
    this.latestRendererMemory = null;
    this.frameIntervalsMs.length = 0;
    this.renderCpuMs.length = 0;
    this.sceneUpdateCpuMs.length = 0;
    this.trackingToRenderMs.length = 0;
    this.uiStateDispatches = 0;
  }

  private restoreRenderer(): void {
    if (this.renderer && this.originalRender && this.renderer.render === this.wrappedRender) {
      this.renderer.render = this.originalRender;
    }
    this.renderer = null;
    this.originalRender = null;
    this.wrappedRender = null;
  }
}

export const arPerformanceMonitor = new ARPerformanceMonitor();
