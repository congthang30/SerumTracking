import React, { useEffect } from 'react';
import { Ingredient } from '../types/ar';

interface IngredientOverlayProps {
  activeIngredient: Ingredient | null;
  onSelectIngredient: (ing: Ingredient) => void;
  onCloseModal: () => void;
}

export const IngredientOverlay: React.FC<IngredientOverlayProps> = ({
  activeIngredient,
  onCloseModal,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseModal();
      }
    };
    if (activeIngredient) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeIngredient, onCloseModal]);

  return (
    <>
      {/* Luxury Detail Modal Popup (Triggered by clicking 3D badges) */}
      {activeIngredient && (
        <div
          className="modal-backdrop interactive-ui"
          onClick={(e) => {
            if (e.target === e.currentTarget) onCloseModal();
          }}
        >
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button
              className="modal-close-icon-btn"
              onClick={onCloseModal}
              aria-label="Đóng popup"
              title="Đóng"
            >
              ✕
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '12px' }}>
              {activeIngredient.iconSvg && (
                <img
                  src={activeIngredient.iconSvg}
                  alt={activeIngredient.title}
                  style={{ width: '44px', height: '44px', objectFit: 'contain', flexShrink: 0 }}
                />
              )}
              <div style={{ paddingRight: '24px' }}>
                <span className="modal-tag" style={{ display: 'block', marginBottom: '3px' }}>
                  Thành phần {activeIngredient.number} • {activeIngredient.tag}
                </span>
                <h2 className="modal-title" style={{ margin: 0 }}>{activeIngredient.title}</h2>
              </div>
            </div>
            {activeIngredient.subtitle && (
              <div className="modal-subtitle-text">{activeIngredient.subtitle}</div>
            )}
            <p className="modal-body">{activeIngredient.description}</p>
            <div className="modal-highlight">{activeIngredient.highlight}</div>
            <button className="modal-close-btn" onClick={onCloseModal}>
              Đã hiểu & Đóng
            </button>
          </div>
        </div>
      )}
    </>
  );
};
