import React, { useEffect, useState } from 'react';
import { arTrackingDiagnostics, ARDiagnosticsData } from '../ar/debug/ARTrackingDiagnostics';

export interface ARTrackingDebugHUDProps {
  onTogglePlaneGrid?: () => void;
  onToggleTrackingMode?: () => void;
  onAdjustPlaneY?: (deltaMeters: number) => void;
  isPlaneGridVisible?: boolean;
  trackingMode?: 'CAMERA_ATTACHED' | 'WORLD_ANCHORED';
}

export const ARTrackingDebugHUD: React.FC<ARTrackingDebugHUDProps> = ({
  onTogglePlaneGrid,
  onToggleTrackingMode,
  onAdjustPlaneY,
  isPlaneGridVisible = false,
  trackingMode = 'CAMERA_ATTACHED',
}) => {
  const [data, setData] = useState<ARDiagnosticsData>(() => arTrackingDiagnostics.getData());
  const [isOpen, setIsOpen] = useState(() => data.debugHudVisible);

  // Poll diagnostics at low-overhead 10Hz interval (100ms) to ensure zero impact on 60fps WebGL render loop
  useEffect(() => {
    const timer = window.setInterval(() => {
      setData({ ...arTrackingDiagnostics.getData() });
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  const handleToggleOpen = () => {
    const next = !isOpen;
    setIsOpen(next);
    arTrackingDiagnostics.setDebugHudVisible(next);
  };

  return (
    <>
      {/* 1. Subtle Floating Diagnostic Trigger Pill */}
      <div className="ar-debug-trigger interactive-ui">
        <button
          className={`ar-debug-trigger-btn ${isOpen ? 'active' : ''}`}
          onClick={handleToggleOpen}
          aria-label="Toggle AR Diagnostics"
          title="Bật/Tắt bảng chuẩn đoán 6DoF"
        >
          <span className="ar-debug-dot" style={{
            backgroundColor: data.trackingStatus === 'NORMAL' ? '#2ecc71' : (data.trackingStatus === 'SIMULATION' ? '#3498db' : '#f39c12')
          }} />
          <span className="ar-debug-trigger-label">6DoF Debug</span>
        </button>
      </div>

      {/* 2. Expanded 6DoF & World Tracking Diagnostic Panel */}
      {isOpen && (
        <div className="ar-debug-panel interactive-ui" role="region" aria-label="AR Tracking Diagnostics">
          <div className="ar-debug-header">
            <div className="ar-debug-title-wrap">
              <span className="ar-debug-badge-status" data-status={data.trackingStatus}>
                {data.trackingStatus}
              </span>
              <span className="ar-debug-title">8th Wall 6DoF HUD</span>
            </div>
            <button
              className="ar-debug-close-btn"
              onClick={handleToggleOpen}
              aria-label="Đóng bảng chuẩn đoán"
            >
              ✕
            </button>
          </div>

          <div className="ar-debug-body">
            {/* Row 1: Session & FPS */}
            <div className="ar-debug-row">
              <span className="ar-debug-label">Perf & Canvas:</span>
              <span className="ar-debug-val highlight">
                {data.fps} FPS &bull; {data.canvasWidth}×{data.canvasHeight} ({data.pixelRatio}x)
              </span>
            </div>

            {/* Row 2: Tracking State */}
            <div className="ar-debug-row">
              <span className="ar-debug-label">SLAM Reason:</span>
              <span className="ar-debug-val">{data.trackingReason}</span>
            </div>

            {/* Row 3: Mode with quick toggle */}
            <div className="ar-debug-row ar-debug-mode-row">
              <div>
                <span className="ar-debug-label">Mode: </span>
                <span className={`ar-debug-val mode-${trackingMode.toLowerCase()}`}>
                  {trackingMode === 'WORLD_ANCHORED' ? '🌐 WORLD_ANCHORED' : '📷 CAMERA_ATTACHED'}
                </span>
              </div>
              {onToggleTrackingMode && (
                <button className="ar-debug-action-btn" onClick={onToggleTrackingMode}>
                  Đổi Mode
                </button>
              )}
            </div>

            {/* Row 4: Camera 6DoF Pose */}
            <div className="ar-debug-section">
              <div className="ar-debug-section-title">Camera 6DoF Pose</div>
              <div className="ar-debug-subrow">
                <span className="ar-debug-sublabel">Pos (m):</span>
                <span className="ar-debug-val-code">
                  X:{data.cameraPosition.x.toFixed(2)} Y:{data.cameraPosition.y.toFixed(2)} Z:{data.cameraPosition.z.toFixed(2)}
                </span>
              </div>
              <div className="ar-debug-subrow">
                <span className="ar-debug-sublabel">Rot (°):</span>
                <span className="ar-debug-val-code">
                  P:{data.cameraEulerDeg.pitch}° Y:{data.cameraEulerDeg.yaw}° R:{data.cameraEulerDeg.roll}°
                </span>
              </div>
            </div>

            {/* Row 5: Model World Pose */}
            <div className="ar-debug-section">
              <div className="ar-debug-section-title">Model World Transform</div>
              <div className="ar-debug-subrow">
                <span className="ar-debug-sublabel">World Pos:</span>
                <span className="ar-debug-val-code">
                  X:{data.modelPosition.x.toFixed(2)} Y:{data.modelPosition.y.toFixed(2)} Z:{data.modelPosition.z.toFixed(2)}
                </span>
              </div>
              <div className="ar-debug-subrow">
                <span className="ar-debug-sublabel">Height / Parent:</span>
                <span className="ar-debug-val">
                  {data.modelHeightCm.toFixed(1)}cm &bull; {data.modelParent}
                </span>
              </div>
              <div className="ar-debug-subrow">
                <span className="ar-debug-sublabel">Cam &rarr; Model:</span>
                <span className="ar-debug-val highlight">
                  {data.cameraModelDistanceM.toFixed(2)} m
                </span>
              </div>
            </div>

            {/* Row 6: Plane & Surface Detection */}
            <div className="ar-debug-section">
              <div className="ar-debug-section-title">Plane & Tabletop Detection</div>
              <div className="ar-debug-subrow">
                <span className="ar-debug-sublabel">Plane Y:</span>
                <span className="ar-debug-val">
                  {data.planeY.toFixed(3)} m ({data.isPlaneCalibrated ? 'Calibrated' : 'Estimating'})
                </span>
              </div>
              <div className="ar-debug-subrow">
                <span className="ar-debug-sublabel">Hit Distance:</span>
                <span className="ar-debug-val">{data.hitDistanceM.toFixed(2)} m</span>
              </div>
              {onAdjustPlaneY && (
                <div className="ar-debug-subrow" style={{ marginTop: '6px', display: 'flex', gap: '6px' }}>
                  <button
                    className="ar-debug-action-btn"
                    style={{ padding: '4px 8px', fontSize: '11px', flex: 1 }}
                    onClick={() => onAdjustPlaneY(-0.05)}
                  >
                    ⬇️ Hạ 5cm
                  </button>
                  <button
                    className="ar-debug-action-btn"
                    style={{ padding: '4px 8px', fontSize: '11px', flex: 1 }}
                    onClick={() => onAdjustPlaneY(0.05)}
                  >
                    ⬆️ Nâng 5cm
                  </button>
                </div>
              )}
              {onTogglePlaneGrid && (
                <button
                  className={`ar-debug-action-btn grid-btn ${isPlaneGridVisible ? 'active' : ''}`}
                  onClick={onTogglePlaneGrid}
                >
                  {isPlaneGridVisible ? 'Ẩn Plane Grid 3D' : 'Hiện Plane Grid 3D'}
                </button>
              )}
            </div>

            {/* Row 7: Warning banner if any */}
            {data.trackingStatus === 'LIMITED' && (
              <div className="ar-debug-alert">
                ⚠️ SLAM LIMITED: Di chuyển nhẹ camera để hệ thống nhận diện mặt phẳng và tái định vị.
              </div>
            )}
            {data.recentPoseWarning && (
              <div className="ar-debug-alert warn">
                ⚠️ {data.recentPoseWarning}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
