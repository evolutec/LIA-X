import { useEffect, useMemo, useState } from "react";

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
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [sortColumn, setSortColumn] = useState("name");
  const [sortDirection, setSortDirection] = useState("asc");

  useEffect(() => {
    refreshAllModelState();
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (!loading && !pendingAction) {
        refreshAllModelState({ silent: true });
      }
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [loading, pendingAction]);

  function log(...args) {
    console.log('[App]', ...args);
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
      ...options,
    };
    if (options.body !== undefined && typeof options.body !== 'string') {
      init.body = JSON.stringify(options.body);
    }
    if (!init.body) {
      delete init.body;
    }

    log('fetch', init.method, url, options.body || 'no body');
    const response = await fetch(url, init);
    const payload = await parseJson(response);
    log('fetch result', init.method, url, response.status, payload);
    if (!response.ok) {
      const message = payload?.detail || payload?.message || response.statusText || String(payload);
      throw new Error(message);
    }
    return payload;
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
      const valueA = a[sortColumn] ?? 0;
      const valueB = b[sortColumn] ?? 0;
      return sortDirection === 'asc' ? valueA - valueB : valueB - valueA;
    });
  }

  function buildRows() {
    const rows = new Map();
    availableFiles.forEach((file) => {
      const name = String(file?.name || '');
      if (!name) return;
      rows.set(name, {
        name,
        filename: file.filename || `${name}.gguf`,
        loaded: false,
        active: false,
        diskSize: file.size ?? null,
        modifiedAt: file.modified_at ?? null,
        vramSize: null,
        expiresAt: null,
      });
    });
    loadedModels.forEach((item) => {
      const name = String(item?.model || '');
      if (!name) return;
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
      });
    });
    return sortRows(Array.from(rows.values()));
  }

  function updateStatus(message) {
    setStatusMessage(message);
    log('status', message);
  }

  async function refreshAllModelState(options = {}) {
    const { silent = false } = options;
    log('refreshAllModelState', options);
    try {
      await Promise.all([
        refreshVersion(silent),
        refreshAvailableFiles(silent),
        refreshLoadedModels(silent),
        refreshActiveModel(silent),
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
      await refreshAllModelState({ silent: true });
      updateStatus(`${modelName} : ${actionType} terminé.`);
      return result;
    } catch (err) {
      console.error('[App] action error', actionType, modelName, err);
      updateStatus(`${modelName} : échec ${actionType} — ${err.message}`);
      throw err;
    } finally {
      setPendingAction(null);
      setLoading(false);
    }
  }

  async function handleLoadFile(modelName) {
    if (!modelName) return;
    return performAction(modelName, 'chargement', async () => apiFetch('/api/models/load', { method: 'POST', body: { model: modelName } }));
  }

  async function handleSelectLoaded(modelName) {
    if (!modelName) return;
    if (modelName === activeModel) {
      updateStatus(`${modelName} est déjà principal.`);
      return;
    }
    return performAction(modelName, 'activation', async () => {
      const data = await apiFetch('/api/models/select', { method: 'POST', body: { model: modelName } });
      setActiveModel(data.active_model || modelName);
      return data;
    });
  }

  async function handleUnloadModel(modelName) {
    if (!modelName) return;
    return performAction(modelName, 'déchargement', async () => apiFetch('/api/models/unload', { method: 'POST', body: { model: modelName } }));
  }

  async function handleDeleteFile(filename) {
    if (!filename || !window.confirm(`Supprimer définitivement ${filename} ?`)) return;
    return performAction(filename, 'suppression', async () => apiFetch(`/api/models/files/${encodeURIComponent(filename)}`, { method: 'DELETE' }));
  }

  async function handleOpenModelDetails(modelName) {
    if (!modelName) return;
    try {
      const data = await apiFetch(`/api/models/details/${encodeURIComponent(modelName)}`);
      window.alert(`Détails du modèle:\n${JSON.stringify(data.model, null, 2)}`);
    } catch (error) {
      updateStatus(`Impossible de charger les détails : ${error.message}`);
    }
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
    setLoading(true);
    setDownloadProgress(0);
    updateStatus('Téléchargement en cours...');
    const interval = window.setInterval(() => setDownloadProgress((prev) => Math.min(prev + 10, 90)), 500);
    try {
      const data = await apiFetch('/api/models/download', { method: 'POST', body });
      updateStatus(`Modèle téléchargé : ${data.filename}`);
      await refreshAllModelState({ silent: true });
      setHuggingfaceUrl('');
      setOllamaName('');
      setHfModelName('');
    } catch (err) {
      console.error('[App] download error', err);
      updateStatus(`Échec du téléchargement : ${err.message}`);
    } finally {
      clearInterval(interval);
      setDownloadProgress(0);
      setLoading(false);
    }
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
    setLoading(true);
    setDownloadProgress(0);
    updateStatus('Import et chargement en cours...');
    const interval = window.setInterval(() => setDownloadProgress((prev) => Math.min(prev + 8, 90)), 500);
    try {
      const data = await apiFetch('/api/models/download', { method: 'POST', body });
      setDownloadProgress(95);
      await apiFetch('/api/models/load', { method: 'POST', body: { model: data.filename } });
      updateStatus(`Modèle importé et chargé : ${data.filename}`);
      await refreshAllModelState({ silent: true });
      setHuggingfaceUrl('');
      setOllamaName('');
      setHfModelName('');
    } catch (err) {
      console.error('[App] download and load error', err);
      updateStatus(`Échec import/chargement : ${err.message}`);
    } finally {
      clearInterval(interval);
      setDownloadProgress(0);
      setLoading(false);
    }
  }

  const modelRows = useMemo(() => {
    const rows = new Map();
    availableFiles.forEach((file) => {
      const name = String(file?.name || '');
      if (!name) return;
      rows.set(name, {
        name,
        filename: file.filename || `${name}.gguf`,
        loaded: false,
        active: false,
        diskSize: file.size ?? null,
        modifiedAt: file.modified_at ?? null,
        vramSize: null,
        expiresAt: null,
      });
    });
    loadedModels.forEach((item) => {
      const name = String(item?.model || '');
      if (!name) return;
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <img src="/logo.svg" alt="LIA Logo" width="44" height="44" />
          <div>
            <h1 style={{ margin: 0 }}>LIA-X</h1>
            <p className="hero-subtitle" style={{ margin: 0 }}>Pilotage local des modèles GGUF et du runtime llama.cpp.</p>
          </div>
        </div>
        <div className="backend-badge">
          <span className={`dot ${version ? '' : 'offline'}`}></span>
          <span>{version ? `Runtime prêt · ${version.version || 'llama.cpp'}` : 'Runtime hors ligne'}</span>
        </div>
      </header>

      <main className="app-content">
        {statusMessage && <div className={`notification ${/échec|Erreur|error/i.test(statusMessage) ? 'error' : 'info'}`}>{statusMessage}</div>}

        <section className="hero-panel">
          <div className="hero-copy">
            <div className="eyebrow">Console locale</div>
            <h2>Gestion des modèles chargés et du modèle principal.</h2>
            <p>Charge un modèle, sélectionne le modèle principal, et expose le runtime sur le proxy <strong>lia-local</strong>.</p>
          </div>
          <div className="hero-routing">
            <article className="hero-route hero-route-primary"><div className="hero-route-kicker">Principal</div><h3>{activeModel || 'Aucun modèle principal'}</h3><p>{activeModel ? `Proxy lia-local diffuse le modèle principal ${activeModel}.` : 'Sélectionne un modèle chargé pour le définir comme principal.'}</p></article>
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
          {downloadProgress > 0 && <div className="progress-bar"><div className="progress-fill" style={{ width: `${downloadProgress}%` }}></div><span className="progress-text">{downloadProgress}%</span></div>}
          <div className="download-actions"><button className="btn btn-primary btn-download" onClick={handleDownloadUrl} disabled={loading}>{loading ? 'Import en cours…' : '⬇️ Importer'}</button><button className="btn btn-secondary btn-download" onClick={handleDownloadAndLoadUrl} disabled={loading}>{loading ? 'Import en cours…' : '⚡ Importer + charger'}</button></div>
        </div>

        <div className="card model-table-card">
          <div className="card-header-row"><div><div className="card-title">🧠 Modèles</div><div className="card-subtitle card-subtitle-inline">Basculer le chargement et définir le modèle principal.</div></div><div className="auto-sync-label">Mise à jour auto</div></div>
          {emptyState ? <div className="empty-state">Aucun modèle local détecté.</div> : <div className="table-wrap"><table className="model-table"><thead><tr>
            <th style={{ cursor: 'pointer' }} onClick={() => handleSortClick('name')}>Nom {sortColumn === 'name' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</th>
            <th style={{ cursor: 'pointer' }} onClick={() => handleSortClick('status')}>État {sortColumn === 'status' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</th>
            <th style={{ cursor: 'pointer' }} onClick={() => handleSortClick('diskSize')}>Taille {sortColumn === 'diskSize' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</th>
            <th style={{ cursor: 'pointer' }} onClick={() => handleSortClick('vramSize')}>VRAM {sortColumn === 'vramSize' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</th>
            <th style={{ cursor: 'pointer' }} onClick={() => handleSortClick('modifiedAt')}>Modifié {sortColumn === 'modifiedAt' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</th>
            <th style={{ cursor: 'pointer' }} onClick={() => handleSortClick('expiresAt')}>Expire {sortColumn === 'expiresAt' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</th>
            <th>Infos</th><th>Chargé</th><th>Principal</th>
          </tr></thead><tbody>
            {modelRows.map((row) => (
              <tr key={row.name} className={[row.loaded ? 'row-loaded' : '', row.active ? 'row-active' : '', pendingAction?.model === row.name ? 'row-pending' : ''].filter(Boolean).join(' ')}>
                <td className="col-name"><div className="table-model-name">{row.filename || row.name}</div></td>
                <td><div className="state-stack">{row.active && <span className="badge badge-success">✓ Principal</span>}{!row.active && row.loaded && <span className="badge badge-loaded">En mémoire</span>}{!row.loaded && <span className="badge badge-neutral">Disponible</span>}{pendingAction?.model === row.name && <span className="badge badge-pending"><span className="spinner spinner-small" /> {pendingAction.type}…</span>}</div></td>
                <td>{formatBytes(row.diskSize)}</td>
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
              </tr>
            ))}
          </tbody></table></div>}
        </div>
      </main>
    </div>
  );
}

export default App;
