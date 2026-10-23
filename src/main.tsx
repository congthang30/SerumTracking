import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import * as THREE from 'three';
import { installCameraFix } from './ar/xr/camera-fix';

// Install camera polyfill early to fix iOS 16.4+ iPhone Pro telephoto camera selection bug
installCameraFix();

// Expose THREE globally before any 8th Wall XR module loads
(window as any).THREE = THREE;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

