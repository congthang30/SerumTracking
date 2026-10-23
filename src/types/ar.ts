import * as THREE from 'three';

export interface ImagePose {
  name: string;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
  /** Width of the detected planar image before applying pose.scale. */
  scaledWidth?: number;
  scaledHeight?: number;
}

export interface Ingredient {
  id: string;
  number: string;
  tag: string;
  title: string;
  subtitle: string;
  description: string;
  highlight: string;
  side: 'left' | 'right';
  localAnchor: THREE.Vector3;
  localElbow: THREE.Vector3;
  delay?: number;
  orbType?: 'b5' | 'ha' | 'c';
  iconSvg?: string;
}

export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

export interface CalloutScreenLayout {
  id: string;
  dotX: number;
  dotY: number;
  cardX: number;
  cardY: number;
  cardW: number;
  cardH: number;
  elbowX: number;
  elbowY: number;
  targetX: number;
  targetY: number;
  side: 'left' | 'right';
  progress: number;
  visible: boolean;
  alpha?: number;
  time?: number;
}
