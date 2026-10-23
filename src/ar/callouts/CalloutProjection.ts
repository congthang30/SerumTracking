import * as THREE from 'three';
import type { Line2 } from 'three/examples/jsm/lines/Line2.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { CalloutScreenLayout } from '../../types/ar';

const _worldAnchor = new THREE.Vector3();
const _projectedAnchor = new THREE.Vector3();
const _worldElbow = new THREE.Vector3();
const _projectedElbow = new THREE.Vector3();
const _tmpBottleCenter = new THREE.Vector3();
const _tmpNormal = new THREE.Vector3();
const _tmpToCam = new THREE.Vector3();
const _cameraWorldPosition = new THREE.Vector3();

function projectObject(
  object: THREE.Object3D,
  camera: THREE.Camera,
  worldPosition: THREE.Vector3,
  projectedPosition: THREE.Vector3
): void {
  object.updateWorldMatrix(true, false);
  object.getWorldPosition(worldPosition);
  projectedPosition.copy(worldPosition).project(camera);
}

function isInsideCameraDepth(projectedPosition: THREE.Vector3): boolean {
  return (
    Number.isFinite(projectedPosition.x) &&
    Number.isFinite(projectedPosition.y) &&
    Number.isFinite(projectedPosition.z) &&
    projectedPosition.z >= -1 &&
    projectedPosition.z <= 1
  );
}

export class CalloutProjection {
  private camera: THREE.Camera;
  private readonly alphaById = new Map<string, { value: number; updatedAt: number }>();

  constructor(camera: THREE.Camera) {
    this.camera = camera;
  }

  public updateCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  public calculateLayout(
    id: string,
    anchorObj: THREE.Object3D,
    elbowObj: THREE.Object3D,
    side: 'left' | 'right',
    progress: number,
    cardElement?: HTMLElement | null,
    time = 0
  ): CalloutScreenLayout | null {
    if (!anchorObj || !elbowObj || progress <= 0) {
      return null;
    }

    const screenW = window.innerWidth;
    const screenH = window.innerHeight;

    // The pin and elbow are projected from bottle-local anchors. Only the label
    // underline uses screen pixels, so its length stays stable across camera moves.
    projectObject(anchorObj, this.camera, _worldAnchor, _projectedAnchor);
    projectObject(elbowObj, this.camera, _worldElbow, _projectedElbow);

    // Let x/y move outside the viewport and fade the complete callout at the edge.
    // Hard clipping here made a few pixels of tracking movement toggle it on/off.
    if (!isInsideCameraDepth(_projectedAnchor) || !isInsideCameraDepth(_projectedElbow)) {
      return null;
    }

    const dotX = (_projectedAnchor.x * 0.5 + 0.5) * screenW;
    const dotY = (-_projectedAnchor.y * 0.5 + 0.5) * screenH;
    const elbowX = (_projectedElbow.x * 0.5 + 0.5) * screenW;
    const elbowY = (-_projectedElbow.y * 0.5 + 0.5) * screenH;

    // 2. Compute Surface Normal & Occlusion Facing:
    // Anchor is attached to the bottle and rotates with it in 3D.
    // When the anchor turns towards the back of the bottle, it smoothly fades out (alpha -> 0)
    // so lines NEVER cut across or slice through the bottle body!
    if (anchorObj.parent) {
      anchorObj.parent.getWorldPosition(_tmpBottleCenter);
    } else {
      anchorObj.getWorldPosition(_tmpBottleCenter);
    }

    // Horizontal normal vector pointing outward from the cylinder central axis to the anchor
    _tmpNormal.subVectors(_worldAnchor, _tmpBottleCenter);
    _tmpNormal.y = 0;
    _tmpNormal.normalize();

    // Direction vector pointing towards the camera
    if ((this.camera as any).isPerspectiveCamera) {
      this.camera.getWorldPosition(_cameraWorldPosition);
      _tmpToCam.subVectors(_cameraWorldPosition, _worldAnchor).normalize();
    } else {
      this.camera.getWorldDirection(_tmpToCam).negate();
    }

    // Dot product: > 0 means facing camera (front of bottle), < 0 means facing away (back of bottle)
    const facing = _tmpNormal.dot(_tmpToCam);

    // Smooth cosine fade:
    // Anchors placed at the bottle rim/contour have normal facing roughly ~0.10 to 0.25 towards camera.
    // When the bottle rotates and the anchor turns towards the back:
    // facing >= -0.05: fully visible (alpha = 1.0)
    // -0.22 < facing < -0.05: smooth dissolution
    // facing <= -0.22: occluded behind bottle (alpha = 0.0)
    const facingAlpha = Math.max(0, Math.min(1, (facing + 0.22) / 0.17));

    const cardW = cardElement && cardElement.offsetWidth > 0 ? cardElement.offsetWidth : 160;
    const cardH = cardElement && cardElement.offsetHeight > 0 ? cardElement.offsetHeight : 24;
    const underlineLen = cardW + 8;
    const targetX = elbowX + (side === 'left' ? -underlineLen : underlineLen);
    const targetY = elbowY;
    const cardX = side === 'left' ? targetX + 2 : elbowX + 2;
    const cardY = elbowY - cardH - 3;

    // Keep the label tied to the projected bottle pin. Fade it as the complete
    // callout crosses the viewport edge instead of abruptly hiding it.
    const left = Math.min(dotX, elbowX, targetX, cardX);
    const right = Math.max(dotX, elbowX, targetX, cardX + cardW);
    const top = Math.min(dotY, elbowY, targetY, cardY);
    const bottom = Math.max(dotY, elbowY, targetY, cardY + cardH);
    const edgeClearance = Math.min(left, screenW - right, top, screenH - bottom);
    const edgeAlpha = Math.max(0, Math.min(1, edgeClearance / 32));
    const targetAlpha = facingAlpha * edgeAlpha;

    // Smooth small changes from tracking noise and the bottle-facing fade.
    const now = performance.now();
    const previous = this.alphaById.get(id);
    const smoothing = previous
      ? 1 - Math.exp(-Math.max(0, now - previous.updatedAt) / 100)
      : 0;
    const alpha = previous ? previous.value + (targetAlpha - previous.value) * smoothing : 0;
    this.alphaById.set(id, { value: alpha, updatedAt: now });

    return {
      id,
      dotX,
      dotY,
      cardX,
      cardY,
      cardW,
      cardH,
      elbowX,
      elbowY,
      targetX,
      targetY,
      side,
      progress,
      visible: true,
      alpha,
      time,
    };
  }

  /**
   * Directly updates DOM elements for butter-smooth 60fps tracking without triggering React rerenders
   */
  public applyToDOM(
    layout: CalloutScreenLayout | null,
    dotEl: HTMLElement | null,
    lineEl: SVGPathElement | null,
    cardEl: HTMLElement | null,
    particleEl?: SVGCircleElement | null,
    pinEl?: SVGCircleElement | null,
    worldLine?: Line2 | null
  ): void {
    if (!layout) {
      if (dotEl) {
        dotEl.style.opacity = '0';
        dotEl.style.visibility = 'hidden';
      }
      if (lineEl) {
        lineEl.style.opacity = '0';
        lineEl.style.visibility = 'hidden';
      }
      if (cardEl) {
        cardEl.style.opacity = '0';
        cardEl.style.visibility = 'hidden';
        cardEl.style.pointerEvents = 'none';
      }
      if (particleEl) {
        particleEl.style.opacity = '0';
        particleEl.style.visibility = 'hidden';
      }
      if (pinEl) {
        pinEl.style.opacity = '0';
        pinEl.style.visibility = 'hidden';
      }
      if (worldLine) {
        worldLine.visible = false;
        (worldLine.material as LineMaterial).opacity = 0;
      }
      return;
    }

    const alphaVal = layout.alpha ?? 1.0;

    if (worldLine) {
      const material = worldLine.material as LineMaterial;
      material.resolution.set(window.innerWidth, window.innerHeight);
      const reveal = Math.min(1, layout.progress / 0.4);
      material.opacity = alphaVal * reveal;
      worldLine.visible = reveal > 0;
    }

    // 1. Position Anchor Dot with spring entrance pop and occlusion alpha
    if (dotEl) {
      dotEl.style.visibility = 'visible';
      if (layout.progress < 0.45) {
        // Elastic pop entrance: scale 0 -> 1.3 -> 1.0
        const p = Math.min(1, layout.progress / 0.45);
        const pop = Math.sin(p * Math.PI * 0.75) * 1.3;
        dotEl.style.transform = `translate(${layout.dotX.toFixed(1)}px, ${layout.dotY.toFixed(1)}px) scale(${pop.toFixed(2)})`;
        dotEl.style.opacity = `${(p * alphaVal).toFixed(2)}`;
      } else {
        dotEl.style.transform = `translate(${layout.dotX.toFixed(1)}px, ${layout.dotY.toFixed(1)}px) scale(1)`;
        dotEl.style.opacity = `${alphaVal.toFixed(2)}`;
      }
    }

    // 3D Callout Lines are baked directly into the master GLB model
    if (lineEl) {
      lineEl.style.opacity = '0';
      lineEl.style.visibility = 'hidden';
    }

    // 3. Position & Reveal HTML Card with luxury elastic reveal and occlusion alpha
    if (cardEl) {
      cardEl.style.left = `${layout.cardX.toFixed(1)}px`;
      cardEl.style.top = `${layout.cardY.toFixed(1)}px`;
      cardEl.style.width = 'auto';

      if (layout.progress >= 0.65) {
        const p = Math.min(1, Math.max(0, (layout.progress - 0.65) / 0.35));
        // Soft overshoot pop: 0.85 -> 1.06 -> 1.0
        const overshoot = 1.0 + Math.sin(p * Math.PI) * 0.08;
        const scale = (0.85 + 0.15 * p) * (p < 1 ? overshoot : 1.0);
        const slideY = (1.0 - p) * 8;
        const totalCardAlpha = p * alphaVal;

        cardEl.style.visibility = 'visible';
        cardEl.style.opacity = `${totalCardAlpha.toFixed(2)}`;
        cardEl.style.transform = `translateY(${slideY.toFixed(1)}px) scale(${scale.toFixed(3)})`;
        cardEl.style.pointerEvents = totalCardAlpha > 0.1 ? 'auto' : 'none';
      } else {
        cardEl.style.opacity = '0';
        cardEl.style.visibility = 'hidden';
        cardEl.style.pointerEvents = 'none';
      }
    }

    if (particleEl) {
      particleEl.style.opacity = '0';
      particleEl.style.visibility = 'hidden';
    }

    // 5. Anchor Pin Dot is baked in 3D GLB
    if (pinEl) {
      pinEl.style.opacity = '0';
      pinEl.style.visibility = 'hidden';
    }
  }
}
