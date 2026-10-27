export interface ARMediaRecorderCallbacks {
  onStart?: () => void;
  onStop?: () => void;
  onVideoReady?: (result: unknown) => void;
  onError?: (error: unknown) => void;
}

export interface ARCaptureEngine {
  CanvasScreenshot?: { takeScreenshot?: () => Promise<unknown> };
  MediaRecorder?: {
    recordVideo?: (callbacks: ARMediaRecorderCallbacks) => void;
    stopRecording?: () => void;
  };
}
