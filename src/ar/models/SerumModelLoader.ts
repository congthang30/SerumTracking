import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';

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
      'assets/models/serum_story_animated.glb?v=35',
      '/assets/models/serum_story_animated.glb?v=35',
      'assets/models/serum_story_animated_opt.glb?v=35',
      '/assets/models/serum_story_animated_opt.glb?v=35',
    ];
    let lastError: any = null;

    for (const url of urls) {
      try {
        return await this.loadSingleGLB(url, onProgress);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Could not load the serum GLB model.');
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
              lowerName.includes('droplet_tiny_right') ||
              lowerName.startsWith('pin_') ||
              lowerName.startsWith('line_') ||
              lowerName.startsWith('callout')
            ) {
              objectsToRemove.push(child);
            }
          });
          for (const obj of objectsToRemove) {
            obj.parent?.remove(obj);
          }

          // Ensure 3D ingredient spheres stay hidden at frame 0 until their Scene 6 pop-in (frames 238..266)
          for (const ctrlName of ['B5_Controller', 'HA_Controller', 'VC_Controller']) {
            const ctrl = source.getObjectByName(ctrlName);
            if (ctrl) {
              ctrl.scale.setScalar(0.0001);
            }
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

          // Luminous Crystal Jewel Orb Shader (bright, airy, crystal-clear interior + saturated jewel Fresnel ring + diamond specular arc)
          const makeGlassOrbMaterial = (
            innerTintHex: number,
            jewelRimHex: number,
            outerContourHex: number,
            highlightHex: number
          ) =>
            new THREE.ShaderMaterial({
              transparent: true,
              depthWrite: false,
              toneMapped: false,
              blending: THREE.NormalBlending,
              side: THREE.FrontSide,
              uniforms: {
                uInnerTint: { value: new THREE.Color(innerTintHex) },
                uRimColor: { value: new THREE.Color(jewelRimHex) },
                uOuterContour: { value: new THREE.Color(outerContourHex) },
                uHighlightColor: { value: new THREE.Color(highlightHex) },
              },
              vertexShader: `
                varying vec3 vNormalV;
                varying vec3 vViewDirV;
                void main() {
                  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                  vNormalV = normalize(normalMatrix * normal);
                  vViewDirV = normalize(-mvPos.xyz);
                  gl_Position = projectionMatrix * mvPos;
                }
              `,
              fragmentShader: `
                uniform vec3 uInnerTint;
                uniform vec3 uRimColor;
                uniform vec3 uOuterContour;
                uniform vec3 uHighlightColor;
                varying vec3 vNormalV;
                varying vec3 vViewDirV;
                void main() {
                  vec3 N = normalize(vNormalV);
                  vec3 V = normalize(vViewDirV);
                  float ndotv = clamp(dot(N, V), 0.0, 1.0);
                  float fresnel = 1.0 - ndotv;

                  // Bright luminous jewel rim + saturated jewel edge contour (visible on both white AR backgrounds and dark studio)
                  float jewelBand = smoothstep(0.45, 0.85, fresnel);
                  float contourEdge = smoothstep(0.80, 0.96, fresnel) * (1.0 - smoothstep(0.95, 0.998, fresnel));
                  float razorDiamondRim = smoothstep(0.90, 0.996, fresnel);

                  // Confine studio softbox reflections toward the outer curvature so the center icon stays crystal-clear
                  float rimMask = smoothstep(0.32, 0.74, fresnel);
                  vec3 light1 = normalize(vec3(-0.56, 0.64, 0.52));
                  vec3 light2 = normalize(vec3(0.55, -0.54, 0.64));
                  float spec1 = pow(max(dot(N, normalize(light1 + V)), 0.0), 105.0) * 1.25 * rimMask;
                  float spec1Arc = pow(max(dot(N, normalize(light1 + V)), 0.0), 34.0) * 0.36 * rimMask;
                  float spec2 = pow(max(dot(N, normalize(light2 + V)), 0.0), 72.0) * 0.75 * rimMask;
                  float specTotal = spec1 + spec1Arc + spec2;

                  vec3 col = mix(uInnerTint, uRimColor, clamp(jewelBand * 1.15, 0.0, 1.0));
                  col = mix(col, uOuterContour, contourEdge * 0.65);
                  col = mix(col, uHighlightColor, clamp(razorDiamondRim * 0.72 + specTotal, 0.0, 1.0));

                  // Ultra-clear bright center (0.07 alpha) rising to a vivid luminous jewel rim (0.86 alpha)
                  float alpha = clamp(0.07 + jewelBand * 0.48 + razorDiamondRim * 0.34 + specTotal * 0.85, 0.0, 0.94);
                  gl_FragColor = vec4(col, alpha);
                }
              `,
            });

          // 3D Luminous Liquid Jewel Micro-Pearl Shader (bright glowing core + saturated jewel contour + diamond specular glint)
          const makeMolecularBubbleMaterial = (coreHex: number, rimHex: number, contourHex: number) =>
            new THREE.ShaderMaterial({
              transparent: true,
              depthWrite: true,
              toneMapped: false,
              blending: THREE.NormalBlending,
              side: THREE.FrontSide,
              uniforms: {
                uCoreColor: { value: new THREE.Color(coreHex) },
                uRimColor: { value: new THREE.Color(rimHex) },
                uContourColor: { value: new THREE.Color(contourHex) },
              },
              vertexShader: `
                varying vec3 vNormalV;
                varying vec3 vViewDirV;
                void main() {
                  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                  vNormalV = normalize(normalMatrix * normal);
                  vViewDirV = normalize(-mvPos.xyz);
                  gl_Position = projectionMatrix * mvPos;
                }
              `,
              fragmentShader: `
                uniform vec3 uCoreColor;
                uniform vec3 uRimColor;
                uniform vec3 uContourColor;
                varying vec3 vNormalV;
                varying vec3 vViewDirV;
                void main() {
                  vec3 N = normalize(vNormalV);
                  vec3 V = normalize(vViewDirV);
                  float ndotv = clamp(dot(N, V), 0.0, 1.0);
                  float fresnel = 1.0 - ndotv;

                  vec3 lightDir = normalize(vec3(-0.48, 0.64, 0.60));
                  vec3 causticDir = normalize(vec3(0.46, -0.56, 0.68));
                  float diff = 0.68 + 0.32 * max(dot(N, lightDir), 0.0);
                  float spec = pow(max(dot(N, normalize(lightDir + V)), 0.0), 88.0) * 1.35;
                  float caustic = pow(max(dot(N, causticDir), 0.0), 2.4) * 0.90;
                  float jewelEdge = smoothstep(0.62, 0.95, fresnel);

                  vec3 col = mix(uCoreColor * diff, uRimColor, clamp(caustic + pow(ndotv, 1.5) * 0.55, 0.0, 1.0));
                  col = mix(col, uContourColor, jewelEdge * 0.52);
                  col += vec3(1.0, 0.99, 0.96) * spec;

                  float alpha = clamp(0.84 + jewelEdge * 0.10 + spec * 0.12, 0.0, 0.98);
                  gl_FragColor = vec4(clamp(col, 0.0, 1.0), alpha);
                }
              `,
            });

          // B5 Radiant 24K Liquid Gold Serum Orb Shader (bright golden honey heart + warm amber contour + diamond cream highlight)
          const b5CoreMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: true,
            toneMapped: false,
            vertexShader: `
              varying vec3 vNormalV;
              varying vec3 vViewDirV;
              void main() {
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                vNormalV = normalize(normalMatrix * normal);
                vViewDirV = normalize(-mvPos.xyz);
                gl_Position = projectionMatrix * mvPos;
              }
            `,
            fragmentShader: `
              varying vec3 vNormalV;
              varying vec3 vViewDirV;
              void main() {
                vec3 N = normalize(vNormalV);
                vec3 V = normalize(vViewDirV);
                float ndotv = clamp(dot(N, V), 0.0, 1.0);
                float fresnel = 1.0 - ndotv;

                vec3 keyLight = normalize(vec3(-0.62, 0.66, 0.42));
                vec3 causticDir = normalize(vec3(0.44, -0.56, 0.70));

                vec3 richAmberGold = vec3(0.86, 0.50, 0.06);
                vec3 bright24KGold = vec3(1.0, 0.76, 0.16);
                vec3 luminousHoneyCaustic = vec3(1.0, 0.91, 0.46);
                vec3 diamondCream = vec3(1.0, 0.99, 0.92);
                vec3 warmGoldContour = vec3(0.74, 0.38, 0.03);

                float lowerCaustic = pow(max(dot(N, causticDir), 0.0), 2.0) * smoothstep(0.05, 0.80, ndotv);
                float coreTranslucency = pow(ndotv, 1.15);

                vec3 col = mix(richAmberGold, bright24KGold, smoothstep(0.0, 0.62, coreTranslucency));
                col = mix(col, luminousHoneyCaustic, clamp(lowerCaustic * 1.18 + pow(coreTranslucency, 2.0) * 0.42, 0.0, 1.0));
                col = mix(col, diamondCream, pow(lowerCaustic, 2.4) * 0.55);

                float contourBand = smoothstep(0.60, 0.88, fresnel);
                col = mix(col, warmGoldContour, contourBand * 0.45);

                float outerRim = smoothstep(0.84, 0.99, fresnel);
                float specMain = pow(max(dot(N, normalize(keyLight + V)), 0.0), 105.0) * 1.20;
                float specCounter = pow(max(dot(N, normalize(causticDir + V)), 0.0), 64.0) * 0.50;

                col = mix(col, luminousHoneyCaustic, outerRim * 0.78);
                col += diamondCream * (specMain + specCounter);

                gl_FragColor = vec4(clamp(col, 0.0, 1.0), 0.98);
              }
            `,
          });

          // Hyaluronic Acid Radiant Crystal-Aqua Water Droplet Shader (luminous sky-cyan heart + ocean azure contour + ice caustic)
          const haDropletMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: true,
            toneMapped: false,
            vertexShader: `
              varying vec3 vNormalV;
              varying vec3 vViewDirV;
              varying vec3 vLocalPos;
              void main() {
                vLocalPos = position;
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                vNormalV = normalize(normalMatrix * normal);
                vViewDirV = normalize(-mvPos.xyz);
                gl_Position = projectionMatrix * mvPos;
              }
            `,
            fragmentShader: `
              varying vec3 vNormalV;
              varying vec3 vViewDirV;
              varying vec3 vLocalPos;
              void main() {
                vec3 N = normalize(vNormalV);
                vec3 V = normalize(vViewDirV);
                float ndotv = clamp(dot(N, V), 0.0, 1.0);
                float fresnel = 1.0 - ndotv;

                vec3 keyLight = normalize(vec3(-0.54, 0.58, 0.61));
                vec3 causticDir = normalize(vec3(0.38, -0.56, 0.73));

                vec3 oceanAzure = vec3(0.05, 0.52, 0.88);
                vec3 crystalAqua = vec3(0.24, 0.80, 1.0);
                vec3 glowingIceCyan = vec3(0.72, 0.96, 1.0);
                vec3 diamondWhite = vec3(0.99, 1.0, 1.0);
                vec3 azureContour = vec3(0.02, 0.38, 0.72);

                float bellyCaustic = pow(max(dot(N, causticDir), 0.0), 1.8) * smoothstep(0.14, -0.08, vLocalPos.y);
                float centerDepth = pow(ndotv, 1.15);

                vec3 col = mix(oceanAzure, crystalAqua, smoothstep(0.02, 0.62, centerDepth));
                col = mix(col, glowingIceCyan, clamp(bellyCaustic * 1.25 + pow(centerDepth, 1.8) * 0.58, 0.0, 1.0));
                col = mix(col, diamondWhite, pow(bellyCaustic, 2.3) * 0.72);

                float contourBand = smoothstep(0.60, 0.88, fresnel);
                col = mix(col, azureContour, contourBand * 0.45);

                float outerRim = smoothstep(0.84, 0.99, fresnel);
                float specMain = pow(max(dot(N, normalize(keyLight + V)), 0.0), 110.0) * 1.25;
                float specRim = pow(max(dot(N, normalize(causticDir + V)), 0.0), 68.0) * 0.55;

                col = mix(col, glowingIceCyan, outerRim * 0.80);
                col += diamondWhite * (specMain + specRim);

                gl_FragColor = vec4(clamp(col, 0.0, 1.0), 0.98);
              }
            `,
          });

          // Vitamin C 3D Sculpted Juicy Citrus Slice Shader (3D normal-mapped vesicles, subsurface citrus glow & wet glints)
          const vcPulpMat = new THREE.ShaderMaterial({
            side: THREE.DoubleSide,
            toneMapped: false,
            vertexShader: `
              varying vec2 vUv;
              varying vec3 vNormalV;
              varying vec3 vViewDirV;
              void main() {
                vUv = uv;
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                vNormalV = normalize(normalMatrix * normal);
                vViewDirV = normalize(-mvPos.xyz);
                gl_Position = projectionMatrix * mvPos;
              }
            `,
            fragmentShader: `
              varying vec2 vUv;
              varying vec3 vNormalV;
              varying vec3 vViewDirV;
              void main() {
                vec2 p = (vUv - vec2(0.5)) * 2.0;
                float r = length(p);
                float theta = atan(p.y, p.x);

                // Subtle organic wave so radial membranes look natural rather than ruler-straight CAD lines
                float thetaOrg = theta + 0.016 * sin(r * 15.0 + theta * 5.0);
                float nSeg = 10.0;
                float sector = 6.2831853 / nSeg;
                float a = mod(thetaOrg + 3.14159265, sector) - 0.5 * sector;

                float dWall = r * sin(abs(a));
                float dOuter = 0.842 - r + 0.010 * cos(a * 10.0);
                float dInner = r - (0.092 + 0.014 * cos(thetaOrg * 10.0));

                vec2 kOut = max(vec2(0.044 - (dWall - 0.0085), 0.044 - dOuter), 0.0);
                float sminOuter = min(dWall - 0.0085, dOuter) - length(kOut) + 0.044 * 0.28;

                vec2 kIn = max(vec2(0.022 - (dWall - 0.007), 0.022 - dInner), 0.0);
                float sminInner = min(dWall - 0.007, dInner) - length(kIn) + 0.022 * 0.28;

                float pulpSDF = min(sminOuter, sminInner);
                float isPulp = smoothstep(-0.004, 0.010, pulpSDF);

                // Plump elongated teardrop juice vesicles radiating inside each segment
                float cellAngular = sin(a * 150.0 + sin(r * 38.0) * 1.6);
                float cellRadial = sin(r * 84.0 - cos(a * 72.0) * 1.4);
                float vesicleRaw = cellAngular * 0.62 + cellRadial * 0.38;
                float vesicle = smoothstep(-0.50, 0.72, vesicleRaw);
                float vesiclePeak = pow(max(0.0, cellAngular * cellRadial), 3.0);

                // 3D Procedural Normal Perturbation for plump segment pillows, individual juice sacs & rounded outer rind
                vec2 radialDir = r > 0.001 ? p / r : vec2(0.0, 1.0);
                vec2 tangDir = vec2(-radialDir.y, radialDir.x);
                float segPillowGrad = (1.0 - smoothstep(0.0, 0.14, pulpSDF)) * sign(a);
                float vesicleGradA = cos(a * 150.0 + sin(r * 38.0) * 1.6);
                float vesicleGradR = cos(r * 84.0 - cos(a * 72.0) * 1.4);

                vec3 baseN = normalize(vNormalV);
                vec3 N_pulp = normalize(baseN + vec3(
                  (tangDir * (segPillowGrad * 0.22 + vesicleGradA * 0.24) + radialDir * (vesicleGradR * 0.24 - (r - 0.46) * 0.35)),
                  0.0
                ));

                vec3 V = normalize(vViewDirV);
                vec3 keyLight = normalize(vec3(-0.42, 0.58, 0.70));
                vec3 fillLight = normalize(vec3(0.48, -0.45, 0.75));

                // Subsurface Translucent Citrus Palette: vibrant tangerine walls -> glowing golden-citrus translucent center
                vec3 rubyAmberWall = vec3(0.92, 0.38, 0.06);
                vec3 juicyTangerine = vec3(1.0, 0.58, 0.14);
                vec3 subsurfaceGold = vec3(1.0, 0.86, 0.35);
                vec3 wetHighlight = vec3(1.0, 0.99, 0.92);

                float pocketDepth = clamp(pulpSDF * 9.0, 0.0, 1.0);
                float diffPulp = 0.65 + 0.35 * max(dot(N_pulp, keyLight), 0.0);
                float sssGlow = smoothstep(0.06, 0.72, pocketDepth) * (0.68 + 0.32 * vesicle);

                vec3 pulpCol = mix(rubyAmberWall, juicyTangerine, smoothstep(0.0, 0.42, pocketDepth));
                pulpCol = mix(pulpCol, subsurfaceGold, sssGlow * 0.84);
                pulpCol *= (0.94 + 0.18 * diffPulp);

                // Wet glossy micro-glints on curved juice sacs
                float specPulp = pow(max(dot(N_pulp, normalize(keyLight + V)), 0.0), 68.0);
                float specFill = pow(max(dot(N_pulp, normalize(fillLight + V)), 0.0), 42.0) * 0.45;
                float wetGlint = (vesiclePeak * 0.75 + 0.25) * (specPulp * 1.35 + specFill) + vesiclePeak * 0.25;
                pulpCol += wetHighlight * wetGlint;

                // Soft organic cream pith with 3D bevel shading next to the juicy segments
                vec3 pithCream = vec3(1.0, 0.97, 0.90);
                vec3 pithWarmBevel = vec3(0.96, 0.78, 0.50);
                float pithBevel = smoothstep(-0.014, 0.006, -pulpSDF);
                vec3 pithCol = mix(pithWarmBevel, pithCream, pithBevel);

                // 3D Rounded Zesty Outer Peel Ring with citrus oil-pore specular sheen
                float peelFactor = smoothstep(0.865, 0.905, r);
                float peelRimRoll = clamp((r - 0.87) / 0.13, 0.0, 1.0);
                vec3 N_peel = normalize(baseN + vec3(radialDir * (peelRimRoll * 0.85), 0.0));
                float pores = 0.5 + 0.5 * sin(p.x * 130.0) * sin(p.y * 130.0);
                vec3 deepZest = vec3(0.90, 0.42, 0.07);
                vec3 brightZest = vec3(1.0, 0.66, 0.16);
                float peelDiff = max(dot(N_peel, keyLight), 0.0);
                float peelSpec = pow(max(dot(N_peel, normalize(keyLight + V)), 0.0), 44.0) * (0.6 + 0.4 * pores);
                vec3 peelCol = mix(deepZest, brightZest, clamp(0.45 + 0.55 * peelDiff, 0.0, 1.0) * (0.90 + 0.10 * pores));
                peelCol += wetHighlight * peelSpec * 0.60;

                pithCol = mix(pithCol, peelCol, peelFactor);
                vec3 finalCol = mix(pithCol, pulpCol, isPulp * (1.0 - peelFactor));
                gl_FragColor = vec4(clamp(finalCol, 0.0, 1.0), 1.0);
              }
            `,
          });

          const vcPeelMat = new THREE.ShaderMaterial({
            side: THREE.DoubleSide,
            toneMapped: false,
            vertexShader: `
              varying vec2 vUv;
              varying vec3 vNormalV;
              varying vec3 vViewDirV;
              void main() {
                vUv = uv;
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                vNormalV = normalize(normalMatrix * normal);
                vViewDirV = normalize(-mvPos.xyz);
                gl_Position = projectionMatrix * mvPos;
              }
            `,
            fragmentShader: `
              varying vec2 vUv;
              varying vec3 vNormalV;
              varying vec3 vViewDirV;
              void main() {
                vec3 N = normalize(vNormalV);
                vec3 V = normalize(vViewDirV);
                float fresnel = 1.0 - clamp(abs(dot(N, V)), 0.0, 1.0);
                float pores = 0.5 + 0.5 * sin(vUv.x * 170.0) * sin(vUv.y * 170.0);
                vec3 keyLight = normalize(vec3(-0.45, 0.62, 0.64));
                vec3 deepRind = vec3(0.88, 0.40, 0.08);
                vec3 brightRind = vec3(1.0, 0.64, 0.16);
                vec3 rimGold = vec3(1.0, 0.88, 0.52);
                float diff = 0.45 + 0.55 * max(dot(N, keyLight), 0.0);
                float spec = pow(max(dot(N, normalize(keyLight + V)), 0.0), 48.0) * (0.55 + 0.45 * pores);
                vec3 col = mix(deepRind, brightRind, diff * (0.88 + 0.12 * pores));
                col = mix(col, rimGold, smoothstep(0.40, 0.96, fresnel) * 0.68);
                col += vec3(1.0, 0.98, 0.90) * spec * 0.60;
                gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
              }
            `,
          });

          const vcPithMat = vcPulpMat;

          const b5OuterMat = makeGlassOrbMaterial(0xfff3c4, 0xfbbf24, 0xd97706, 0xffffff);
          const haOuterMat = makeGlassOrbMaterial(0xe0f7ff, 0x38bdf8, 0x0284c7, 0xffffff);
          const vcOuterMat = makeGlassOrbMaterial(0xffedd5, 0xfb923c, 0xea580c, 0xffffff);

          const b5BubbleMat = makeMolecularBubbleMaterial(0xfbbf24, 0xfffbeb, 0xd97706);
          const haBubbleMat = makeMolecularBubbleMaterial(0x38bdf8, 0xf0f9ff, 0x0284c7);
          const vcBubbleMat = makeMolecularBubbleMaterial(0xfb923c, 0xfff7ed, 0xea580c);

          // Luminous 3D Beveled Text Shader (radiant front face + rich jewel-toned 3D bevel edge so text pops in any light)
          const makeBeveledTextMaterial = (faceHex: number, bevelEdgeHex: number) =>
            new THREE.ShaderMaterial({
              side: THREE.DoubleSide,
              toneMapped: false,
              uniforms: {
                uFaceColor: { value: new THREE.Color(faceHex) },
                uEdgeColor: { value: new THREE.Color(bevelEdgeHex) },
              },
              vertexShader: `
                varying vec3 vNormalV;
                void main() {
                  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                  vNormalV = normalize(normalMatrix * normal);
                  gl_Position = projectionMatrix * mvPos;
                }
              `,
              fragmentShader: `
                uniform vec3 uFaceColor;
                uniform vec3 uEdgeColor;
                varying vec3 vNormalV;
                void main() {
                  vec3 N = normalize(vNormalV);
                  float facing = smoothstep(0.28, 0.78, abs(N.z));
                  vec3 col = mix(uEdgeColor, uFaceColor, facing);
                  gl_FragColor = vec4(col, 1.0);
                }
              `,
            });

          // Borderless Feathered Contrast Halo behind 3D Labels (soft radial shadow-glow without any hard box outline)
          const makeLabelPillMaterial = (_borderHex: number, accentHex: number, aspect: number) =>
            new THREE.ShaderMaterial({
              transparent: true,
              depthWrite: false,
              toneMapped: false,
              side: THREE.DoubleSide,
              uniforms: {
                uAccentColor: { value: new THREE.Color(accentHex) },
                uAspect: { value: aspect },
              },
              vertexShader: `
                varying vec2 vUv;
                void main() {
                  vUv = uv;
                  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
              `,
              fragmentShader: `
                uniform vec3 uAccentColor;
                uniform float uAspect;
                varying vec2 vUv;
                void main() {
                  vec2 p = (vUv - 0.5) * 2.0;
                  p.x *= uAspect;
                  float halfLine = max(uAspect - 1.0, 0.0);
                  vec2 q = vec2(max(abs(p.x) - halfLine, 0.0), abs(p.y));
                  float dist = length(q);
                  if (dist > 1.0) discard;

                  // Smooth cosine feather from center (alpha 0.36) to 0.0 at edge — zero hard box border
                  float falloff = clamp(1.0 - dist, 0.0, 1.0);
                  float softHalo = falloff * falloff * (3.0 - 2.0 * falloff);
                  vec3 col = mix(vec3(0.05, 0.07, 0.11), uAccentColor * 0.35, 0.25);
                  gl_FragColor = vec4(col, softHalo * 0.36);
                }
              `,
            });

          const goldTextMat = makeBeveledTextMaterial(0xfffbeb, 0xb45309);
          const whiteTextMat = makeBeveledTextMaterial(0xffffff, 0x9a4a06);
          const haTextMat = makeBeveledTextMaterial(0xf8fdff, 0x0369a1);

          // Luxury Frosted Cosmetic Glass Shader (Soft cloudy translucent glass body + thick rim curvature + crisp studio softbox reflections)
          const makeCrystalBottleGlassMaterial = (
            rimStrength: number,
            specStrength: number,
            frostedBaseOpacity: number = 0.24,
            frostedEdgeOpacity: number = 0.65
          ) =>
            new THREE.ShaderMaterial({
              transparent: true,
              depthWrite: false,
              blending: THREE.NormalBlending,
              side: THREE.FrontSide,
              uniforms: {
                uRimStrength: { value: rimStrength },
                uSpecStrength: { value: specStrength },
                uFrostedBase: { value: frostedBaseOpacity },
                uFrostedEdge: { value: frostedEdgeOpacity },
              },
              vertexShader: `
                varying vec3 vNormalV;
                varying vec3 vViewDirV;
                void main() {
                  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                  vNormalV = normalize(normalMatrix * normal);
                  vViewDirV = normalize(-mvPos.xyz);
                  gl_Position = projectionMatrix * mvPos;
                }
              `,
              fragmentShader: `
                uniform float uRimStrength;
                uniform float uSpecStrength;
                uniform float uFrostedBase;
                uniform float uFrostedEdge;
                varying vec3 vNormalV;
                varying vec3 vViewDirV;
                void main() {
                  vec3 N = normalize(vNormalV);
                  vec3 V = normalize(vViewDirV);
                  float ndotv = clamp(abs(dot(N, V)), 0.0, 1.0);
                  float fresnel = 1.0 - ndotv;

                  // 1. Frosted Glass Body Density (naturally translucent frosted glass)
                  float thickness = pow(fresnel, 1.4);
                  float frostedOpacity = mix(uFrostedBase, uFrostedEdge, thickness);

                  // 2. Thick Glass Wall Rim & Shoulder Glaze
                  float rimBand = smoothstep(0.48, 0.95, fresnel) * pow(fresnel, 2.2);
                  float rimEdge = smoothstep(0.78, 0.995, fresnel);

                  // 3. Crisp vertical studio softbox light reflections (glossy glass surface)
                  vec3 light1 = normalize(vec3(-0.56, 0.42, 0.71));
                  vec3 light2 = normalize(vec3(0.62, 0.28, 0.73));
                  vec3 light3 = normalize(vec3(0.0, 0.86, 0.51));
                  float spec1 = pow(max(dot(N, normalize(light1 + V)), 0.0), 96.0) * 0.95;
                  float spec1Soft = pow(max(dot(N, normalize(light1 + V)), 0.0), 22.0) * 0.24;
                  float spec2 = pow(max(dot(N, normalize(light2 + V)), 0.0), 72.0) * 0.55;
                  float spec3 = pow(max(dot(N, normalize(light3 + V)), 0.0), 54.0) * 0.45;
                  float specTotal = (spec1 + spec1Soft + spec2 + spec3) * uSpecStrength;

                  // 4. Luxury White Flint Frosted Glass Tint with subtle warm champagne highlight
                  vec3 glassBase = vec3(0.95, 0.965, 0.985);
                  vec3 glassRim = vec3(1.0, 0.98, 0.95);
                  float diffuse = max(dot(N, light1), 0.0) * 0.12 + 0.88;
                  vec3 col = mix(glassBase, glassRim, smoothstep(0.40, 0.92, fresnel)) * diffuse;
                  col += vec3(1.0, 1.0, 1.0) * (specTotal + rimEdge * 0.35 * uRimStrength);

                  // 5. Final Opacity: cloudy frosted veil in center + denser glass at edges + bright specular glints
                  float alpha = clamp(frostedOpacity + (rimBand * 0.28 + rimEdge * 0.32) * uRimStrength + specTotal * 0.75, 0.0, 0.92);
                  gl_FragColor = vec4(clamp(col, 0.0, 1.0), alpha);
                }
              `,
            });

          const bottleGlassMat = makeCrystalBottleGlassMaterial(1.15, 1.10, 0.24, 0.65);
          const pipetteGlassMat = makeCrystalBottleGlassMaterial(1.25, 1.0, 0.08, 0.35);

          // Warm Nude-Blush Peach-Pink Serum Shader with Pearlescent Diamond Micro-Shimmer
          const serumLiquidMat = new THREE.ShaderMaterial({
            transparent: false,
            depthWrite: true,
            toneMapped: false,
            side: THREE.FrontSide,
            uniforms: {
              uTime: { value: 0 },
            },
            vertexShader: `
              varying vec3 vNormalV;
              varying vec3 vViewDirV;
              varying vec3 vLocalPos;
              void main() {
                vLocalPos = position;
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                vNormalV = normalize(normalMatrix * normal);
                vViewDirV = normalize(-mvPos.xyz);
                gl_Position = projectionMatrix * mvPos;
              }
            `,
            fragmentShader: `
              uniform float uTime;
              varying vec3 vNormalV;
              varying vec3 vViewDirV;
              varying vec3 vLocalPos;
              void main() {
                vec3 N = normalize(vNormalV);
                vec3 V = normalize(vViewDirV);
                float ndotv = clamp(dot(N, V), 0.0, 1.0);
                float fresnel = 1.0 - ndotv;

                // Exact warm blush-peach palette sampled from reference swatch
                vec3 edgeBlushShadow = vec3(0.845, 0.675, 0.650); // #d7aca6 warm dusty blush edge
                vec3 midBlushBody    = vec3(0.898, 0.755, 0.732); // #e5c0bb soft warm rose-nude
                vec3 centerBlushGlow = vec3(0.945, 0.828, 0.808); // #f1d3ce creamy peach-blush center
                vec3 highlightBlush  = vec3(0.988, 0.898, 0.880); // #fce5e0 luminous blush highlight
                vec3 meniscusBlush   = vec3(0.865, 0.705, 0.680); // #dcb4ad top meniscus surface

                // Horizontal lighting gradient across cylinder + Fresnel contour matching swatch
                float horizGrad = clamp(0.5 + 0.5 * N.x, 0.0, 1.0);
                vec3 baseCol = mix(midBlushBody, centerBlushGlow, smoothstep(0.15, 0.75, horizGrad));
                baseCol = mix(baseCol, highlightBlush, smoothstep(0.65, 1.0, horizGrad) * 0.55);

                // Smooth cylinder edge contour (#ddb4ae / #d7aca6)
                vec3 col = mix(baseCol, edgeBlushShadow, smoothstep(0.38, 0.95, fresnel));

                // Subtle top meniscus shading where normal points upward
                float topMeniscus = smoothstep(0.45, 0.90, N.y);
                col = mix(col, meniscusBlush, topMeniscus * 0.65);

                // Soft glossy studio highlight on upper-left curve
                vec3 keyLight = normalize(vec3(-0.35, 0.52, 0.78));
                float spec = pow(max(dot(N, normalize(keyLight + V)), 0.0), 52.0) * 0.42;
                col += vec3(1.0, 0.97, 0.96) * spec;

                // Subtle pearlescent rose-diamond micro-shimmer inside the serum essence
                vec3 pGrid = vLocalPos * 145.0;
                float sparkleCell = sin(pGrid.x + sin(pGrid.y * 1.3 + uTime * 1.8)) *
                                    sin(pGrid.y * 1.1 + cos(pGrid.z * 1.4 - uTime * 1.5)) *
                                    sin(pGrid.z * 1.2 + sin(pGrid.x * 0.9 + uTime * 2.1));
                float microGlint = pow(max(0.0, sparkleCell), 14.0) * smoothstep(0.15, 0.85, ndotv);
                col += vec3(1.0, 0.96, 0.90) * microGlint * 0.55;

                gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
              }
            `,
          });

          // Load stone_texture_v5.png for Rock_Pedestal and texture_flow_v2.png for Flower Petals
          const configureSharpTexture = (tex: THREE.Texture, repeat: boolean) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.flipY = false;
            tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
            tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
            tex.generateMipmaps = true;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.anisotropy = 16;
          };

          const texLoader = new THREE.TextureLoader();
          const stoneTexture = texLoader.load('/assets/textures/stone_texture_v6.png');
          configureSharpTexture(stoneTexture, true);

          const flowerTexture = texLoader.load('/assets/textures/texture_flow_v2.png');
          configureSharpTexture(flowerTexture, true);

          const leafTexture = texLoader.load('/assets/textures/texture_leaf.jpg');
          configureSharpTexture(leafTexture, false);

          source.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              const mesh = child as THREE.Mesh;
              mesh.castShadow = false;
              mesh.receiveShadow = false;
              mesh.frustumCulled = false;

              const lowerName = mesh.name.toLowerCase();
              const matName = ((mesh.material as THREE.Material)?.name || '').toLowerCase();
              const isIngredientObj =
                lowerName.startsWith('b5_') ||
                lowerName.startsWith('ha_') ||
                lowerName.startsWith('vc_') ||
                matName.startsWith('mat_b5_') ||
                matName.startsWith('mat_ha_') ||
                matName.startsWith('mat_vc_') ||
                matName === 'mat_gold_label';

              if (isIngredientObj) {
                if (lowerName.startsWith('b5_glasssphere') || matName === 'mat_b5_outerglass') {
                  mesh.material = b5OuterMat;
                  mesh.renderOrder = 6;
                } else if (lowerName.startsWith('ha_glasssphere') || matName === 'mat_ha_outerglass') {
                  mesh.material = haOuterMat;
                  mesh.renderOrder = 6;
                } else if (lowerName.startsWith('vc_glasssphere') || matName === 'mat_vc_outerglass') {
                  mesh.material = vcOuterMat;
                  mesh.renderOrder = 6;
                } else if (lowerName.startsWith('b5_innercore') || matName === 'mat_b5_innercore') {
                  mesh.material = b5CoreMat;
                  mesh.renderOrder = 2;
                } else if (lowerName.startsWith('ha_waterdroplet') || matName === 'mat_ha_waterdroplet') {
                  mesh.material = haDropletMat;
                  mesh.renderOrder = 2;
                } else if (lowerName.startsWith('b5_molecularbubbles') || matName === 'mat_b5_bubble') {
                  mesh.material = b5BubbleMat;
                  mesh.renderOrder = 4;
                } else if (lowerName.startsWith('ha_molecularbubbles') || matName === 'mat_ha_bubble') {
                  mesh.material = haBubbleMat;
                  mesh.renderOrder = 4;
                } else if (lowerName.startsWith('vc_molecularbubbles') || matName === 'mat_vc_bubble') {
                  mesh.material = vcBubbleMat;
                  mesh.renderOrder = 4;
                } else if (matName === 'mat_vc_orangepulp') {
                  mesh.material = vcPulpMat;
                  mesh.renderOrder = 2;
                } else if (matName === 'mat_vc_orangepeel') {
                  mesh.material = vcPeelMat;
                  mesh.renderOrder = 2;
                } else if (matName === 'mat_vc_orangepith') {
                  mesh.material = vcPithMat;
                  mesh.renderOrder = 2;
                } else if (lowerName.startsWith('vc_leaves') || matName === 'mat_vc_leaf') {
                  const vcLeafTexMat = new THREE.MeshStandardMaterial({
                    map: leafTexture,
                    color: new THREE.Color(0xffffff),
                    emissive: new THREE.Color(0x3a7d28),
                    emissiveIntensity: 0.42,
                    roughness: 0.38,
                    metalness: 0.0,
                    side: THREE.DoubleSide,
                  });
                  mesh.material = vcLeafTexMat;
                  mesh.renderOrder = 2;
                } else if (lowerName.startsWith('b5_centertext') || matName === 'mat_b5_centertext') {
                  mesh.material = whiteTextMat;
                  mesh.renderOrder = 5;
                } else if (lowerName.startsWith('b5_label') || lowerName.startsWith('vc_label') || matName === 'mat_gold_label') {
                  mesh.material = goldTextMat;
                  mesh.renderOrder = 5;
                  if (!mesh.userData.hasPillPlaque) {
                    mesh.userData.hasPillPlaque = true;
                    mesh.geometry.computeBoundingBox();
                    const bb = mesh.geometry.boundingBox;
                    if (bb) {
                      const w = (bb.max.x - bb.min.x) + 0.075;
                      const h = (bb.max.z - bb.min.z) + 0.042;
                      const cx = (bb.min.x + bb.max.x) * 0.5;
                      const cy = bb.min.y - 0.003;
                      const cz = (bb.min.z + bb.max.z) * 0.5;
                      const borderCol = lowerName.startsWith('vc_') ? 0xfb923c : 0xf5b942;
                      const pillMesh = new THREE.Mesh(
                        new THREE.PlaneGeometry(w, h),
                        makeLabelPillMaterial(borderCol, borderCol, w / Math.max(h, 0.001))
                      );
                      pillMesh.rotation.x = -Math.PI / 2;
                      pillMesh.position.set(cx, cy, cz);
                      pillMesh.renderOrder = 4;
                      mesh.add(pillMesh);
                    }
                  }
                } else if (lowerName.startsWith('ha_label') || matName === 'mat_ha_label') {
                  mesh.material = haTextMat;
                  mesh.renderOrder = 5;
                  if (!mesh.userData.hasPillPlaque) {
                    mesh.userData.hasPillPlaque = true;
                    mesh.geometry.computeBoundingBox();
                    const bb = mesh.geometry.boundingBox;
                    if (bb) {
                      const w = (bb.max.x - bb.min.x) + 0.075;
                      const h = (bb.max.z - bb.min.z) + 0.042;
                      const cx = (bb.min.x + bb.max.x) * 0.5;
                      const cy = bb.min.y - 0.003;
                      const cz = (bb.min.z + bb.max.z) * 0.5;
                      const pillMesh = new THREE.Mesh(
                        new THREE.PlaneGeometry(w, h),
                        makeLabelPillMaterial(0x38bdf8, 0x0ea5e9, w / Math.max(h, 0.001))
                      );
                      pillMesh.rotation.x = -Math.PI / 2;
                      pillMesh.position.set(cx, cy, cz);
                      pillMesh.renderOrder = 4;
                      mesh.add(pillMesh);
                    }
                  }
                } else {
                  mesh.renderOrder = 2;
                }
                return;
              }

              if (lowerName.includes('water') || lowerName.includes('splash') || lowerName.includes('liquid')) {
                mesh.material = waterMaterial.clone();
              } else if (lowerName.includes('droplet')) {
                mesh.material = waterMaterial;
              } else if (lowerName.includes('rock_pedestal') || matName === 'm_stone_natural') {
                const stoneMat = (mesh.material as THREE.MeshStandardMaterial).clone();
                stoneMat.map = stoneTexture;
                stoneMat.color.setHex(0xffffff);
                stoneMat.roughness = 0.42;
                stoneMat.metalness = 0.05;
                stoneMat.normalMap = null;
                stoneMat.roughnessMap = null;
                stoneMat.metalnessMap = null;
                stoneMat.needsUpdate = true;
                mesh.material = stoneMat;
              } else if (
                (lowerName.startsWith('flower_') && !lowerName.includes('stamen') && !lowerName.includes('leaf')) ||
                matName === 'm_flower_petal'
              ) {
                const petalMat = (mesh.material as THREE.MeshStandardMaterial).clone();
                petalMat.map = flowerTexture;
                petalMat.color.setHex(0xffffff);
                petalMat.roughness = 0.34;
                petalMat.metalness = 0.0;
                petalMat.normalMap = null;
                petalMat.roughnessMap = null;
                petalMat.metalnessMap = null;
                petalMat.side = THREE.DoubleSide;
                petalMat.needsUpdate = true;
                mesh.material = petalMat;
              } else if (lowerName.startsWith('leaf_') || matName === 'm_leaf_botanical') {
                const leafMat = (mesh.material as THREE.MeshStandardMaterial).clone();
                leafMat.map = leafTexture;
                leafMat.color.setHex(0xffffff);
                leafMat.roughness = 0.46;
                leafMat.metalness = 0.0;
                leafMat.normalMap = null;
                leafMat.roughnessMap = null;
                leafMat.metalnessMap = null;
                leafMat.side = THREE.DoubleSide;
                leafMat.needsUpdate = true;
                mesh.material = leafMat;
              } else if (lowerName === 'object_18.001' || matName === 'sv.001') {
                mesh.material = serumLiquidMat;
                mesh.renderOrder = 1;
                mesh.onBeforeRender = () => {
                  serumLiquidMat.uniforms.uTime.value = performance.now() * 0.001;
                };
              } else if (
                lowerName === 'object_20' ||
                lowerName === 'object_22.001' ||
                matName === 'material.005' ||
                matName === 'material.006'
              ) {
                const capMat = (mesh.material as THREE.MeshStandardMaterial).clone();
                capMat.color.setHex(0xf5ded5); // Luminous champagne rose-gold
                capMat.metalness = 0.84;
                capMat.roughness = 0.18;
                capMat.emissive.setHex(0x36221d);
                capMat.emissiveIntensity = 0.22;
                capMat.needsUpdate = true;
                mesh.material = capMat;
              } else if (lowerName === 'object_24' || matName === 'pipette_glass') {
                mesh.material = pipetteGlassMat;
                mesh.renderOrder = 2;
                return;
              } else if (lowerName === 'object_16.001' || matName === 'glass.002') {
                mesh.material = bottleGlassMat;
                mesh.renderOrder = 3;
                return;
              } else if (lowerName.includes('bottle_label_decal') || matName.includes('serum_label')) {
                const labelMat = mesh.material as THREE.MeshStandardMaterial;
                if (labelMat) {
                  labelMat.transparent = true;
                  labelMat.depthWrite = false;
                  if (labelMat.map) {
                    labelMat.map.anisotropy = 16;
                    labelMat.map.minFilter = THREE.LinearMipmapLinearFilter;
                    labelMat.map.magFilter = THREE.LinearFilter;
                    labelMat.map.needsUpdate = true;
                  }
                }
                mesh.renderOrder = 4;
                return;
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
              actions.push(action);
            } else {
              for (const anim of gltf.animations) {
                const action = mixer.clipAction(anim);
                action.setLoop(THREE.LoopOnce, 1);
                action.clampWhenFinished = true;
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
            if (
              lowerName.startsWith('pin_') ||
              lowerName.startsWith('line_') ||
              lowerName.startsWith('callout_') ||
              lowerName.startsWith('b5_') ||
              lowerName.startsWith('ha_') ||
              lowerName.startsWith('vc_')
            ) {
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
          const targetSize = 0.725; // Scaled up 1.25x (from 0.58) for hero presentation
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

          // 4. Bottle Group for 360 interactive rotation & Luxury "Bling Bling" Diamond Starburst Sparkles
          const serumGroup = source.getObjectByName('Serum_Group');
          const rawBottle = source.getObjectByName('Sketchfab_model');
          const bottleGroup: THREE.Object3D = serumGroup || rawBottle || source;

          interface SparkleDef {
            pos: [number, number, number];
            phase: number;
            speed: number;
            size: number;
            drift: number;
            color: [number, number, number];
          }

          const buildBlingSparkleMesh = (name: string, sparkles: SparkleDef[]): THREE.Mesh => {
            const count = sparkles.length;
            const anchors = new Float32Array(count * 4 * 3);
            const corners = new Float32Array(count * 4 * 2);
            const params = new Float32Array(count * 4 * 4);
            const colors = new Float32Array(count * 4 * 3);
            const indices: number[] = [];

            const quadCorners: [number, number][] = [
              [-1, -1],
              [1, -1],
              [1, 1],
              [-1, 1],
            ];

            for (let i = 0; i < count; i++) {
              const s = sparkles[i];
              for (let c = 0; c < 4; c++) {
                const vIdx = i * 4 + c;
                anchors[vIdx * 3] = s.pos[0];
                anchors[vIdx * 3 + 1] = s.pos[1];
                anchors[vIdx * 3 + 2] = s.pos[2];

                corners[vIdx * 2] = quadCorners[c][0];
                corners[vIdx * 2 + 1] = quadCorners[c][1];

                params[vIdx * 4] = s.phase;
                params[vIdx * 4 + 1] = s.speed;
                params[vIdx * 4 + 2] = s.size;
                params[vIdx * 4 + 3] = s.drift;

                colors[vIdx * 3] = s.color[0];
                colors[vIdx * 3 + 1] = s.color[1];
                colors[vIdx * 3 + 2] = s.color[2];
              }
              const base = i * 4;
              indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            }

            const geo = new THREE.BufferGeometry();
            // Provide standard 'position' attribute so Three.js bounding-box/raycast checks remain valid
            geo.setAttribute('position', new THREE.BufferAttribute(anchors, 3));
            geo.setAttribute('aAnchor', new THREE.BufferAttribute(anchors, 3));
            geo.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
            geo.setAttribute('aParams', new THREE.BufferAttribute(params, 4));
            geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
            geo.setIndex(indices);

            const mat = new THREE.ShaderMaterial({
              transparent: true,
              depthWrite: false,
              depthTest: true,
              toneMapped: false,
              blending: THREE.NormalBlending,
              side: THREE.DoubleSide,
              uniforms: {
                uTime: { value: 0 },
              },
              vertexShader: `
                uniform float uTime;
                attribute vec3 aAnchor;
                attribute vec2 aCorner;
                attribute vec4 aParams;
                attribute vec3 aColor;
                varying vec2 vUv;
                varying vec3 vColor;
                varying float vTwinkle;
                void main() {
                  float phase = aParams.x;
                  float speed = aParams.y;
                  float baseSize = aParams.z;
                  float drift = aParams.w;

                  // Sharp rhythmic diamond twinkle with sparkling secondary harmonic
                  float w1 = 0.5 + 0.5 * sin(uTime * speed + phase);
                  float w2 = 0.5 + 0.5 * sin(uTime * (speed * 1.85) - phase * 1.3);
                  float flash = pow(w1, 2.4) * (0.65 + 0.35 * w2);
                  vTwinkle = flash;
                  vColor = aColor;

                  vec3 localPos = aAnchor;
                  localPos.y += drift * sin(uTime * 1.45 + phase) * 0.048;
                  localPos.x += drift * cos(uTime * 1.15 + phase * 1.7) * 0.024;
                  localPos.z += drift * sin(uTime * 1.25 + phase * 2.1) * 0.024;

                  vec4 mvPos = modelViewMatrix * vec4(localPos, 1.0);
                  float worldScale = length(modelViewMatrix[0].xyz);

                  // Rotate 4-point star spikes gently as each diamond glint flashes
                  float angle = uTime * 0.45 + phase * 0.35;
                  float ca = cos(angle);
                  float sa = sin(angle);
                  vec2 rotCorner = vec2(
                    aCorner.x * ca - aCorner.y * sa,
                    aCorner.x * sa + aCorner.y * ca
                  );

                  float scale = baseSize * worldScale * (0.20 + 1.05 * flash);
                  mvPos.xy += rotCorner * scale;
                  // Slight Z pull toward camera so surface glints never z-fight with the glass/cap
                  mvPos.z += 0.012 * worldScale;

                  vUv = aCorner;
                  gl_Position = projectionMatrix * mvPos;
                }
              `,
              fragmentShader: `
                varying vec2 vUv;
                varying vec3 vColor;
                varying float vTwinkle;
                void main() {
                  vec2 p = vUv;
                  float r = length(p);
                  if (r > 1.0) discard;

                  // Primary 4-point needle-sharp diamond cross rays
                  float rayX = exp(-abs(p.y) * 20.0) * exp(-abs(p.x) * 2.3);
                  float rayY = exp(-abs(p.x) * 20.0) * exp(-abs(p.y) * 2.3);

                  // Secondary 45-degree diagonal star rays
                  vec2 d = vec2(p.x + p.y, p.x - p.y) * 0.70710678;
                  float rayDiag1 = exp(-abs(d.y) * 28.0) * exp(-abs(d.x) * 3.8) * 0.68;
                  float rayDiag2 = exp(-abs(d.x) * 28.0) * exp(-abs(d.y) * 3.8) * 0.68;

                  // Intense diamond pinpoint heart + warm luxury corona
                  float core = exp(-r * r * 36.0) * 1.45;
                  float halo = exp(-r * 4.0) * 0.48 * (1.0 - smoothstep(0.60, 1.0, r));

                  float star = core + (rayX + rayY) * 1.25 + (rayDiag1 + rayDiag2) + halo;
                  float alpha = clamp(star * (0.15 + 0.95 * vTwinkle), 0.0, 1.0) * (1.0 - smoothstep(0.82, 1.0, r));
                  if (alpha < 0.01) discard;

                  vec3 col = mix(vColor, vec3(1.0, 1.0, 1.0), clamp(core + (rayX + rayY) * 0.70, 0.0, 1.0));
                  gl_FragColor = vec4(col, alpha);
                }
              `,
            });

            const mesh = new THREE.Mesh(geo, mat);
            mesh.name = name;
            mesh.frustumCulled = false;
            mesh.renderOrder = 12;
            mesh.onBeforeRender = () => {
              mat.uniforms.uTime.value = performance.now() * 0.001;
            };
            return mesh;
          };

          const cDiamond: [number, number, number] = [1.0, 0.99, 0.96];
          const cChampagne: [number, number, number] = [1.0, 0.89, 0.62];
          const cRoseGold: [number, number, number] = [1.0, 0.82, 0.86];
          const cAquaIce: [number, number, number] = [0.75, 0.96, 1.0];

          const bottleSparkles: SparkleDef[] = [
            // 1. Rose-Gold Metallic Cap & Dropper Rim Glints (pinned to cap & collar highlights)
            { pos: [-0.115, 1.135, 0.115], phase: 0.2, speed: 3.1, size: 0.105, drift: 0.0, color: cChampagne },
            { pos: [0.125, 1.085, 0.118], phase: 1.8, speed: 2.7, size: 0.095, drift: 0.0, color: cDiamond },
            { pos: [-0.085, 0.965, 0.138], phase: 3.4, speed: 3.4, size: 0.092, drift: 0.0, color: cRoseGold },
            { pos: [0.118, 0.975, -0.115], phase: 4.7, speed: 2.9, size: 0.092, drift: 0.0, color: cChampagne },
            { pos: [-0.122, 1.095, -0.112], phase: 2.5, speed: 3.2, size: 0.095, drift: 0.0, color: cDiamond },
            { pos: [0.055, 1.285, 0.078], phase: 0.9, speed: 2.6, size: 0.078, drift: 0.0, color: cDiamond },

            // 2. Crystal Glass Bottle Shoulder, Body & Base Rim Starburst Glints
            { pos: [-0.215, 0.845, 0.155], phase: 0.6, speed: 2.8, size: 0.118, drift: 0.0, color: cDiamond },
            { pos: [0.228, 0.825, 0.152], phase: 2.3, speed: 3.3, size: 0.112, drift: 0.0, color: cChampagne },
            { pos: [-0.238, 0.560, 0.135], phase: 4.1, speed: 2.5, size: 0.098, drift: 0.0, color: cRoseGold },
            { pos: [0.245, 0.440, 0.138], phase: 1.4, speed: 3.0, size: 0.102, drift: 0.0, color: cDiamond },
            { pos: [-0.218, 0.125, 0.165], phase: 3.0, speed: 2.9, size: 0.105, drift: 0.0, color: cChampagne },
            { pos: [0.225, 0.095, 0.162], phase: 5.2, speed: 3.5, size: 0.100, drift: 0.0, color: cDiamond },
            { pos: [0.215, 0.835, -0.155], phase: 1.1, speed: 2.7, size: 0.108, drift: 0.0, color: cDiamond },
            { pos: [-0.225, 0.480, -0.152], phase: 3.8, speed: 3.1, size: 0.098, drift: 0.0, color: cChampagne },

            // 3. Floating Luxury Shimmer Aura Sparkles around the Serum Bottle
            { pos: [-0.305, 0.920, 0.120], phase: 0.4, speed: 2.4, size: 0.082, drift: 1.0, color: cChampagne },
            { pos: [0.315, 0.890, 0.110], phase: 1.9, speed: 2.8, size: 0.085, drift: 1.0, color: cDiamond },
            { pos: [-0.325, 0.680, 0.165], phase: 3.5, speed: 2.6, size: 0.076, drift: 1.2, color: cRoseGold },
            { pos: [0.330, 0.620, 0.170], phase: 5.0, speed: 3.1, size: 0.080, drift: 1.1, color: cChampagne },
            { pos: [-0.295, 0.340, 0.195], phase: 1.2, speed: 2.9, size: 0.075, drift: 1.2, color: cDiamond },
            { pos: [0.308, 0.280, 0.190], phase: 2.8, speed: 2.5, size: 0.078, drift: 1.0, color: cRoseGold },
            { pos: [-0.165, 0.720, 0.258], phase: 4.4, speed: 3.3, size: 0.072, drift: 0.8, color: cDiamond },
            { pos: [0.185, 0.520, 0.262], phase: 0.8, speed: 2.7, size: 0.074, drift: 0.8, color: cChampagne },
            { pos: [-0.155, 0.240, 0.255], phase: 2.1, speed: 3.0, size: 0.070, drift: 0.9, color: cDiamond },
            { pos: [0.165, 1.180, 0.145], phase: 3.9, speed: 2.6, size: 0.076, drift: 1.0, color: cChampagne },
            { pos: [-0.175, 1.210, 0.135], phase: 5.5, speed: 3.2, size: 0.074, drift: 1.0, color: cRoseGold },
            { pos: [0.015, 1.415, 0.095], phase: 1.6, speed: 2.8, size: 0.084, drift: 0.6, color: cDiamond },
          ];

          bottleGroup.add(buildBlingSparkleMesh('Bottle_Bling_Sparkles', bottleSparkles));

          // Attach delicate twinkling star glints to each of the 3 floating molecules
          const b5Ctrl = source.getObjectByName('B5_Controller');
          if (b5Ctrl) {
            b5Ctrl.add(
              buildBlingSparkleMesh('B5_Bling_Sparkles', [
                { pos: [-0.125, 0.120, 0.115], phase: 0.3, speed: 3.0, size: 0.085, drift: 0.3, color: cChampagne },
                { pos: [0.135, -0.095, 0.118], phase: 2.4, speed: 2.7, size: 0.072, drift: 0.4, color: cDiamond },
                { pos: [0.110, 0.128, 0.110], phase: 4.2, speed: 3.3, size: 0.068, drift: 0.3, color: cChampagne },
              ])
            );
          }
          const haCtrl = source.getObjectByName('HA_Controller');
          if (haCtrl) {
            haCtrl.add(
              buildBlingSparkleMesh('HA_Bling_Sparkles', [
                { pos: [-0.120, 0.122, 0.115], phase: 1.1, speed: 2.9, size: 0.085, drift: 0.3, color: cAquaIce },
                { pos: [0.132, -0.100, 0.118], phase: 3.2, speed: 3.2, size: 0.072, drift: 0.4, color: cDiamond },
                { pos: [0.112, 0.125, 0.110], phase: 5.0, speed: 2.6, size: 0.068, drift: 0.3, color: cAquaIce },
              ])
            );
          }
          const vcCtrl = source.getObjectByName('VC_Controller');
          if (vcCtrl) {
            vcCtrl.add(
              buildBlingSparkleMesh('VC_Bling_Sparkles', [
                { pos: [-0.122, 0.120, 0.115], phase: 0.7, speed: 3.1, size: 0.085, drift: 0.3, color: cChampagne },
                { pos: [0.134, -0.098, 0.118], phase: 2.8, speed: 2.8, size: 0.072, drift: 0.4, color: cDiamond },
                { pos: [0.110, 0.126, 0.110], phase: 4.6, speed: 3.4, size: 0.068, drift: 0.3, color: cChampagne },
              ])
            );
          }

          // Add invisible hit proxy spheres to each active molecule controller for seamless tap/click detection
          const hitProxyGeo = new THREE.SphereGeometry(0.28, 16, 16);
          const hitProxyMat = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 0,
            depthWrite: false,
          });

          const attachHitTarget = (ctrl: THREE.Object3D | null | undefined, ingId: string, meshName: string) => {
            if (!ctrl) return;
            ctrl.userData.ingredientId = ingId;
            ctrl.traverse((child) => {
              child.userData.ingredientId = ingId;
            });
            const hitMesh = new THREE.Mesh(hitProxyGeo, hitProxyMat);
            hitMesh.name = meshName;
            hitMesh.position.set(0, -0.06, 0);
            hitMesh.userData.ingredientId = ingId;
            ctrl.add(hitMesh);
          };

          attachHitTarget(b5Ctrl, 'b5', 'B5_HitTarget');
          attachHitTarget(haCtrl, 'ha', 'HA_HitTarget');
          attachHitTarget(vcCtrl, 'c', 'VC_HitTarget');

          const anchors: Record<string, THREE.Object3D> = {};
          const elbows: Record<string, THREE.Object3D> = {};
          const calloutLines: Record<string, Line2> = {};

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

let preloadedModelPromise: Promise<LoadedSerumModel> | null = null;

export function preloadSerumModel(): Promise<LoadedSerumModel> {
  if (!preloadedModelPromise) {
    preloadedModelPromise = new SerumModelLoader().load().catch((error) => {
      preloadedModelPromise = null;
      throw error;
    });
  }
  return preloadedModelPromise;
}

export async function takePreloadedSerumModel(): Promise<LoadedSerumModel> {
  const model = await preloadSerumModel();
  preloadedModelPromise = null;
  return model;
}
