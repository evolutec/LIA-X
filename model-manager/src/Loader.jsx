import { useEffect, useMemo, useState } from 'react';

function Loader({ show, progress = 0 }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!show) {
      setTick(0);
      return;
    }

    const intervalId = window.setInterval(() => {
      setTick((value) => value + 1);
    }, 120);

    return () => window.clearInterval(intervalId);
  }, [show]);

  const clampedProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  const isDeterminate = clampedProgress > 0;
  const dots = '.'.repeat((tick % 4) + 1);

  const stageLabel = useMemo(() => {
    if (!isDeterminate) return 'Initialisation du runtime';
    if (clampedProgress < 35) return 'Préparation des ressources';
    if (clampedProgress < 75) return 'Téléchargement et validation';
    if (clampedProgress < 100) return 'Finalisation de la configuration';
    return 'Synchronisation terminée';
  }, [clampedProgress, isDeterminate]);

  if (!show) return null;

  return (
    <>
      <div className="loader-backdrop" />
      <div className="loader-overlay" role="status" aria-live="polite" aria-busy="true">
        <section className="loader-panel" aria-label="Chargement en cours">
          <p className="loader-kicker">LIA-X Runtime</p>
          <h2 className="loader-title">Chargement{dots}</h2>
          <p className="loader-subtitle">{stageLabel}</p>

          <div className="loader-visual" aria-hidden="true">
            <div className="loader-orbit" />
            <div className="loader-core" />
            <span className="loader-core-text">AI</span>
          </div>

          <div className={`loader-progress-track ${isDeterminate ? 'determinate' : 'indeterminate'}`}>
            <div className="loader-progress-fill" style={{ width: `${isDeterminate ? clampedProgress : 42}%` }} />
          </div>

          <div className="loader-meta">
            <span>{isDeterminate ? `${Math.round(clampedProgress)}%` : 'En cours'}</span>
            <span>{isDeterminate ? 'Import modèle' : 'Connexion services'}</span>
          </div>
        </section>
      </div>
    </>
  );
}

export default Loader;

