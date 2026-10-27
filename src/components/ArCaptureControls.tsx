import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ARCaptureEngine } from '../types/capture';
import styles from './ArCaptureControls.module.css';

interface ArCaptureControlsProps {
  engine: ARCaptureEngine | null;
  isReady: boolean;
  filenamePrefix: string;
  label: string;
  placement?: 'default' | 'above-bottom-dock';
}

function screenshotToBlob(data: unknown): Blob {
  if (data instanceof Blob) return data;
  if (typeof data !== 'string') {
    throw new Error('The screenshot API returned an unsupported image format.');
  }

  const base64 = data.replace(/^data:image\/jpeg;base64,/, '');
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: 'image/jpeg' });
}

function videoBlobFromResult(result: unknown): Blob {
  if (result instanceof Blob) return result;
  if (result && typeof result === 'object' && 'videoBlob' in result && result.videoBlob instanceof Blob) {
    return result.videoBlob;
  }
  throw new Error('The video recorder did not return a video file.');
}

type CapturedMediaKind = 'photo' | 'video';
type ShareOutcome = 'shared' | 'cancelled' | 'needs-gesture' | 'unsupported' | 'failed';

function createCapturedFile(blob: Blob, filenamePrefix: string, extension: 'jpg' | 'mp4' | 'webm'): File {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fallbackType = extension === 'jpg' ? 'image/jpeg' : extension === 'mp4' ? 'video/mp4' : 'video/webm';
  return new File([blob], `${filenamePrefix}-${stamp}.${extension}`, {
    type: blob.type || fallbackType,
    lastModified: Date.now(),
  });
}

function downloadCapturedMedia(file: File): void {
  const objectUrl = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = file.name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

async function shareCapturedMedia(file: File): Promise<ShareOutcome> {
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return 'unsupported';
  }

  const shareData: ShareData = { files: [file], title: file.name };
  try {
    if (!navigator.canShare(shareData)) return 'unsupported';
    await navigator.share(shareData);
    return 'shared';
  } catch (error) {
    const errorName = error instanceof Error ? error.name : '';
    if (errorName === 'AbortError') return 'cancelled';
    if (errorName === 'NotAllowedError') return 'needs-gesture';
    return 'failed';
  }
}

export const ArCaptureControls: React.FC<ArCaptureControlsProps> = ({
  engine,
  isReady,
  filenamePrefix,
  label,
  placement = 'default',
}) => {
  const [isCapturingPhoto, setIsCapturingPhoto] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isFinalizingVideo, setIsFinalizingVideo] = useState(false);
  const [captureFeedback, setCaptureFeedback] = useState('');
  const isRecordingRef = useRef(false);
  const feedbackTimeoutRef = useRef<number | undefined>(undefined);

  const showCaptureFeedback = useCallback((message: string) => {
    setCaptureFeedback(message);
    if (feedbackTimeoutRef.current !== undefined) {
      window.clearTimeout(feedbackTimeoutRef.current);
    }
    feedbackTimeoutRef.current = window.setTimeout(() => {
      setCaptureFeedback('');
      feedbackTimeoutRef.current = undefined;
    }, 2600);
  }, []);

  const deliverCapturedMedia = useCallback(async (file: File, kind: CapturedMediaKind) => {
    const outcome = await shareCapturedMedia(file);
    if (outcome === 'shared') {
      showCaptureFeedback(kind === 'photo' ? 'Photo shared.' : 'Video shared.');
      return;
    }

    if (outcome === 'cancelled') return;

    downloadCapturedMedia(file);
    showCaptureFeedback(kind === 'photo'
      ? 'Photo captured. Check your downloads.'
      : 'Video captured. Check your downloads.');
  }, [showCaptureFeedback]);

  const handleCapturePhoto = useCallback(async () => {
    if (!isReady || isCapturingPhoto) return;

    const screenshotApi = engine?.CanvasScreenshot;
    if (typeof screenshotApi?.takeScreenshot !== 'function') {
      showCaptureFeedback('Photo capture is unavailable in this browser.');
      return;
    }

    setIsCapturingPhoto(true);
    try {
      const imageBlob = screenshotToBlob(await screenshotApi.takeScreenshot());
      const file = createCapturedFile(imageBlob, filenamePrefix, 'jpg');
      await deliverCapturedMedia(file, 'photo');
    } catch (error) {
      console.error('[Serum][AR] Photo capture failed:', error);
      showCaptureFeedback('Could not capture the photo. Try again.');
    } finally {
      setIsCapturingPhoto(false);
    }
  }, [deliverCapturedMedia, engine, filenamePrefix, isCapturingPhoto, isReady, showCaptureFeedback]);

  const handleToggleVideoRecording = useCallback(() => {
    if (!isReady) return;

    const recorder = engine?.MediaRecorder;
    if (typeof recorder?.stopRecording !== 'function' || typeof recorder?.recordVideo !== 'function') {
      showCaptureFeedback('Video recording is unavailable in this browser.');
      return;
    }

    if (isRecordingRef.current) {
      try {
        isRecordingRef.current = false;
        setIsRecording(false);
        setIsFinalizingVideo(true);
        recorder.stopRecording();
      } catch (error) {
        console.error('[Serum][AR] Could not stop video recording:', error);
        setIsFinalizingVideo(false);
        showCaptureFeedback('Could not stop the recording. Try again.');
      }
      return;
    }

    if (isFinalizingVideo) return;
    isRecordingRef.current = true;
    setIsRecording(true);
    try {
      recorder.recordVideo({
        onStart: () => showCaptureFeedback('Recording video. Tap the red button to stop.'),
        onStop: () => {
          isRecordingRef.current = false;
          setIsRecording(false);
          setIsFinalizingVideo(true);
          showCaptureFeedback('Preparing your video…');
        },
        onVideoReady: (result) => {
          try {
            const videoBlob = videoBlobFromResult(result);
            const extension = videoBlob.type.includes('webm') ? 'webm' : 'mp4';
            const file = createCapturedFile(videoBlob, filenamePrefix, extension);
            void deliverCapturedMedia(file, 'video').catch((error) => {
              console.error('[Serum][AR] Could not share or download the video:', error);
              showCaptureFeedback('Could not export the video. Try again.');
            });
          } catch (error) {
            console.error('[Serum][AR] Video export failed:', error);
            showCaptureFeedback('Could not prepare the video. Try again.');
          } finally {
            isRecordingRef.current = false;
            setIsRecording(false);
            setIsFinalizingVideo(false);
          }
        },
        onError: (error) => {
          console.error('[Serum][AR] Video recording failed:', error);
          isRecordingRef.current = false;
          setIsRecording(false);
          setIsFinalizingVideo(false);
          showCaptureFeedback('Video recording failed. Try again.');
        },
      });
    } catch (error) {
      console.error('[Serum][AR] Could not start video recording:', error);
      isRecordingRef.current = false;
      setIsRecording(false);
      setIsFinalizingVideo(false);
      showCaptureFeedback('Could not start recording. Try again.');
    }
  }, [deliverCapturedMedia, engine, filenamePrefix, isFinalizingVideo, isReady, showCaptureFeedback]);

  useEffect(() => {
    if (isReady || !isRecordingRef.current) return;
    isRecordingRef.current = false;
    setIsRecording(false);
    try {
      engine?.MediaRecorder?.stopRecording?.();
    } catch (error) {
      console.error('[Serum][AR] Could not stop recording after camera shutdown:', error);
      setIsFinalizingVideo(false);
    }
  }, [engine, isReady]);

  useEffect(() => () => {
    if (feedbackTimeoutRef.current !== undefined) window.clearTimeout(feedbackTimeoutRef.current);
    if (isRecordingRef.current) {
      try { engine?.MediaRecorder?.stopRecording?.(); } catch { /* Session is already stopping. */ }
    }
  }, [engine]);

  if (!isReady || typeof document === 'undefined') return null;

  return createPortal((
    <>
      <div
        className={`${styles.captureControls} ${placement === 'above-bottom-dock' ? styles.captureControlsAboveDock : ''}`}
        role="group"
        aria-label={`${label} photo and video controls`}
      >
        <button
          type="button"
          className={`${styles.captureButton} ${styles.photoCaptureButton}`}
          onClick={() => void handleCapturePhoto()}
          disabled={!isReady || isCapturingPhoto}
          aria-label={isCapturingPhoto ? 'Capturing photo' : 'Take photo'}
          title="Take photo"
        >
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M5.25 10.25h4.1l2.15-3h8.95l2.15 3h4.15c1.1 0 2 0.9 2 2v11.5c0 1.1-.9 2-2 2h-21.5c-1.1 0-2-.9-2-2v-11.5c0-1.1.9-2 2-2Z" />
            <circle cx="16" cy="17.5" r="5.15" />
          </svg>
        </button>

        <span className={styles.captureDivider} aria-hidden="true" />

        <button
          type="button"
          className={`${styles.captureButton} ${styles.videoCaptureButton} ${isRecording ? styles.videoCaptureRecording : ''}`}
          onClick={handleToggleVideoRecording}
          disabled={!isReady || isFinalizingVideo}
          aria-label={isFinalizingVideo ? 'Preparing video' : isRecording ? 'Stop video recording' : 'Start video recording'}
          title={isRecording ? 'Stop recording' : 'Record video'}
        >
          {isRecording ? (
            <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <rect x="10" y="10" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <rect x="3.75" y="8" width="16.5" height="16" rx="3" />
              <path d="m20.25 13.25 7-4v13.5l-7-4" />
            </svg>
          )}
        </button>
      </div>

      {captureFeedback && (
        <div
          className={`${styles.captureFeedback} ${placement === 'above-bottom-dock' ? styles.captureFeedbackAboveDock : ''}`}
          role="status"
          aria-live="polite"
        >
          {captureFeedback}
        </div>
      )}
    </>
  ), document.body);
};
