import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './ModelDownloads.css';

function formatBytes(value) {
  if (value == null || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let size = number;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '—';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (minutes > 0) return `${minutes} min ${String(remaining).padStart(2, '0')} s`;
  return `${remaining} s`;
}

function formatSpeed(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0;
  return value > 0 ? `${formatBytes(value)}/s` : '—';
}

// Notification système (visible même si l'onglet est en arrière-plan).
export function notifyBrowser(title, body) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // eslint-disable-next-line no-new
    new Notification(title, { body, tag: `lia-x-${title}`, icon: '/logo.svg' });
  } catch {
    /* notifications non supportées par le navigateur */
  }
}

export function requestNotificationPermission() {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  } catch {
    /* noop */
  }
}

function ModelDownloads({ downloads = [], onCancel, onDismiss, onLoad, onPause, onResume }) {
  const [collapsed, setCollapsed] = useState(false);
  const [toasts, setToasts] = useState([]);
  const previousRef = useRef(new Map());

  const pushToast = useCallback((toast) => {
    setToasts((current) => [...current.filter((item) => item.id !== toast.id), toast]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== toast.id));
    }, 25000);
  }, []);

  // Notifications de fin / d'erreur, quel que soit l'état du panneau.
  useEffect(() => {
    const previous = previousRef.current;
    const seen = new Set();

    downloads.forEach((job) => {
      seen.add(job.id);
      const before = previous.get(job.id);
      previous.set(job.id, job);
      if (!before) return; // premier affichage : pas de notification

      if (!before.done && job.done) {
        pushToast({
          id: `done-${job.id}`,
          type: 'success',
          title: 'Téléchargement terminé',
          message: `${job.filename} est prêt à être chargé.`,
          job,
        });
        notifyBrowser('LIA-X — téléchargement terminé', `${job.filename} est prêt à être chargé.`);
      } else if (!before.error && job.error) {
        pushToast({
          id: `error-${job.id}`,
          type: 'error',
          title: 'Téléchargement en échec',
          message: `${job.filename} : ${job.error}`,
          job,
        });
        notifyBrowser('LIA-X — téléchargement en échec', job.error);
      }
    });

    for (const id of [...previous.keys()]) {
      if (!seen.has(id)) previous.delete(id);
    }
  }, [downloads, pushToast]);

  const activeJobs = useMemo(() => downloads.filter((job) => job.active), [downloads]);
  const finishedJobs = useMemo(() => downloads.filter((job) => !job.active), [downloads]);
  const ordered = useMemo(() => [...activeJobs, ...finishedJobs], [activeJobs, finishedJobs]);

  if (ordered.length === 0 && toasts.length === 0) return null;

  return (
    <>
      {toasts.length > 0 && (
        <div className="download-toasts" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`download-toast ${toast.type}`}>
              <div className="download-toast-body">
                <strong>{toast.type === 'success' ? '✅' : '⚠️'} {toast.title}</strong>
                <span>{toast.message}</span>
              </div>
              <div className="download-toast-actions">
                {toast.type === 'success' && toast.job && onLoad && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      onLoad(toast.job.model);
                      setToasts((current) => current.filter((item) => item.id !== toast.id));
                    }}
                  >
                    ⚡ Charger
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
                >
                  Fermer
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {ordered.length > 0 && (
        <aside className={`downloads-panel${collapsed ? ' collapsed' : ''}`} aria-label="Téléchargements de modèles">
          <header className="downloads-panel-head">
            <strong>
              ⬇️ Téléchargements
              {activeJobs.length > 0 && <span className="downloads-badge">{activeJobs.length}</span>}
            </strong>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCollapsed((value) => !value)}>
              {collapsed ? 'Afficher' : 'Réduire'}
            </button>
          </header>

          {!collapsed && (
            <div className="downloads-list">
              {ordered.map((job) => {
                const percent = Number(job.percent) || 0;
                const determinate = Number(job.total_bytes) > 0;
                const classes = [
                  'download-item',
                  job.active ? 'active' : '',
                  job.done ? 'done' : '',
                  job.error ? 'error' : '',
                  job.cancelled ? 'cancelled' : '',
                ].filter(Boolean).join(' ');

                return (
                  <article key={job.id} className={classes}>
                    <div className="download-item-head">
                      <span className="download-item-name" title={job.filename}>{job.filename}</span>
                      <span className="download-item-percent">
                        {job.done ? '100 %' : (determinate ? `${percent} %` : formatBytes(job.received_bytes))}
                      </span>
                    </div>

                    <div className={`download-bar${determinate ? '' : ' indeterminate'}`}>
                      <div className="download-bar-fill" style={determinate ? { width: `${Math.min(100, percent)}%` } : undefined} />
                    </div>

                    <div className="download-item-meta">
                      <span>
                        {formatBytes(job.received_bytes)}
                        {job.total_bytes ? ` / ${formatBytes(job.total_bytes)}` : ''}
                      </span>
                      {job.active && <span>{formatSpeed(job.speed_bps)}</span>}
                      {job.active && job.eta_seconds ? <span>reste {formatDuration(job.eta_seconds)}</span> : null}
                      {job.active && job.resumable ? <span>reprise auto</span> : null}
                      {job.attempts > 1 && job.active ? <span>essai {job.attempts}</span> : null}
                    </div>

                    {job.retry_message && <div className="download-item-note">{job.retry_message}</div>}
                    {job.error && <div className="download-item-error">{job.error}</div>}
                    {job.cancelled && <div className="download-item-note">Téléchargement annulé (fichier partiel conservé pour une reprise).</div>}

                    <div className="download-item-actions">
                      {job.active && !job.paused && (
                        <>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onPause?.(job)}>
                            ⏸ Pause
                          </button>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCancel?.(job)}>
                            Annuler
                          </button>
                        </>
                      )}
                      {job.paused && (
                        <>
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => onResume?.(job)}>
                            ▶ Reprendre
                          </button>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCancel?.(job)}>
                            Annuler
                          </button>
                        </>
                      )}
                      {job.done && (
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => onLoad?.(job.model)}>
                          ⚡ Charger
                        </button>
                      )}
                      {!job.active && !job.paused && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onDismiss?.(job)}>
                          Retirer
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </aside>
      )}
    </>
  );
}

export default ModelDownloads;
