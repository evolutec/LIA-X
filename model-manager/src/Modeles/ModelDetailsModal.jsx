import { useMemo } from "react";

function formatDetailValue(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${value.map((item) => String(item)).join(", ")}]`;
  }
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "boolean") {
    return value ? "Oui" : "Non";
  }
  return String(value);
}

/**
 * Modale « Détails du modèle » : métadonnées GGUF et aperçu technique.
 * Extraite de App.jsx, elle était auparavant rendue par le shell alors
 * qu'elle n'est actionnable que depuis la page d'accueil.
 */
export default function ModelDetailsModal({ modelDetails, modelDetailsLoading, onClose }) {
  if (!modelDetails) return null;

  const metadataRows = useMemo(() => {
    const rows = [...(modelDetails.gguf?.metadata || [])];
    rows.sort((a, b) => {
      const aGeneral = a.key.startsWith("general.");
      const bGeneral = b.key.startsWith("general.");
      if (aGeneral !== bGeneral) return aGeneral ? -1 : 1;
      return a.key.localeCompare(b.key, "fr", { sensitivity: "base" });
    });
    return rows;
  }, [modelDetails]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Détails du modèle ${modelDetails.model?.name || ''}`}>
    <div className="modal-card">
      <div className="modal-header-row">
        <div>
          <h2>Détails du modèle</h2>
          <p className="card-subtitle">Lecture des métadonnées GGUF et aperçu technique du modèle.</p>
        </div>
        <button type="button" className="btn btn-secondary btn-close-modal" onClick={onClose}>
          Fermer
        </button>
      </div>

      <div className="modal-content-grid">
        <section className="modal-section">
          <h3>Informations modèle</h3>
          <table className="metadata-table">
            <tbody>
              <tr>
                <th>Nom</th>
                <td>{modelDetails.model?.name || '—'}</td>
              </tr>
              <tr>
                <th>Fichier</th>
                <td>{modelDetails.model?.filename || '—'}</td>
              </tr>
              <tr>
                <th>Taille sur disque</th>
                <td>{formatBytes(modelDetails.model?.size)}</td>
              </tr>
              <tr>
                <th>Modifié</th>
                <td>{formatShortDate(modelDetails.model?.modified_at)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="modal-section">
          <h3>Résumé GGUF</h3>
          <table className="metadata-table">
            <tbody>
              <tr>
                <th>Architecture</th>
                <td>{modelDetails.gguf?.architecture || '—'}</td>
              </tr>
              <tr>
                <th>Version GGUF</th>
                <td>{modelDetails.gguf?.version ?? '—'}</td>
              </tr>
              <tr>
                <th>Context length</th>
                <td>{modelDetails.gguf?.context_length ?? '—'}</td>
              </tr>
              <tr>
                <th>Tensor count</th>
                <td>{String(modelDetails.gguf?.tensor_count ?? '—')}</td>
              </tr>
              <tr>
                <th>KV count</th>
                <td>{String(modelDetails.gguf?.kv_count ?? '—')}</td>
              </tr>
              <tr>
                <th>Clés metadata</th>
                <td>{String(modelDetails.gguf?.metadata?.length ?? 0)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="modal-section modal-table-wrap">
          <div className="card-header-row" style={{ padding: 0 }}>
            <h3 style={{ margin: 0 }}>Métadonnées GGUF</h3>
            {modelDetailsLoading && <span className="badge badge-neutral">Chargement...</span>}
          </div>
          {metadataRows.length === 0 ? (
            <div className="modal-empty-state">Aucune métadonnée détectée dans ce GGUF.</div>
          ) : (
            <div className="table-wrap">
              <table className="metadata-table">
                <thead>
                  <tr>
                    <th>Clé</th>
                    <th>Type</th>
                    <th>Valeur</th>
                  </tr>
                </thead>
                <tbody>
                  {metadataRows.map((item) => (
                    <tr key={item.key}>
                      <td className="metadata-key">{item.key}</td>
                      <td className="metadata-type">{item.type}</td>
                      <td className="metadata-value-cell"><p className="metadata-value">{formatDetailValue(item.value_display)}</p></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
    </div>
  );
}
