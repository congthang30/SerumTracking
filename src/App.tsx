import React from 'react';
import { useAREngine } from './hooks/useAREngine';
import { ARCanvas } from './components/ARCanvas';
import { IngredientOverlay } from './components/IngredientOverlay';
import { SurfacePlacementOverlay } from './components/SurfacePlacementOverlay';
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
        onPlace={placeOnSurface}
        onRelock={relockToCamera}
      />

      {/* Ingredient Detail Modal Popup */}
      <IngredientOverlay
        activeIngredient={activeIngredient}
        onSelectIngredient={openIngredientModal}
        onCloseModal={closeIngredientModal}
      />
    </>
  );
};

export default App;
