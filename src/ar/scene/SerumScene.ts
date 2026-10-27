import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Safely updates the near clipping plane on an 8th Wall XR camera (PerspectiveCamera)
 * WITHOUT calling camera.updateProjectionMatrix().
 * 
 * 8th Wall calculates its projection matrix from physical camera lens calibration (focal length fx, fy
 * and asymmetric optical center cx, cy). Calling Three.js camera.updateProjectionMatrix() completely
 * destroys this calibration by recalculating a symmetric pinhole matrix, which causes severe visual
 * distortion and makes models violently jump toward the top-left corner as the camera approaches!
 * 
 * By modifying ONLY elements[10] and elements[14] (depth row in column-major order), we adjust the near
 * clipping plane to 1cm (0.01m) while preserving 100% of 8th Wall's physical lens intrinsics.
 */
export function applyNearClippingPlaneToXRCamera(
  camera: THREE.Camera,
  targetNear = 0.01
): void {
  const perspectiveCamera = camera as THREE.PerspectiveCamera;
  if (!perspectiveCamera || !perspectiveCamera.isPerspectiveCamera) return;
  // If near plane is already configured to targetNear, avoid mutating projection matrix every frame
  if (Math.abs(perspectiveCamera.near - targetNear) < 1e-4) return;
  perspectiveCamera.near = targetNear;

  const elements = perspectiveCamera.projectionMatrix?.elements;
  if (!elements || elements.length < 16) return;

  const far = perspectiveCamera.far || 1000;
  // Standard perspective projection matrix depth terms:
  // elements[10] = -(far + near) / (far - near)
  // elements[14] = -(2 * far * near) / (far - near)
  elements[10] = -(far + targetNear) / (far - targetNear);
  elements[14] = -(2 * far * targetNear) / (far - targetNear);
  perspectiveCamera.projectionMatrixInverse.copy(perspectiveCamera.projectionMatrix).invert();
}

export class SerumScene {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer?: THREE.WebGLRenderer;
  public simControls?: OrbitControls;
  private isAttachedToXRScene = false;
  public rootAnchor: THREE.Group;
  /** Independent SLAM/world-space parent used after image tracking handoff. */
  public worldAnchorGroup: THREE.Group;
  public productRoot: THREE.Group;
  public userRotationGroup: THREE.Group;
  public lights: THREE.Light[] = [];
  /** 3D grid on XR8's ground reference. */
  public planeDebugGrid: THREE.GridHelper;

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = null; // Transparent so camera stream shows through

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 100);
    // Luxury cosmetic commercial angle: framed lower with generous clearance for full scene
    this.camera.position.set(0, 0.26, 0.98);
    this.camera.lookAt(0, 0.18, 0);
    this.scene.add(this.camera);

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

    // Grid for XR8's ground reference.
    this.planeDebugGrid = new THREE.GridHelper(1.8, 18, 0xd4af37, 0x4a4a4a);
    this.planeDebugGrid.name = 'PlaneDebugGrid';
    this.planeDebugGrid.position.set(0, -0.001, 0);
    this.planeDebugGrid.visible = false;
    this.scene.add(this.planeDebugGrid);

    this.setupLighting();
    this.setupContactShadow();
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
        contactShadow.visible = false;
        this.productRoot.add(contactShadow);
      }
    } catch {
      // Contact shadow is an optional visual enhancement.
    }
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
    this.isAttachedToXRScene = true;
    if (this.rootAnchor.parent !== xrScene) {
      xrScene.add(this.rootAnchor);
    }
    if (this.worldAnchorGroup.parent !== xrScene) {
      xrScene.add(this.worldAnchorGroup);
    }
    if (this.planeDebugGrid.parent !== xrScene) {
      xrScene.add(this.planeDebugGrid);
    }
    for (const light of this.lights) {
      if (light.parent !== xrScene) {
        xrScene.add(light);
      }
    }
    if ((xrCamera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      this.camera = xrCamera as THREE.PerspectiveCamera;
      // Safely set 1cm near clipping plane on the 8th Wall XR camera WITHOUT destroying lens intrinsics
      applyNearClippingPlaneToXRCamera(this.camera, 0.01);
    }
    // Ensure AR Camera is added to the XR Scene so children attached to camera (Camera-Locked mode) are traversed & rendered
    if (xrCamera && xrCamera.parent !== xrScene) {
      xrScene.add(xrCamera);
    }
    if (xrRenderer) {
      this.renderer = xrRenderer;
      xrRenderer.outputColorSpace = THREE.SRGBColorSpace;
      xrRenderer.toneMapping = THREE.ACESFilmicToneMapping;
      xrRenderer.toneMappingExposure = 1.05;
      xrRenderer.shadowMap.enabled = false;
      xrScene.environment = null; // Do NOT blow out xrScene with global IBL
      this.resizeXRCanvasToViewport();
    }
  }

  public attachToSimScene(): void {
    this.isAttachedToXRScene = false;
    if (this.camera.parent !== this.scene) {
      this.scene.add(this.camera);
    }
    if (this.rootAnchor.parent !== this.scene) {
      this.scene.add(this.rootAnchor);
    }
    if (this.worldAnchorGroup.parent !== this.scene) {
      this.scene.add(this.worldAnchorGroup);
    }
    if (this.planeDebugGrid.parent !== this.scene) {
      this.scene.add(this.planeDebugGrid);
    }
    for (const light of this.lights) {
      if (light.parent !== this.scene) {
        this.scene.add(light);
      }
    }
  }

  public setPlaneGridPosition(x: number, y: number, z: number): void {
    this.planeDebugGrid.position.set(x, y + 0.001, z);
  }

  public setPlaneGridVisible(visible: boolean): void {
    this.planeDebugGrid.visible = visible;
  }

  public handleResize(): void {
    if (this.isAttachedToXRScene) {
      // Keep the XR8 canvas/drawing buffer matched to the viewport, but leave
      // its camera intrinsics and projection matrix under XR8's control.
      this.resizeXRCanvasToViewport();
      return;
    }
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer?.setSize(window.innerWidth, window.innerHeight);
  }

  private resizeXRCanvasToViewport(): void {
    if (!this.renderer) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = Math.max(1, Math.round(window.innerWidth * dpr));
    const height = Math.max(1, Math.round(window.innerHeight * dpr));
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
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
