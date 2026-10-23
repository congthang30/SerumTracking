import * as THREE from 'three';

/**
 * Creates a soft, feathered circular alpha texture for dewdrop and mist particles.
 */
function createDewdropTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  grad.addColorStop(0.35, 'rgba(125, 211, 252, 0.85)'); // Aqua water blue
  grad.addColorStop(0.70, 'rgba(56, 189, 248, 0.40)');
  grad.addColorStop(1, 'rgba(14, 165, 233, 0)');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

/**
 * Creates a 3D spiral curve wrapping from bottom to top around the product.
 */
function createSpiralSpline(
  startY: number,
  endY: number,
  baseR: number,
  peakR: number,
  turns: number,
  startAngle: number
): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = [];
  const count = 20;
  for (let i = 0; i <= count; i++) {
    const p = i / count;
    const y = startY + (endY - startY) * p;
    const angle = startAngle + p * turns * Math.PI * 2;
    // Radius swells gracefully in the middle for a dramatic liquid swoop
    const r = baseR + (peakR - baseR) * Math.sin(p * Math.PI);
    pts.push(new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r));
  }
  return new THREE.CatmullRomCurve3(pts);
}

/**
 * Generates a parametric 3D Fluid Ribbon Veil geometry with lens-shaped cross section.
 */
function createFluidRibbonGeometry(
  curve: THREE.CatmullRomCurve3,
  numSegments = 64,
  numRadial = 14,
  maxWidth = 0.28,
  maxThick = 0.032
): { geometry: THREE.BufferGeometry; basePositions: Float32Array; numSegments: number; numRadial: number } {
  const points = curve.getPoints(numSegments);
  const frenet = curve.computeFrenetFrames(numSegments, false);

  const vertices: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= numSegments; i++) {
    const u = i / numSegments;
    const pt = points[i];
    const N = frenet.normals[i];
    const B = frenet.binormals[i];

    // Envelope: 0 at tips, swells into broad fluid sheet in body
    const envelope = Math.sin(u * Math.PI);
    const width = maxWidth * Math.pow(envelope, 0.72);
    const thick = maxThick * envelope;

    for (let j = 0; j <= numRadial; j++) {
      const v = j / numRadial;
      const angle = v * Math.PI * 2;

      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      // Width along Binormal B, thickness along Normal N
      const offsetX = B.x * (cosA * width * 0.5) + N.x * (sinA * thick * 0.5);
      const offsetY = B.y * (cosA * width * 0.5) + N.y * (sinA * thick * 0.5);
      const offsetZ = B.z * (cosA * width * 0.5) + N.z * (sinA * thick * 0.5);

      vertices.push(pt.x + offsetX, pt.y + offsetY, pt.z + offsetZ);

      // Surface normal vector
      const normX = B.x * cosA + N.x * (sinA * (width / (thick || 0.001)));
      const normY = B.y * cosA + N.y * (sinA * (width / (thick || 0.001)));
      const normZ = B.z * cosA + N.z * (sinA * (width / (thick || 0.001)));
      const len = Math.hypot(normX, normY, normZ) || 1;
      normals.push(normX / len, normY / len, normZ / len);

      uvs.push(u * 4.0, v);
    }
  }

  for (let i = 0; i < numSegments; i++) {
    for (let j = 0; j < numRadial; j++) {
      const row1 = i * (numRadial + 1);
      const row2 = (i + 1) * (numRadial + 1);

      const a = row1 + j;
      const b = row2 + j;
      const c = row2 + j + 1;
      const d = row1 + j + 1;

      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  const basePositions = new Float32Array(vertices);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);

  return { geometry, basePositions, numSegments, numRadial };
}

/**
 * HydrationFX: Photorealistic Commercial-Grade Dual Water Splash Vortex
 *
 * Storyboard Vision (Frame 6):
 * As the serum bottle levitates, a surging spiral of crystalline aqua hydration essence
 * rises from the base and wraps around the product in a grand, cinematic double-helix splash.
 */
export class HydrationFX {
  public group: THREE.Group;

  // Normal Map
  private waterNormalTex: THREE.Texture;

  // 1. Primary Ascending Water Vortex Veil (Sweeps from base up to shoulder)
  private primaryRibbonMesh: THREE.Mesh;
  private primaryRibbonGeo: THREE.BufferGeometry;
  private primaryBasePos: Float32Array;
  private primarySegments: number;
  private primaryRadial: number;
  private primaryMat: THREE.MeshStandardMaterial;

  // 2. Secondary Counter-Splash Veil (Cross-swirl adding volume & fluid collision)
  private accentRibbonMesh: THREE.Mesh;
  private accentRibbonGeo: THREE.BufferGeometry;
  private accentBasePos: Float32Array;
  private accentSegments: number;
  private accentRadial: number;
  private accentMat: THREE.MeshStandardMaterial;

  // 3. Floating Dewdrop Gems (12 dynamic droplets splashing in the wake)
  private dropletGroup: THREE.Group;
  private droplets: { mesh: THREE.Mesh; orbitRadius: number; speed: number; phase: number; baseY: number; baseScale: number }[] = [];
  private dropletMat: THREE.MeshStandardMaterial;

  // 4. Micro-Mist Hydration Particles (30 fine mist dewdrops)
  private mistMesh: THREE.Points;
  private mistMat: THREE.PointsMaterial;
  private mistBasePositions: Float32Array;
  private mistVelocities: Float32Array;
  private dewdropTex: THREE.Texture;

  // Animation State
  private currentIntensity = 0; // 0..1
  private animTime = 0;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'LuxuryHydrationFXGroup';

    // --- 0. LOAD REAL WATER NORMAL MAP ---
    const texLoader = new THREE.TextureLoader();
    this.waterNormalTex = texLoader.load('assets/textures/water_normal.png');
    this.waterNormalTex.wrapS = THREE.RepeatWrapping;
    this.waterNormalTex.wrapT = THREE.RepeatWrapping;
    this.waterNormalTex.repeat.set(4.0, 1.5);

    // --- 1. BUILD PRIMARY ASCENDING SPIRAL SPLASH VEIL ---
    // Rises from below the bottle (Y = -0.10), spirals around at R = 0.42 to 0.58, reaching shoulder (Y = 1.30)
    const primarySpline = createSpiralSpline(-0.10, 1.30, 0.42, 0.58, 1.15, -0.3);
    const primaryData = createFluidRibbonGeometry(primarySpline, 64, 14, 0.28, 0.032);
    this.primaryRibbonGeo = primaryData.geometry;
    this.primaryBasePos = primaryData.basePositions;
    this.primarySegments = primaryData.numSegments;
    this.primaryRadial = primaryData.numRadial;

    this.primaryMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x38bdf8), // Refreshing crystal aqua water blue
      emissive: new THREE.Color(0x0284c7),
      emissiveIntensity: 0.18,
      roughness: 0.02,
      metalness: 0.03,
      transparent: true,
      opacity: 0,
      normalMap: this.waterNormalTex,
      normalScale: new THREE.Vector2(0.45, 0.45),
      envMapIntensity: 1.6,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.primaryRibbonMesh = new THREE.Mesh(this.primaryRibbonGeo, this.primaryMat);
    this.primaryRibbonMesh.name = 'Hydration_PrimaryVortexVeil';
    this.primaryRibbonMesh.visible = false; // Superseded by real 3D GLB water_splash_spiral_animated
    this.group.add(this.primaryRibbonMesh);

    // --- 2. BUILD SECONDARY COUNTER-SPLASH VEIL ---
    // Spirals in counter-rotation from opposite flank (Y = 0.05 to 1.15), R = 0.38 to 0.52
    const accentSpline = createSpiralSpline(0.05, 1.15, 0.38, 0.52, -1.0, Math.PI * 0.75);
    const accentData = createFluidRibbonGeometry(accentSpline, 48, 12, 0.20, 0.024);
    this.accentRibbonGeo = accentData.geometry;
    this.accentBasePos = accentData.basePositions;
    this.accentSegments = accentData.numSegments;
    this.accentRadial = accentData.numRadial;

    this.accentMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x7dd3fc), // Luminous azure crystal water blue
      emissive: new THREE.Color(0x0369a1),
      emissiveIntensity: 0.16,
      roughness: 0.02,
      metalness: 0.03,
      transparent: true,
      opacity: 0,
      normalMap: this.waterNormalTex,
      normalScale: new THREE.Vector2(0.40, 0.40),
      envMapIntensity: 1.5,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.accentRibbonMesh = new THREE.Mesh(this.accentRibbonGeo, this.accentMat);
    this.accentRibbonMesh.name = 'Hydration_SecondaryCounterVeil';
    this.accentRibbonMesh.visible = false; // Superseded by real 3D GLB water_splash_spiral_animated
    this.group.add(this.accentRibbonMesh);

    // --- 3. BUILD SPLASHING DEWDROP GEMS (12 droplets) ---
    this.dropletGroup = new THREE.Group();
    this.dropletGroup.name = 'Hydration_SplashDroplets';
    this.group.add(this.dropletGroup);

    this.dropletMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x67e8f9), // Aqua cyan dewdrop
      emissive: new THREE.Color(0x0891b2),
      emissiveIntensity: 0.22,
      roughness: 0.02,
      metalness: 0.04,
      transparent: true,
      opacity: 0,
      envMapIntensity: 1.8,
      depthWrite: false,
    });

    const dropBaseGeo = new THREE.SphereGeometry(1, 16, 14);
    const dropConfigs = [
      { r: 0.44, y: 0.15, phase: 0.0, speed: 0.50, s: 0.018 },
      { r: 0.52, y: 0.35, phase: 0.9, speed: 0.42, s: 0.022 },
      { r: 0.58, y: 0.55, phase: 1.8, speed: 0.48, s: 0.026 },
      { r: 0.54, y: 0.78, phase: 2.7, speed: 0.38, s: 0.020 },
      { r: 0.48, y: 1.02, phase: 3.6, speed: 0.44, s: 0.016 },
      { r: 0.40, y: 1.22, phase: 4.5, speed: 0.36, s: 0.014 },
      // Counter droplets
      { r: 0.42, y: 0.22, phase: 5.2, speed: -0.45, s: 0.017 },
      { r: 0.50, y: 0.48, phase: 3.1, speed: -0.40, s: 0.024 },
      { r: 0.55, y: 0.68, phase: 1.2, speed: -0.46, s: 0.022 },
      { r: 0.46, y: 0.92, phase: 4.0, speed: -0.38, s: 0.018 },
      { r: 0.38, y: 1.12, phase: 2.2, speed: -0.42, s: 0.015 },
      { r: 0.45, y: 0.40, phase: 0.5, speed: 0.35, s: 0.020 },
    ];

    for (const cfg of dropConfigs) {
      const mesh = new THREE.Mesh(dropBaseGeo, this.dropletMat);
      mesh.scale.set(cfg.s, cfg.s * 1.2, cfg.s);
      this.droplets.push({
        mesh,
        orbitRadius: cfg.r,
        speed: cfg.speed,
        phase: cfg.phase,
        baseY: cfg.y,
        baseScale: cfg.s,
      });
      this.dropletGroup.add(mesh);
    }

    // --- 4. BUILD MICRO-MIST HYDRATION PARTICLES (30 particles) ---
    this.dewdropTex = createDewdropTexture();
    const mistCount = 30;
    this.mistBasePositions = new Float32Array(mistCount * 3);
    this.mistVelocities = new Float32Array(mistCount);

    const mistPosArr = new Float32Array(mistCount * 3);
    for (let i = 0; i < mistCount; i++) {
      const angle = (i / mistCount) * Math.PI * 2 + (i % 4) * 0.3;
      const r = 0.35 + (i % 6) * 0.045;
      const y = -0.05 + (i / mistCount) * 1.35;

      mistPosArr[i * 3] = Math.cos(angle) * r;
      mistPosArr[i * 3 + 1] = y;
      mistPosArr[i * 3 + 2] = Math.sin(angle) * r;

      this.mistBasePositions[i * 3] = mistPosArr[i * 3];
      this.mistBasePositions[i * 3 + 1] = y;
      this.mistBasePositions[i * 3 + 2] = mistPosArr[i * 3 + 2];

      this.mistVelocities[i] = 0.05 + (i % 4) * 0.018;
    }

    const mistGeo = new THREE.BufferGeometry();
    mistGeo.setAttribute('position', new THREE.BufferAttribute(mistPosArr, 3));

    this.mistMat = new THREE.PointsMaterial({
      map: this.dewdropTex,
      color: new THREE.Color(0x7dd3fc), // Refreshing light sky blue mist
      size: 0.024,
      transparent: true,
      opacity: 0,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    this.mistMesh = new THREE.Points(mistGeo, this.mistMat);
    this.group.add(this.mistMesh);

    this.setIntensity(0);
  }

  public setEnvironmentMap(envMap: THREE.Texture): void {
    this.primaryMat.envMap = envMap;
    this.primaryMat.envMapIntensity = 1.6;
    this.primaryMat.needsUpdate = true;

    this.accentMat.envMap = envMap;
    this.accentMat.envMapIntensity = 1.4;
    this.accentMat.needsUpdate = true;

    this.dropletMat.envMap = envMap;
    this.dropletMat.envMapIntensity = 1.8;
    this.dropletMat.needsUpdate = true;
  }

  /**
   * Sets hydration effect intensity from 0.0 (completely invisible) to 1.0 (full blooming glory)
   */
  public setIntensity(intensity: number): void {
    const clamped = Math.max(0, Math.min(1, intensity));
    this.currentIntensity = clamped;

    const isVis = clamped > 0.001;
    this.group.visible = isVis;

    // Smooth luxury opacity: semi-transparent crystal body with water blue radiance
    this.primaryMat.opacity = clamped * 0.72;
    this.accentMat.opacity = clamped * 0.62;
    this.dropletMat.opacity = clamped * 0.88;
    this.mistMat.opacity = clamped * 0.55;

    // Fluid swirl scale blooming
    const s = 0.70 + 0.30 * clamped;
    this.primaryRibbonMesh.scale.set(s, 1.0, s);
    this.accentRibbonMesh.scale.set(s, 1.0, s);
  }

  /**
   * Continuous 60fps frame update:
   * 1. Scrolls normal map ripples along the fluid flow
   * 2. Swirls the vortex veils around the bottle
   * 3. Undulates ribbon vertices with organic wave harmonics
   * 4. Orbits splashing dewdrop gems with centrifugal drift
   * 5. Rises micro-mist particles softly
   */
  public update(dt: number): void {
    if (this.currentIntensity <= 0.001) return;

    this.animTime += dt;
    const t = this.animTime;

    // 1. Scroll water normal map caustics along the flow direction (dynamic caustics)
    this.waterNormalTex.offset.x = (t * 0.40) % 1.0;
    this.waterNormalTex.offset.y = (t * 0.12) % 1.0;

    // 2. Dynamic, energetic rotation of the water vortex around the bottle
    this.primaryRibbonMesh.rotation.y = t * 0.45;
    this.accentRibbonMesh.rotation.y = -t * 0.38;

    // 3. Harmonic wave undulation on Primary Fluid Veil
    const primPosAttr = this.primaryRibbonGeo.attributes.position as THREE.BufferAttribute;
    const primPos = primPosAttr.array as Float32Array;
    const primBase = this.primaryBasePos;
    const numPrimSeg = this.primarySegments;
    const numPrimRad = this.primaryRadial;

    for (let i = 0; i <= numPrimSeg; i++) {
      const u = i / numPrimSeg;
      const wave = Math.sin(u * Math.PI * 3.0 - t * 2.8) * Math.sin(u * Math.PI) * 0.012;

      for (let j = 0; j <= numPrimRad; j++) {
        const idx = (i * (numPrimRad + 1) + j) * 3;
        primPos[idx] = primBase[idx];
        primPos[idx + 1] = primBase[idx + 1] + wave;
        primPos[idx + 2] = primBase[idx + 2];
      }
    }
    primPosAttr.needsUpdate = true;
    this.primaryRibbonGeo.computeVertexNormals();

    // 4. Harmonic wave undulation on Secondary Counter Veil
    const accPosAttr = this.accentRibbonGeo.attributes.position as THREE.BufferAttribute;
    const accPos = accPosAttr.array as Float32Array;
    const accBase = this.accentBasePos;
    const numAccSeg = this.accentSegments;
    const numAccRad = this.accentRadial;

    for (let i = 0; i <= numAccSeg; i++) {
      const u = i / numAccSeg;
      const wave = Math.sin(u * Math.PI * 2.5 - t * 2.2 + 1.2) * Math.sin(u * Math.PI) * 0.010;

      for (let j = 0; j <= numAccRad; j++) {
        const idx = (i * (numAccRad + 1) + j) * 3;
        accPos[idx] = accBase[idx];
        accPos[idx + 1] = accBase[idx + 1] + wave;
        accPos[idx + 2] = accBase[idx + 2];
      }
    }
    accPosAttr.needsUpdate = true;
    this.accentRibbonGeo.computeVertexNormals();

    // 5. Splashing Dewdrop Gems: dynamic orbit with natural buoyancy
    for (const d of this.droplets) {
      const angle = d.phase + t * d.speed;
      const bob = Math.sin(t * 2.2 + d.phase) * 0.022;
      const x = Math.cos(angle) * d.orbitRadius;
      const z = Math.sin(angle) * d.orbitRadius;
      d.mesh.position.set(x, d.baseY + bob, z);
    }

    // 6. Micro-Mist Hydration Particles: gentle upward surge
    const mistPosAttr = this.mistMesh.geometry.attributes.position as THREE.BufferAttribute;
    const mistArr = mistPosAttr.array as Float32Array;
    const mistBase = this.mistBasePositions;
    const count = mistArr.length / 3;

    for (let i = 0; i < count; i++) {
      const speed = this.mistVelocities[i];
      const driftY = ((t * speed) % 0.45);
      const swayX = Math.sin(t * 1.5 + i) * 0.012;
      const swayZ = Math.cos(t * 1.5 + i) * 0.012;

      mistArr[i * 3] = mistBase[i * 3] + swayX;
      mistArr[i * 3 + 1] = mistBase[i * 3 + 1] + driftY;
      mistArr[i * 3 + 2] = mistBase[i * 3 + 2] + swayZ;
    }
    mistPosAttr.needsUpdate = true;
  }

  public reset(): void {
    this.animTime = 0;
    this.setIntensity(0);
  }

  public dispose(): void {
    this.primaryRibbonGeo.dispose();
    this.primaryMat.dispose();
    this.accentRibbonGeo.dispose();
    this.accentMat.dispose();
    this.dropletMat.dispose();
    for (const d of this.droplets) {
      d.mesh.geometry.dispose();
    }
    this.mistMesh.geometry.dispose();
    this.mistMat.dispose();
    this.dewdropTex.dispose();
    this.waterNormalTex.dispose();
  }
}
