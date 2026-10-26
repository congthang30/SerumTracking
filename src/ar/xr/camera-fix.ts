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

export function isARTraceEnabled(): boolean {
  return false;
}

export function beginARTraceSession(): void {
  // Disabled in the shipped experience.
}

export function reportCameraDiagnostic(_label: string, _value: string): void {
  // Disabled in the shipped experience.
}

export function traceAR(
  _event: string,
  _details: Record<string, unknown> = {},
  _level: 'info' | 'warn' | 'error' = 'info'
): void {
  // Disabled in the shipped experience.
}

function normalizeCameraLabel(raw: string): string {
  return (raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .trim();
}

function parseCameraInfo(d: Pick<MediaDeviceInfo, 'deviceId' | 'label' | 'kind'>): CameraInfo {
  const l = normalizeCameraLabel(d.label || '');
  const isFront = /front|user|truoc|selfie|facetime/.test(l);
  const isTele = /telephoto|tele|zoom|chup xa/.test(l);
  const isUltra = /ultra|0\.5|sieu rong|macro/.test(l);
  const isBack = !isFront && (/back|sau|rear|wide|triple|dual|main|camera|environment/.test(l) || l === '');
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

  // 1. Prefer dedicated 1x Main Wide camera ("Back Camera" / "Camera mặt sau" / "Back Wide Camera")
  // which has continuous autofocus from ~15cm to infinity without macro-lock blur at >20cm
  const primarySingleWide = videoDevs.find((d) => {
    const info = parseCameraInfo(d);
    const norm = normalizeCameraLabel(d.label);
    return (
      info.isWide &&
      (/^(back camera|camera mat sau|back wide camera|camera goc rong mat sau|rear camera)$/.test(norm) ||
        (/wide|main|chinh/.test(norm) && !/dual|triple|kep|ba/.test(norm)))
    );
  });
  if (primarySingleWide) return primarySingleWide;

  // 2. Back camera with label containing 'wide', 'main', 'triple', 'dual' and NOT tele/ultra
  const wideBack = videoDevs.find((d) => {
    const info = parseCameraInfo(d);
    const norm = normalizeCameraLabel(d.label);
    return info.isWide && /wide|triple|dual|main|chinh|ba|kep/.test(norm);
  });
  if (wideBack) return wideBack;

  // 3. Any back camera that is not tele/ultra
  const nonTeleBack = videoDevs.find((d) => {
    const info = parseCameraInfo(d);
    return info.isBack && !info.isTele && !info.isUltra && d.label.length > 0;
  });
  if (nonTeleBack) return nonTeleBack;

  // 4. Fallback: first back camera
  const anyBack = videoDevs.find((d) => parseCameraInfo(d).isBack);
  if (anyBack) return anyBack;

  return videoDevs[0];
}

async function requestContinuousFocus(track: MediaStreamTrack, capabilities: any): Promise<string> {
  const supportedConstraints = (navigator.mediaDevices.getSupportedConstraints?.() as any) ?? {};
  const modes = capabilities?.focusMode;
  const canSetFocus = Boolean(
    supportedConstraints.focusMode || (Array.isArray(modes) && modes.includes('continuous'))
  );

  const currentConstraints = track.getConstraints();
  const advanced = [...(currentConstraints.advanced ?? [])] as any[];
  const extraAdvanced: Record<string, any> = {};

  if (canSetFocus) {
    extraAdvanced.focusMode = 'continuous';
  }
  if (Array.isArray(capabilities?.exposureMode) && capabilities.exposureMode.includes('continuous')) {
    extraAdvanced.exposureMode = 'continuous';
  }
  if (Array.isArray(capabilities?.whiteBalanceMode) && capabilities.whiteBalanceMode.includes('continuous')) {
    extraAdvanced.whiteBalanceMode = 'continuous';
  }

  if (Object.keys(extraAdvanced).length === 0) {
    return 'not supported; browser default';
  }

  advanced.push(extraAdvanced);
  await (track as any).applyConstraints({ ...currentConstraints, advanced });

  return String((track.getSettings() as any).focusMode ?? 'continuous requested');
}

function enhanceVideoConstraints(videoConstraint: boolean | MediaTrackConstraints): MediaTrackConstraints {
  if (videoConstraint === true || typeof videoConstraint !== 'object' || videoConstraint === null) {
    return {
      facingMode: { ideal: 'environment' },
      width: { min: 960, ideal: 1920 },
      height: { min: 720, ideal: 1440 },
    };
  }
  const enhanced: Record<string, any> = { ...videoConstraint };
  if (typeof enhanced.width === 'object' && enhanced.width !== null && !('exact' in enhanced.width)) {
    enhanced.width = { ...enhanced.width, ideal: Math.max(enhanced.width.min ?? 960, 1920) };
  }
  if (typeof enhanced.height === 'object' && enhanced.height !== null && !('exact' in enhanced.height)) {
    enhanced.height = { ...enhanced.height, ideal: Math.max(enhanced.height.min ?? 720, 1440) };
  }
  return enhanced as MediaTrackConstraints;
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

    const enhancedVideo = enhanceVideoConstraints(constraints.video);

    let stream: MediaStream;
    try {
      stream = await origGetUserMedia({
        ...constraints,
        video: enhancedVideo,
      });
    } catch (err: any) {
      logger.log('warn', '[CAMERA_FIX] Enhanced getUserMedia failed, retrying with original constraints', err.message);
      try {
        stream = await origGetUserMedia(constraints);
      } catch (err2: any) {
        logger.log('warn', '[CAMERA_FIX] Initial getUserMedia failed, retrying with fallback facingMode: environment', err2.message);
        stream = await origGetUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      }
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

      // 2. Check if Safari opened a Telephoto OR Ultra-Wide (0.5x Macro) lens instead of the main 1x Wide camera
      const openedInfo = parseCameraInfo({
        deviceId: settings.deviceId || '',
        label,
        kind: 'videoinput',
      });
      if ((openedInfo.isTele || openedInfo.isUltra) && !isSwitching) {
        logger.log('warn', `[CAMERA_FIX] Non-standard lens detected ("${label}", tele=${openedInfo.isTele}, ultra=${openedInfo.isUltra}). Switching to 1x Wide camera...`);
        try {
          isSwitching = true;
          const devices = await origEnumerateDevices();
          const wideDev = findBestWideCamera(devices);

          if (wideDev && wideDev.deviceId && wideDev.deviceId !== settings.deviceId) {
            logger.log('info', `[CAMERA_FIX] Found Wide Camera device: "${wideDev.label}" (${wideDev.deviceId}). Switching...`);
            track.stop();

            const wideStream = await origGetUserMedia({
              ...constraints,
              video: {
                ...enhancedVideo,
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
