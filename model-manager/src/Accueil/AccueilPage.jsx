import ModelDetailsModal from "./ModelDetailsModal";
import RecommendedRuntimeModal from "./RecommendedRuntimeModal";
import "./accueil.css";

/**
 * Page d'accueil : hero (modele principal, endpoint), import d'un GGUF et
 * table des modeles (chargement, principal, embedding, contexte, VRAM).
 *
 * Ce composant ne detient aucun etat : tout provient de useModelManager(), ce
 * qui laisse le shell (App.jsx) libre de piloter la navigation sans toucher au
 * contenu de la page.
 */
export default function AccueilPage(props) {
  const {
    huggingfaceUrl, setHuggingfaceUrl, ollamaName, setOllamaName,
    hfModelName, setHfModelName, modelsHostDir, openingFolder, hostPathCopied,
    setHostPathCopied, openModelsFolder, apiCopied, setApiCopied,
    modelRows, emptyState, activeModel, availableFiles, loadedModels,
    embeddingModel, embeddingModelLoading, sortColumn, sortDirection,
    handleSortClick, modelContextNeedsReload, recommendedRuntime,
    formatBytes, formatShortDate, vramSourceLabel, vramSourceBadge,
    getSliderMinContext, getSliderMaxContext, getRequestedContextForRow,
    handleContextSliderChange, handleContextSliderCommit, loading, pendingAction,
    handleLoadFile, handleUnloadModel, handleSelectLoaded, handleReloadModel, handleTogglePin, pinnedModels, toFilename,
    handleDeleteFile, handleOpenModelDetails, handleSetEmbeddingModel,
    handleUnsetEmbeddingModel, handleDownloadUrl, handleDownloadAndLoadUrl,
    handlePauseDownload, handleResumeDownload, handleDismissDownload,
    setShowRecommendedRuntimeModal, showRecommendedRuntimeModal,
    modelDetails, modelDetailsLoading, setModelDetails,
    hardwareProfile, hardwareDiagnostic, hardwareRescanLoading, rescanHardware,
    apiBaseUrl,
  } = props;

  return (
    <>
    <section className="hero-panel">
      <div className="hero-copy">
        <div className="eyebrow">Console locale</div>
        <h2>Gestion des modèles chargés et du modèle principal.</h2>
        <p>Charge un modèle, sélectionne le modèle principal, et expose le runtime sur le proxy <strong>lia-local</strong>.</p>
      </div>
      <div className="hero-routing">
        <article className="hero-route hero-route-primary"><div className="hero-route-kicker">Principal</div><h3>{activeModel || 'Aucun modèle principal'}</h3><p>{activeModel ? `Proxy lia-local diffuse le modèle principal ${activeModel}.` : 'Sélectionne un modèle chargé pour le définir comme principal.'}</p></article>
        <article className="hero-route"><div className="hero-route-kicker">Disponibles</div><h3>{availableFiles.length}</h3><p>{availableFiles.length > 0 ? 'Fichiers GGUF détectés sur disque.' : 'Aucun fichier GGUF disponible.'}</p></article>
        <article className="hero-route"><div className="hero-route-kicker">Chargés</div><h3>{loadedModels.length}</h3><p>{loadedModels.length > 0 ? 'Les modèles en mémoire sont exposés via /api/models.' : 'Aucun modèle chargé.'}</p></article>
        <article className="hero-route hero-route-endpoint">
          <div className="hero-route-kicker">🔌 Endpoint API (OpenAI-compatible)</div>
          <h3><code>{apiBaseUrl}</code></h3>
          <p>Connectez vos outils (Open WebUI, AnythingLLM, LibreChat, VS Code…) à cette adresse, avec le modèle <strong>lia-local</strong>. Aucune clé API requise.</p>
          <button type="button" className="btn btn-reload btn-sm" onClick={() => { navigator.clipboard?.writeText(apiBaseUrl); setApiCopied(true); setTimeout(() => setApiCopied(false), 2000); }}>
            {apiCopied ? '✓ Copié !' : '📋 Copier l\'adresse'}
          </button>
        </article>
      </div>
    </section>

    <div className="card download-card">
      <div className="card-title">⬇️ Importer un modèle GGUF</div>
      <div className="download-grid">
        <label className="field-block"><span className="field-label">Nom local</span><input type="text" value={hfModelName} onChange={(e) => setHfModelName(e.target.value)} placeholder="qwen2.5-coder-3b" /></label>
        <label className="field-block"><span className="field-label">Lien Hugging Face</span><input type="text" value={huggingfaceUrl} onChange={(e) => setHuggingfaceUrl(e.target.value)} placeholder="https://huggingface.co/.../resolve/model.gguf" /></label>
        <label className="field-block download-grid-span"><span className="field-label">Référence Ollama</span><input type="text" value={ollamaName} onChange={(e) => setOllamaName(e.target.value)} placeholder="gemma3n:e4b" /></label>
      </div>
      <div className="download-links">
        <a href="https://ollama.com/library" target="_blank" rel="noreferrer"><img className="link-icon ollama-icon" src="https://ollama.com/public/assets/c889cc0d-cb83-4c46-a98e-0d0e273151b9/42f6b28d-9117-48cd-ac0d-44baaf5c178e.png" alt="" aria-hidden="true" />Ollama Library</a>
        <a href="https://huggingface.co/models" target="_blank" rel="noreferrer"><img className="link-icon huggingface-icon" src="https://huggingface.co/front/assets/huggingface_logo-noborder.svg" alt="" aria-hidden="true" />Hugging Face Models</a>
      </div>


      <div className="download-actions">
        <button className="btn btn-primary btn-download" onClick={handleDownloadUrl} disabled={loading || Boolean(pendingAction)}>⬇️ Télécharger</button>
        <button className="btn btn-secondary btn-download" onClick={handleDownloadAndLoadUrl} disabled={loading || Boolean(pendingAction)}>⚡ Télécharger + charger</button>
      </div>
      <p className="download-hint">Le téléchargement se poursuit en arrière-plan (même si vous fermez cet onglet) : progression réelle, vitesse, temps restant, reprise automatique en cas de coupure, et notification dès que le modèle est prêt.</p>
    </div>

    <div className="card model-table-card">
      <div className="card-header-row">
        <div>
          <div className="card-title">🧠 Modèles</div>
          <div className="card-subtitle card-subtitle-inline">Basculer le chargement et définir le modèle principal.</div>
          {modelsHostDir && (
            <div className="models-folder-inline" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
              <span style={{ fontSize: '0.85rem', opacity: 0.85 }}>📁 Dossier de stockage :</span>
              <code style={{ fontFamily: 'monospace', fontSize: '0.85rem', wordBreak: 'break-all' }}>{modelsHostDir}</code>
              <button type="button" className="btn btn-reload btn-sm" onClick={openModelsFolder} disabled={openingFolder} title="Ouvrir le dossier des modèles dans l'Explorateur Windows">
                {openingFolder ? '⏳ Ouverture…' : '📂 Ouvrir le dossier'}
              </button>
              <button type="button" className="btn btn-reload btn-sm" onClick={() => { navigator.clipboard?.writeText(modelsHostDir); setHostPathCopied(true); setTimeout(() => setHostPathCopied(false), 2000); }} title="Copier le chemin du dossier">
                {hostPathCopied ? '✓ Copié !' : '📋 Copier le chemin'}
              </button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button type="button" className="btn btn-secondary btn-icon" onClick={() => setShowRecommendedRuntimeModal(true)} disabled={loading || Boolean(pendingAction)} title="Voir les recommandations runtime">
            ⚙️
          </button>
          <div className="auto-sync-label">Mise à jour auto</div>
        </div>
      </div>
      {emptyState ? <div className="empty-state">Aucun modèle local détecté.</div> : <div className="table-wrap"><div className="table-legend">Afficher les fichiers GGUF disponibles sur disque et les modèles chargés en mémoire. Cliquez sur un toggle pour charger / décharger.</div><table className="model-table"><thead><tr>
        <th style={{ cursor: 'pointer' }} onClick={() => handleSortClick('name')}>Nom {sortColumn === 'name' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</th>
        <th style={{ cursor: 'pointer' }} onClick={() => handleSortClick('status')}>État {sortColumn === 'status' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</th>
        <th style={{ cursor: 'pointer' }} onClick={() => handleSortClick('diskSize')}>Taille {sortColumn === 'diskSize' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</th>
        <th style={{ cursor: 'pointer' }} onClick={() => handleSortClick('contextLength')}>Context {sortColumn === 'contextLength' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</th>
        <th style={{ cursor: 'pointer' }} onClick={() => handleSortClick('vramSize')}>VRAM {sortColumn === 'vramSize' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</th>
        <th style={{ cursor: 'pointer' }} onClick={() => handleSortClick('modifiedAt')}>Modifié {sortColumn === 'modifiedAt' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</th>
        <th style={{ cursor: 'pointer' }} onClick={() => handleSortClick('expiresAt')}>Expire {sortColumn === 'expiresAt' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</th>
          <th>Infos</th><th>Chargé</th><th>Épinglé</th><th>Principal</th><th>Embedding</th><th>Supprimer</th>
       </tr></thead><tbody>
        {modelRows.map((row) => (
          <tr key={row.name} className={[row.loaded ? 'row-loaded' : '', row.active ? 'row-active' : '', pendingAction?.model === row.name ? 'row-pending' : ''].filter(Boolean).join(' ')}>
            <td className="col-name"><div className="table-model-name">{row.filename || row.name}</div></td>
            <td><div className="state-stack">{row.partial && (
              <span className="badge badge-partial" title={row.partialJob?.paused ? 'Téléchargement en pause — cliquez sur Reprendre' : (row.partialJob?.retry_message || 'Téléchargement en cours')}>
                {row.partialJob?.paused ? '⏸ En pause' : '⬇ Téléchargement'}{row.partialJob?.total_bytes ? ` ${row.partialJob.percent ?? 0} %` : ''}
              </span>
            )}{!row.partial && row.active && <span className="badge badge-success">✓ Principal</span>}{!row.partial && !row.active && row.loaded && <span className="badge badge-loaded">En mémoire</span>}{!row.partial && !row.loaded && <span className="badge badge-neutral">Disponible</span>}{pendingAction?.model === row.name && <span className="badge badge-pending"><span className="spinner spinner-small" /> {pendingAction.type}…</span>}</div></td>
            <td>{row.partial
              ? `${formatBytes(row.partialJob?.received_bytes ?? 0)}${row.partialJob?.total_bytes ? ` / ${formatBytes(row.partialJob.total_bytes)}` : ''}`
              : formatBytes(row.diskSize)}</td>
            <td>
              <div className="context-cell">
                <div className="context-values">
                  <span className="badge badge-loaded">{row.partial ? '—' : `${getRequestedContextForRow(row)} / ${row.contextLength ?? '?'} tokens`}</span>
                </div>
                <input
                  type="range"
                  min={getSliderMinContext()}
                  max={Math.max(getSliderMaxContext(row), getRequestedContextForRow(row))}
                  step={256}
                  value={getRequestedContextForRow(row)}
                  onChange={(event) => handleContextSliderChange(row, event.target.value)}
                  onMouseUp={() => handleContextSliderCommit(row)}
                  onTouchEnd={() => handleContextSliderCommit(row)}
                  disabled={loading || Boolean(pendingAction) || row.partial}
                  aria-label={`Context length pour ${row.name}`}
                />
                {row.loaded && modelContextNeedsReload[row.name] && (
                  <div className="context-reload-row">
                    <div className="context-reload-note">Modifié : recharger pour appliquer.</div>
                    <button
                      type="button"
                      className="btn btn-reload btn-sm"
                      onClick={() => handleReloadModel(row.name)}
                      disabled={loading || Boolean(pendingAction)}
                    >
                      ⟳ Recharger
                    </button>
                  </div>
                )}
                <div className="gpu-summary">
                  <span className="badge badge-neutral">gpu_layers metadata: {row.gpuLayers ?? '—'}</span>
                  <span className="badge badge-loaded">gpu_layers recommandé: {recommendedRuntime?.gpu_layers ?? 'auto'}</span>
                </div>
              </div>
            </td>
            <td>{row.vramSize ? (
              <span className="vram-cell" title={vramSourceLabel(row)}>
                <span className="vram-values">
                  {formatBytes(row.vramSize)}
                  {vramSourceBadge(row.vramSource) && (
                    <span className={`vram-source vram-source-${row.vramSource}`}>{vramSourceBadge(row.vramSource)}</span>
                  )}
                </span>
                {row.vramPeak && row.vramPeak > row.vramSize * 1.5 && (
                  <span className="vram-peak">pic {formatBytes(row.vramPeak)}</span>
                )}
              </span>
            ) : '—'}</td>
            <td>{formatShortDate(row.modifiedAt)}</td>
            <td>{formatShortDate(row.expiresAt)}</td>
            <td><button className="btn btn-secondary btn-icon" onClick={() => handleOpenModelDetails(row.name)} disabled={loading || Boolean(pendingAction) || row.partial} title={row.partial ? `Téléchargement en cours de ${row.name}` : `Détails ${row.name}`}>ℹ️</button></td>
            <td>
              <button className={`btn btn-table btn-toggle ${row.loaded ? 'btn-toggle-on' : 'btn-toggle-off'}`} onClick={() => row.loaded ? handleUnloadModel(row.name) : handleLoadFile(row.name)} disabled={loading || Boolean(pendingAction) || row.partial} aria-pressed={row.loaded} aria-label={row.loaded ? `${row.name} chargé` : `${row.name} disponible`}>
                <span className="toggle-switch" aria-hidden="true">
                  <span className="toggle-knob" />
                </span>
                <span className="toggle-led" aria-hidden="true" />
              </button>
            </td>
              <td>
                <button
                  className={`btn btn-table btn-toggle ${pinnedModels.has(toFilename(row.name)) ? 'btn-toggle-on' : 'btn-toggle-off'}`}
                  onClick={() => handleTogglePin(row.name)}
                  disabled={loading || Boolean(pendingAction) || row.partial}
                  aria-pressed={pinnedModels.has(toFilename(row.name))}
                  title={pinnedModels.has(toFilename(row.name))
                    ? `Désépingler ${row.name} : il pourra se décharger après inactivité`
                    : `Épingler ${row.name} : il restera chargé en VRAM en permanence`}
                  aria-label={pinnedModels.has(toFilename(row.name)) ? `${row.name} épinglé` : `Épingler ${row.name}`}
                >
                  <span className="toggle-switch" aria-hidden="true">
                    <span className="toggle-knob" />
                  </span>
                  <span className="toggle-led" aria-hidden="true" />
                </button>
              </td>
            <td>
              <button className={`btn btn-table btn-toggle ${row.active ? 'btn-toggle-on' : 'btn-toggle-off'}`} onClick={() => handleSelectLoaded(row.name)} disabled={loading || Boolean(pendingAction) || !row.loaded || row.active || row.partial} aria-pressed={row.active} aria-label={row.active ? `${row.name} principal` : `Définir ${row.name} principal`}>
                <span className="toggle-switch" aria-hidden="true">
                  <span className="toggle-knob" />
                </span>
                <span className="toggle-led" aria-hidden="true" />
              </button>
              </td>
              <td>
                <button className={`btn btn-table btn-toggle ${embeddingModel === row.name ? 'btn-toggle-on' : 'btn-toggle-off'}`} onClick={() => embeddingModel === row.name ? handleUnsetEmbeddingModel() : handleSetEmbeddingModel(row.name)} disabled={loading || Boolean(pendingAction) || embeddingModelLoading || row.partial} aria-pressed={embeddingModel === row.name} aria-label={embeddingModel === row.name ? `${row.name} modele d'embedding` : `Definir ${row.name} comme modele d'embedding`}>
                  <span className="toggle-switch" aria-hidden="true">
                    <span className="toggle-knob" />
                  </span>
                  <span className="toggle-led" aria-hidden="true" />
                </button>
              </td>
              <td>
                {row.partial ? (
                  <div className="partial-actions">
                    {row.partialJob && !row.partialJob.paused && (
                      <button type="button" className="btn btn-reload btn-sm" onClick={() => handlePauseDownload(row.partialJob)} disabled={loading || !row.partialJob} title={`Mettre en pause le téléchargement de ${row.name}`}>
                        ⏸ Pause
                      </button>
                    )}
                    {row.partialJob?.paused && (
                      <button type="button" className="btn btn-reload btn-sm" onClick={() => handleResumeDownload(row.partialJob)} disabled={loading || !row.partialJob} title={`Reprendre le téléchargement de ${row.name}`}>
                        ▶ Reprendre
                      </button>
                    )}
                    <button type="button" className="btn btn-icon btn-delete" onClick={() => handleDismissDownload(row.partialJob)} disabled={loading || !row.partialJob} title={`Annuler le téléchargement et supprimer le fichier .part de ${row.name}`}>
                      ✕
                    </button>
                  </div>
                ) : (
                  <button className="btn btn-icon btn-delete" onClick={() => handleDeleteFile(row.filename)} disabled={loading || Boolean(pendingAction)} title={`Supprimer ${row.name}`}>
                    🗑️
                  </button>
                )}
              </td>
           </tr>
        ))}
      </tbody></table></div>}
    </div>

    <ModelDetailsModal
      modelDetails={modelDetails}
      modelDetailsLoading={modelDetailsLoading}
      onClose={() => setModelDetails(null)}
    />
    {showRecommendedRuntimeModal && (
      <RecommendedRuntimeModal
        recommendedRuntime={recommendedRuntime}
        hardwareProfile={hardwareProfile}
        hardwareDiagnostic={hardwareDiagnostic}
        hardwareRescanLoading={hardwareRescanLoading}
        onRescan={rescanHardware}
        onClose={() => setShowRecommendedRuntimeModal(false)}
      />
    )}
    </>
  );
}
