import * as THREE from 'three';
import { logger } from '../../utils/logger';

export interface SurfaceHit {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

export class SurfacePlacementController {
  /** Target real-world height of the product when placed on surface (exactly 20cm / 0.20m). */
  public static readonly TARGET_PLACED_HEIGHT_METERS = 0.20;

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
  private hasSurface = false;
  private animTime = 0;

  // Surface tracking
  private readonly targetHitPosition = new THREE.Vector3();
  private lastPlaneY = 0;
  private hasCalibratedPlane = false;
  private initialPosterPosition: THREE.Vector3 | null = null;
  private lastHitDistance = 0;
  private cameraPitchTooHigh = false;
  private worldTrackingStatus: 'NORMAL' | 'LIMITED' = 'LIMITED';
  private worldTrackingReason = 'INITIALIZING';

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

  public setTargetFound(found: boolean, initialPosePosition?: THREE.Vector3): void {
    this.isTargetFound = found;
    if (found) {
      if (initialPosePosition) {
        // Lock plane height directly to the scanned poster on the tabletop!
        this.lastPlaneY = initialPosePosition.y;
        this.hasCalibratedPlane = true;
        this.initialPosterPosition = initialPosePosition.clone();
        this.targetHitPosition.copy(initialPosePosition);
        if (this.reticleGroup) {
          this.reticleGroup.position.copy(initialPosePosition);
          this.reticleGroup.visible = true;
        }
        this.hasSurface = true;
        this.canPlace = true;
        this.onPlacementChanged?.(this.isPlaced, true);
      }
    } else {
      this.canPlace = false;
      this.hasSurface = false;
      if (this.reticleGroup) {
        this.reticleGroup.visible = false;
      }
    }
  }

  public setTrackingStatus(status: 'NORMAL' | 'LIMITED', reason = 'UNDEFINED'): void {
    this.worldTrackingStatus = status;
    this.worldTrackingReason = reason;
    if (status === 'LIMITED' && !this.isSimulation) {
      if (this.canPlace) {
        this.canPlace = false;
        this.onPlacementChanged?.(this.isPlaced, false);
      }
    }
  }

  public get trackingStatusInfo(): { status: 'NORMAL' | 'LIMITED'; reason: string } {
    return { status: this.worldTrackingStatus, reason: this.worldTrackingReason };
  }

  public get planeY(): number {
    return this.lastPlaneY;
  }

  public get isPlaneCalibrated(): boolean {
    return this.hasCalibratedPlane;
  }

  public get hitDistance(): number {
    return this.lastHitDistance;
  }

  public get hasTargetBeenFound(): boolean {
    return this.isTargetFound;
  }

  public get isProductPlaced(): boolean {
    return this.isPlaced;
  }

  public get isSurfaceDetected(): boolean {
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

    // Reticle radius proportioned to match the 20cm-tall product footprint (width ~23.7cm, radius ~11.8cm)
    const targetScale = this.normalizedModelHeight > 0
      ? SurfacePlacementController.TARGET_PLACED_HEIGHT_METERS / this.normalizedModelHeight
      : 0.327;
    const footprintRadius = Math.max(0.10, (this.normalizedModelWidth * targetScale) / 2); // ~0.118m (11.8cm radius, 23.7cm diameter)

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

    // Do NOT detect surfaces or show placement reticle before image target is scanned
    if (!this.isTargetFound) {
      if (this.reticleGroup.visible) {
        this.reticleGroup.visible = false;
      }
      if (this.canPlace) {
        this.canPlace = false;
        this.onPlacementChanged?.(false, false);
      }
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

    // Process placement glide transition if animating
    if (this.isAnimatingPlacement) {
      this.updatePlacementAnimation();
      return;
    }

    // Once placed, the reticle stays hidden
    if (this.isPlaced) {
      if (this.reticleGroup.visible) {
        this.reticleGroup.visible = false;
      }
      return;
    }

    // Only detect surfaces and allow placement if SLAM world tracking is sufficiently stable
    const isTrackingStable = this.isSimulation || this.worldTrackingStatus === 'NORMAL';
    if (!isTrackingStable) {
      this.hasSurface = false;
      if (this.reticleGroup.visible) {
        this.reticleGroup.visible = false;
      }
      if (this.canPlace) {
        this.canPlace = false;
        this.onPlacementChanged?.(this.isPlaced, false, 'Đang ổn định SLAM camera...');
      }
      return;
    }

    // Detect surface in front of camera
    const surfaceHit = this.detectSurface();
    if (surfaceHit) {
      this.targetHitPosition.copy(surfaceHit.position);
      this.hasSurface = true;

      if (!this.reticleGroup.visible) {
        this.reticleGroup.position.copy(surfaceHit.position);
        this.reticleGroup.visible = true;
      } else {
        // Smooth 60fps lerp towards detected surface point
        this.reticleGroup.position.lerp(surfaceHit.position, 0.25);
      }

      if (!this.canPlace) {
        this.canPlace = true;
        this.onPlacementChanged?.(this.isPlaced, true, 'Đặt sản phẩm tại đây');
      }
    } else {
      this.hasSurface = false;
      if (this.reticleGroup.visible) {
        this.reticleGroup.visible = false;
      }
      if (this.canPlace) {
        this.canPlace = false;
        const guidance = this.cameraPitchTooHigh
          ? 'Nghiêng camera xuống mặt bàn'
          : 'Lia camera tới mặt phẳng (bàn hoặc sàn)';
        this.onPlacementChanged?.(this.isPlaced, false, guidance);
      }
    }
  }

  private detectSurface(): SurfaceHit | null {
    if (!this.camera) return null;

    // 1. Real 8th Wall AR Mode
    if (!this.isSimulation) {
      const camPos = new THREE.Vector3();
      const camDir = new THREE.Vector3();
      this.camera.getWorldPosition(camPos);
      this.camera.getWorldDirection(camDir);

      // Condition 1: Camera must be angled downward towards the table (pitch < -0.15, at least ~9° downward tilt).
      // If the user points horizontally at walls, across the room, or up at the ceiling, REJECT immediately!
      if (camDir.y > -0.15) {
        this.cameraPitchTooHigh = true;
        return null;
      }
      this.cameraPitchTooHigh = false;

      // Condition 2: 8th Wall Hit-Testing for actual physical geometry.
      // If 8th Wall finds no surface/features in the center of the camera view, REJECT!
      const XR8 = (window as any).XR8;
      if (!XR8?.XrController?.hitTest) {
        return null;
      }

      let validHit: { position: THREE.Vector3; distance: number; isPlane: boolean } | null = null;
      try {
        const hits = XR8.XrController.hitTest(0.5, 0.5, ['DETECTED_SURFACE', 'ESTIMATED_SURFACE', 'FEATURE_POINT']);
        if (!hits || hits.length === 0) {
          // Zero hits in raycast direction: camera is aiming at empty air or a textureless void
          return null;
        }

        for (const hit of hits) {
          if (!hit?.position) continue;
          const px = hit.position.x;
          const py = hit.position.y;
          const pz = hit.position.z;
          if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
          const dist = typeof hit.distance === 'number' ? hit.distance : 1.0;

          // Reject hits that are outside plausible tabletop range
          if (dist < 0.35 || dist > 1.80) continue;

          // Check surface normal if this hit is a plane
          if (hit.rotation && (hit.type === 'DETECTED_SURFACE' || hit.type === 'ESTIMATED_SURFACE')) {
            const rot = hit.rotation;
            const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
            const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
            // Must be a horizontal flat plane (normal pointing upwards, tilt < 45°)
            if (Math.abs(normal.y) < 0.70) {
              continue; // Vertical wall or steep slope; reject!
            }
            validHit = {
              position: new THREE.Vector3(px, py, pz),
              distance: dist,
              isPlane: true,
            };
            break;
          }

          // For FEATURE_POINT:
          // Must lie below camera level and near the calibrated tabletop plane height
          if (py < camPos.y) {
            if (this.hasCalibratedPlane) {
              // Only accept feature points within 18cm of the calibrated table height
              if (Math.abs(py - this.lastPlaneY) <= 0.18) {
                validHit = {
                  position: new THREE.Vector3(px, py, pz),
                  distance: dist,
                  isPlane: false,
                };
                break;
              }
            } else {
              // If not yet calibrated by poster, accept if within typical desk height below camera (0.20m to 1.10m)
              const depthBelowCam = camPos.y - py;
              if (depthBelowCam >= 0.20 && depthBelowCam <= 1.10) {
                validHit = {
                  position: new THREE.Vector3(px, py, pz),
                  distance: dist,
                  isPlane: false,
                };
                break;
              }
            }
          }
        }
      } catch {
        return null;
      }

      // If no hit passed the horizontal flat surface criteria, REJECT!
      if (!validHit) {
        return null;
      }

      // Refine plane height if valid hit is confirmed
      if (!this.hasCalibratedPlane) {
        this.lastPlaneY = validHit.position.y;
        this.hasCalibratedPlane = true;
      } else if (Math.abs(validHit.position.y - this.lastPlaneY) < 0.12) {
        this.lastPlaneY = THREE.MathUtils.lerp(this.lastPlaneY, validHit.position.y, 0.06);
      }

      const planeY = this.lastPlaneY;
      if (camPos.y <= planeY) {
        return null;
      }

      // Calculate intersection distance along camera ray to reach table plane
      const rawT = (planeY - camPos.y) / camDir.y;

      // Consistency check: raycast intersection distance must roughly align with 8th Wall's physical hit distance
      if (Math.abs(rawT - validHit.distance) > 0.45) {
        return null;
      }

      // Strictly clamp distance to the golden tabletop range: 0.60m to 0.85m
      const clampedT = Math.min(0.85, Math.max(0.60, rawT));
      this.lastHitDistance = clampedT;

      return {
        position: new THREE.Vector3(
          camPos.x + camDir.x * clampedT,
          planeY,
          camPos.z + camDir.z * clampedT
        ),
        normal: new THREE.Vector3(0, 1, 0),
        distance: clampedT,
      };
    }

    // 2. Desktop Simulation Mode: Raycast against horizontal tabletop plane at Y = 0
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);
    this.camera.getWorldDirection(camDir);

    // In simulation mode, only accept when looking downward towards the tabletop
    if (camDir.y > -0.08) {
      this.cameraPitchTooHigh = true;
      return null;
    }
    this.cameraPitchTooHigh = false;

    const planeY = 0;
    if (camPos.y > planeY) {
      const rawT = (planeY - camPos.y) / camDir.y;
      if (rawT > 0.1 && rawT < 10.0) {
        // Clamp distance in simulation mode to comfortable tabletop range (0.65m - 0.85m)
        const t = Math.min(0.85, Math.max(0.65, rawT));
        this.lastHitDistance = t;
        return {
          position: new THREE.Vector3(
            camPos.x + camDir.x * t,
            planeY,
            camPos.z + camDir.z * t
          ),
          normal: new THREE.Vector3(0, 1, 0),
          distance: t,
        };
      }
    }

    return null;
  }

  /**
   * Places product onto the detected surface, unlocks camera, and transitions to World Tracking.
   */
  public placeProduct(): boolean {
    if (!this.productRoot || !this.camera || !this.worldAnchorGroup) return false;
    if (!this.hasSurface && !this.reticleGroup.visible) return false;

    // Destination target is current reticle position on the surface in world coordinates
    this.animEndPos.copy(this.reticleGroup.position);

    // Orient product so front faces the user camera (yaw only around Y-axis)
    const camPos = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);
    const lookDir = new THREE.Vector3(camPos.x - this.animEndPos.x, 0, camPos.z - this.animEndPos.z);
    if (lookDir.lengthSq() > 0.001) {
      lookDir.normalize();
      const yaw = Math.atan2(lookDir.x, lookDir.z);
      this.animEndQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    } else {
      this.animEndQuat.identity();
    }

    // Target scale in world space: fixed real-world height of exactly 20cm (0.20m)
    const placedScale = this.normalizedModelHeight > 0
      ? SurfacePlacementController.TARGET_PLACED_HEIGHT_METERS / this.normalizedModelHeight
      : 0.3267;
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
