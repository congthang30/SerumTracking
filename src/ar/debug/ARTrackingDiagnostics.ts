import * as THREE from 'three';

export interface ARDiagnosticsData {
  fps: number;
  canvasWidth: number;
  canvasHeight: number;
  pixelRatio: number;
  trackingStatus: 'NORMAL' | 'LIMITED' | 'SIMULATION';
  trackingReason: string;
  trackingMode: 'CAMERA_ATTACHED' | 'WORLD_ANCHORED';
  cameraPosition: { x: number; y: number; z: number };
  cameraEulerDeg: { pitch: number; yaw: number; roll: number };
  cameraQuaternion: { x: number; y: number; z: number; w: number };
  modelPosition: { x: number; y: number; z: number };
  modelHeightCm: number;
  modelParent: string;
  cameraModelDistanceM: number;
  planeY: number;
  isPlaneCalibrated: boolean;
  hitDistanceM: number;
  imageTargetState: string;
  poseJumpCount: number;
  recentPoseWarning: string | null;
  planeGridVisible: boolean;
  debugHudVisible: boolean;
}

class ARTrackingDiagnostics {
  private data: ARDiagnosticsData = {
    fps: 60,
    canvasWidth: 0,
    canvasHeight: 0,
    pixelRatio: 1,
    trackingStatus: 'LIMITED',
    trackingReason: 'INITIALIZING',
    trackingMode: 'CAMERA_ATTACHED',
    cameraPosition: { x: 0, y: 0, z: 0 },
    cameraEulerDeg: { pitch: 0, yaw: 0, roll: 0 },
    cameraQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    modelPosition: { x: 0, y: 0, z: 0 },
    modelHeightCm: 20.0,
    modelParent: 'None',
    cameraModelDistanceM: 0,
    planeY: 0,
    isPlaneCalibrated: false,
    hitDistanceM: 0,
    imageTargetState: 'SCANNING',
    poseJumpCount: 0,
    recentPoseWarning: null,
    planeGridVisible: false,
    debugHudVisible: false,
  };

  private frameCount = 0;
  private lastFpsUpdate = 0;
  private tempEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private tempCamPos = new THREE.Vector3();
  private tempModelPos = new THREE.Vector3();

  constructor() {
    if (typeof window !== 'undefined') {
      const p = new URLSearchParams(window.location.search);
      if (p.get('debug') === '1' || p.get('diagnostics') === '1') {
        this.data.debugHudVisible = true;
      }
    }
  }

  public getData(): Readonly<ARDiagnosticsData> {
    return this.data;
  }

  public setDebugHudVisible(visible: boolean): void {
    this.data.debugHudVisible = visible;
  }

  public toggleDebugHud(): boolean {
    this.data.debugHudVisible = !this.data.debugHudVisible;
    return this.data.debugHudVisible;
  }

  public setPlaneGridVisible(visible: boolean): void {
    this.data.planeGridVisible = visible;
  }

  public recordTrackingStatus(status: 'NORMAL' | 'LIMITED', reason: string): void {
    this.data.trackingStatus = status;
    this.data.trackingReason = reason;
  }

  public recordPoseJump(details: string): void {
    this.data.poseJumpCount++;
    this.data.recentPoseWarning = details;
  }

  public updateFrame(params: {
    dt: number;
    camera: THREE.Camera | null;
    productRoot: THREE.Object3D | null;
    canvas: HTMLCanvasElement | null;
    trackingMode: 'CAMERA_ATTACHED' | 'WORLD_ANCHORED';
    imageTargetState: string;
    planeY: number;
    isPlaneCalibrated: boolean;
    hitDistanceM: number;
    planeGridVisible: boolean;
    isSimulation: boolean;
  }): void {
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsUpdate >= 300) {
      if (params.dt > 0.0001) {
        this.data.fps = Math.round(1 / params.dt);
      }
      this.lastFpsUpdate = now;
    }

    if (params.isSimulation) {
      this.data.trackingStatus = 'SIMULATION';
      this.data.trackingReason = 'DESKTOP_ORBIT_SIM';
    }

    this.data.trackingMode = params.trackingMode;
    this.data.imageTargetState = params.imageTargetState;
    this.data.planeY = Number(params.planeY.toFixed(3));
    this.data.isPlaneCalibrated = params.isPlaneCalibrated;
    this.data.hitDistanceM = Number(params.hitDistanceM.toFixed(2));
    this.data.planeGridVisible = params.planeGridVisible;

    if (params.canvas) {
      this.data.canvasWidth = params.canvas.clientWidth || window.innerWidth;
      this.data.canvasHeight = params.canvas.clientHeight || window.innerHeight;
      this.data.pixelRatio = Math.round((window.devicePixelRatio || 1) * 10) / 10;
    }

    if (params.camera) {
      params.camera.getWorldPosition(this.tempCamPos);
      this.data.cameraPosition.x = Number(this.tempCamPos.x.toFixed(3));
      this.data.cameraPosition.y = Number(this.tempCamPos.y.toFixed(3));
      this.data.cameraPosition.z = Number(this.tempCamPos.z.toFixed(3));

      this.tempEuler.setFromQuaternion(params.camera.quaternion, 'YXZ');
      this.data.cameraEulerDeg.pitch = Math.round(THREE.MathUtils.radToDeg(this.tempEuler.x));
      this.data.cameraEulerDeg.yaw = Math.round(THREE.MathUtils.radToDeg(this.tempEuler.y));
      this.data.cameraEulerDeg.roll = Math.round(THREE.MathUtils.radToDeg(this.tempEuler.z));

      this.data.cameraQuaternion.x = Number(params.camera.quaternion.x.toFixed(3));
      this.data.cameraQuaternion.y = Number(params.camera.quaternion.y.toFixed(3));
      this.data.cameraQuaternion.z = Number(params.camera.quaternion.z.toFixed(3));
      this.data.cameraQuaternion.w = Number(params.camera.quaternion.w.toFixed(3));
    }

    if (params.productRoot) {
      params.productRoot.getWorldPosition(this.tempModelPos);
      this.data.modelPosition.x = Number(this.tempModelPos.x.toFixed(3));
      this.data.modelPosition.y = Number(this.tempModelPos.y.toFixed(3));
      this.data.modelPosition.z = Number(this.tempModelPos.z.toFixed(3));
      this.data.modelParent = params.productRoot.parent?.name || params.productRoot.parent?.type || 'None';

      const worldScale = new THREE.Vector3();
      params.productRoot.getWorldScale(worldScale);
      // Normalized GLB height is ~0.6122m. Height in cm:
      this.data.modelHeightCm = Math.round(0.612157 * worldScale.y * 1000) / 10;

      if (params.camera) {
        this.data.cameraModelDistanceM = Number(this.tempCamPos.distanceTo(this.tempModelPos).toFixed(2));
      }
    }
  }
}

export const arTrackingDiagnostics = new ARTrackingDiagnostics();
