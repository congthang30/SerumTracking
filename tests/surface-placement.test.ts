import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SurfacePlacementController } from '../src/ar/tracking/SurfacePlacementController';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 1.5, 0);
camera.lookAt(0, 0, -1);
scene.add(camera);
const product = new THREE.Group();
product.position.set(0, 0, -0.4);
camera.add(product);
const worldAnchor = new THREE.Group();
scene.add(worldAnchor);

const controller = new SurfacePlacementController(scene, camera, product, worldAnchor);
controller.setTargetFound(true);
controller.setTrackingStatus('NORMAL');

const frames = (count: number) => {
  for (let i = 0; i < count; i++) controller.update(1 / 60);
};
const matrixElements = () => {
  product.updateWorldMatrix(true, true);
  return product.matrixWorld.elements.slice();
};
const assertMatrixUnchanged = (before: number[]) => {
  const after = matrixElements();
  before.forEach((element, index) => assert.ok(Math.abs(element - after[index]) < 1e-8));
};

frames(10);
assert.equal(controller.hasStablePreview, false, 'tracking must settle before preview');
frames(20);
assert.equal(controller.hasStablePreview, true);
assert.equal(controller.planeY, 0);
assert.equal(controller.currentSurfacePosition.y, 0);

controller.setTrackingStatus('LIMITED');
assert.equal(controller.hasStablePreview, false);
assert.equal(controller.placeProduct(), false, 'placement is blocked while tracking is limited');
controller.setTrackingStatus('NORMAL');
frames(30);
assert.equal(controller.placeProduct(), true);
assert.equal(controller.scalePlacedModelBy(1.5), false, 'pinch waits until placement finishes');

await new Promise((resolve) => setTimeout(resolve, 470));
controller.update(1 / 60);
const placedWorldScale = new THREE.Vector3();
product.getWorldScale(placedWorldScale);
assert.ok(Math.abs(placedWorldScale.y * 0.612157 - 0.30) < 1e-6, 'placed model height is 1.5x the former 20 cm target');
const placedPosition = product.getWorldPosition(new THREE.Vector3());
const placedQuaternion = product.getWorldQuaternion(new THREE.Quaternion());
let scaledMatrix: THREE.Matrix4 | null = null;
controller.onPlacedTransformChanged = (matrix) => { scaledMatrix = matrix.clone(); };
assert.equal(controller.scalePlacedModelBy(1.5), true);
assert.equal(controller.placedModelScaleMultiplier, 1.5);
product.getWorldScale(placedWorldScale);
assert.ok(Math.abs(placedWorldScale.y * 0.612157 - 0.45) < 1e-6, 'pinch enlarges the placed model');
assert.ok(product.getWorldPosition(new THREE.Vector3()).distanceTo(placedPosition) < 1e-8);
assert.ok(product.getWorldQuaternion(new THREE.Quaternion()).angleTo(placedQuaternion) < 1e-8);
assert.deepEqual(scaledMatrix?.elements, matrixElements(), 'tracking receives the new world transform');
assert.equal(controller.scalePlacedModelBy(100), true);
assert.equal(controller.placedModelScaleMultiplier, 2, 'pinch scale has an upper bound');
assert.equal(controller.scalePlacedModelBy(0.001), true);
assert.equal(controller.placedModelScaleMultiplier, 0.5, 'pinch scale has a lower bound');
assert.equal(controller.scalePlacedModelBy(3), true);
const placedMatrix = matrixElements();
assert.equal(controller.scalePlacedModelBy(-1), false);
assertMatrixUnchanged(placedMatrix);

camera.position.y = 2.3;
camera.lookAt(0, 0, -1);
camera.updateMatrixWorld(true);
controller.update(1 / 60);
assert.equal(controller.hasStablePreview, false);
frames(30);
assert.equal(controller.currentSurfacePosition.y, 0, 'camera distance cannot change the floor height');
assertMatrixUnchanged(placedMatrix);

camera.position.x = 1;
camera.updateMatrixWorld(true);
controller.update(1 / 60);
assert.equal(controller.hasStablePreview, false, 'a pose jump hides the grid');
frames(30);
assert.equal(controller.hasStablePreview, true, 'preview returns after tracking settles');
assertMatrixUnchanged(placedMatrix);

controller.relockToCamera();
assert.equal(controller.canScalePlacedModel, false, 'camera-locked model cannot be pinched');
frames(30);
assert.equal(controller.placeProduct(), true);
await new Promise((resolve) => setTimeout(resolve, 470));
controller.update(1 / 60);
product.getWorldScale(placedWorldScale);
assert.ok(Math.abs(placedWorldScale.y * 0.612157 - 0.45) < 1e-6, 'chosen size persists after repositioning');

controller.dispose();
console.log('Floor-only preview, anchored pinch scale, and placed model stability: passed');
