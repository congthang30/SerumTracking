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

await new Promise((resolve) => setTimeout(resolve, 470));
controller.update(1 / 60);
const placedMatrix = matrixElements();
const placedWorldScale = new THREE.Vector3();
product.getWorldScale(placedWorldScale);
assert.ok(Math.abs(placedWorldScale.y * 0.612157 - 0.30) < 1e-6, 'placed model height is 1.5x the former 20 cm target');

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

controller.dispose();
console.log('Floor-only preview stability and placed model transform: passed');
