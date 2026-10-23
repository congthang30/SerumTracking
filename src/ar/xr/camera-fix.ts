// Camera lens manager for iOS (Safari / Chrome) and Android.
// Resolves the issue where iOS CoreMedia / AVFoundation defaults to the Telephoto (3x/5x) lens
// on iPhone Pro models instead of the standard 1x Wide camera.
// Uses WebKit-safe constraints and track-level zoom: 1.0.

import { logger } from '../../utils/logger';

export interface CameraInfo {
  deviceId: string;
  label: string;
  kind: string;
  isWide: boolean;
  isTele: boolean;
  isUltra: boolean;
  isBack: boolean;
}

const cameraDebugValues = new Map<string, string>();
const CAMERA_DEBUG_ENABLED = typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('cameraDebug') === '1';
const CAMERA_DEBUG_TERMINAL_BRIDGE_ENABLED = (import.meta as any).env?.DEV === true;
let cameraTraceStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
let cameraTraceSessionId = new Date().toISOString().replace(/[:.]/g, '-');
const cameraDebugTrace: string[] = [];
const CAMERA_DEBUG_TRACE_LIMIT = 120;
let cameraDebugTraceSequence = 0;
let restoreXR8ConsoleBridge: (() => void) | null = null;
let terminalTraceQueue: Promise<void> = Promise.resolve();

export function isCameraDebugEnabled(): boolean {
  return CAMERA_DEBUG_ENABLED;
}

/** True when AR trace events are being collected in either the debug panel or dev terminal. */
export function isARTraceEnabled(): boolean {
  return CAMERA_DEBUG_ENABLED || CAMERA_DEBUG_TERMINAL_BRIDGE_ENABLED;
}

export function beginARTraceSession(): void {
  if (!isCameraDebugEnabled() && !CAMERA_DEBUG_TERMINAL_BRIDGE_ENABLED) return;
  cameraTraceStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
  cameraTraceSessionId = new Date().toISOString().replace(/[:.]/g, '-');
  cameraDebugTrace.length = 0;
  cameraDebugTraceSequence = 0;
  traceAR('AR_TRACE_SESSION_START', { sessionId: cameraTraceSessionId });
}

export function reportCameraDiagnostic(label: string, value: string): void {
  if (!isCameraDebugEnabled() || typeof document === 'undefined') return;

  cameraDebugValues.set(label, value);
  renderCameraDiagnostics(false);
}

/** Emits a timestamped AR lifecycle event to both the device console and debug panel. */
export function traceAR(
  event: string,
  details: Record<string, unknown> = {},
  level: 'info' | 'warn' | 'error' = 'info'
): void {
  if (!isCameraDebugEnabled() && !CAMERA_DEBUG_TERMINAL_BRIDGE_ENABLED) return;

  const now = typeof performance !== 'undefined' ? performance.now() : cameraTraceStartedAt;
  const elapsed = Math.max(0, now - cameraTraceStartedAt) / 1000;
  const sequence = ++cameraDebugTraceSequence;
  const detailText = Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
  const line = `#${String(sequence).padStart(4, '0')} +${elapsed.toFixed(3)}s ${event}${detailText}`;
  cameraDebugTrace.push(line);
  if (cameraDebugTrace.length > CAMERA_DEBUG_TRACE_LIMIT) cameraDebugTrace.shift();

  const log = console[level] ?? console.log;
  log.call(console, `[AR_TRACE ${cameraTraceSessionId}] ${line}`);
  if (CAMERA_DEBUG_TERMINAL_BRIDGE_ENABLED) {
    const sessionId = cameraTraceSessionId;
    terminalTraceQueue = terminalTraceQueue.then(async () => {
      try {
        await fetch('/__ar-trace', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ sessionId, line }),
          keepalive: true,
        });
      } catch {
        // The debug console and on-screen panel still work if the terminal bridge is unavailable.
      }
    });
  }
  if (isCameraDebugEnabled()) renderCameraDiagnostics(true);
}

/** Mirrors only 8th Wall's verbose session startup lines to the Vite terminal in dev. */
export function installXR8ConsoleBridge(): () => void {
  if (!CAMERA_DEBUG_TERMINAL_BRIDGE_ENABLED) return () => {};
  if (restoreXR8ConsoleBridge) return restoreXR8ConsoleBridge;

  const levels = ['log', 'info', 'warn', 'error'] as const;
  const originals = new Map<typeof levels[number], typeof console.log>();
  for (const level of levels) {
    const original = console[level] as typeof console.log;
    originals.set(level, original);
    console[level] = ((...args: unknown[]) => {
      original.apply(console, args);
      const message = args.map((value) => {
        if (typeof value === 'string') return value;
        if (value instanceof Error) return `${value.name}: ${value.message}`;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }).join(' ');
      if (/^\[(?:XR|xr)\]\s/.test(message) || message.startsWith('8th Wall XR Version:')) {
        traceAR('XR8_INTERNAL_LOG', { level, message }, level === 'log' ? 'info' : level);
      }
    }) as typeof console.log;
  }

  restoreXR8ConsoleBridge = () => {
    for (const level of levels) {
      const original = originals.get(level);
      if (original) console[level] = original;
    }
    restoreXR8ConsoleBridge = null;
  };
  return restoreXR8ConsoleBridge;
}

function renderCameraDiagnostics(followTrace: boolean): void {
  if (!isCameraDebugEnabled() || typeof document === 'undefined') return;

  let panel = document.getElementById('serum-camera-diagnostics') as HTMLPreElement | null;
  if (!panel) {
    panel = document.createElement('pre');
    panel.id = 'serum-camera-diagnostics';
    panel.setAttribute('aria-label', 'Camera diagnostics');
    Object.assign(panel.style, {
      position: 'fixed',
      left: '8px',
      right: '8px',
      bottom: 'max(8px, env(safe-area-inset-bottom))',
      zIndex: '2147483647',
      maxHeight: '40vh',
      overflow: 'auto',
      margin: '0',
      padding: '8px 10px',
      borderRadius: '8px',
      background: 'rgba(0, 0, 0, 0.82)',
      color: '#d9ffe7',
      font: '11px/1.4 monospace',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      pointerEvents: 'auto',
    });
    document.body.appendChild(panel);
  }

  const entries = Array.from(cameraDebugValues, ([name, detail]) => `${name}: ${detail}`);
  const wasNearBottom = panel.scrollHeight - panel.clientHeight - panel.scrollTop < 40;
  panel.textContent = [
    `SERUM AR DEBUG | session ${cameraTraceSessionId}`,
    ...entries,
    '',
    'EVENT TRACE (oldest to newest; max 120)',
    ...cameraDebugTrace,
  ].join('\n');
  if (followTrace && wasNearBottom) panel.scrollTop = panel.scrollHeight;
}

function parseCameraInfo(d: MediaDeviceInfo): CameraInfo {
  const l = (d.label || '').toLowerCase();
  const isFront = /front|user|truoc|selfie/.test(l);
  const isTele = /telephoto|tele|zoom|chup xa/.test(l);
  const isUltra = /ultra|0\.5|sieu rong/.test(l);
  const isBack = !isFront && (/back|sau|rear|wide|triple|dual|main|camera/.test(l) || l === '');
  const isWide = isBack && !isTele && !isUltra;
  return {
    deviceId: d.deviceId,
    label: d.label || 'Camera',
    kind: d.kind,
    isWide,
    isTele,
    isUltra,
    isBack,
  };
}

export function findBestWideCamera(devices: MediaDeviceInfo[]): MediaDeviceInfo | null {
  const videoDevs = devices.filter((d) => d.kind === 'videoinput');
  if (videoDevs.length === 0) return null;
  if (videoDevs.length === 1) return videoDevs[0];

  // 1. Back camera with label containing 'wide', 'main', 'triple', 'dual' and NOT tele/ultra
  const wideBack = videoDevs.find((d) => {
    const info = parseCameraInfo(d);
    return info.isWide && /wide|triple|dual|main|chinh/i.test(d.label);
  });
  if (wideBack) return wideBack;

  // 2. Any back camera that is not tele/ultra
  const nonTeleBack = videoDevs.find((d) => {
    const info = parseCameraInfo(d);
    return info.isBack && !info.isTele && !info.isUltra && d.label.length > 0;
  });
  if (nonTeleBack) return nonTeleBack;

  // 3. Fallback: first back camera
  const anyBack = videoDevs.find((d) => parseCameraInfo(d).isBack);
  if (anyBack) return anyBack;

  return videoDevs[0];
}

async function requestContinuousFocus(track: MediaStreamTrack, capabilities: any): Promise<string> {
  const supported = (navigator.mediaDevices.getSupportedConstraints?.() as any)?.focusMode;
  const modes = capabilities?.focusMode;
  if (!supported || !Array.isArray(modes) || !modes.includes('continuous')) {
    return 'not supported; browser default';
  }

  const activeMode = (track.getSettings() as any).focusMode;
  if (activeMode === 'continuous') return 'continuous already active';

  const currentConstraints = track.getConstraints();
  const advanced = [...(currentConstraints.advanced ?? [])] as any[];
  advanced.push({ focusMode: 'continuous' });
  await (track as any).applyConstraints({ ...currentConstraints, advanced });

  return String((track.getSettings() as any).focusMode ?? 'continuous requested; mode not exposed');
}

export function installCameraFix(): void {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;

  reportCameraDiagnostic(
    'Browser',
    `${navigator.userAgent.slice(0, 120)} | DPR ${window.devicePixelRatio || 1} | viewport ${window.innerWidth}x${window.innerHeight}`
  );

  const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const origEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);

  let isSwitching = false;

  navigator.mediaDevices.getUserMedia = async (
    constraints?: MediaStreamConstraints
  ): Promise<MediaStream> => {
    logger.log('info', '[CAMERA_FIX] getUserMedia requested with constraints:', constraints);

    if (!constraints || !constraints.video) {
      return origGetUserMedia(constraints);
    }

    let stream: MediaStream;
    try {
      stream = await origGetUserMedia(constraints);
    } catch (err: any) {
      logger.log('warn', '[CAMERA_FIX] Initial getUserMedia failed, retrying with fallback facingMode: environment', err.message);
      stream = await origGetUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    }

    const track = stream.getVideoTracks()[0];
    if (track) {
      const settings = track.getSettings();
      const label = track.label || '';
      let cameraCaps: any = null;

      // 1. Apply zoom: 1.0 natively (supported on iOS 16.4+ WebKit)
      try {
        cameraCaps = (track as any).getCapabilities ? (track as any).getCapabilities() : null;
        const supportsZoom = !!cameraCaps && 'zoom' in cameraCaps;
        if (supportsZoom) {
          logger.log('info', `[CAMERA_FIX] Zoom capability detected: min=${cameraCaps.zoom.min}, max=${cameraCaps.zoom.max}. Applying zoom=1.0`);
          // applyConstraints replaces the active constraint set, so retain XR8's
          // width/height request when adding the zoom constraint.
          const currentConstraints = track.getConstraints();
          const advanced = [...(currentConstraints.advanced ?? [])] as any[];
          advanced.push({ zoom: 1.0 });
          await (track as any).applyConstraints({
            ...currentConstraints,
            advanced,
          });
        }
      } catch (e: any) {
        logger.log('warn', '[CAMERA_FIX] applyConstraints zoom: 1.0 notice:', e?.message || e);
      }

      let focusStatus = 'not supported; browser default';
      try {
        focusStatus = await requestContinuousFocus(track, cameraCaps);
        logger.log('info', `[CAMERA_FIX] Continuous autofocus: ${focusStatus}`);
      } catch (e: any) {
        focusStatus = `request failed; browser default (${e?.message || e})`;
        logger.log('warn', '[CAMERA_FIX] Could not request continuous autofocus:', e?.message || e);
      }

      const openedSettings = track.getSettings();
      const resolution = openedSettings.width && openedSettings.height
        ? `${openedSettings.width}x${openedSettings.height}`
        : 'unknown';
      const activeConstraints = track.getConstraints();
      const focusModes = Array.isArray(cameraCaps?.focusMode) ? cameraCaps.focusMode.join(',') : 'not exposed';
      const focusDistanceRange = cameraCaps?.focusDistance
        ? `${cameraCaps.focusDistance.min ?? '?'}..${cameraCaps.focusDistance.max ?? '?'}`
        : 'not exposed';
      const focusModeConstraint = (navigator.mediaDevices.getSupportedConstraints?.() as any)?.focusMode ?? false;
      reportCameraDiagnostic(
        'Camera track',
        `${resolution}, ${openedSettings.frameRate ?? '?'}fps, zoom ${openedSettings.zoom ?? '?'}, focus ${String((openedSettings as any).focusMode ?? focusStatus)} (supports: ${focusModes})`
      );
      reportCameraDiagnostic(
        'Focus controls',
        `focusMode constraint=${focusModeConstraint}, modes=${focusModes}, active=${String((openedSettings as any).focusMode ?? 'not exposed')}; focusDistance=${String((openedSettings as any).focusDistance ?? 'not exposed')} (range ${focusDistanceRange})`
      );
      reportCameraDiagnostic(
        'Track constraints',
        `width=${JSON.stringify(activeConstraints.width ?? 'default')}, height=${JSON.stringify(activeConstraints.height ?? 'default')}`
      );
      logger.log(
        'info',
        `[CAMERA_FIX] Track opened: "${label}" (deviceId: ${openedSettings.deviceId}, resolution: ${resolution}, fps: ${openedSettings.frameRate ?? 'unknown'}, focus: ${(openedSettings as any).focusMode ?? 'unknown'})`
      );

      // 2. Check if Safari opened a Telephoto lens instead of the main Wide camera
      const isTele = /telephoto|tele|zoom|chup xa/i.test(label);
      if (isTele && !isSwitching) {
        logger.log('warn', `[CAMERA_FIX] Telephoto lens detected ("${label}"). Attempting switch to 1x Wide camera...`);
        try {
          isSwitching = true;
          const devices = await origEnumerateDevices();
          const wideDev = findBestWideCamera(devices);

          if (wideDev && wideDev.deviceId && wideDev.deviceId !== settings.deviceId) {
            logger.log('info', `[CAMERA_FIX] Found Wide Camera device: "${wideDev.label}" (${wideDev.deviceId}). Switching...`);
            track.stop();

            const requestedVideo = constraints.video === true ? {} : constraints.video;
            const wideStream = await origGetUserMedia({
              ...constraints,
              video: {
                ...requestedVideo,
                deviceId: { exact: wideDev.deviceId },
              },
            });

            const newTrack = wideStream.getVideoTracks()[0];
            if (newTrack) {
              let wideCaps: any = null;
              try {
                wideCaps = (newTrack as any).getCapabilities?.();
                const supportsZoom = !!wideCaps && 'zoom' in wideCaps;
                if (supportsZoom) {
                  const currentConstraints = newTrack.getConstraints();
                  const advanced = [...(currentConstraints.advanced ?? [])] as any[];
                  advanced.push({ zoom: 1.0 });
                  await (newTrack as any).applyConstraints({
                    ...currentConstraints,
                    advanced,
                  });
                }
              } catch (constraintErr: any) {
                logger.log('warn', '[CAMERA_FIX] Could not preserve stream constraints while setting wide-camera zoom:', constraintErr?.message || constraintErr);
              }
              let focusStatus = 'not supported; browser default';
              try {
                focusStatus = await requestContinuousFocus(newTrack, wideCaps);
                logger.log('info', `[CAMERA_FIX] Wide-camera continuous autofocus: ${focusStatus}`);
              } catch (focusErr: any) {
                focusStatus = `request failed; browser default (${focusErr?.message || focusErr})`;
                logger.log('warn', '[CAMERA_FIX] Could not request continuous autofocus on wide camera:', focusErr?.message || focusErr);
              }
              try {
                const settings = newTrack.getSettings();
                reportCameraDiagnostic(
                  'Camera track',
                  `${settings.width ?? '?'}x${settings.height ?? '?'}, ${settings.frameRate ?? '?'}fps, zoom ${settings.zoom ?? '?'}, focus ${String((settings as any).focusMode ?? focusStatus)}`
                );
                logger.log(
                  'info',
                  `[CAMERA_FIX] Wide camera stream: ${settings.width ?? '?'}x${settings.height ?? '?'}, ${settings.frameRate ?? '?'}fps, focus: ${(settings as any).focusMode ?? 'unknown'}`
                );
              } catch {
                /* ignore */
              }
              logger.log('info', `[CAMERA_FIX] Successfully switched to Wide Camera: "${newTrack.label}"`);
              return wideStream;
            }
          }
        } catch (switchErr: any) {
          logger.log('error', '[CAMERA_FIX] Failed switching from telephoto to wide lens:', switchErr?.message || switchErr);
        } finally {
          isSwitching = false;
        }
      }
    }

    return stream;
  };

  logger.log('info', '[CAMERA_FIX] iOS Camera Lens & Zoom Fix successfully installed.');
}
