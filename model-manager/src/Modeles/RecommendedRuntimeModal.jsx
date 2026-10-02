import "./modeles.css";

/**
 * Modale « Recommandations runtime » : backend, contexte et gpu_layers
 * conseilles par la detection materielle, avec reanalyse a la volee.
 *
 * Cette modale etait definie dans App.jsx mais jamais appelee : le bouton
 * d'engrenage de la page d'accueil positionnait l'etat sans rien afficher.
 * Elle est desormais rendue par la page d'accueil.
 */
export default function RecommendedRuntimeModal({
  recommendedRuntime,
  hardwareProfile,
  hardwareDiagnostic,
  hardwareRescanLoading,
  onRescan,
  onClose,
}) {
  if (!recommendedRuntime) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Recommandations runtime">
    <div className="modal-card">
      <div className="modal-header-row">
        <div>
          <h2 style={{ margin: 0 }}>Recommandations runtime</h2>
          <p style={{ margin: '0.5rem 0 0' }}>Valeurs utilisées pour charger ou sélectionner un modèle.</p>
        </div>
        <button type="button" className="btn btn-secondary btn-close-modal" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="modal-content-grid">
        <section className="modal-section">
          <div className="summary-stack">
            <div className="summary-title">Backend recommandé</div>
            <div>{recommendedRuntime?.backend || 'Auto'}</div>
          </div>
          <div className="summary-stack">
            <div className="summary-title">Contexte recommandé</div>
            <div>{recommendedRuntime?.context ? `${recommendedRuntime.context} tokens` : 'Auto'}</div>
          </div>
          <div className="summary-stack">
            <div className="summary-title">gpu_layers recommandé</div>
            <div>{recommendedRuntime?.gpu_layers ?? 'Auto'}</div>
          </div>
          <div className="summary-stack">
            <div className="summary-title">GPU détecté</div>
            <div>{hardwareProfile?.gpu?.label || hardwareProfile?.label || 'Aucun'}</div>
          </div>
          <div className="summary-stack">
            <div className="summary-title">Backend actif</div>
            <div>
              {hardwareDiagnostic?.backend_label || hardwareDiagnostic?.backend || 'Inconnu'}
              {hardwareDiagnostic?.binary_validated ? ' — binaire validé' : ''}
            </div>
          </div>
          {hardwareDiagnostic?.capabilities && (
            <div className="summary-stack">
              <div className="summary-title">Capacités réellement détectées</div>
              <div>
                {['cuda', 'rocm', 'vulkan', 'cpu'].map((name) => {
                  const cap = hardwareDiagnostic.capabilities[name];
                  if (!cap) return null;
                  return (
                    <div key={name} title={cap.detail || ''}>
                      {cap.available ? '✓' : '✗'} {name}{cap.source ? ` (${cap.source})` : ''}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {hardwareDiagnostic?.gpu_memory_gb && (
            <div className="summary-stack">
              <div
                className="summary-title"
                title={hardwareDiagnostic.gpu_memory_gb.is_unified
                  ? 'iGPU : mémoire unifiée partagée avec la RAM, pas de VRAM dédiée.'
                  : 'VRAM dédiée rapportée par le pilote.'}
              >
                Mémoire GPU
              </div>
              <div>
                {hardwareDiagnostic.gpu_memory_gb.is_unified
                  ? `unifiée ${hardwareDiagnostic.gpu_memory_gb.unified ?? '?'} Go — utilisable ${hardwareDiagnostic.gpu_memory_gb.usable ?? '?'} Go`
                  : `dédiée ${hardwareDiagnostic.gpu_memory_gb.dedicated ?? '?'} Go`}
              </div>
            </div>
          )}
          {hardwareDiagnostic?.binary_version && (
            <div className="summary-stack">
              <div className="summary-title">Binaire llama.cpp</div>
              <div title={hardwareDiagnostic.binary_path || ''}>{hardwareDiagnostic.binary_version}</div>
            </div>
          )}
          {hardwareDiagnostic?.fallback_reason && (
            <div className="summary-stack">
              <div className="summary-title">Repli appliqué</div>
              <div>{hardwareDiagnostic.fallback_reason}</div>
            </div>
          )}
          <div className="summary-stack">
            <div className="summary-title">Réanalyse matérielle</div>
            <button
              type="button"
              className="btn btn-reload btn-sm"
              onClick={onRescan}
              disabled={hardwareRescanLoading}
              title="Relancer la détection matérielle (même code que l'installateur), sans réinstaller"
            >
              {hardwareRescanLoading ? '⏳ Analyse en cours...' : '🔄 Réanalyser le matériel'}
            </button>
          </div>
        </section>
        <section className="modal-section">
          <div className="modal-section-title">Requête UI</div>
          <div className="modal-note">Le contexte sélectionné dans le slider est utilisé par le serveur et transmis au controller dans la requête de démarrage.</div>
          <div className="summary-stack">
            <div className="summary-title">Contexte actif</div>
            <div>{recommendedRuntime?.context ? `${recommendedRuntime.context} tokens` : 'Auto'}</div>
          </div>
        </section>
      </div>
    </div>
    </div>
  );
}
