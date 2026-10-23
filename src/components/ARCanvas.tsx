import React from 'react';

interface ARCanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement>;
}

export const ARCanvas: React.FC<ARCanvasProps> = ({ canvasRef }) => {
  return (
    <div className="ar-container">
      <canvas id="ar-canvas" ref={canvasRef} />
    </div>
  );
};
