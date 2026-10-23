import * as THREE from 'three';
import { ImagePose } from '../../types/ar';
import { loadImageTargetData, ImageTargetData } from '../config/targets';
import { reportCameraDiagnostic, traceAR } from '../xr/camera-fix';
import { logger } from '../../utils/logger';
import type { XR8FrameContext } from '../debug/WorldTrackingDebugger';

// Expose THREE globally for 8th Wall's Threejs pipeline module
(window as any).THREE = THREE;

export interface EightWallCallbacks {
  onTargetFound: (pose: ImagePose) => void;
  onTargetUpdated: (pose: ImagePose) => void;
  onTargetLost: (name: string) => void;
  onWorldTrackingStatus?: (status: 'NORMAL' | 'LIMITED', reason?: string) => void;
  onFrameUpdate?: (context: XR8FrameContext) => void;
  onPipelineEventPhase?: (phase: 'START' | 'END') => void;
  onPipelineState?: (state: 'PAUSED' | 'RESUMED' | 'DETACHED') => void;
  onCameraStatus?: (payload: Record<string, unknown>, video?: HTMLVideoElement | null) => void;
  onCameraStarted: (info: { scene: THREE.Scene; camera: THREE.Camera; renderer?: THREE.WebGLRenderer }) => void;
  onError: (message: string) => void;
  onProgress?: (stage: string) => void;
}

const LOCAL_XR_URL = 'external/xr/xr.js';
const CDN_XR_URL = 'https://cdn.jsdelivr.net/npm/@8thwall/engine-binary@1/dist/xr.js';
const BUNDLED_XR_BUILD_ID = '1.657942';

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-xr-engine="${src}"]`)) {
      resolve();
      return;
    }
    const el = document.createElement('script');
    const versionedSrc = src.includes('?') ? src : `${src}?t=${Date.now()}`;
    el.src = versionedSrc;
    el.async = true;
    el.crossOrigin = 'anonymous';
    el.dataset.xrEngine = src;
    el.setAttribute('data-preload-chunks', 'slam');
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
}

function whenXrReady(): Promise<any> {
  if (typeof (window as any).XR8 !== 'undefined') {
    return Promise.resolve((window as any).XR8);
  }
  return new Promise((resolve, reject) => {
    const onReady = () => {
      window.removeEventListener('xrloaded', onReady);
      if (typeof (window as any).XR8 !== 'undefined') {
        resolve((window as any).XR8);
      } else {
        reject(new Error('xrloaded fired but window.XR8 is missing'));
      }
    };
    window.addEventListener('xrloaded', onReady as EventListener, { once: true });
  });
}

export function parseImagePose(eventOrDetail: any): ImagePose | null {
  const d = eventOrDetail?.detail ?? eventOrDetail ?? {};
  const p = d.position;
  const r = d.rotation;
  const numbers = [p?.x, p?.y, p?.z, r?.x, r?.y, r?.z, r?.w, d.scale];
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value)) || d.scale <= 0) {
    return null;
  }

  const scaledWidth = d.scaledWidth;
  const scaledHeight = d.scaledHeight;
  if ((scaledWidth !== undefined && (!Number.isFinite(scaledWidth) || scaledWidth <= 0)) ||
      (scaledHeight !== undefined && (!Number.isFinite(scaledHeight) || scaledHeight <= 0))) {
    return null;
  }

  const quaternion = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const quaternionLengthSq = quaternion.lengthSq();
  if (!Number.isFinite(quaternionLengthSq) || quaternionLengthSq < 1e-6) return null;
  quaternion.normalize();

  return {
    name: String(d.name ?? 'serum'),
    position: new THREE.Vector3(p.x, p.y, p.z),
    quaternion,
    scale: d.scale,
    scaledWidth: typeof scaledWidth === 'number' ? scaledWidth : undefined,
    scaledHeight: typeof scaledHeight === 'number' ? scaledHeight : undefined,
  };
}

export class EightWallManager {
  private running = false;
  private isStarting = false;
  private imageTargetClearRequested = false;
  private imageTargetClearConfigured = false;
  private imageTargetClearConfiguredAt = 0;
  private pendingImageTargetClearFrame: number | null = null;
  private imageTargetClearVerificationTimer: number | null = null;
  private imageEventsAfterClearConfigured = 0;
  private loggedImageEventAfterClear = false;
  private configuredImageTargetCount = 0;
  private imageUpdateCount = 0;
  private arSessionStartedAt = 0;
  private runtimeVersion = 'unknown';
  private hasLoggedImageScanning = false;
  private orientationFixTimers: number[] = [];
  private startupTimeoutTimer: number | null = null;
  private cancelPendingStart: (() => void) | null = null;

  private dispatchPipelineEvent(cb: EightWallCallbacks, callback: () => void): void {
    cb.onPipelineEventPhase?.('START');
    try {
      callback();
    } finally {
      cb.onPipelineEventPhase?.('END');
    }
  }

  public get isRunning(): boolean {
    return this.running;
  }

  /**
   * Queues an Image Target reconfiguration after the current XR8 event callback.
   * World Tracking remains enabled; disableWorldTracking is intentionally not changed.
   */
  public disableImageTargets(): boolean {
    if (this.imageTargetClearRequested) return true;
    if (!this.running) {
      traceAR('IMAGE_TARGET_CLEAR_SKIPPED', { reason: 'XR8 manager is not running' }, 'warn');
      return false;
    }

    const XR8 = (window as any).XR8;
    if (typeof XR8?.XrController?.configure !== 'function') {
      traceAR('IMAGE_TARGET_CLEAR_FAILED', { error: 'XR8.XrController.configure is unavailable.' }, 'error');
      return false;
    }

    // Block app callbacks immediately, then apply the new target list after the
    // current XR8 image event has finished dispatching.
    this.imageTargetClearRequested = true;
    traceAR('IMAGE_TARGET_CLEAR_SCHEDULED', {
      requestedTargetCount: 0,
      previousConfiguredTargetCount: this.configuredImageTargetCount,
      applyAfterCurrentImageEvent: true,
      worldTracking: 'left enabled; disableWorldTracking remains false',
      runtimeVersion: this.runtimeVersion,
    });
    reportCameraDiagnostic('Image Tracking', 'Clear scheduled after world anchor; checking that XR8 stops target events.');
    logger.log('info', '[8TH_WALL] Scheduled Image Target clear after handoff; World Tracking remains enabled.');

    this.pendingImageTargetClearFrame = window.requestAnimationFrame(() => {
      this.pendingImageTargetClearFrame = null;
      if (!this.running) return;
      try {
        XR8.XrController.configure({ imageTargetData: [] });
        this.imageTargetClearConfigured = true;
        this.imageTargetClearConfiguredAt = performance.now();
        traceAR('IMAGE_TARGET_CLEAR_CONFIGURED', {
          requestedTargetCount: 0,
          configureCallReturned: true,
          previousConfiguredTargetCount: this.configuredImageTargetCount,
          elapsedSinceSessionStartMs: this.arSessionStartedAt > 0 ? Math.round(performance.now() - this.arSessionStartedAt) : null,
          worldTracking: 'left enabled; disableWorldTracking remains false',
          runtimeVersion: this.runtimeVersion,
        });
        this.imageTargetClearVerificationTimer = window.setTimeout(() => {
          this.imageTargetClearVerificationTimer = null;
          const eventsObserved = this.imageEventsAfterClearConfigured;
          traceAR('IMAGE_TARGET_CLEAR_VERIFICATION', {
            configureCallReturned: true,
            observationWindowMs: 2000,
            imageEventsObserved: eventsObserved,
            result: eventsObserved === 0 ? 'no image events observed' : 'image events still emitted',
            worldTracking: 'remains enabled',
          }, eventsObserved === 0 ? 'info' : 'warn');
        }, 2000);
      } catch (error) {
        traceAR('IMAGE_TARGET_CLEAR_FAILED', { error: String(error) }, 'error');
        reportCameraDiagnostic('Image Tracking', `clear failed after handoff: ${String(error)}`);
        logger.log('error', `[8TH_WALL] Failed to clear Image Targets after handoff: ${String(error)}`);
      }
    });
    return true;
  }

  public static isSdkAvailable(): boolean {
    return typeof (window as any).XR8 !== 'undefined';
  }

  public async ensureSdk(): Promise<boolean> {
    if (EightWallManager.isSdkAvailable()) return true;
    for (const src of [LOCAL_XR_URL, CDN_XR_URL, '/external/xr/xr.js']) {
      try {
        await loadScript(src);
        await whenXrReady();
        if (EightWallManager.isSdkAvailable()) return true;
      } catch {
        /* try fallback */
      }
    }
    return EightWallManager.isSdkAvailable();
  }

  public async startAR(
    canvas: HTMLCanvasElement,
    cb: EightWallCallbacks,
    customTargetData?: ImageTargetData[]
  ): Promise<{ scene: THREE.Scene; camera: THREE.Camera }> {
    if (this.running || this.isStarting) {
      const XR8 = (window as any).XR8;
      const xr = XR8?.Threejs?.xrScene?.();
      if (xr) {
        traceAR('XR8_START_REUSED_EXISTING_SESSION', { running: this.running, starting: this.isStarting });
        return { scene: xr.scene, camera: xr.camera };
      }
    }

    this.isStarting = true;
    this.imageTargetClearRequested = false;
    this.imageTargetClearConfigured = false;
    this.imageTargetClearConfiguredAt = 0;
    this.imageEventsAfterClearConfigured = 0;
    this.loggedImageEventAfterClear = false;
    if (this.pendingImageTargetClearFrame !== null) {
      window.cancelAnimationFrame(this.pendingImageTargetClearFrame);
      this.pendingImageTargetClearFrame = null;
    }
    if (this.imageTargetClearVerificationTimer !== null) {
      window.clearTimeout(this.imageTargetClearVerificationTimer);
      this.imageTargetClearVerificationTimer = null;
    }
    this.configuredImageTargetCount = 0;
    this.imageUpdateCount = 0;
    this.arSessionStartedAt = performance.now();
    this.hasLoggedImageScanning = false;
    this.clearOrientationFixTimers();
    traceAR('XR8_SESSION_START_REQUEST', { imageTracking: 'enabled', worldTracking: 'enabled', scale: 'absolute' });

    const hasSdk = await this.ensureSdk();
    if (!hasSdk) {
      this.isStarting = false;
      traceAR('XR8_SDK_LOAD_FAILED', { attemptedSources: [LOCAL_XR_URL, CDN_XR_URL, '/external/xr/xr.js'] }, 'error');
      throw new Error('8th Wall XR Engine script could not be loaded.');
    }
    traceAR('XR8_SDK_READY', { xr8Available: true });

    const XR8 = (window as any).XR8;

    let browserCompatible: boolean | string = 'unavailable';
    let incompatibleReasons: unknown[] = [];
    try {
      browserCompatible = Boolean(XR8.XrDevice?.isDeviceBrowserCompatible?.());
      incompatibleReasons = XR8.XrDevice?.incompatibleReasons?.() ?? [];
    } catch (error) {
      incompatibleReasons = [`diagnostic failed: ${String(error)}`];
    }
    traceAR('XR8_DEVICE_DIAGNOSTICS', {
      origin: window.location.origin,
      secureContext: window.isSecureContext,
      getUserMediaAvailable: typeof navigator.mediaDevices?.getUserMedia === 'function',
      userAgent: navigator.userAgent,
      browserCompatible,
      incompatibleReasons,
      allowedDevices: 'XR8.run default (MOBILE_AND_HEADSETS)',
    }, browserCompatible === true && window.isSecureContext ? 'info' : 'warn');

    if (typeof XR8.clearCameraPipelineModules === 'function') {
      try {
        XR8.clearCameraPipelineModules();
      } catch {
        /* ignore */
      }
    }

    // Load Target JSON following flycam-logo targets loader pattern
    cb.onProgress?.('Đang tải cấu hình Image Target...');
    let imageTargetData: ImageTargetData[] = customTargetData || [];
    if (imageTargetData.length === 0) {
      try {
        const target = await loadImageTargetData('targets/serum.json');
        imageTargetData = [target];
      } catch (err) {
        traceAR('IMAGE_TARGET_CONFIG_LOAD_FAILED', { path: 'targets/serum.json', error: String(err), tryingFallback: true }, 'warn');
        try {
          const fallbackTarget = await loadImageTargetData('assets/image-target/serum-target.json');
          imageTargetData = [fallbackTarget];
        } catch (e2) {
          traceAR('IMAGE_TARGET_CONFIG_LOAD_FAILED', { path: 'assets/image-target/serum-target.json', error: String(e2), activeTargetCount: 0 }, 'error');
        }
      }
    }

    cb.onProgress?.('Cấu hình 8th Wall Image Tracking...');
    try {
      XR8.XrController.configure({
        imageTargetData,
        disableWorldTracking: false,
        scale: 'absolute',
      });
    } catch (error) {
      traceAR('XR8_CONFIGURE_FAILED', { error: String(error), targetCount: imageTargetData.length }, 'error');
      throw error;
    }
    this.configuredImageTargetCount = imageTargetData.length;
    const loadedLocalBundleForConfig = Array.from(document.scripts).some((script) =>
      script.dataset.xrEngine === LOCAL_XR_URL
    );
    const exposedRuntimeVersion = XR8.version ?? XR8.VERSION ?? XR8._version;
    this.runtimeVersion = String(
      loadedLocalBundleForConfig
        ? `${BUNDLED_XR_BUILD_ID} (bundled xr.js)`
        : typeof exposedRuntimeVersion === 'function'
        ? exposedRuntimeVersion.call(XR8)
        : exposedRuntimeVersion ?? 'not exposed by loaded bundle'
    );
    traceAR('XR8_CONFIGURED', {
      runtimeVersion: this.runtimeVersion,
      configuredImageTargetCount: imageTargetData.length,
      disableWorldTracking: false,
      worldTracking: 'SLAM enabled before XR8.run()',
      scale: 'absolute',
    });

    const modules: any[] = [];
    try {
      modules.push(XR8.GlTextureRenderer.pipelineModule());
      modules.push(XR8.Threejs.pipelineModule());
      modules.push(XR8.XrController.pipelineModule());
      modules.push({
        name: 'serum-scene-updates',
        onUpdate: (context: XR8FrameContext) => cb.onFrameUpdate?.(context),
        onPaused: () => cb.onPipelineState?.('PAUSED'),
        onResume: () => cb.onPipelineState?.('RESUMED'),
        onCameraStatusChange: ({ status, stream, video }: any) => {
          const track = stream?.getVideoTracks?.()[0];
          const settings = track?.getSettings?.();
          cb.onCameraStatus?.({
            status: String(status ?? 'UNKNOWN'),
            videoAvailable: Boolean(video),
            videoWidth: typeof video?.videoWidth === 'number' ? video.videoWidth : null,
            videoHeight: typeof video?.videoHeight === 'number' ? video.videoHeight : null,
            width: typeof settings?.width === 'number' ? settings.width : null,
            height: typeof settings?.height === 'number' ? settings.height : null,
            frameRate: typeof settings?.frameRate === 'number' ? settings.frameRate : null,
            facingMode: typeof settings?.facingMode === 'string' ? settings.facingMode : null,
          }, video ?? null);
        },
      });
    } catch (e) {
      this.isStarting = false;
      traceAR('XR8_PIPELINE_MODULE_BUILD_FAILED', { error: String(e) }, 'error');
      throw new Error(`Could not build 8th Wall pipeline modules: ${String(e)}`);
    }

    const handleFound = (e: any) => {
      const pose = parseImagePose(e);
      if (!pose) {
        if (this.ignoreImageEventAfterClear('imagefound', '(invalid pose)')) return;
        traceAR('IMAGE_FOUND_INVALID', { reason: 'pose missing or invalid' }, 'warn');
        logger.log('warn', '[8TH_WALL] Ignored imagefound with missing or invalid pose.');
        return;
      }
      if (this.ignoreImageEventAfterClear('imagefound', pose.name)) return;
      traceAR('XR8_IMAGE_FOUND_EVENT', {
        target: pose.name,
        position: `(${pose.position.x.toFixed(4)},${pose.position.y.toFixed(4)},${pose.position.z.toFixed(4)})`,
        scale: pose.scale,
        worldTrackingConfigured: true,
        imageTargetClearRequested: this.imageTargetClearRequested,
      });
      reportCameraDiagnostic(
        'Image Tracking',
        `FOUND ${pose.name}; p=(${pose.position.x.toFixed(3)},${pose.position.y.toFixed(3)},${pose.position.z.toFixed(3)}) scale=${pose.scale.toFixed(3)}`
      );
      logger.log('info', `[8TH_WALL] 🎯 TARGET FOUND: "${pose.name}" pos=(${pose.position.x.toFixed(2)}, ${pose.position.y.toFixed(2)}, ${pose.position.z.toFixed(2)}) scale=${pose.scale.toFixed(3)}`);
      this.dispatchPipelineEvent(cb, () => cb.onTargetFound(pose));
    };
    const handleUpdated = (e: any) => {
      const pose = parseImagePose(e);
      if (!pose) {
        if (this.ignoreImageEventAfterClear('imageupdated', '(invalid pose)')) return;
        traceAR('IMAGE_UPDATED_INVALID', { reason: 'pose missing or invalid' }, 'warn');
        logger.log('warn', '[8TH_WALL] Ignored imageupdated with missing or invalid pose.');
        return;
      }
      if (this.ignoreImageEventAfterClear('imageupdated', pose.name)) return;
      this.imageUpdateCount += 1;
      if (this.imageUpdateCount % 30 === 0) {
        traceAR('XR8_IMAGE_UPDATED_SAMPLE', {
          updateCount: this.imageUpdateCount,
          target: pose.name,
          imageTargetClearRequested: this.imageTargetClearRequested,
          elapsedSinceSessionStartMs: Math.round(performance.now() - this.arSessionStartedAt),
          position: `(${pose.position.x.toFixed(4)},${pose.position.y.toFixed(4)},${pose.position.z.toFixed(4)})`,
          scale: pose.scale,
        });
      }
      this.dispatchPipelineEvent(cb, () => cb.onTargetUpdated(pose));
    };
    const handleLost = (e: any) => {
      const d = e?.detail ?? e;
      const name = String(d?.name ?? '');
      if (this.ignoreImageEventAfterClear('imagelost', name || '(unknown)')) return;
      traceAR('XR8_IMAGE_LOST_EVENT', {
        target: name || '(unknown)',
        imageTargetClearRequested: this.imageTargetClearRequested,
        elapsedSinceSessionStartMs: Math.round(performance.now() - this.arSessionStartedAt),
      }, 'warn');
      reportCameraDiagnostic('Image Tracking', `LOST ${name || '(unknown target)'}`);
      logger.log('warn', `[8TH_WALL] ⚠️ TARGET LOST: "${name}"`);
      this.dispatchPipelineEvent(cb, () => cb.onTargetLost(name));
    };
    const handleWorldTrackingStatus = (e: any) => {
      const d = e?.detail ?? e;
      const status = d?.status === 'NORMAL' ? 'NORMAL' : 'LIMITED';
      const reason = String(d?.reason ?? 'UNDEFINED');
      traceAR('XR8_TRACKING_STATUS_EVENT', {
        status: String(d?.status ?? 'UNKNOWN'),
        reason,
        imageTargetClearRequested: this.imageTargetClearRequested,
        elapsedSinceSessionStartMs: Math.round(performance.now() - this.arSessionStartedAt),
      }, d?.status === 'NORMAL' ? 'info' : 'warn');
      logger.log('info', `[8TH_WALL] World tracking status=${String(d?.status ?? 'UNKNOWN')} reason=${reason}`);
      this.dispatchPipelineEvent(cb, () => cb.onWorldTrackingStatus?.(status, reason));
    };

    const triggerOrientationFix = () => {
      try {
        window.dispatchEvent(new Event('orientationchange'));
        window.dispatchEvent(new Event('resize'));
      } catch {
        /* ignore */
      }
    };

    return new Promise<{ scene: THREE.Scene; camera: THREE.Camera }>((resolve, reject) => {
      let isSettled = false;
      const failStart = (error: Error) => {
        if (isSettled) return;
        isSettled = true;
        this.isStarting = false;
        this.cancelPendingStart = null;
        this.clearStartupTimeoutTimer();
        traceAR('XR8_SESSION_START_FAILED', { error: error.message }, 'error');
        reject(error);
      };
      this.cancelPendingStart = () => {
        failStart(new Error('8th Wall AR session stopped before camera startup completed.'));
      };

      this.startupTimeoutTimer = window.setTimeout(() => {
        failStart(new Error('Hết thời gian chờ camera 8th Wall. Vui lòng cấp quyền truy cập camera.'));
      }, 20000);

      const markReady = () => {
        if (isSettled) return;
        try {
          const xr = XR8.Threejs.xrScene();
          if (!xr || !xr.scene || !xr.camera) return;

          logger.log(
            'info',
            `[8TH_WALL] Engine version=${this.runtimeVersion}; disableWorldTracking=false; SLAM configured before XR8.run()`
          );

          cb.onCameraStarted({ scene: xr.scene, camera: xr.camera, renderer: xr.renderer });
          this.running = true;
          this.isStarting = false;
          traceAR('XR8_SESSION_READY', {
            runtimeVersion: this.runtimeVersion,
            activeImageTargets: this.configuredImageTargetCount,
            imageTracking: this.imageTargetClearRequested ? 'clear requested' : 'enabled',
            worldTracking: 'enabled',
            camera: `${xr.camera.name || xr.camera.type}; matrixWorldValid=${xr.camera.matrixWorld.elements.every(Number.isFinite)}`,
            elapsedSinceStartMs: Math.round(performance.now() - this.arSessionStartedAt),
          });
          isSettled = true;
          this.cancelPendingStart = null;
          this.clearStartupTimeoutTimer();
          resolve({ scene: xr.scene, camera: xr.camera });

          // Refresh display geometry after startup and viewport changes without
          // recentering SLAM, which would move already captured world anchors.
          triggerOrientationFix();
          for (const delay of [150, 400, 800]) {
            let timer = 0;
            timer = window.setTimeout(() => {
              this.orientationFixTimers = this.orientationFixTimers.filter((id) => id !== timer);
              if (this.running) triggerOrientationFix();
            }, delay);
            this.orientationFixTimers.push(timer);
          }
        } catch (e) {
          this.running = false;
          traceAR('XR8_SESSION_READY_FAILED', { error: String(e) }, 'error');
          failStart(e instanceof Error ? e : new Error(String(e)));
        }
      };

      modules.push({
        name: 'serum-webar-module',
        onStart: () => markReady(),
        onAttach: () => markReady(),
        listeners: [
          { event: 'reality.imagefound', process: handleFound },
          { event: 'reality.imageupdated', process: handleUpdated },
          { event: 'reality.imagelost', process: handleLost },
          { event: 'reality.trackingstatus', process: handleWorldTrackingStatus },
          {
            event: 'reality.imagescanning',
            process: () => {
              if (!this.hasLoggedImageScanning) {
                this.hasLoggedImageScanning = true;
                traceAR('IMAGE_SCANNING', {
                  activeImageTargets: this.configuredImageTargetCount,
                  worldTracking: 'enabled concurrently',
                });
              }
              cb.onProgress?.('Hướng camera vào poster HYDRATING SERUM...');
            },
          },
        ],
        onDetach: () => {
          cb.onPipelineState?.('DETACHED');
          traceAR('XR8_PIPELINE_DETACHED', {
            elapsedSinceStartMs: this.arSessionStartedAt > 0 ? Math.round(performance.now() - this.arSessionStartedAt) : null,
            imageTargetClearRequested: this.imageTargetClearRequested,
          }, 'warn');
          this.running = false;
          if (this.pendingImageTargetClearFrame !== null) {
            window.cancelAnimationFrame(this.pendingImageTargetClearFrame);
            this.pendingImageTargetClearFrame = null;
          }
          if (this.imageTargetClearVerificationTimer !== null) {
            window.clearTimeout(this.imageTargetClearVerificationTimer);
            this.imageTargetClearVerificationTimer = null;
          }
          this.clearOrientationFixTimers();
          this.cancelPendingStart?.();
        },
        onException: (e: any) => {
          const errMsg = String(e?.message ?? e);
          traceAR('XR8_PIPELINE_EXCEPTION', { error: errMsg }, 'error');
          logger.log('error', `[8TH_WALL] Module exception: ${errMsg}`);
          failStart(new Error(errMsg));
          cb.onError(`8th Wall exception: ${errMsg}`);
        },
      });

      try {
        XR8.addCameraPipelineModules(modules);
        cb.onProgress?.('Đang yêu cầu quyền camera...');
        traceAR('XR8_RUN_CALLED', {
          configuredImageTargetCount: this.configuredImageTargetCount,
          disableWorldTracking: false,
        });
        XR8.run({ canvas, verbose: false });
      } catch (e) {
        traceAR('XR8_RUN_FAILED', { error: String(e) }, 'error');
        failStart(new Error(`XR8.run failed: ${String(e)}`));
      }
    });
  }

  private clearOrientationFixTimers(): void {
    for (const timer of this.orientationFixTimers) {
      window.clearTimeout(timer);
    }
    this.orientationFixTimers = [];
  }

  private ignoreImageEventAfterClear(event: string, target: string): boolean {
    if (!this.imageTargetClearRequested) return false;
    if (this.imageTargetClearConfigured) {
      this.imageEventsAfterClearConfigured += 1;
      if (!this.loggedImageEventAfterClear) {
        this.loggedImageEventAfterClear = true;
        traceAR('IMAGE_TARGET_EVENT_AFTER_CLEAR_CONFIGURED', {
          event,
          target,
          eventCountAfterConfiguration: this.imageEventsAfterClearConfigured,
          elapsedSinceConfigurationMs: Math.round(performance.now() - this.imageTargetClearConfiguredAt),
          action: 'ignored before application callback',
        }, 'warn');
      }
    }
    return true;
  }

  private clearStartupTimeoutTimer(): void {
    if (this.startupTimeoutTimer === null) return;
    window.clearTimeout(this.startupTimeoutTimer);
    this.startupTimeoutTimer = null;
  }

  public stopAR(): void {
    traceAR('XR8_SESSION_STOP', {
      running: this.running,
      starting: this.isStarting,
      imageTargetClearRequested: this.imageTargetClearRequested,
      elapsedSinceStartMs: this.arSessionStartedAt > 0 ? Math.round(performance.now() - this.arSessionStartedAt) : null,
    });
    this.clearOrientationFixTimers();
    if (this.pendingImageTargetClearFrame !== null) {
      window.cancelAnimationFrame(this.pendingImageTargetClearFrame);
      this.pendingImageTargetClearFrame = null;
    }
    if (this.imageTargetClearVerificationTimer !== null) {
      window.clearTimeout(this.imageTargetClearVerificationTimer);
      this.imageTargetClearVerificationTimer = null;
    }
    this.cancelPendingStart?.();
    this.clearStartupTimeoutTimer();
    try {
      const XR8 = (window as any).XR8;
      if (XR8) {
        if (this.running) XR8.stop();
        if (typeof XR8.clearCameraPipelineModules === 'function') {
          XR8.clearCameraPipelineModules();
        }
      }
    } catch {
      /* ignore */
    }
    this.running = false;
    this.isStarting = false;
  }
}
