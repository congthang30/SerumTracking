import * as THREE from 'three';

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}

export type StoryPhase =
  | 'PHASE_1_REVEAL'
  | 'PHASE_2_LEVITATION'
  | 'PHASE_3_HYDRATION_FX'
  | 'PHASE_4_DESCENT'
  | 'PHASE_5_INGREDIENTS'
  | 'PHASE_6_INTERACTIVE_360';

export interface StoryProgress {
  sequenceTime: number;
  phase: StoryPhase;
  isRevealed: boolean;
  is360Active: boolean;
  b5Progress: number;
  haProgress: number;
  cProgress: number;
}

/**
 * ProductStoryTimeline:
 * Drives the 6-Phase Photorealistic WebAR Commercial Storyboard:
 *
 * 0.0s – 1.0s: PHASE 1 — Scene Reveal (Bottle on rock pedestal, grounded, blooming flowers)
 * 1.0s – 2.5s: PHASE 2 — Serum Levitation (Bottle rises ~10cm along +Y, rock & flowers stay)
 * 2.5s – 4.8s: PHASE 3 — Realistic Hydration FX (Swirling 3D water stream, droplets, sparkles)
 * 4.8s – 6.0s: PHASE 4 — Serum Descent (Water fades, bottle glides back to resting pedestal)
 * 6.0s – 8.8s: PHASE 5 — Ingredient Reveal (Vitamin B5 -> Hyaluronic Acid -> Vitamin C)
 * After 8.8s : PHASE 6 — Interactive 360° Mode (Swipe to inspect serum bottle)
 */
export class ProductStoryTimeline {
  private targetGroup: THREE.Group; // userRotationGroup / ProductRoot
  private bottleGroup: THREE.Object3D;
  private flowerGroup?: THREE.Object3D | null;

  // Initial transforms of bottleGroup and flowerGroup to guarantee ZERO drift
  private initialBottlePos = new THREE.Vector3();
  private initialBottleRotY = 0;
  private initialFlowerRotY = 0;

  // Animation timeline state
  private sequenceTime = 0;
  private isStarted = false;
  private hasCompletedInitialReveal = false;

  // Base normalization scale
  public baseScale = 1.0;

  // User interactive 360 rotation angle
  public userBottleRotY = 0;

  // Continuous auto-rotation from right to left (~27.5 deg/sec luxury turntable showcase speed, increased 1.5x)
  public autoRotateSpeed = 0.48;
  public autoRotateAngle = 0;

  constructor(
    targetGroup: THREE.Group,
    bottleGroup: THREE.Object3D,
    flowerGroup?: THREE.Object3D | null
  ) {
    this.targetGroup = targetGroup;
    this.bottleGroup = bottleGroup;
    this.flowerGroup = flowerGroup ?? null;

    this.initialBottlePos.copy(bottleGroup.position);
    this.initialBottleRotY = bottleGroup.rotation.y;
    if (this.flowerGroup) {
      this.initialFlowerRotY = this.flowerGroup.rotation.y;
    }

    this.reset();
  }

  public getSequenceTime(): number {
    return this.sequenceTime;
  }

  public start(): void {
    if (this.hasCompletedInitialReveal) return;
    this.sequenceTime = 0;
    this.isStarted = true;
  }

  public reset(): void {
    this.sequenceTime = 0;
    this.isStarted = false;
    this.hasCompletedInitialReveal = false;
    this.userBottleRotY = 0;
    this.autoRotateAngle = 0;

    // Reset bottle to exact resting position
    this.bottleGroup.position.copy(this.initialBottlePos);
    this.bottleGroup.rotation.y = this.initialBottleRotY;
    this.bottleGroup.rotation.z = 0;
    if (this.flowerGroup) {
      this.flowerGroup.rotation.y = this.initialFlowerRotY;
    }

    // Reset scene scale & rotation
    this.targetGroup.scale.setScalar(this.baseScale * 0.85);
    this.targetGroup.position.set(0, 0, 0);
    this.targetGroup.rotation.y = 0;
  }

  public update(dt: number, isInteracting = false): StoryProgress {
    if (!this.isStarted) {
      return {
        sequenceTime: 0,
        phase: 'PHASE_1_REVEAL',
        isRevealed: false,
        is360Active: false,
        b5Progress: 0,
        haProgress: 0,
        cProgress: 0,
      };
    }

    this.sequenceTime += dt;
    const t = this.sequenceTime;

    let phase: StoryPhase = 'PHASE_1_REVEAL';
    let is360Active = false;

    // --- PHASE 1: 0.0s – 0.83s (Storyboard Scene 01: Hero Intro) ---
    if (t < 0.83) {
      phase = 'PHASE_1_REVEAL';
      const p = clamp01(t / 0.83);
      const ease = easeOutCubic(p);

      const s = this.baseScale * (0.85 + 0.15 * ease);
      this.targetGroup.scale.setScalar(s);
      this.targetGroup.position.z = 0.015 * ease;

      this.bottleGroup.position.copy(this.initialBottlePos);
      this.bottleGroup.rotation.y = this.initialBottleRotY;
      this.bottleGroup.rotation.z = 0;
      if (this.flowerGroup) this.flowerGroup.rotation.y = this.initialFlowerRotY;
    }
    // --- PHASE 2: 0.83s – 6.80s (Storyboard Scene 02 & 03: Water Emergence & 5.6s Spiral Swirl) ---
    else if (t < 6.80) {
      phase = 'PHASE_2_LEVITATION';
      this.hasCompletedInitialReveal = true;
      this.targetGroup.scale.setScalar(this.baseScale);
      this.targetGroup.position.z = 0.015;

      this.bottleGroup.position.copy(this.initialBottlePos);
      this.bottleGroup.rotation.z = 0;
      this.bottleGroup.rotation.y = this.initialBottleRotY;
      if (this.flowerGroup) this.flowerGroup.rotation.y = this.initialFlowerRotY;
    }
    // --- PHASE 3: 6.80s – 7.53s (Storyboard Scene 04: Dynamic Splash Burst) ---
    else if (t < 7.53) {
      phase = 'PHASE_3_HYDRATION_FX';
      this.targetGroup.scale.setScalar(this.baseScale);

      this.bottleGroup.position.copy(this.initialBottlePos);
      this.bottleGroup.rotation.z = 0;
      this.bottleGroup.rotation.y = this.initialBottleRotY;
      if (this.flowerGroup) this.flowerGroup.rotation.y = this.initialFlowerRotY;
    }
    // --- PHASE 4: 7.53s – 9.10s (Storyboard Scene 05 & 06: Rock Pedestal Emergence & Flower Blooming) ---
    else if (t < 9.10) {
      phase = 'PHASE_4_DESCENT';
      this.bottleGroup.position.copy(this.initialBottlePos);
      this.bottleGroup.rotation.z = 0;
      this.bottleGroup.rotation.y = this.initialBottleRotY;
      if (this.flowerGroup) this.flowerGroup.rotation.y = this.initialFlowerRotY;
    }
    // --- PHASE 5 & 6: 9.10s ONWARD (Scene 06B: Full Bloom Hold, Ingredients & Interactive 360) ---
    else {
      // Bottle firmly seated in full botanical bloom
      this.bottleGroup.position.copy(this.initialBottlePos);
      this.bottleGroup.rotation.z = 0;

      if (t < 10.07) {
        phase = 'PHASE_5_INGREDIENTS';
        this.bottleGroup.rotation.y = this.initialBottleRotY;
        if (this.flowerGroup) this.flowerGroup.rotation.y = this.initialFlowerRotY;
        this.targetGroup.rotation.y = 0;
      } else {
        phase = 'PHASE_6_INTERACTIVE_360';
        is360Active = true;
        // Continuous steady turntable auto-rotation from right to left (-Y rotation)
        if (!isInteracting) {
          this.autoRotateAngle -= this.autoRotateSpeed * dt;
        }
        const rotY = this.autoRotateAngle + this.userBottleRotY;
        // Rock pedestal and 3 ingredients stay completely still (targetGroup.rotation.y = 0)!
        // Only bottle and flowers rotate together smoothly!
        this.bottleGroup.rotation.y = this.initialBottleRotY + rotY;
        if (this.flowerGroup) {
          this.flowerGroup.rotation.y = this.initialFlowerRotY + rotY;
        }
        this.targetGroup.rotation.y = 0;
      }

      // Product group stays firmly anchored
      this.targetGroup.position.z = 0.015;
    }

    // Ingredient reveal progress (staggered cascade during Hero Full Bloom Hold)
    const b5Progress = clamp01((t - 9.15) / 0.5);
    const haProgress = clamp01((t - 9.85) / 0.5);
    const cProgress = clamp01((t - 10.55) / 0.5);

    return {
      sequenceTime: t,
      phase,
      isRevealed: t >= 0.83,
      is360Active,
      b5Progress,
      haProgress,
      cProgress,
    };
  }

  /**
   * Helper to fetch progress for any ingredient based on id
   */
  public getIngredientProgress(id: string, t: number): number {
    switch (id) {
      case 'vitamin_b5':
        return clamp01((t - 9.15) / 0.5);
      case 'hyaluronic_acid':
        return clamp01((t - 9.85) / 0.5);
      case 'vitamin_c':
        return clamp01((t - 10.55) / 0.5);
      default:
        return clamp01((t - 9.15) / 0.5);
    }
  }
}
