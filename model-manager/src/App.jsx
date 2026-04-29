import { useEffect, useMemo, useState } from "react";
import ContainerLogs from "./ContainerLogs";
import Performance from "./Performance";
import Loader from "./Loader";
import Documentation from "./Documentation";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

function App() {
  const [huggingfaceUrl, setHuggingfaceUrl] = useState("");
  const [ollamaName, setOllamaName] = useState("");
  const [hfModelName, setHfModelName] = useState("");
  const [availableFiles, setAvailableFiles] = useState([]);
  const [loadedModels, setLoadedModels] = useState([]);
  const [activeModel, setActiveModel] = useState("");
  const [version, setVersion] = useState(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [controllerHealth, setControllerHealth] = useState({ ok: true, controller_ok: true, detail: '', runtime: null });
  const [controllerLoading, setControllerLoading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [sortColumn, setSortColumn] = useState("name");
  const [sortDirection, setSortDirection] = useState("asc");
  const [currentPage, setCurrentPage] = useState('home');
  const [modelDetails, setModelDetails] = useState(null);
  const [modelDetailsLoading, setModelDetailsLoading] = useState(false);
  const [modelContextOverrides, setModelContextOverrides] = useState({});
  const [modelContextNeedsReload, setModelContextNeedsReload] = useState({});
  const [hardwareProfile, setHardwareProfile] = useState(null);
  const [recommendedRuntime, setRecommendedRuntime] = useState(null);
  const [showRecommendedRuntimeModal, setShowRecommendedRuntimeModal] = useState(false);

  useEffect(() => {
    refreshAllModelState();
    fetchControllerHealth();
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (!loading && !pendingAction) {
        refreshAllModelState({ silent: true });
        fetchControllerHealth();
      }
    }, 25000);
    return () => window.clearInterval(intervalId);
  }, [loading, pendingAction]);

  function log(...args) {
    // LOGS DÉSACTIVÉS PAR DÉFAUT: commenter pour réactiver
    // console.log('[App]', ...args);
  }

  function normalizeUrl(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  async function parseJson(response) {
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }

  async function apiFetch(path, options = {}) {
    const url = `${apiBase}${path}`;
    const init = {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      cache: 'no-store',
      ...options,
    };
    if (options.body !== undefined && typeof options.body !== 'string') {
      init.body = JSON.stringify(options.body);
    }
    if (!init.body) {
      delete init.body;
    }

    // LOGS DÉSACTIVÉS POUR LES REQUÊTES GET SILENCIEUSES
    // log('fetch', init.method, url, options.body || 'no body');
    const response = await fetch(url, init);
    const payload = await parseJson(response);
    // LOGS DÉSACTIVÉS POUR LES RÉPONSES
    // log('fetch result', init.method, url, response.status, payload);
    if (!response.ok) {
      const message = payload?.detail || payload?.message || response.statusText || String(payload);
      throw new Error(message);
    }
    return payload;
  }

  async function fetchControllerHealth() {
    setControllerLoading(true);
    try {
      const data = await apiFetch('/health');
      setControllerHealth(data);
    } catch (err) {
      setControllerHealth({ ok: false, controller_ok: false, detail: err?.message || 'Impossible de contacter le contrôleur', runtime: null });
    } finally {
      setControllerLoading(false);
    }
  }

  async function handleRestartController() {
    if (loading || pendingAction) return;
    setLoading(true);
    setPendingAction({ model: 'controller', type: 'redémarrage' });
    updateStatus('Redémarrage du contrôleur...');
    try {
      await apiFetch('/api/controller/restart', { method: 'POST' });
      await fetchControllerHealth();
      await refreshAllModelState({ silent: true });
      updateStatus('Contrôleur redémarré.');
    } catch (err) {
      updateStatus(`Échec du redémarrage du contrôleur — ${err.message}`);
      throw err;
    } finally {
      setPendingAction(null);
      setLoading(false);
    }
  }

  function formatBytes(value) {
    if (value == null || value === '') return '—';
    const number = Number(value);
    if (Number.isNaN(number)) return String(value);
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = number;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size.toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
  }

  function formatShortDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function sortRows(rows) {
    return rows.sort((a, b) => {
      if (sortColumn === 'name') {
        return sortDirection === 'asc'
          ? a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })
          : b.name.localeCompare(a.name, 'fr', { sensitivity: 'base' });
      }
      if (sortColumn === 'status') {
        const order = (item) => (item.active ? 0 : item.loaded ? 1 : 2);
        return sortDirection === 'asc' ? order(a) - order(b) : order(b) - order(a);
      }
      if (sortColumn === 'contextLength') {
        const valueA = Number(a.contextLength) || 0;
        const valueB = Number(b.contextLength) || 0;
        return sortDirection === 'asc' ? valueA - valueB : valueB - valueA;
      }
      if (sortColumn === 'gpuLayers') {
        const valueA = Number(a.gpuLayers) || 0;
        const valueB = Number(b.gpuLayers) || 0;
        return sortDirection === 'asc' ? valueA - valueB : valueB - valueA;
      }
      const valueA = a[sortColumn] ?? 0;
      const valueB = b[sortColumn] ?? 0;
      return sortDirection === 'asc' ? valueA - valueB : valueB - valueA;
    });
  }

  function normalizeContextValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const rounded = Math.round(number);
    return rounded > 0 ? rounded : null;
  }

  function getSliderMinContext() {
    return 512;
  }

  function getRowRuntimeContext(row) {
    if (!row) return null;
    if (row.loaded && normalizeContextValue(row?.runtimeContextLength) !== null) {
      return normalizeContextValue(row.runtimeContextLength);
    }
    return normalizeContextValue(row?.contextLength);
  }

  function getSliderMaxContext(row) {
    const runtimeContext = getRowRuntimeContext(row);
    const recommended = normalizeContextValue(recommendedRuntime?.context);
    const metadataContext = normalizeContextValue(row?.contextLength);
    const baseMax = runtimeContext ?? 32768;
    return Math.max(getSliderMinContext(), baseMax, recommended ?? 0, metadataContext ?? 0);
  }

  function getDefaultContext(row) {
    const runtimeContext = getRowRuntimeContext(row);
    const recommended = normalizeContextValue(recommendedRuntime?.context);
    if (runtimeContext !== null) {
      return runtimeContext;
    }
    if (recommended !== null) {
      return recommended;
    }
    return 8192;
  }

  function getRequestedContextForRow(row) {
    if (!row?.name) return getDefaultContext(row);
    const override = normalizeContextValue(modelContextOverrides[row.name]);
    if (override) return override;
    return getDefaultContext(row);
  }

  function handleContextSliderChange(row, rawValue) {
    if (!row?.name) return;
    const normalized = normalizeContextValue(rawValue);
    if (!normalized) return;

    setModelContextOverrides((current) => ({
      ...current,
      [row.name]: normalized,
    }));

    if (row.loaded) {
      setModelContextNeedsReload((current) => ({
        ...current,
        [row.name]: true,
      }));
    }
  }

  function handleContextSliderCommit(row) {
    if (!row?.name || !row.loaded) return;
    updateStatus(`${row.name}: contexte modifié (${getRequestedContextForRow(row)}). Déchargez/rechargez le modèle pour appliquer.`);
  }


  function buildRows() {
    // On veut une ligne pour chaque fichier du dossier, enrichie si chargé
    const fileMap = new Map();
    availableFiles.forEach((file) => {
      const name = String(file?.name || '');
      if (!name) return;
      const rawGpuLayers = Number(file.gpu_layers);
      fileMap.set(name, {
        name,
        filename: file.filename || `${name}.gguf`,
        loaded: !!file.loaded,
        active: name === activeModel,
        diskSize: file.size ?? null,
        modifiedAt: file.modified_at ?? null,
        vramSize: null,
        expiresAt: null,
        contextLength: normalizeContextValue(file.context_length),
        runtimeContextLength: null,
        gpuLayers: Number.isFinite(rawGpuLayers) ? rawGpuLayers : null,
      });
    });
    // Pour chaque modèle chargé, fusionne les infos si déjà dans le dossier, sinon ajoute une ligne "orpheline"
    loadedModels.forEach((item) => {
      const name = String(item?.model || '');
      if (!name) return;
  const itemContext = normalizeContextValue(item.context_length) ?? normalizeContextValue(item.context);
      if (fileMap.has(name)) {
        const base = fileMap.get(name);
        fileMap.set(name, {
          ...base,
          loaded: true,
          active: name === activeModel,
          vramSize: item.size_vram ?? base.vramSize,
          expiresAt: item.expires_at ?? base.expiresAt,
          contextLength: base.contextLength ?? itemContext ?? null,
          runtimeContextLength: itemContext ?? base.runtimeContextLength ?? null,
          gpuLayers: base.gpuLayers ?? null,
        });
      } else {
        fileMap.set(name, {
          name,
          filename: item.filename || `${name}.gguf`,
          loaded: true,
          active: name === activeModel,
          diskSize: null,
          modifiedAt: null,
          vramSize: item.size_vram ?? null,
          expiresAt: item.expires_at ?? null,
          contextLength: itemContext ?? null,
          runtimeContextLength: itemContext ?? null,
          gpuLayers: null,
        });
      }
    });
    return sortRows(Array.from(fileMap.values()));
  }

  function updateStatus(message) {
    setStatusMessage(message);
    log('status', message);
  }

  async function refreshHardwareProfile(silent = false) {
    try {
      const data = await apiFetch('/api/hardware-profile');
      setHardwareProfile(data.profile || null);
      setRecommendedRuntime(data.recommended_runtime || null);
    } catch (err) {
      setHardwareProfile(null);
      setRecommendedRuntime(null);
      if (!silent) updateStatus(`Impossible de lire le profil matériel : ${err.message}`);
    }
  }

  async function refreshAllModelState(options = {}) {
    const { silent = false } = options;
    // LOG DÉSACTIVÉ:
    // log('refreshAllModelState', options);
    try {
      await Promise.all([
        refreshVersion(silent),
        refreshAvailableFiles(silent),
        refreshLoadedModels(silent),
        refreshActiveModel(silent),
        refreshHardwareProfile(silent),
      ]);
      if (!silent) updateStatus('Synchronisation terminée.');
    } catch (err) {
      if (!silent) updateStatus(`Erreur de synchronisation : ${err.message}`);
    }
  }

  async function refreshVersion(silent = false) {
    try {
      const data = await apiFetch('/api/version');
      setVersion(data);
    } catch (err) {
      setVersion(null);
      if (!silent) updateStatus(`Impossible de lire la version : ${err.message}`);
    }
  }

  async function refreshAvailableFiles(silent = false) {
    try {
      const data = await apiFetch('/api/models/available');
      setAvailableFiles(Array.isArray(data.files) ? data.files : []);
    } catch (err) {
      setAvailableFiles([]);
      if (!silent) updateStatus(`Impossible de lister les fichiers : ${err.message}`);
    }
  }

  async function refreshLoadedModels(silent = false) {
    try {
      const data = await apiFetch('/api/models');
      setLoadedModels(Array.isArray(data.models) ? data.models : []);
    } catch (err) {
      setLoadedModels([]);
      if (!silent) updateStatus(`Impossible de lire les modèles chargés : ${err.message}`);
    }
  }

  async function refreshActiveModel(silent = false) {
    try {
      const data = await apiFetch('/api/models/active');
      setActiveModel(data.active_model || '');
    } catch (err) {
      setActiveModel('');
      if (!silent) updateStatus(`Impossible de lire le modèle principal : ${err.message}`);
    }
  }

  async function refreshModelsState(silent = false) {
    await Promise.all([refreshLoadedModels(silent), refreshActiveModel(silent)]);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function performAction(modelName, actionType, callback) {
    if (loading || pendingAction) return;
    setLoading(true);
    setPendingAction({ model: modelName, type: actionType });
    updateStatus(`${modelName} : ${actionType}...`);
    try {
      const result = await callback();
      log('action', actionType, modelName, result);
      await delay(250);
      await refreshModelsState(true);
      await refreshAllModelState({ silent: true });
      
      // Clear fetch cache to prevent stale state on next actions
      if ('caches' in window) {
        try {
          const cacheNames = await caches.keys();
          for (const name of cacheNames) {
            await caches.delete(name);
          }
        } catch (e) { /* ignore cache errors */ }
      }
      
      updateStatus(`${modelName} : ${actionType} terminé.`);
      return result;
    } catch (err) {
      console.error('[App] action error', actionType, modelName, err);
      updateStatus(`${modelName} : échec ${actionType} — ${err.message}`);
      try {
        await refreshAllModelState({ silent: true });
      } catch (refreshErr) {
        console.warn('[App] post-error refresh failed', refreshErr);
      }
      return null;
    } finally {
      setPendingAction(null);
      setLoading(false);
    }
  }

  async function handleLoadFile(modelName) {
    if (!modelName) return;
    const row = buildRows().find((item) => item.name === modelName);
    const requestedContext = getRequestedContextForRow(row);
    const payload = {
      model: modelName,
      context: requestedContext,
    };
    if (recommendedRuntime?.gpu_layers !== undefined && recommendedRuntime?.gpu_layers !== null) {
      payload.gpu_layers = recommendedRuntime.gpu_layers;
    }
    log('load payload', payload);
    const result = await performAction(modelName, 'chargement', async () => apiFetch('/api/models/load', {
      method: 'POST',
      body: payload,
    }));

    if (result) {
      setModelContextNeedsReload((current) => ({
        ...current,
        [modelName]: false,
      }));
    }

    return result;
  }

  async function handleSelectLoaded(modelName) {
    if (!modelName) return;
    if (modelName === activeModel) {
      updateStatus(`${modelName} est déjà principal.`);
      return;
    }

    const row = buildRows().find((r) => r.name === modelName);
    if (!row) {
      updateStatus(`Impossible de trouver ${modelName}.`);
      return null;
    }

    // Si le modèle n'est pas chargé, charge-le d'abord puis promeut
    if (!row.loaded) {
      await handleLoadFile(modelName);
    }

    // Si le contexte ou les GPU layers ont changé pour un modèle déjà chargé,
    // recharge-le avant d'en faire le principal.
    const needsReload = row.loaded && modelContextNeedsReload[row.name];
    if (needsReload) {
      await handleUnloadModel(modelName);
      await handleLoadFile(modelName);
    }

    const updatedRow = buildRows().find((r) => r.name === modelName);
    return performAction(modelName, 'activation', async () => {
      const payload = { model: modelName };
      if (updatedRow) {
        const requestedContext = getRequestedContextForRow(updatedRow);
        if (requestedContext !== null) payload.context = requestedContext;
      }
      if (recommendedRuntime?.gpu_layers !== undefined && recommendedRuntime?.gpu_layers !== null) {
        payload.gpu_layers = recommendedRuntime.gpu_layers;
      }
      log('select payload', payload);
      const data = await apiFetch('/api/models/select', { method: 'POST', body: payload });
      setActiveModel(data.active_model || modelName);
      return data;
    });
  }

  async function handleUnloadModel(modelName) {
    if (!modelName) return;
    const result = await performAction(modelName, 'déchargement', async () => apiFetch('/api/models/unload', { method: 'POST', body: { model: modelName } }));
    if (result) {
      setModelContextNeedsReload((current) => ({
        ...current,
        [modelName]: false,
      }));
    }
    return result;
  }

  async function handleReloadModel(modelName) {
    if (!modelName) return;
    const row = buildRows().find((item) => item.name === modelName);
    if (!row || !row.loaded) {
      updateStatus(`${modelName} n'est pas chargé.`);
      return null;
    }

    updateStatus(`${modelName} : rechargement pour appliquer le nouveau contexte...`);
    await handleUnloadModel(modelName);
    const result = await handleLoadFile(modelName);
    return result;
  }

  async function handleDeleteFile(filename) {
    if (!filename || !window.confirm(`Supprimer définitivement ${filename} ?`)) return;
    return performAction(filename, 'suppression', async () => apiFetch(`/api/models/files/${encodeURIComponent(filename)}`, { method: 'DELETE' }));
  }

  async function handleOpenModelDetails(modelName) {
    if (!modelName) return;
    setModelDetailsLoading(true);
    try {
      const data = await apiFetch(`/api/models/details/${encodeURIComponent(modelName)}`);
      setModelDetails(data);
    } catch (error) {
      updateStatus(`Impossible de charger les détails : ${error.message}`);
    } finally {
      setModelDetailsLoading(false);
    }
  }

  function formatDetailValue(value) {
    if (Array.isArray(value)) {
      return value.length === 0 ? '[]' : `[${value.map((item) => String(item)).join(', ')}]`;
    }
    if (value === null || value === undefined) {
      return '—';
    }
    if (typeof value === 'boolean') {
      return value ? 'Oui' : 'Non';
    }
    return String(value);
  }

  function renderModelDetailsModal() {
    if (!modelDetails) return null;

    const metadataRows = [...(modelDetails.gguf?.metadata || [])];
    metadataRows.sort((a, b) => {
      const aGeneral = a.key.startsWith('general.');
      const bGeneral = b.key.startsWith('general.');
      if (aGeneral !== bGeneral) return aGeneral ? -1 : 1;
      return a.key.localeCompare(b.key, 'fr', { sensitivity: 'base' });
    });

    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Détails du modèle ${modelDetails.model?.name || ''}`}>
        <div className="modal-card">
          <div className="modal-header-row">
            <div>
              <h2>Détails du modèle</h2>
              <p className="card-subtitle">Lecture des métadonnées GGUF et aperçu technique du modèle.</p>
            </div>
            <button type="button" className="btn btn-secondary btn-close-modal" onClick={() => setModelDetails(null)}>
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

  function renderRecommendedRuntimeModal() {
    if (!showRecommendedRuntimeModal) return null;

    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Recommandations runtime">
        <div className="modal-card">
          <div className="modal-header-row">
            <div>
              <h2 style={{ margin: 0 }}>Recommandations runtime</h2>
              <p style={{ margin: '0.5rem 0 0' }}>Valeurs utilisées pour charger ou sélectionner un modèle.</p>
            </div>
            <button type="button" className="btn btn-secondary btn-close-modal" onClick={() => setShowRecommendedRuntimeModal(false)}>
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

async function handleDownloadUrl() {
    const url = normalizeUrl(huggingfaceUrl);
    const ollama = normalizeUrl(ollamaName);
    if (!url && !ollama) {
      updateStatus('Entrez un lien HuggingFace ou un nom Ollama.');
      return;
    }
    const body = ollama ? { ollama_name: ollama, name: hfModelName || undefined } : { url, name: hfModelName || undefined };
    log('download payload', body);

    const xhr = new XMLHttpRequest();
    const apiUrl = `${apiBase}/api/models/download`;
    
    setLoading(true);
    setDownloadProgress(0);
    updateStatus('Téléchargement en cours...');

    xhr.open('POST', apiUrl, true);
    xhr.setRequestHeader('Content-Type', 'application/json');

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        setDownloadProgress(percent);
        updateStatus(`Téléchargement: ${percent}%`);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = JSON.parse(xhr.responseText || '{}');
        setDownloadProgress(100);
        updateStatus(`Modèle téléchargé : ${data.filename}`);
        delay(1500).then(() => {
          setDownloadProgress(0);
          setLoading(false);
        });
        refreshAllModelState({ silent: true });
        setHuggingfaceUrl('');
        setOllamaName('');
        setHfModelName('');
      } else {
        const errMsg = xhr.statusText || `Erreur HTTP ${xhr.status}`;
        updateStatus(`Échec téléchargement: ${errMsg}`);
        setDownloadProgress(0);
        setLoading(false);
      }
    });

    xhr.addEventListener('error', () => {
      updateStatus('Erreur réseau téléchargement');
      setDownloadProgress(0);
      setLoading(false);
    });

    xhr.send(JSON.stringify(body));
  }

  async function handleDownloadAndLoadUrl() {
    const url = normalizeUrl(huggingfaceUrl);
    const ollama = normalizeUrl(ollamaName);
    if (!url && !ollama) {
      updateStatus('Entrez un lien HuggingFace ou un nom Ollama.');
      return;
    }
    const body = ollama ? { ollama_name: ollama, name: hfModelName || undefined } : { url, name: hfModelName || undefined };
    log('download+load payload', body);

    const xhr = new XMLHttpRequest();
    const apiUrl = `${apiBase}/api/models/download`;
    
    setLoading(true);
    setDownloadProgress(0);
    updateStatus('Import en cours...');

    xhr.open('POST', apiUrl, true);
    xhr.setRequestHeader('Content-Type', 'application/json');

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        setDownloadProgress(percent);
        updateStatus(`Import: ${percent}%`);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = JSON.parse(xhr.responseText || '{}');
        setDownloadProgress(95);
        apiFetch('/api/models/load', {
          method: 'POST',
          body: {
            model: data.filename,
            context: getDefaultContext(null),
            gpu_layers: recommendedRuntime?.gpu_layers,
          },
        }).then(() => {
          setDownloadProgress(100);
          updateStatus(`Modèle importé et chargé : ${data.filename}`);
          delay(1500).then(() => {
            setDownloadProgress(0);
            setLoading(false);
          });
          refreshAllModelState({ silent: true });
          setHuggingfaceUrl('');
          setOllamaName('');
          setHfModelName('');
        });
      } else {
        const errMsg = xhr.statusText || `Erreur HTTP ${xhr.status}`;
        updateStatus(`Échec import: ${errMsg}`);
        setDownloadProgress(0);
        setLoading(false);
      }
    });

    xhr.addEventListener('error', () => {
      updateStatus('Erreur réseau import');
      setDownloadProgress(0);
      setLoading(false);
    });

    xhr.send(JSON.stringify(body));
  }

  const modelRows = useMemo(() => {
    const rows = new Map();
    availableFiles.forEach((file) => {
      const name = String(file?.name || '');
      if (!name) return;
      const rawGpuLayers = Number(file.gpu_layers);
      rows.set(name, {
        name,
        filename: file.filename || `${name}.gguf`,
        loaded: false,
        active: false,
        diskSize: file.size ?? null,
        modifiedAt: file.modified_at ?? null,
        vramSize: null,
        expiresAt: null,
        contextLength: normalizeContextValue(file.context_length),
        runtimeContextLength: null,
        gpuLayers: Number.isFinite(rawGpuLayers) ? rawGpuLayers : null,
      });
    });
    loadedModels.forEach((item) => {
      const name = String(item?.model || '');
      if (!name) return;
        const itemContext = normalizeContextValue(item.context_length) ?? normalizeContextValue(item.context);
      const existing = rows.get(name) || {};
      rows.set(name, {
        name,
        filename: item.filename || existing.filename || `${name}.gguf`,
        loaded: true,
        active: name === activeModel,
        diskSize: existing.diskSize ?? null,
        modifiedAt: existing.modifiedAt ?? null,
        vramSize: item.size_vram ?? null,
        expiresAt: item.expires_at ?? null,
        contextLength: existing.contextLength ?? itemContext ?? null,
        runtimeContextLength: itemContext ?? existing.runtimeContextLength ?? null,
        gpuLayers: existing.gpuLayers ?? null,
      });
    });
    return sortRows(Array.from(rows.values()));
  }, [availableFiles, loadedModels, activeModel, sortColumn, sortDirection]);

  function handleSortClick(column) {
    if (sortColumn === column) {
      setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  }

  const emptyState = modelRows.length === 0;

  function renderPageContent() {
    if (currentPage === 'logs') {
      return <ContainerLogs />;
    }

    if (currentPage === 'performance') {
      return <Performance />;
    }

    if (currentPage === 'chat') {
      return (
        <div className="card">
          <div className="card-title">💬 Chat</div>
          <p className="card-subtitle">Interface de conversation. Implémentation à venir.</p>
          <div className="placeholder-block">Préparez ici l'intégration d'un chat avec le runtime sous-jacent.</div>
        </div>
      );
    }

    if (currentPage === 'documentation') {
      return <Documentation />;
    }

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


          <div className="download-actions"><button className="btn btn-primary btn-download" onClick={handleDownloadUrl} disabled={loading}>{loading ? 'Import en cours…' : '⬇️ Importer'}</button><button className="btn btn-secondary btn-download" onClick={handleDownloadAndLoadUrl} disabled={loading}>{loading ? 'Import en cours…' : '⚡ Importer + charger'}</button></div>
        </div>

        <div className="card model-table-card">
          <div className="card-header-row">
            <div>
              <div className="card-title">🧠 Modèles</div>
              <div className="card-subtitle card-subtitle-inline">Basculer le chargement et définir le modèle principal.</div>
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
             <th>Infos</th><th>Chargé</th><th>Principal</th><th>Supprimer</th>
           </tr></thead><tbody>
            {modelRows.map((row) => (
              <tr key={row.name} className={[row.loaded ? 'row-loaded' : '', row.active ? 'row-active' : '', pendingAction?.model === row.name ? 'row-pending' : ''].filter(Boolean).join(' ')}>
                <td className="col-name"><div className="table-model-name">{row.filename || row.name}</div></td>
                <td><div className="state-stack">{row.active && <span className="badge badge-success">✓ Principal</span>}{!row.active && row.loaded && <span className="badge badge-loaded">En mémoire</span>}{!row.loaded && <span className="badge badge-neutral">Disponible</span>}{pendingAction?.model === row.name && <span className="badge badge-pending"><span className="spinner spinner-small" /> {pendingAction.type}…</span>}</div></td>
                <td>{formatBytes(row.diskSize)}</td>
                <td>
                  <div className="context-cell">
                    <div className="context-values">
                      <span className="badge badge-loaded">{getRequestedContextForRow(row)} / {row.contextLength ?? '?'} tokens</span>
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
                      disabled={loading || Boolean(pendingAction)}
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
                <td>{formatBytes(row.vramSize)}</td>
                <td>{formatShortDate(row.modifiedAt)}</td>
                <td>{formatShortDate(row.expiresAt)}</td>
                <td><button className="btn btn-secondary btn-icon" onClick={() => handleOpenModelDetails(row.name)} disabled={loading || Boolean(pendingAction)} title={`Détails ${row.name}`}>ℹ️</button></td>
                <td>
                  <button className={`btn btn-table btn-toggle ${row.loaded ? 'btn-toggle-on' : 'btn-toggle-off'}`} onClick={() => row.loaded ? handleUnloadModel(row.name) : handleLoadFile(row.name)} disabled={loading || Boolean(pendingAction)} aria-pressed={row.loaded} aria-label={row.loaded ? `${row.name} chargé` : `${row.name} disponible`}>
                    <span className="toggle-switch" aria-hidden="true">
                      <span className="toggle-knob" />
                    </span>
                    <span className="toggle-led" aria-hidden="true" />
                  </button>
                </td>
                <td>
                  <button className={`btn btn-table btn-toggle ${row.active ? 'btn-toggle-on' : 'btn-toggle-off'}`} onClick={() => handleSelectLoaded(row.name)} disabled={loading || Boolean(pendingAction) || !row.loaded || row.active} aria-pressed={row.active} aria-label={row.active ? `${row.name} principal` : `Définir ${row.name} principal`}>
                    <span className="toggle-switch" aria-hidden="true">
                      <span className="toggle-knob" />
                    </span>
                    <span className="toggle-led" aria-hidden="true" />
                  </button>
                 </td>
                 <td>
                   <button className="btn btn-icon btn-delete" onClick={() => handleDeleteFile(row.filename)} disabled={loading || Boolean(pendingAction)} title={`Supprimer ${row.name}`}>
                     🗑️
                   </button>
                 </td>
               </tr>
            ))}
          </tbody></table></div>}
        </div>
      </>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <img src="/logo.svg" alt="LIA Logo" width="44" height="44" />
          <div>
            <h1 style={{ margin: 0 }}>LIA-X</h1>
            <p className="hero-subtitle" style={{ margin: 0 }}>Local Intelligence Assistant XTENDED</p>
          </div>
        </div>
        <nav className="app-nav">
           {[
             { key: 'home', label: 'Accueil' },
             { key: 'logs', label: 'Logs' },
             { key: 'performance', label: 'Performance' },
             { key: 'chat', label: 'Chat' },
             { key: 'documentation', label: 'Documentation' },
           ].map((item) => (
            <button
              key={item.key}
              type="button"
              className={`app-nav-button${currentPage === item.key ? ' active' : ''}`}
              onClick={() => setCurrentPage(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="backend-badges">
          <div className="backend-badge">
            <span className={`dot ${version ? 'badge-success' : 'offline'}`}></span>
            <span>{version ? `Runtime prêt · ${version.version || 'llama.cpp'}` : 'Runtime hors ligne'}</span>
          </div>
          <div className="backend-badge">
            <span className={`dot ${controllerHealth.controller_ok ? 'badge-success' : 'badge-error'}`}></span>
            <span>{controllerHealth.controller_ok ? 'Contrôleur OK' : 'Contrôleur indisponible'}</span>
          </div>
        </div>
      </header>

      <main className="app-content">
        {statusMessage && <div className={`notification ${/échec|Erreur|error/i.test(statusMessage) ? 'error' : 'info'}`}>{statusMessage}</div>}
        {renderPageContent()}
        {renderModelDetailsModal()}
      </main>
      <Loader show={loading || !!pendingAction} progress={downloadProgress} />
    </div>
  );
}

export default App;
