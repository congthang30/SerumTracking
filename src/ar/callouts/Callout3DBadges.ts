import * as THREE from 'three';
import { INGREDIENTS } from '../../data/ingredients';
import { Ingredient } from '../../types/ar';

const BADGE_CONTENT_SCALE = 1.5;
const badgeMipmapsQuery = typeof window === 'undefined'
  ? null
  : new URLSearchParams(window.location.search).get('badgeMipmaps');

// A/B: default (?badgeMipmaps=1) enables mipmaps; ?badgeMipmaps=0 restores the legacy filter.
export const BADGE_MIPMAPS_ENABLED = badgeMipmapsQuery !== '0';

export interface CalloutBadgeItem {
  id: string;
  ingredient: Ingredient;
  mesh: THREE.Mesh;
  shelfMidpoint: THREE.Vector3;
  baseScale: number;
}

export class Callout3DBadges {
  public group: THREE.Group;
  private items: CalloutBadgeItem[] = [];
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private camera: THREE.Camera;
  private onSelect: (ing: Ingredient) => void;
  private canvasEl: HTMLCanvasElement;

  constructor(
    parentGroup: THREE.Object3D,
    camera: THREE.Camera,
    canvasEl: HTMLCanvasElement,
    onSelect: (ing: Ingredient) => void
  ) {
    this.group = new THREE.Group();
    this.group.name = 'Callout3DBadgesGroup';
    parentGroup.add(this.group);

    this.camera = camera;
    this.canvasEl = canvasEl;
    this.onSelect = onSelect;

    this.initBadges();
    this.setupInteraction();
  }

  public updateCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  private initBadges(): void {
    // 3D Shelf positions in Serum_Group local coordinates
    // Positioned directly on top of the GLB 3D glowing shelf lines
    const shelfSpecs: Record<string, { pos: THREE.Vector3; width: number; height: number }> = {
      vitamin_b5: {
        pos: new THREE.Vector3(-0.84, 1.018, 0.18),
        width: 0.38,
        height: 0.095,
      },
      hyaluronic_acid: {
        pos: new THREE.Vector3(-1.225, 0.318, 0.18),
        width: 0.45,
        height: 0.095,
      },
      vitamin_c: {
        // Right edge aligns with the GLB shelf endpoint at x=1.15.
        pos: new THREE.Vector3(0.96, 0.578, 0.14),
        width: 0.38,
        height: 0.095,
      },
    };

    for (const ing of INGREDIENTS) {
      const spec = shelfSpecs[ing.id] || {
        pos: new THREE.Vector3(-0.5, 0.5, 0.15),
        width: 0.38,
        height: 0.095,
      };

      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 256;

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = BADGE_MIPMAPS_ENABLED;
      texture.minFilter = BADGE_MIPMAPS_ENABLED
        ? THREE.LinearMipmapLinearFilter
        : THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;

      this.renderBadgeToCanvas(canvas, ing, texture);

      const geometry = new THREE.PlaneGeometry(
        spec.width * BADGE_CONTENT_SCALE,
        spec.height * BADGE_CONTENT_SCALE
      );
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `Badge3D_${ing.id}`;
      mesh.position.copy(spec.pos);
      mesh.scale.set(0.0001, 0.0001, 0.0001); // Emerges smoothly in sync with timeline
      mesh.renderOrder = 10;
      (mesh as any).userData = { ingredient: ing };

      this.group.add(mesh);
      this.items.push({
        id: ing.id,
        ingredient: ing,
        mesh,
        shelfMidpoint: spec.pos.clone(),
        baseScale: 1.0,
      });
    }
  }

  /**
   * Renders ONLY the large bold typography and icon - zero box/pill frame, 100% transparent background!
   */
  private renderBadgeToCanvas(
    canvas: HTMLCanvasElement,
    ing: Ingredient,
    texture: THREE.CanvasTexture
  ): void {
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    const cy = h / 2;

    const redraw = (svgImage?: HTMLImageElement) => {
      ctx.clearRect(0, 0, w, h);

      // Setup high-contrast shadow so the white text and icon pop against any scene background
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 4;

      const iconSize = 220;
      const isRightSide = ing.id === 'vitamin_c';

      if (!isRightSide) {
        // --- LEFT SIDE INGREDIENTS (B5, Hyaluronic Acid): [ ICON ]  [ TEXT ] ---
        const iconX = 28;
        const iconY = cy - iconSize / 2;

        if (svgImage && svgImage.complete && svgImage.naturalWidth > 0) {
          ctx.drawImage(svgImage, iconX, iconY, iconSize, iconSize);
        } else {
          this.drawFallbackIcon(ctx, ing.id, iconX + iconSize / 2, cy, iconSize / 2);
        }

        // Large bold white text
        ctx.fillStyle = '#FFFFFF';
        ctx.font = ing.id === 'hyaluronic_acid'
          ? '900 140px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
          : '900 156px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const title = ing.title.toUpperCase();
        const textX = iconX + iconSize + 32;
        ctx.fillText(title, textX, cy - 2, w - textX - 24);

      } else {
        // --- RIGHT SIDE INGREDIENT (Vitamin C): [ TEXT ]  [ ICON ] ---
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '900 156px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        const textX = 24;
        const title = ing.title.toUpperCase();
        const iconX = w - iconSize - 24;
        const maxTextWidth = iconX - textX - 28;
        ctx.fillText(title, textX, cy - 2, maxTextWidth);

        const iconY = cy - iconSize / 2;

        if (svgImage && svgImage.complete && svgImage.naturalWidth > 0) {
          ctx.drawImage(svgImage, iconX, iconY, iconSize, iconSize);
        } else {
          this.drawFallbackIcon(ctx, ing.id, iconX + iconSize / 2, cy, iconSize / 2);
        }
      }

      ctx.restore();
      texture.needsUpdate = true;
    };

    // Initial render with fallback icon
    redraw();

    // Async load official vector SVG from public/svg
    if (ing.iconSvg) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => redraw(img);
      img.onerror = () => redraw();
      img.src = ing.iconSvg;
    }
  }

  private drawFallbackIcon(
    ctx: CanvasRenderingContext2D,
    id: string,
    cx: number,
    cy: number,
    r: number
  ): void {
    ctx.save();
    if (id === 'vitamin_b5') {
      ctx.beginPath();
      ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
      ctx.fillStyle = '#54D6C7';
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.fillStyle = '#121926';
      ctx.font = 'bold 88px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('B', cx, cy + 2);
    } else if (id === 'hyaluronic_acid') {
      ctx.beginPath();
      ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
      ctx.fillStyle = '#4AC3FF';
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 90px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('💧', cx, cy);
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
      ctx.fillStyle = '#FF9F2E';
      ctx.fill();
      ctx.strokeStyle = '#FFE08A';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 90px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🍊', cx, cy);
    }
    ctx.restore();
  }

  /**
   * Updates badge scale and visibility aligned with the master story timeline
   */
  public update(sequenceTime: number): void {
    for (const item of this.items) {
      // Emergence timeline:
      // vitamin_b5: 8.5s - 9.0s
      // hyaluronic_acid: 8.8s - 9.3s
      // vitamin_c: 9.1s - 9.6s
      const delay = item.id === 'vitamin_b5' ? 8.5 : item.id === 'hyaluronic_acid' ? 8.8 : 9.1;
      const progress = Math.max(0, Math.min(1, (sequenceTime - delay) / 0.5));

      if (progress <= 0) {
        item.mesh.scale.set(0.0001, 0.0001, 0.0001);
        item.mesh.visible = false;
      } else {
        item.mesh.visible = true;
        // Elastic pop overshoot reveal: 0 -> 1.08 -> 1.0
        const pop = progress < 1 ? 1.0 + Math.sin(progress * Math.PI) * 0.12 : 1.0;
        const scaleVal = progress * pop * item.baseScale;
        item.mesh.scale.set(scaleVal, scaleVal, scaleVal);
      }
    }
  }

  private setupInteraction(): void {
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const rect = this.canvasEl.getBoundingClientRect();
      let clientX = 0;
      let clientY = 0;

      if ('touches' in e && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else if ('clientX' in e) {
        clientX = (e as MouseEvent).clientX;
        clientY = (e as MouseEvent).clientY;
      }

      this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

      this.raycaster.setFromCamera(this.mouse, this.camera);
      const meshes = this.items.map((i) => i.mesh).filter((m) => m.visible);
      const intersects = this.raycaster.intersectObjects(meshes, false);

      if (intersects.length > 0) {
        const hit = intersects[0].object;
        const item = this.items.find((i) => i.mesh === hit);
        if (item) {
          // Micro pop animation
          item.baseScale = 1.15;
          setTimeout(() => {
            item.baseScale = 1.0;
            this.onSelect(item.ingredient);
          }, 120);
        }
      }
    };

    this.canvasEl.addEventListener('click', onPointerDown);
  }

  public dispose(): void {
    for (const item of this.items) {
      item.mesh.geometry.dispose();
      if (Array.isArray(item.mesh.material)) {
        item.mesh.material.forEach((m) => m.dispose());
      } else {
        item.mesh.material.dispose();
      }
    }
    this.group.clear();
  }
}
