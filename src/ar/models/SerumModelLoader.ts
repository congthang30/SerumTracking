import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { INGREDIENTS } from '../../data/ingredients';

export interface LoadedSerumModel {
  /** Outer normalized root group ready to attach to TargetAnchor */
  modelScene: THREE.Group;
  sourceScene: THREE.Group;
  bottleGroup: THREE.Object3D;
  mixer: THREE.AnimationMixer | null;
  anchors: Record<string, THREE.Object3D>;
  elbows: Record<string, THREE.Object3D>;
  calloutLines: Record<string, Line2>;
  scale: number;
  normalizedSize: THREE.Vector3;
  actions?: THREE.AnimationAction[];
  waterGroup?: THREE.Object3D | null;
  flowerGroup?: THREE.Object3D | null;
  waterMixer?: THREE.AnimationMixer | null;
}

export class SerumModelLoader {
  private loader = new GLTFLoader();

  public async load(
    onProgress?: (percent: number) => void
  ): Promise<LoadedSerumModel> {
    const urls = [
      'assets/models/serum_story_animated.glb?v=10',
      '/assets/models/serum_story_animated.glb?v=10',
      'assets/models/serum_story_animated_opt.glb?v=9',
      '/assets/models/serum_story_animated_opt.glb?v=9',
    ];
    let lastError: any = null;

    for (const url of urls) {
      try {
        return await this.loadSingleGLB(url, onProgress);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Không thể tải file model serum GLB.');
  }

  private loadSingleGLB(
    url: string,
    onProgress?: (percent: number) => void
  ): Promise<LoadedSerumModel> {
    return new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => {
          const source = gltf.scene;

          // Runtime-only shelf-line adjustments to keep the ingredient labels clear.
          // These mesh paths run along local Y and are animated by the GLB's scale tracks.
          const shelfLineLengthScales: Record<string, number> = {
            Line_Shelf_vitamin_b5: 0.85,
            Line_Shelf_hyaluronic_acid: 1.39,
          };
          for (const [name, lengthScale] of Object.entries(shelfLineLengthScales)) {
            const line = source.getObjectByName(name) as THREE.Mesh | undefined;
            if (!line?.isMesh) continue;
            line.geometry = line.geometry.clone();
            line.geometry.scale(1, lengthScale, 1);
          }

          // Strip any embedded lights from GLB so they do not blow out the Three.js studio lighting
          const objectsToRemove: THREE.Object3D[] = [];
          source.traverse((child) => {
            if ((child as THREE.Light).isLight) {
              objectsToRemove.push(child);
              return;
            }
            const lowerName = child.name.toLowerCase();
            // Remove floating petals in air (the 2 floating capsule streaks) and unwanted static remnants
            if (
              lowerName.includes('petal_falling') ||
              lowerName.includes('air_left') ||
              lowerName.includes('air_right') ||
              lowerName.includes('petal_fallen') ||
              lowerName.includes('petal_resting') ||
              lowerName.includes('droplet_top_left') ||
              lowerName.includes('droplet_main_right') ||
              lowerName.includes('droplet_mid_right') ||
              lowerName.includes('droplet_tiny_right')
            ) {
              objectsToRemove.push(child);
            }
          });
          for (const obj of objectsToRemove) {
            obj.parent?.remove(obj);
          }

          // 1. Refine water splash & droplets to luxury crystal water material
          const waterMaterial = new THREE.MeshPhysicalMaterial({
            color: new THREE.Color(0xd2f3fe),
            roughness: 0.02,
            metalness: 0.04,
            transparent: true,
            opacity: 0.85,
            envMapIntensity: 2.5,
            depthWrite: false,
            side: THREE.DoubleSide,
          });

          source.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              const mesh = child as THREE.Mesh;
              mesh.castShadow = false;
              mesh.receiveShadow = false;

              const lowerName = mesh.name.toLowerCase();
              if (lowerName.includes('water') || lowerName.includes('splash') || lowerName.includes('liquid')) {
                mesh.material = waterMaterial.clone();
              } else if (lowerName.includes('droplet')) {
                mesh.material = waterMaterial;
              }

              // Eliminate black checkerboard / pixelated refraction artifacts on glass bottle and pipette
              const mat = mesh.material as THREE.Material;
              if (mat) {
                const materials = Array.isArray(mat) ? mat : [mat];
                for (const m of materials) {
                  if ((m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
                    const pMat = m as THREE.MeshPhysicalMaterial;
                    if (pMat.transmission > 0 && !lowerName.includes('water') && !lowerName.includes('droplet')) {
                      pMat.transmission = 0;
                      pMat.transparent = true;
                      pMat.opacity = 0.38;
                      pMat.roughness = 0.04;
                      pMat.metalness = 0.05;
                      pMat.depthWrite = true;
                    }
                  }
                }
              }
            }
          });

          // 2. Play Master 6-Scene Cinematic Sequence Animation (Play Once & Freeze at Full Bloom)
          let mixer: THREE.AnimationMixer | null = null;
          const actions: THREE.AnimationAction[] = [];
          if (gltf.animations && gltf.animations.length > 0) {
            mixer = new THREE.AnimationMixer(source);
            const masterClip = gltf.animations.find(a => a.name === 'Serum_Cinematic_Sequence');
            if (masterClip) {
              const action = mixer.clipAction(masterClip);
              action.setLoop(THREE.LoopOnce, 1);
              action.clampWhenFinished = true;
              action.play();
              actions.push(action);
            } else {
              for (const anim of gltf.animations) {
                const action = mixer.clipAction(anim);
                action.setLoop(THREE.LoopOnce, 1);
                action.clampWhenFinished = true;
                action.play();
                actions.push(action);
              }
            }
          }

          // 3. Model Normalization
          // Callout pins and lines sit far outside the product to reach the label edges.
          // Including them in normalization shrinks the bottle and flowers to fit those
          // annotation endpoints instead of fitting the visible product scene.
          const rawBox = new THREE.Box3();
          source.updateMatrixWorld(true);
          source.traverse((child) => {
            if (!(child as THREE.Mesh).isMesh) return;
            const lowerName = child.name.toLowerCase();
            if (lowerName.startsWith('pin_') || lowerName.startsWith('line_') || lowerName.startsWith('callout_')) {
              return;
            }

            const mesh = child as THREE.Mesh;
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            if (mesh.geometry.boundingBox) {
              rawBox.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
            }
          });
          if (rawBox.isEmpty()) rawBox.setFromObject(source);
          const rawSize = new THREE.Vector3();
          rawBox.getSize(rawSize);

          const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z) || 1;
          const targetSize = 0.58;
          const scale = targetSize / maxDim;
          const normalizedSize = rawSize.clone().multiplyScalar(scale);

          const inner = new THREE.Group();
          inner.name = 'SerumNormalizedInner';
          inner.add(source);

          // Dynamically compute bottle center and rock bottom with safe fallbacks
          const rockObj = source.getObjectByName('Rock_Pedestal') || source.getObjectByName('Object_4') || source.getObjectByName('Rock_Group');
          let rockMinY = -0.227;
          if (rockObj) {
            const rockBox = new THREE.Box3().setFromObject(rockObj);
            if (rockBox.min.y < -0.10) {
              rockMinY = rockBox.min.y;
            }
          }

          const bottleObj = source.getObjectByName('Serum_Group') || source.getObjectByName('Sketchfab_model');
          let bottleRawX = 0.01428;
          if (bottleObj) {
            const bBox = new THREE.Box3().setFromObject(bottleObj);
            if (Math.abs(bBox.max.x - bBox.min.x) > 0.1) {
              bottleRawX = (bBox.min.x + bBox.max.x) / 2;
            }
          }

          inner.position.set(
            -bottleRawX * scale,
            -rockMinY * scale,
            0
          );
          inner.scale.setScalar(scale);

          const root = new THREE.Group();
          root.name = 'SerumModelRoot';
          root.add(inner);

          // 4. Bottle Group for 360 interactive rotation and ingredient anchors
          const serumGroup = source.getObjectByName('Serum_Group');
          const rawBottle = source.getObjectByName('Sketchfab_model');
          const bottleGroup: THREE.Object3D = serumGroup || rawBottle || source;

          // Anchor container attached directly to bottleGroup so ingredient callouts
          // stick to the bottle and rotate with it in 3D!
          const bottleAnchorContainer = new THREE.Group();
          bottleAnchorContainer.name = 'BottleAnchorContainer';
          bottleAnchorContainer.position.set(bottleRawX, 0, 0);
          bottleGroup.add(bottleAnchorContainer);

          const anchors: Record<string, THREE.Object3D> = {};
          const elbows: Record<string, THREE.Object3D> = {};
          const calloutLines: Record<string, Line2> = {};

          for (const ing of INGREDIENTS) {
            // Priority: Use the 3D baked pins and elbows directly from GLB model!
            const glbAnchor = source.getObjectByName(`Pin_Anchor_${ing.id}`);
            const glbElbow = source.getObjectByName(`Pin_Elbow_${ing.id}`);

            if (glbAnchor) {
              anchors[ing.id] = glbAnchor;
            } else {
              const anchor = new THREE.Object3D();
              anchor.name = `Anchor_${ing.id}`;
              anchor.position.copy(ing.localAnchor);
              bottleAnchorContainer.add(anchor);
              anchors[ing.id] = anchor;
            }

            if (glbElbow) {
              elbows[ing.id] = glbElbow;
            } else {
              const elbow = new THREE.Object3D();
              elbow.name = `Elbow_${ing.id}`;
              elbow.position.copy(ing.localElbow);
              bottleAnchorContainer.add(elbow);
              elbows[ing.id] = elbow;
            }
          }

          // 5. Water & Flower Groups references directly from master model
          const waterGroup = source.getObjectByName('Water_Group') || source.getObjectByName('Main_Water_Spiral') || null;
          const flowerGroup = source.getObjectByName('Flower_Group') || null;

          resolve({
            modelScene: root,
            sourceScene: source,
            bottleGroup,
            mixer,
            actions,
            anchors,
            elbows,
            calloutLines,
            scale,
            normalizedSize,
            waterGroup,
            flowerGroup,
            waterMixer: null,
          });
        },
        (xhr) => {
          if (xhr.total > 0 && onProgress) {
            const pct = Math.round((xhr.loaded / xhr.total) * 100);
            onProgress(pct);
          }
        },
        (err) => reject(err)
      );
    });
  }
}
