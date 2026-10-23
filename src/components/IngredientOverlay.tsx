import React from 'react';
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
          <div className="modal-content">
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
              {activeIngredient.iconSvg && (
                <img
                  src={activeIngredient.iconSvg}
                  alt={activeIngredient.title}
                  style={{ width: '40px', height: '40px', objectFit: 'contain', flexShrink: 0 }}
                />
              )}
              <div>
                <span className="modal-tag" style={{ display: 'block', marginBottom: '2px' }}>
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
