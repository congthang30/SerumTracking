import React, { useEffect, useState } from 'react';

export interface SurfacePlacementOverlayProps {
  hasTargetFound: boolean;
  isCameraLocked: boolean;
  canPlaceOnSurface: boolean;
  trackingStatus?: 'NORMAL' | 'LIMITED' | 'SIMULATION';
  guidanceText?: string;
  onPlace: () => void;
  onRelock?: () => void;
}

/* Custom Vector Icons for Luxury Cosmetic AR UI */
const TargetPlacementIcon: React.FC = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    {/* Elliptical plane ring */}
    <ellipse cx="12" cy="18" rx="8" ry="3.8" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.5 2" />
    {/* High-precision location pin */}
    <path
      d="M12 2.5C9.51472 2.5 7.5 4.51472 7.5 7C7.5 10.3 11.2 14.8 11.64 15.35C11.83 15.58 12.17 15.58 12.36 15.35C12.8 14.8 16.5 10.3 16.5 7C16.5 4.51472 14.4853 2.5 12 2.5Z"
      fill="currentColor"
      fillOpacity="0.25"
      stroke="currentColor"
      strokeWidth="1.6"
    />
    <circle cx="12" cy="7" r="2" fill="currentColor" />
  </svg>
);

const RepositionIcon: React.FC = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M20 11A8.1 8.1 0 0 0 6.34 5.34L3 8.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M3 3V8.5H8.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M4 13A8.1 8.1 0 0 0 17.66 18.66L21 15.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M21 21V15.5H15.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CheckSparkleIcon: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="9.5" stroke="#d4af37" strokeWidth="1.6" fill="rgba(212, 175, 55, 0.2)" />
    <path
      d="M8 12.2L10.8 15L16 9.5"
      stroke="#fff8f3"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SearchPlaneIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="12" cy="15" rx="9" ry="4.5" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2" />
    <path d="M12 4V11M8 7.5L12 11.5L16 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const SurfacePlacementOverlay: React.FC<SurfacePlacementOverlayProps> = ({
  hasTargetFound,
  isCameraLocked,
  canPlaceOnSurface,
  trackingStatus = 'NORMAL',
  guidanceText,
  onPlace,
  onRelock,
}) => {
  const [showToast, setShowToast] = useState(false);

  // Show a brief luxury toast notification upon placing into World Tracking
  useEffect(() => {
    if (hasTargetFound && !isCameraLocked) {
      setShowToast(true);
      const timer = window.setTimeout(() => setShowToast(false), 3400);
      return () => window.clearTimeout(timer);
    } else {
      setShowToast(false);
    }
  }, [hasTargetFound, isCameraLocked]);

  if (!hasTargetFound) {
    return null;
  }

  return (
    <>
      {/* 1. Camera-Locked Mode: Placement Button or Surface Detection Guidance */}
      {isCameraLocked && (
        <div className="surface-placement-container interactive-ui">
          {canPlaceOnSurface ? (
            <button
              className="surface-place-btn"
              onClick={onPlace}
              aria-label="Đặt sản phẩm tại đây"
              title="Đặt sản phẩm tại đây"
            >
              <span className="place-btn-shimmer" aria-hidden="true" />
              <span className="place-btn-ripple" aria-hidden="true" />
              <TargetPlacementIcon />
            </button>
          ) : (
            <div className={`surface-guidance-pill ${trackingStatus === 'LIMITED' ? 'tracking-limited' : ''}`}>
              <span className="guidance-icon-wrap">
                <SearchPlaneIcon />
              </span>
              <span className={`guidance-dot ${trackingStatus === 'LIMITED' ? 'warning' : ''}`} />
              <span className="guidance-text">
                {guidanceText || (trackingStatus === 'LIMITED'
                  ? 'Đang ổn định SLAM camera...'
                  : 'Lia camera tới mặt phẳng (bàn hoặc sàn)')}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 2. World Tracking Mode: Success Toast & Reposition Control */}
      {!isCameraLocked && (
        <>
          {showToast && (
            <div className="surface-toast interactive-ui">
              <span className="toast-icon-wrap">
                <CheckSparkleIcon />
              </span>
              <div className="toast-text-group">
                <span className="toast-title">Đã mở lock camera</span>
                <span className="toast-sub">Chế độ World Tracking 6DoF đang kích hoạt</span>
              </div>
            </div>
          )}

          {onRelock && (
            <div className="surface-reposition-container interactive-ui">
              <button
                className="surface-reposition-btn"
                onClick={onRelock}
                aria-label="Đổi vị trí sản phẩm"
                title="Ghim lại vào camera để đổi vị trí"
              >
                <span className="reposition-icon-wrap">
                  <RepositionIcon />
                </span>
                <span className="reposition-text">Đổi vị trí</span>
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
};
