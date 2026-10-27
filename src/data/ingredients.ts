import * as THREE from 'three';
import { Ingredient } from '../types/ar';

export const INGREDIENTS: Ingredient[] = [
  {
    id: 'b5',
    number: '01',
    tag: 'Repair',
    title: 'Vitamin B5',
    subtitle: 'Soothe skin and restore its protective barrier',
    description:
      'High-concentration D-Panthenol (Vitamin B5) instantly soothes irritated skin, strengthens its natural lipid barrier, and supports epidermal cell renewal from within.',
    highlight: '🛡️ Restores the skin barrier, calms irritation, and helps skin stay resilient and healthy.',
    side: 'left',
    localAnchor: new THREE.Vector3(-0.68, 1.05, 0.04),
    localElbow: new THREE.Vector3(-0.68, 1.05, 0.04),
    delay: 0.0,
    orbType: 'b5',
    iconSvg: '/svg/icon_vitamin_b_vector.svg',
  },
  {
    id: 'ha',
    number: '02',
    tag: 'Deep Hydration',
    title: 'Hyaluronic Acid',
    subtitle: 'Multi-layer hydration and plump skin for 72 hours',
    description:
      'A multi-molecular Hyaluronic Acid complex (Micro & Macro HA) penetrates the layers of the epidermis, locks in moisture, and plumps fine lines.',
    highlight: '💧 Deep hydration for 72 hours, an immediate 82% boost in moisture, and lasting supple skin.',
    side: 'left',
    localAnchor: new THREE.Vector3(-0.94, 0.46, 0.04),
    localElbow: new THREE.Vector3(-0.94, 0.46, 0.04),
    delay: 0.3,
    orbType: 'ha',
    iconSvg: '/svg/giot_nuoc_phan_tu.svg',
  },
  {
    id: 'c',
    number: '03',
    tag: 'Brightening',
    title: 'Vitamin C',
    subtitle: 'Antioxidant care for a brighter, more even complexion',
    description:
      'A next-generation pure Vitamin C derivative fights free radicals, helps limit melanin formation, and supports natural collagen production.',
    highlight: '🌸 Promotes a radiant complexion, helps fade post-acne marks in just 14 days, and helps prevent early signs of aging.',
    side: 'right',
    localAnchor: new THREE.Vector3(0.74, 0.82, 0.04),
    localElbow: new THREE.Vector3(0.74, 0.82, 0.04),
    delay: 0.6,
    orbType: 'c',
    iconSvg: '/svg/orange-svgrepo-com.svg',
  },
];

export function getIngredientById(idOrKey: string): Ingredient | undefined {
  const norm = idOrKey.toLowerCase();
  return INGREDIENTS.find((ing) =>
    ing.id.toLowerCase() === norm ||
    ing.orbType?.toLowerCase() === norm ||
    norm.includes(ing.id.toLowerCase()) ||
    (norm.includes('b5') && ing.id === 'b5') ||
    (norm.includes('ha') && ing.id === 'ha') ||
    ((norm.includes('vc') || norm.includes('vitamin_c') || norm.includes('vitamin c') || norm.includes('orange')) && ing.id === 'c')
  );
}
