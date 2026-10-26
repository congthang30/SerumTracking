import * as THREE from 'three';
import { Ingredient } from '../../types/ar';

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

  constructor(
    parentGroup: THREE.Object3D,
    _camera: THREE.Camera,
    _canvasEl: HTMLCanvasElement,
    _onSelect: (ing: Ingredient) => void
  ) {
    this.group = new THREE.Group();
    this.group.name = 'Callout3DBadgesGroup';
    parentGroup.add(this.group);
  }

  public updateCamera(_camera: THREE.Camera): void {}

  public update(_sequenceTime: number): void {}

  public dispose(): void {
    this.group.clear();
  }
}

