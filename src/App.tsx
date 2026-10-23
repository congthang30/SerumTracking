import React from 'react';
import { useAREngine } from './hooks/useAREngine';
import { ARCanvas } from './components/ARCanvas';
import { IngredientOverlay } from './components/IngredientOverlay';
import './styles/ar.css';

export const App: React.FC = () => {
  const {
    canvasRef,
    activeIngredient,
    openIngredientModal,
    closeIngredientModal,
  } = useAREngine();

  return (
    <>
      {/* 3D WebGL Canvas */}
      <ARCanvas canvasRef={canvasRef} />

      {/* 3D Anchor Callout Lines & Ingredient Cards */}
      <IngredientOverlay
        activeIngredient={activeIngredient}
        onSelectIngredient={openIngredientModal}
        onCloseModal={closeIngredientModal}
      />
    </>
  );
};

export default App;
