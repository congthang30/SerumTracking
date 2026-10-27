import React from 'react';
import styles from './ImageTrackingIntro.module.css';

export const ImageTrackingIntro: React.FC<{ onStart: () => void }> = ({ onStart }) => (
  <section className={styles.cameraIntro} aria-labelledby="image-tracking-intro-title">
    <div className={styles.cameraIntroTop}>
      <img src="/img/logo.webp" alt="HoloLab Apps" />
      <span className={styles.cameraIntroBadge}><span /> IMAGE AR</span>
    </div>

    <div className={styles.cameraIntroTitle}>
      <p>HOLOLAB PRESENTS</p>
      <h1 id="image-tracking-intro-title">Image<span>AR</span></h1>
      <strong>IMAGE TRACKING DEMO</strong>
      <small>Bring the image in front of you to life</small>
    </div>

    <div className={styles.cameraIntroActions}>
      <button type="button" className={styles.cameraStartButton} onClick={onStart}>
        Start Demo
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 12h14m-6-6 6 6-6 6" />
        </svg>
      </button>
      <p>No app needed · Runs in your browser</p>
    </div>
  </section>
);

export const ImageTrackingLoader: React.FC<{ stage: string }> = ({ stage }) => (
  <section className={styles.cameraLoadingScreen} role="status" aria-live="polite">
    <div className={styles.cameraLoadingContent}>
      <img src="/img/logo.webp" alt="HoloLab Apps" />
      <span className={styles.cameraSpinner} aria-hidden="true" />
      <strong>Preparing your image tracking experience…</strong>
      <p>{stage}</p>
    </div>
  </section>
);

export const ImageTrackingStartError: React.FC<{ onRetry: () => void; message?: string }> = ({ onRetry, message }) => (
  <section className={styles.cameraStartupError} role="alert">
    <strong>Could not start the image tracking demo</strong>
    <p>{message || 'Check camera access, then try again.'}</p>
    <button type="button" onClick={onRetry}>Try again</button>
  </section>
);
