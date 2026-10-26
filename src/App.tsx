import React from 'react';
import { useAREngine } from './hooks/useAREngine';
import { ARCanvas } from './components/ARCanvas';
import './styles/ar.css';

export const App: React.FC = () => {
  const { canvasRef } = useAREngine();

  return (
    <>
      {/* 3D WebGL Canvas */}
      <ARCanvas canvasRef={canvasRef} />
    </>
  );
};

export default App;
