import React from 'react';
import { useAREngine } from './hooks/useAREngine';
import { ARCanvas } from './components/ARCanvas';
import { IngredientOverlay } from './components/IngredientOverlay';
import { SurfacePlacementOverlay } from './components/SurfacePlacementOverlay';
import { ARTrackingDebugHUD } from './components/ARTrackingDebugHUD';
import './styles/ar.css';

export const App: React.FC = () => {
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
    isPlaneGridVisible,
    togglePlaneGrid,
    toggleTrackingMode,
    trackingMode,
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
      />

      {/* Ingredient Detail Modal Popup */}
      <IngredientOverlay
        activeIngredient={activeIngredient}
        onSelectIngredient={openIngredientModal}
        onCloseModal={closeIngredientModal}
      />

      {/* 6DoF World Tracking Diagnostics HUD (Toggleable, 10Hz low-overhead) */}
      <ARTrackingDebugHUD
        isPlaneGridVisible={isPlaneGridVisible}
        onTogglePlaneGrid={togglePlaneGrid}
        trackingMode={trackingMode}
        onToggleTrackingMode={toggleTrackingMode}
      />
    </>
  );
};

export default App;
