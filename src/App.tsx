import React, { useEffect, useState } from 'react';
import { useAREngine } from './hooks/useAREngine';
import { preloadSerumModel } from './ar/models/SerumModelLoader';
import { ARCanvas } from './components/ARCanvas';
import { IngredientOverlay } from './components/IngredientOverlay';
import { SurfacePlacementOverlay } from './components/SurfacePlacementOverlay';
import { ArCaptureControls } from './components/ArCaptureControls';
import { ImageTrackingIntro, ImageTrackingLoader, ImageTrackingStartError } from './components/ImageTrackingIntro';
import './styles/ar.css';

const ARExperience: React.FC = () => {
  const {
    canvasRef,
    activeIngredient,
    openIngredientModal,
    closeIngredientModal,
    hasTargetFound,
    isCameraLocked,
    canPlaceOnSurface,
    placeOnSurface,
    relockToCamera,
    worldTrackingStatus,
    surfaceGuidance,
    isExperienceReady,
    isCaptureReady,
    captureEngine,
    startupError,
    startupStage,
  } = useAREngine();

  return (
    <>
      {/* 3D WebGL Canvas */}
      <ARCanvas canvasRef={canvasRef} />

      {/* Surface Placement & World Tracking Handoff Overlay */}
      <SurfacePlacementOverlay
        hasTargetFound={hasTargetFound}
        isCameraLocked={isCameraLocked}
        canPlaceOnSurface={canPlaceOnSurface}
        guidanceText={surfaceGuidance}
        trackingStatus={worldTrackingStatus}
        onPlace={placeOnSurface}
        onRelock={relockToCamera}
        hasCaptureControls={isCaptureReady}
      />

      {/* Ingredient Detail Modal Popup */}
      <IngredientOverlay
        activeIngredient={activeIngredient}
        onSelectIngredient={openIngredientModal}
        onCloseModal={closeIngredientModal}
      />

      <ArCaptureControls
        engine={captureEngine}
        isReady={isCaptureReady}
        filenamePrefix="serum-image-ar"
        label="Image AR"
      />

      {!isExperienceReady && !startupError && <ImageTrackingLoader stage={startupStage} />}
      {startupError && <ImageTrackingStartError message={startupError} onRetry={() => window.location.reload()} />}
    </>
  );
};

export const App: React.FC = () => {
  const [hasStartedDemo, setHasStartedDemo] = useState(false);
  useEffect(() => {
    void preloadSerumModel().catch(() => {
      // Start Demo can retry if the background preload fails.
    });
  }, []);
  return hasStartedDemo
    ? <ARExperience />
    : <ImageTrackingIntro onStart={() => setHasStartedDemo(true)} />;
};

export default App;
