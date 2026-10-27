# HYDRATING SERUM — WEBAR (REACT + VITE + THREE.JS + 8TH WALL)

A premium WebAR image-tracking experience for **HYDRATING SERUM**, built with **React**, **Vite**, **TypeScript**, **Three.js**, and the **8th Wall Open-Source XR Engine**.

---

## 1. Project Structure

```
serum/
├── public/
│   ├── assets/
│   │   ├── models/
│   │   │   ├── serum_ex.glb          # Official 3D model (39.9 MB)
│   │   │   └── serum4.glb            # Supporting symlink/alias
│   │   ├── textures/                 # Extracted labels and textures
│   │   └── image-target/
│   │       ├── img_target.png        # Original poster (1122x1402)
│   │       ├── serum-target.json     # Metadata 8th Wall Image Target
│   │       ├── serum_luminance.jpg   # High-contrast grayscale image
│   │       ├── serum_thumbnail.png   # Thumbnail
│   │       └── serum_cropped.png     # Image cropped to the target aspect ratio
│   └── external/
│       └── xr/
│           ├── xr.js                 # 8th Wall Core Engine (1 MB)
│           ├── xr-slam.js            # SLAM Engine
│           └── resources/            # WebAssembly & Shaders
├── src/
│   ├── components/
│   │   ├── ARCanvas.tsx              # WebGL rendering canvas
│   │   ├── ARLoadingScreen.tsx       # Loading screen and camera permission
│   │   ├── ARScanOverlay.tsx         # Scanning frame and guidance
│   │   └── IngredientOverlay.tsx     # SVG line layer and details modal
│   ├── ar/
│   │   ├── engine/
│   │   │   └── EightWallManager.ts   # 8th Wall XR pipeline lifecycle
│   │   ├── tracking/
│   │   │   └── ImageTrackingController.ts # Pose smoothing filter (slerp/lerp)
│   │   ├── scene/
│   │   │   └── SerumScene.ts         # Three.js setup and studio lighting rig
│   │   ├── models/
│   │   │   └── SerumModelLoader.ts   # GLB loading, water refraction, 3D anchors
│   │   ├── animation/
│   │   │   └── ProductStoryTimeline.ts # Product cinematic timeline
│   │   └── callouts/
│   │       └── CalloutProjection.ts  # Project 3D coordinates to screen at 60 fps
│   ├── hooks/
│   │   └── useAREngine.ts            # Custom hook connecting the UI and WebAR
│   ├── data/
│   │   └── ingredients.ts            # Data for three active ingredients
│   ├── styles/
│   │   └── ar.css                    # Luxury Skincare styling
│   ├── types/
│   │   └── ar.ts                     # Type definitions
│   ├── App.tsx                       # Root UI Component
│   └── main.tsx                      # React Entry point
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

## 2. Installation and Running the App

### Install dependencies:
```bash
cd serum
npm install
```

### Start the development server:
```bash
npm run dev
```
Open the app at: `http://localhost:5173/`

### Build for production:
```bash
npm run build
```
The bundle is written to `dist/`.

### Preview the build:
```bash
npm run preview
```

---

## 3. Testing on a Phone

1. **Network requirements**:
   - Connect the computer and phone to the **same Wi-Fi network**.
   - Run `npm run dev -- --host`. Vite will display a LAN address, for example: `http://192.168.1.15:5173/`.
2. **Camera permission (HTTPS)**:
   - Mobile browsers (Safari on iOS / Chrome on Android) require a secure connection (HTTPS or localhost) to access the camera.
   - You can use a tunnel such as **ngrok**:
     ```bash
     ngrok http 5173
     ```
   - Open `https://xxxx.ngrok-free.app` on the phone.
3. **Scan the poster**:
   - When you open the page on the phone, tap **Start Demo**. Select **Allow** when the browser requests camera access.
   - Point the camera at the [img_target.png](public/assets/image-target/img_target.png) poster (shown on a computer screen or printed).
   - The 3D serum bottle appears, floats, and shows three ingredient callouts in sequence. Use the camera and video buttons to capture or record the AR view.

---

## 4. Previewing 3D on a Computer

- On a computer, tap **Start Demo** to open a 3D preview that you can rotate and inspect.
- Add `?sim=1` to the URL to open the preview manually on a phone.
- The [img_target.png](public/assets/image-target/img_target.png) poster is hidden by default in the preview.

---

## 5. Advanced Customization

### A. Change the image target:
1. Place the new target image at `public/assets/image-target/your_target.png`.
2. Update the JSON path in `src/ar/engine/EightWallManager.ts` or use a new metadata file.

### B. Adjust model size and position:
In `src/ar/models/SerumModelLoader.ts`:
- Z-axis offset from the poster: `modelScene.position.set(0, 0, -0.20);`
- Product display scale is controlled by `baseScale` in `src/ar/animation/ProductStoryTimeline.ts`.

### C. Add or change an ingredient callout:
Open `src/data/ingredients.ts` and edit or add an item in the `INGREDIENTS` array:
```typescript
{
  id: 'vitamin_c',
  number: '03',
  tag: 'Antioxidant',
  title: 'VITAMIN C',
  subtitle: 'Brightens and evens skin tone',
  description: 'A highly stable Vitamin C derivative...',
  highlight: '🌟 Helps fade dark spots and brighten skin naturally.',
  side: 'right',
  localAnchor: new THREE.Vector3(0.13, 0.05, 0.09),
}
```

---

## 6. Test Report

For details on XR8's single-plane limit, the floor-based reticle, and the hidden grid, see [Surface Tracking](docs/surface-tracking.md).

| Item | Status | Notes |
| :--- | :---: | :--- |
| **Vite installation and build** | **PASS** | `tsc --noEmit` and `npm run build` completed without errors |
| **3D model and materials** | **PASS** | The pink serum, rose-gold cap, blooming flowers, falling petals, and refractive water were preserved |
| **Poster alignment** | **PASS** | The vertical axis was raised so the rock pedestal and bottle align with the illustration on [img_target.png](file:///home/congthang/Downloads/MODEL/serum/public/assets/image-target/img_target.png) |
| **Simulation mode** | **PASS** | Automatic rendering was verified in headless Chrome |
| **Real camera test on mobile** | *Device test required* | Open through HTTPS/ngrok on a phone to grant access to the physical camera |
