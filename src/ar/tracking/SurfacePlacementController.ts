import * as THREE from 'three';
import { logger } from '../../utils/logger';

interface PreviewIntersection {
  position: THREE.Vector3;
}

export class SurfacePlacementController {
  /** Placed product height: 1.5x the previous 20 cm size. */
  public static readonly TARGET_PLACED_HEIGHT_METERS = 0.30;

  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private productRoot: THREE.Group | null = null;
  private worldAnchorGroup: THREE.Group | null = null;
  private isSimulation = false;
  private normalizedModelWidth = 0.725;
  private normalizedModelHeight = 0.612157;

  // 3D Reticle components
  private reticleGroup: THREE.Group;
  private reticleRing: THREE.Mesh | null = null;
  private reticleInner: THREE.Mesh | null = null;
  private reticleCenterDot: THREE.Mesh | null = null;

  // Placement state
  private isTargetFound = false;
  private isPlaced = false;
  private canPlace = false;
  private hasPreviewIntersection = false;
  private placedScaleMultiplier = 1;
  private animTime = 0;

  // XR8 exposes one ground reference. Preview stays on its Y=0 plane.
  private readonly targetHitPosition = new THREE.Vector3();
  private stableTrackingSeconds = 0;
  private readonly lastCameraPosition = new THREE.Vector3();
  private readonly lastCameraQuaternion = new THREE.Quaternion();
  private hasCameraSample = false;
  private readonly previewPosition = new THREE.Vector3();
  private hasPreviewPosition = false;
  private worldTrackingStatus: 'NORMAL' | 'LIMITED' = 'LIMITED';
  private worldTrackingReason = 'INITIALIZING';
  private currentGuidance = 'Hold the camera steady over the floor';
  private lastReportedGuidance = '';

  // Placement glide animation
  private isAnimatingPlacement = false;
  private placementStartTime = 0;
  private readonly placementDurationMs = 450;
  private readonly animStartPos = new THREE.Vector3();
  private readonly animStartQuat = new THREE.Quaternion();
  private readonly animStartScale = new THREE.Vector3();
  private readonly animEndPos = new THREE.Vector3();
  private readonly animEndQuat = new THREE.Quaternion();
  private readonly animEndScale = new THREE.Vector3();

  // Callback to sync with React UI
  public onPlacementChanged?: (isPlaced: boolean, canPlace: boolean, guidance?: string) => void;
  public onPlacementSettled?: (placedWorldMatrix: THREE.Matrix4) => void;
  public onPlacedTransformChanged?: (placedWorldMatrix: THREE.Matrix4) => void;

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    productRoot: THREE.Group,
    worldAnchorGroup: THREE.Group,
    isSimulation = false,
    normalizedModelWidth = 0.725,
    normalizedModelHeight = 0.612157
  ) {
    this.scene = scene;
    this.camera = camera;
    this.productRoot = productRoot;
    this.worldAnchorGroup = worldAnchorGroup;
    this.isSimulation = isSimulation;
    this.normalizedModelWidth = normalizedModelWidth || 0.725;
    this.normalizedModelHeight = normalizedModelHeight || 0.612157;
    this.isTargetFound = isSimulation; // In simulation mode, start ready; in real AR, wait until target image is scanned

    this.reticleGroup = this.createReticleMesh();
    this.scene.add(this.reticleGroup);
  }

  private notifyPlacementState(canPlace: boolean, guidance: string): void {
    const stateChanged = this.canPlace !== canPlace;
    const guidanceChanged = this.lastReportedGuidance !== guidance;
    if (stateChanged || guidanceChanged) {
      this.canPlace = canPlace;
      this.lastReportedGuidance = guidance;
      this.onPlacementChanged?.(this.isPlaced, canPlace, guidance);
    }
  }

  public setTargetFound(found: boolean): void {
    this.isTargetFound = found;
    if (found) {
      this.invalidatePreview();
      this.notifyPlacementState(false, 'Hold the camera steady over the floor');
    } else {
      this.invalidatePreview();
      this.notifyPlacementState(false, 'Point the camera at the target');
    }
  }

  public setTrackingStatus(status: 'NORMAL' | 'LIMITED', reason = 'UNDEFINED'): void {
    this.worldTrackingStatus = status;
    this.worldTrackingReason = reason;
    if (status !== 'NORMAL') this.invalidatePreview();
  }

  public get trackingStatusInfo(): { status: 'NORMAL' | 'LIMITED'; reason: string } {
    return { status: this.worldTrackingStatus, reason: this.worldTrackingReason };
  }

  public get planeY(): number {
    return 0;
  }

  public get currentSurfacePosition(): THREE.Vector3 {
    return this.targetHitPosition;
  }

  public get hasStablePreview(): boolean {
    return this.hasPreviewIntersection;
  }

  public get hasTargetBeenFound(): boolean {
    return this.isTargetFound;
  }

  public get isProductPlaced(): boolean {
    return this.isPlaced;
  }

  public get canScalePlacedModel(): boolean {
    return this.isPlaced && !this.isAnimatingPlacement && this.productRoot?.parent === this.worldAnchorGroup;
  }

  public get placedModelScaleMultiplier(): number {
    return this.placedScaleMultiplier;
  }

  /** Applies a two-finger pinch ratio without changing the placed model's position or orientation. */
  public scalePlacedModelBy(ratio: number): boolean {
    if (!this.canScalePlacedModel || !this.productRoot || !Number.isFinite(ratio) || ratio <= 0) return false;
    const next = THREE.MathUtils.clamp(this.placedScaleMultiplier * ratio, 0.5, 2);
    if (Math.abs(next - this.placedScaleMultiplier) < 1e-4) return true;

    this.productRoot.scale.multiplyScalar(next / this.placedScaleMultiplier);
    this.placedScaleMultiplier = next;
    this.reticleGroup.scale.setScalar(next);
    this.productRoot.updateMatrix();
    this.productRoot.updateWorldMatrix(true, true);
    this.onPlacedTransformChanged?.(this.productRoot.matrixWorld);
    return true;
  }

  public get isPlacementReady(): boolean {
    return this.canPlace;
  }

  public attachToXRScene(xrScene: THREE.Scene, xrCamera: THREE.Camera): void {
    this.scene = xrScene;
    this.camera = xrCamera;
    if (this.reticleGroup.parent !== xrScene) {
      xrScene.add(this.reticleGroup);
    }
  }

  public attachToSimScene(simScene: THREE.Scene, simCamera: THREE.Camera): void {
    this.scene = simScene;
    this.camera = simCamera;
    if (this.reticleGroup.parent !== simScene) {
      simScene.add(this.reticleGroup);
    }
  }

  private createReticleMesh(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'SurfaceReticleGroup';
    group.visible = false;

    // Reticle radius matches the 30 cm placed product footprint (width ~35.5 cm).
    const targetScale = this.normalizedModelHeight > 0
      ? SurfacePlacementController.TARGET_PLACED_HEIGHT_METERS / this.normalizedModelHeight
      : 0.4901;
    const footprintRadius = Math.max(0.10, (this.normalizedModelWidth * targetScale) / 2);

    // 1. Outer Ring: Luxury Champagne Rose Gold
    const ringInner = footprintRadius * 0.90; // ~0.107m
    const ringOuter = footprintRadius * 1.02; // ~0.121m
    const ringGeo = new THREE.RingGeometry(ringInner, ringOuter, 48);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xf5dfd0,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.reticleRing = new THREE.Mesh(ringGeo, ringMat);
    this.reticleRing.rotation.x = -Math.PI / 2;
    group.add(this.reticleRing);

    // 2. Inner Disc: Soft Translucent Pearl Fill
    const discGeo = new THREE.RingGeometry(0.0, ringInner * 0.96, 36);
    const discMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.13,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.reticleInner = new THREE.Mesh(discGeo, discMat);
    this.reticleInner.rotation.x = -Math.PI / 2;
    this.reticleInner.position.y = 0.0004;
    group.add(this.reticleInner);

    // 3. Center Target Dot
    const dotGeo = new THREE.RingGeometry(0.0, 0.016, 24);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xfff6ec,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.reticleCenterDot = new THREE.Mesh(dotGeo, dotMat);
    this.reticleCenterDot.rotation.x = -Math.PI / 2;
    this.reticleCenterDot.position.y = 0.0008;
    group.add(this.reticleCenterDot);

    // 4. Outer Accent Ticks (4 precision focus marks)
    const tickDist = footprintRadius * 1.22; // ~0.145m
    const tickMat = new THREE.MeshBasicMaterial({
      color: 0xe5c4a5,
      transparent: true,
      opacity: 0.80,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    for (let i = 0; i < 4; i++) {
      const angle = (i * Math.PI) / 2;
      const tickGeo = new THREE.PlaneGeometry(0.012, 0.026);
      const tick = new THREE.Mesh(tickGeo, tickMat);
      tick.rotation.x = -Math.PI / 2;
      tick.position.set(Math.cos(angle) * tickDist, 0.0006, Math.sin(angle) * tickDist);
      tick.rotation.z = -angle;
      group.add(tick);
    }

    return group;
  }

  public update(dt: number): void {
    this.animTime += dt;

    if (!this.isTargetFound) {
      this.reticleGroup.visible = false;
      return;
    }

    // Animate Reticle pulse & subtle rotation
    if (this.reticleRing) {
      this.reticleRing.rotation.z += dt * 0.35;
    }
    if (this.reticleInner) {
      (this.reticleInner.material as THREE.MeshBasicMaterial).opacity =
        0.11 + 0.07 * Math.sin(this.animTime * 3.2);
    }
    if (this.reticleCenterDot) {
      const s = 1.0 + 0.12 * Math.sin(this.animTime * 4.5);
      this.reticleCenterDot.scale.set(s, s, 1);
    }

    if (this.isAnimatingPlacement) {
      this.updatePlacementAnimation();
    }

    // The ground grid remains independent after placement and never changes
    // ProductRoot or SerumWorldAnchor.
    const intersection = this.projectGroundPlane(dt);
    if (intersection) {
      this.targetHitPosition.copy(intersection.position);
      this.hasPreviewIntersection = true;

      if (!this.isPlaced) {
        this.reticleGroup.position.copy(intersection.position);
        this.reticleGroup.visible = true;
        this.notifyPlacementState(true, 'Place the product on the floor');
      }
    } else {
      this.hasPreviewIntersection = false;
      this.hasPreviewPosition = false;
      this.reticleGroup.visible = false;
      if (!this.isPlaced) this.notifyPlacementState(false, this.currentGuidance);
    }
  }

  private invalidatePreview(): void {
    this.hasPreviewIntersection = false;
    this.hasPreviewPosition = false;
    this.hasCameraSample = false;
    this.stableTrackingSeconds = 0;
    this.reticleGroup.visible = false;
    if (this.canPlace) this.notifyPlacementState(false, 'Hold the camera steady over the floor');
  }

  private projectGroundPlane(dt: number): PreviewIntersection | null {
    if (!this.camera) return null;
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);
    this.camera.getWorldDirection(camDir);

    if (!this.isSimulation) {
      if (this.worldTrackingStatus !== 'NORMAL') {
        this.stableTrackingSeconds = 0;
        this.hasCameraSample = false;
        this.currentGuidance = 'Waiting for world tracking to stabilize';
        return null;
      }
      const camQuat = new THREE.Quaternion();
      this.camera.getWorldQuaternion(camQuat);
      if (this.hasCameraSample &&
          (camPos.distanceTo(this.lastCameraPosition) > 0.4 ||
           camQuat.angleTo(this.lastCameraQuaternion) > THREE.MathUtils.degToRad(35))) {
        this.stableTrackingSeconds = 0;
        this.hasPreviewPosition = false;
      } else {
        this.stableTrackingSeconds += dt;
      }
      this.lastCameraPosition.copy(camPos);
      this.lastCameraQuaternion.copy(camQuat);
      this.hasCameraSample = true;
      if (this.stableTrackingSeconds < 0.35) {
        this.currentGuidance = 'Hold the camera steady over the floor';
        return null;
      }
    }

    if (camDir.y >= -0.05) {
      this.currentGuidance = 'Tilt the camera down toward the floor';
      return null;
    }
    const planeY = this.planeY;
    if (camPos.y <= planeY) {
      this.currentGuidance = 'Raise the camera above the floor';
      return null;
    }
    const rayDistance = (planeY - camPos.y) / camDir.y;
    if (!Number.isFinite(rayDistance) || rayDistance <= 0) return null;

    const rawPosition = new THREE.Vector3(
      camPos.x + camDir.x * rayDistance,
      planeY,
      camPos.z + camDir.z * rayDistance
    );
    if (this.hasPreviewPosition && rawPosition.distanceTo(this.previewPosition) > 0.75) {
      this.stableTrackingSeconds = 0;
      this.hasPreviewPosition = false;
      this.currentGuidance = 'Hold the camera steady to update the grid';
      return null;
    }
    if (!this.hasPreviewPosition) {
      this.previewPosition.copy(rawPosition);
      this.hasPreviewPosition = true;
    } else {
      this.previewPosition.lerp(rawPosition, 1 - Math.exp(-dt / 0.12));
      this.previewPosition.y = planeY;
    }
    this.currentGuidance = 'Place the product on the floor';
    return { position: this.previewPosition };
  }

  /**
   * Places product on the XR8 ground reference and transitions to World Tracking.
   */
  public placeProduct(): boolean {
    if (!this.productRoot || !this.camera || !this.worldAnchorGroup) return false;
    if (this.isPlaced || !this.canPlace || !this.hasPreviewIntersection) return false;

    // Destination is the current reticle position in world coordinates.
    this.animEndPos.copy(this.reticleGroup.position);

    // Orient product so front faces the user camera (yaw only around Y-axis)
    const camPos = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);
    const lookDir = new THREE.Vector3(camPos.x - this.animEndPos.x, 0, camPos.z - this.animEndPos.z);
    if (lookDir.lengthSq() > 0.005) {
      lookDir.normalize();
      const yaw = Math.atan2(lookDir.x, lookDir.z);
      this.animEndQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    } else {
      // In top-down view (camera directly above product), orient product using camera heading
      const camEuler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.animEndQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), camEuler.y);
    }

    // Target scale in world space: 30 cm, 1.5x the previous placed size.
    const placedScale = this.normalizedModelHeight > 0
      ? (SurfacePlacementController.TARGET_PLACED_HEIGHT_METERS / this.normalizedModelHeight) * this.placedScaleMultiplier
      : 0.4901 * this.placedScaleMultiplier;
    this.animEndScale.set(placedScale, placedScale, placedScale);

    // Disable frustum culling on all child meshes so model never vanishes when camera gets close
    this.productRoot.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.frustumCulled = false;
      }
    });

    // Ensure worldAnchorGroup has a clean, identity world transform at (0, 0, 0)
    this.worldAnchorGroup.position.set(0, 0, 0);
    this.worldAnchorGroup.quaternion.identity();
    this.worldAnchorGroup.scale.set(1, 1, 1);
    this.worldAnchorGroup.visible = true;
    this.worldAnchorGroup.updateMatrix();
    this.worldAnchorGroup.updateWorldMatrix(true, true);

    // Update camera and product matrices before reparenting to ensure attach() captures pristine world coords
    this.camera.updateMatrixWorld(true);
    this.productRoot.updateMatrixWorld(true);

    // Reparent productRoot cleanly from camera into worldAnchorGroup
    // Using attach() preserves the exact current world transform with zero visual jump!
    this.worldAnchorGroup.attach(this.productRoot);
    this.productRoot.updateMatrixWorld(true);

    // Capture starting world transform
    this.animStartPos.copy(this.productRoot.position);
    this.animStartQuat.copy(this.productRoot.quaternion);
    this.animStartScale.copy(this.productRoot.scale);

    // Begin landing glide animation
    this.isAnimatingPlacement = true;
    this.placementStartTime = performance.now();
    this.reticleGroup.visible = false;
    this.canPlace = false;
    this.isPlaced = true;

    const realHeightCm = (this.normalizedModelHeight * placedScale * 100).toFixed(1);
    const realWidthCm = (this.normalizedModelWidth * placedScale * 100).toFixed(1);
    logger.log('info', `[SURFACE_PLACEMENT] 📍 Placed product at (${this.animEndPos.x.toFixed(3)}, ${this.animEndPos.y.toFixed(3)}, ${this.animEndPos.z.toFixed(3)}) with scale ${placedScale.toFixed(4)} (real-world size: ${realWidthCm}cm W x ${realHeightCm}cm H). Camera unlocked.`);
    this.onPlacementChanged?.(true, false);
    return true;
  }

  private updatePlacementAnimation(): void {
    if (!this.productRoot) return;
    const elapsed = performance.now() - this.placementStartTime;
    const t = Math.min(1, Math.max(0, elapsed / this.placementDurationMs));
    const ease = 1 - Math.pow(1 - t, 3); // Cubic ease-out

    this.productRoot.position.lerpVectors(this.animStartPos, this.animEndPos, ease);

    // Natural landing arc trajectory peaking midway (gentle 4cm arch)
    const arc = Math.sin(t * Math.PI) * 0.04;
    this.productRoot.position.y += arc;

    this.productRoot.quaternion.slerpQuaternions(this.animStartQuat, this.animEndQuat, ease);
    this.productRoot.scale.lerpVectors(this.animStartScale, this.animEndScale, ease);
    this.productRoot.updateMatrix();
    this.productRoot.updateWorldMatrix(true, true);

    if (t >= 1) {
      this.isAnimatingPlacement = false;
      this.productRoot.position.copy(this.animEndPos);
      this.productRoot.quaternion.copy(this.animEndQuat);
      this.productRoot.scale.copy(this.animEndScale);
      this.productRoot.updateMatrix();
      this.productRoot.updateWorldMatrix(true, true);

      // Ground contact shadow to surface
      const shadow = this.productRoot.getObjectByName('ContactShadowPlane');
      if (shadow) shadow.visible = true;

      // Lock expected world matrix in tracking controller
      this.onPlacementSettled?.(this.productRoot.matrixWorld);
    }
  }

  /**
   * Re-locks product back to AR camera for repositioning.
   */
  public relockToCamera(): void {
    if (!this.productRoot || !this.camera) return;

    this.camera.updateMatrixWorld(true);
    this.productRoot.updateMatrixWorld(true);
    this.camera.attach(this.productRoot);
    this.productRoot.updateMatrixWorld(true);

    this.isPlaced = false;
    this.isAnimatingPlacement = false;
    this.canPlace = false;

    const shadow = this.productRoot.getObjectByName('ContactShadowPlane');
    if (shadow) shadow.visible = false;

    logger.log('info', '[SURFACE_PLACEMENT] 🔄 Product re-locked to AR camera.');
    this.onPlacementChanged?.(false, false);
  }

  public dispose(): void {
    if (this.reticleRing) {
      this.reticleRing.geometry.dispose();
      (this.reticleRing.material as THREE.Material).dispose();
    }
    if (this.reticleInner) {
      this.reticleInner.geometry.dispose();
      (this.reticleInner.material as THREE.Material).dispose();
    }
    if (this.reticleCenterDot) {
      this.reticleCenterDot.geometry.dispose();
      (this.reticleCenterDot.material as THREE.Material).dispose();
    }
    this.reticleGroup.parent?.remove(this.reticleGroup);
  }
}
