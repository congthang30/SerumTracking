import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class SerumScene {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer?: THREE.WebGLRenderer;
  public simControls?: OrbitControls;
  public rootAnchor: THREE.Group;
  /** Independent SLAM/world-space parent used after image tracking handoff. */
  public worldAnchorGroup: THREE.Group;
  public productRoot: THREE.Group;
  public userRotationGroup: THREE.Group;
  public lights: THREE.Light[] = [];

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = null; // Transparent so camera stream shows through

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 100);
    // Luxury cosmetic commercial angle: framed lower with generous clearance for full scene
    this.camera.position.set(0, 0.26, 0.98);
    this.camera.lookAt(0, 0.18, 0);

    // Hierarchy matching 8th Wall anchor structure
    this.rootAnchor = new THREE.Group();
    this.rootAnchor.name = 'ImageTargetAnchor';
    this.scene.add(this.rootAnchor);

    this.worldAnchorGroup = new THREE.Group();
    this.worldAnchorGroup.name = 'SerumWorldAnchor';
    this.worldAnchorGroup.visible = false;

    this.productRoot = new THREE.Group();
    this.productRoot.name = 'ProductRoot';
    this.rootAnchor.add(this.productRoot);

    this.userRotationGroup = new THREE.Group();
    this.userRotationGroup.name = 'UserRotationGroup';
    this.productRoot.add(this.userRotationGroup);

    this.setupLighting();
  }

  /**
   * Initializes WebGLRenderer on-demand for desktop simulation testing only.
   * Real 8th Wall WebAR uses 8th Wall's internal XR8.Threejs renderer to avoid context collisions.
   */
  public initSimRenderer(canvas: HTMLCanvasElement): void {
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.setupStudioEnvironment(this.renderer);

      // Desktop simulation: luxury OrbitControls for 360 inspection
      this.simControls = new OrbitControls(this.camera, canvas);
      this.simControls.enableDamping = true;
      this.simControls.dampingFactor = 0.05;
      this.simControls.target.set(0, 0.18, 0);
      this.simControls.minDistance = 0.35;
      this.simControls.maxDistance = 2.2;
      this.simControls.maxPolarAngle = Math.PI / 2 + 0.06;
      this.simControls.update();

      this.setupContactShadow();
    }
  }

  /**
   * Adds a soft radial contact shadow under the rock pedestal in simulation mode
   */
  private setupContactShadow(): void {
    if (this.scene.getObjectByName('ContactShadowPlane')) return;
    try {
      const shadowCanvas = document.createElement('canvas');
      shadowCanvas.width = 256;
      shadowCanvas.height = 256;
      const ctx = shadowCanvas.getContext('2d');
      if (ctx) {
        const grad = ctx.createRadialGradient(128, 128, 15, 128, 128, 120);
        grad.addColorStop(0, 'rgba(0, 0, 0, 0.50)');
        grad.addColorStop(0.5, 'rgba(0, 0, 0, 0.18)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 256, 256);

        const shadowTex = new THREE.CanvasTexture(shadowCanvas);
        const shadowGeo = new THREE.PlaneGeometry(0.85, 0.85);
        const shadowMat = new THREE.MeshBasicMaterial({
          map: shadowTex,
          transparent: true,
          opacity: 0.75,
          depthWrite: false,
        });
        const contactShadow = new THREE.Mesh(shadowGeo, shadowMat);
        contactShadow.name = 'ContactShadowPlane';
        contactShadow.rotation.x = -Math.PI / 2;
        contactShadow.position.set(0, -0.001, 0);
        this.rootAnchor.add(contactShadow);
      }
    } catch (e) {
      console.warn('[SerumScene] Could not setup contact shadow:', e);
    }
  }

  private studioEnvMap: THREE.Texture | null = null;

  /**
   * Generates a studio softbox environment texture exclusively for reflective water/droplet materials.
   * Does NOT assign to scene.environment to avoid washing out the stone pedestal, petals, and bottle label.
   */
  public setupStudioEnvironment(renderer: THREE.WebGLRenderer): void {
    if (this.studioEnvMap) return;

    try {
      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      pmremGenerator.compileEquirectangularShader();

      const studio = new THREE.Scene();
      // Neutral dark studio background so it only reflects light panels without blowing out diffuse objects
      studio.background = new THREE.Color(0x0f131a);

      // Key softbox panel
      const keyBoxGeo = new THREE.PlaneGeometry(3, 4);
      const keyBoxMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const keyBox = new THREE.Mesh(keyBoxGeo, keyBoxMat);
      keyBox.position.set(2.5, 3.5, 2.5);
      keyBox.lookAt(0, 0, 0);
      studio.add(keyBox);

      // Rim softbox panel (soft rose-gold warm reflection)
      const rimBoxGeo = new THREE.PlaneGeometry(2, 3);
      const rimBoxMat = new THREE.MeshBasicMaterial({ color: 0xffeedd });
      const rimBox = new THREE.Mesh(rimBoxGeo, rimBoxMat);
      rimBox.position.set(-2.5, 2.5, -2.5);
      rimBox.lookAt(0, 0, 0);
      studio.add(rimBox);

      // Top softbox panel
      const topBoxGeo = new THREE.PlaneGeometry(3, 3);
      const topBoxMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const topBox = new THREE.Mesh(topBoxGeo, topBoxMat);
      topBox.position.set(0, 4.0, 0);
      topBox.rotation.x = Math.PI / 2;
      studio.add(topBox);

      const renderTarget = pmremGenerator.fromScene(studio, 0.04);
      this.studioEnvMap = renderTarget.texture;

      // Ensure scene.environment is null so the stone, flowers, and bottle retain their natural contrast & rich textures
      this.scene.environment = null;

      keyBoxGeo.dispose();
      keyBoxMat.dispose();
      rimBoxGeo.dispose();
      rimBoxMat.dispose();
      topBoxGeo.dispose();
      topBoxMat.dispose();
      pmremGenerator.dispose();
    } catch (e) {
      console.warn('[SerumScene] Could not generate studio PMREM environment:', e);
    }
  }

  public getStudioEnvMap(): THREE.Texture | null {
    return this.studioEnvMap;
  }

  private setupLighting(): void {
    // Bright, vibrant, clean studio lighting matching original crystal clarity
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x2d1f1c, 0.60);
    const ambientLight = new THREE.AmbientLight(0xfff5ea, 0.45);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.25);
    keyLight.position.set(1.5, 3.0, 2.0);
    keyLight.castShadow = false;

    const fillLight = new THREE.DirectionalLight(0xfcd5ce, 0.60);
    fillLight.position.set(-2.0, 1.5, 1.5);

    const rimLight = new THREE.DirectionalLight(0xe8d5c4, 0.80);
    rimLight.position.set(0, 2.5, -2.5);

    this.lights = [hemiLight, ambientLight, keyLight, fillLight, rimLight];
    for (const light of this.lights) {
      this.scene.add(light);
    }
  }

  /**
   * Attaches rootAnchor and lights directly into 8th Wall's internal Three.js XR Scene
   */
  public attachToXRScene(xrScene: THREE.Scene, xrCamera: THREE.Camera, xrRenderer?: THREE.WebGLRenderer): void {
    if (this.rootAnchor.parent !== xrScene) {
      xrScene.add(this.rootAnchor);
    }
    if (this.worldAnchorGroup.parent !== xrScene) {
      xrScene.add(this.worldAnchorGroup);
    }
    for (const light of this.lights) {
      if (light.parent !== xrScene) {
        xrScene.add(light);
      }
    }
    if ((xrCamera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      this.camera = xrCamera as THREE.PerspectiveCamera;
    }
    if (xrRenderer) {
      this.renderer = xrRenderer;
      xrRenderer.outputColorSpace = THREE.SRGBColorSpace;
      xrRenderer.toneMapping = THREE.ACESFilmicToneMapping;
      xrRenderer.toneMappingExposure = 1.05;
      xrRenderer.shadowMap.enabled = false;
      this.setupStudioEnvironment(xrRenderer);
      xrScene.environment = null; // Do NOT blow out xrScene with global IBL
    }
  }

  public attachToSimScene(): void {
    if (this.rootAnchor.parent !== this.scene) {
      this.scene.add(this.rootAnchor);
    }
    for (const light of this.lights) {
      if (light.parent !== this.scene) {
        this.scene.add(light);
      }
    }
  }

  public handleResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer?.setSize(window.innerWidth, window.innerHeight);
  }

  public render(): void {
    this.simControls?.update();
    if (this.renderer) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  public dispose(): void {
    this.simControls?.dispose();
    this.renderer?.dispose();
  }
}
