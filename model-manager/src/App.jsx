import { useEffect, useState } from "react";

// VITE_API_BASE_URL="" → appels relatifs (même origin que la page)
// Utilise ?? (nullish) et non || pour que la chaîne vide soit acceptée
const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

function App() {
  const [huggingfaceUrl, setHuggingfaceUrl] = useState("");
  const [ollamaName, setOllamaName] = useState("");
  const [availableFiles, setAvailableFiles] = useState([]);
  const [loadedModels, setLoadedModels] = useState([]);
  const [activeModel, setActiveModel] = useState("");
  const [status, setStatus] = useState("");
  const [version, setVersion] = useState(null);
  const [statusInfo, setStatusInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [hfModelName, setHfModelName] = useState("");

  useEffect(() => {
    refreshStatus();
    refreshAvailableFiles();
    refreshLoadedModels();
    refreshStatusInfo();
    refreshActiveModel();
  }, []);

  async function refreshStatus() {
    try {
      const res = await fetch(`${apiBase}/api/version`);
      if (!res.ok) throw new Error(res.statusText);
      setVersion(await res.json());
    } catch (err) {
      setVersion(null);
      setStatus(`Backend unavailable: ${extractErrorMessage(err.message || err)}`);
    }
  }

  function extractErrorMessage(detail) {
    if (typeof detail === "string") {
      return detail;
    }
    if (Array.isArray(detail)) {
      return detail
        .map((item) => {
          if (typeof item === "string") return item;
          if (item?.msg) return item.msg;
          if (item?.detail) return item.detail;
          return JSON.stringify(item);
        })
        .join("; ");
    }
    if (detail && typeof detail === "object") {
      if (detail.msg) return detail.msg;
      if (detail.detail) return detail.detail;
      return JSON.stringify(detail);
    }
    return String(detail);
  }

  function formatModelValue(value) {
    if (value == null || value === "") {
      return "-";
    }
    if (typeof value === "object") {
      if (value.n_ctx != null) return String(value.n_ctx);
      if (value.value != null) return String(value.value);
      return JSON.stringify(value);
    }
    return String(value);
  }

  function formatBytes(bytes) {
    if (bytes == null || bytes === "") {
      return "-";
    }
    const value = Number(bytes);
    if (Number.isNaN(value)) {
      return String(bytes);
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let index = 0;
    let amount = value;
    while (amount >= 1024 && index < units.length - 1) {
      amount /= 1024;
      index += 1;
    }
    return `${amount.toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
  }

  async function refreshAvailableFiles() {
    try {
      const res = await fetch(`${apiBase}/api/models/available`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setAvailableFiles(Array.isArray(data.files) ? data.files : []);
    } catch (err) {
      setAvailableFiles([]);
      setStatus(`Unable to list local models: ${extractErrorMessage(err.message || err)}`);
    }
  }

  async function refreshLoadedModels() {
    try {
      const res = await fetch(`${apiBase}/api/models`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setLoadedModels(Array.isArray(data.models) ? data.models : []);
    } catch (err) {
      setLoadedModels([]);
      setStatus(`Unable to list loaded models: ${extractErrorMessage(err.message || err)}`);
    }
  }

  async function refreshStatusInfo() {
    try {
      const res = await fetch(`${apiBase}/api/models/status`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setStatusInfo(data);
    } catch (err) {
      setStatusInfo(null);
      setStatus(`Unable to fetch model status: ${extractErrorMessage(err.message || err)}`);
    }
  }

  async function refreshActiveModel() {
    try {
      const res = await fetch(`${apiBase}/api/models/active`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setActiveModel(data.active_model || "");
    } catch {
      setActiveModel("");
    }
  }

  async function handleDownloadUrl() {
    const payload = {};
    if (ollamaName.trim()) {
      payload.ollama_name = ollamaName.trim();
    } else if (huggingfaceUrl.trim()) {
      payload.url = huggingfaceUrl.trim();
    } else {
      setStatus("Entrez un nom Ollama ou une URL Hugging Face.");
      return;
    }
    setLoading(true);
    setDownloadProgress(0);
    setStatus(`Téléchargement du modèle...`);
    const progressInterval = setInterval(() => {
      setDownloadProgress(prev => Math.min(prev + 10, 90));
    }, 500);
    try {
      const res = await fetch(`${apiBase}/api/models/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));
      setDownloadProgress(100);
      setStatus(`Modèle téléchargé : ${data.filename}`);
      setHuggingfaceUrl("");
      setOllamaName("");
      await refreshAvailableFiles();
    } catch (err) {
      setStatus(`Échec du téléchargement : ${extractErrorMessage(err.message || err)}`);
    } finally {
      clearInterval(progressInterval);
      setLoading(false);
      setTimeout(() => setDownloadProgress(0), 1000);
    }
  }

  async function handleDownloadAndLoadUrl() {
    const payload = {};
    if (ollamaName.trim()) {
      payload.ollama_name = ollamaName.trim();
    } else if (huggingfaceUrl.trim()) {
      payload.url = huggingfaceUrl.trim();
    } else {
      setStatus("Entrez un nom Ollama ou une URL Hugging Face.");
      return;
    }
    setLoading(true);
    setDownloadProgress(0);
    setStatus(`Téléchargement et chargement du modèle...`);
    const progressInterval = setInterval(() => {
      setDownloadProgress(prev => Math.min(prev + 10, 90));
    }, 500);
    try {
      const res = await fetch(`${apiBase}/api/models/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));
      const downloadedName = data.filename;
      setDownloadProgress(95);
      await refreshAvailableFiles();

      const loadRes = await fetch(`${apiBase}/api/models/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: downloadedName }),
      });
      const loadData = await loadRes.json();
      if (!loadRes.ok) throw new Error(extractErrorMessage(loadData.detail || loadRes.statusText));
      setDownloadProgress(100);
      setStatus(`Modèle téléchargé et chargé : ${downloadedName}`);
      setHuggingfaceUrl("");
      setOllamaName("");
      await refreshLoadedModels();
      await refreshActiveModel();
    } catch (err) {
      setStatus(`Échec du téléchargement/chargement : ${extractErrorMessage(err.message || err)}`);
    } finally {
      clearInterval(progressInterval);
      setLoading(false);
      setTimeout(() => setDownloadProgress(0), 1000);
    }
  }

  async function handleLoadFile(filename) {
    setLoading(true);
    setStatus(`Chargement du fichier local ${filename}...`);
    try {
      const res = await fetch(`${apiBase}/api/models/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: filename }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));
      setStatus(`Modèle chargé : ${data.model}`);
      await refreshLoadedModels();
      await refreshActiveModel();
    } catch (err) {
      setStatus(`Échec du chargement : ${extractErrorMessage(err.message || err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectLoaded(model) {
    setLoading(true);
    setStatus(`Sélection du modèle ${model}...`);
    try {
      const res = await fetch(`${apiBase}/api/models/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));
      setActiveModel(data.active_model || "");
      setStatus(`Modèle actif : ${data.active_model}`);
    } catch (err) {
      setStatus(`Échec de la sélection : ${extractErrorMessage(err.message || err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleUnloadModel(model) {
    setLoading(true);
    setStatus(`Déchargement du modèle ${model}...`);
    try {
      const res = await fetch(`${apiBase}/api/models/unload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));
      setStatus(`Modèle déchargé : ${data.model}`);
      await refreshLoadedModels();
      await refreshActiveModel();
    } catch (err) {
      setStatus(`Échec du déchargement : ${extractErrorMessage(err.message || err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteFile(filename) {
    if (!confirm(`Êtes-vous sûr de vouloir supprimer le modèle "${filename}" ? Cette action est irréversible.`)) {
      return;
    }
    setLoading(true);
    setStatus(`Suppression du modèle ${filename}...`);
    try {
      const res = await fetch(`${apiBase}/api/models/files/${encodeURIComponent(filename)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));
      setStatus(`Modèle supprimé : ${data.filename}`);
      await refreshAvailableFiles();
    } catch (err) {
      setStatus(`Échec de la suppression : ${extractErrorMessage(err.message || err)}`);
    } finally {
      setLoading(false);
    }
  }

  function handleHFUrlChange(url) {
    setHuggingfaceUrl(url);
    // Auto-dériver le nom du modèle depuis l'URL si le champ est vide
    if (url) {
      try {
        const pathname = new URL(url).pathname;
        const filename = pathname.split('/').pop();
        const derived = filename.replace(/\.gguf.*$/i, '').replace(/\?.*$/, '');
        if (derived) setHfModelName(prev => prev || derived);
      } catch { /* URL incomplète — ignorer */ }
    }
  }

  async function handleImportHF(andLoad) {
    if (!huggingfaceUrl.trim()) { setStatus("Entrez une URL HuggingFace (.gguf)."); return; }
    if (!hfModelName.trim()) { setStatus("Entrez un nom pour le modèle."); return; }
    setLoading(true);
    setDownloadProgress(0);
    setStatus("Import GGUF depuis HuggingFace (peut prendre plusieurs minutes selon la taille)...");
    const progressInterval = setInterval(() => {
      setDownloadProgress(prev => Math.min(prev + 2, 90));
    }, 3000);
    try {
      const res = await fetch(`${apiBase}/api/models/import-hf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: huggingfaceUrl.trim(), name: hfModelName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));
      setDownloadProgress(andLoad ? 95 : 100);
      const importedName = hfModelName.trim();
      if (andLoad) {
        const loadRes = await fetch(`${apiBase}/api/models/load`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: importedName }),
        });
        const loadData = await loadRes.json();
        if (!loadRes.ok) throw new Error(extractErrorMessage(loadData.detail || loadRes.statusText));
        setDownloadProgress(100);
        setStatus(`Modèle importé et chargé : ${importedName}`);
        await refreshLoadedModels();
        await refreshActiveModel();
      } else {
        setStatus(`Modèle importé : ${importedName}`);
      }
      setHuggingfaceUrl("");
      setHfModelName("");
      await refreshAvailableFiles();
    } catch (e) {
      setStatus(`Échec de l'import HF : ${extractErrorMessage(e.message || e)}`);
    } finally {
      clearInterval(progressInterval);
      setLoading(false);
      setTimeout(() => setDownloadProgress(0), 1000);
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>⚡ Model Manager — Ollama IPEX</h1>
        <div className="backend-badge">
          <span className={`dot ${version ? "" : "offline"}`}></span>
          <span>{version ? `Connecté · Ollama ${version.version ?? ""}` : "Ollama hors ligne"}</span>
        </div>
      </header>

      <div className="app-content">
        {status && (
          <div className={`notification ${status.includes("Échec") || status.includes("unavailable") || status.includes("offline") ? "error" : "info"}`}>
            {status}
          </div>
        )}

        {/* Backend status */}
        <div className="card">
          <div className="card-title">📊 Statut</div>
          <div className="status-row">
            <div className="status-item">
              <label>Version Ollama</label>
              <div className="value">{version?.version ?? "—"}</div>
            </div>
            <div className="status-item">
              <label>Device</label>
              <div className="value">{version?.device ?? "—"}</div>
            </div>
            <div className="status-item">
              <label>Modèle actif</label>
              <div className="value">{activeModel || "—"}</div>
            </div>
            <div className="status-item">
              <label>Stockage</label>
              <div className="value">{version?.model_dir ?? "—"}</div>
            </div>
          </div>
        </div>

        {/* Download */}
        <div className="card">
          <div className="card-title">⬇️ Télécharger un modèle</div>
          {downloadProgress > 0 && (
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${downloadProgress}%` }}></div>
              <span className="progress-text">{downloadProgress}%</span>
            </div>
          )}
          <div className="form-grid">
            <input
              type="text"
              value={ollamaName}
              onChange={(e) => setOllamaName(e.target.value)}
              placeholder="qwen2.5:0.5b, llama3.2:1b… (nom Ollama)"
              aria-label="Nom du modèle Ollama"
            />
            <button className="btn btn-secondary" onClick={handleDownloadUrl} disabled={loading}>
              {loading ? <><span className="spinner" /> En cours…</> : "⬇️ Télécharger"}
            </button>
            <button className="btn btn-primary" onClick={handleDownloadAndLoadUrl} disabled={loading}>
              {loading ? <><span className="spinner" /> En cours…</> : "⚡ Télécharger & Charger"}
            </button>
          </div>
          <p className="hint">
            Nom de modèle Ollama (ex&nbsp;: <code>qwen2.5:0.5b</code>, <code>llama3.2:1b</code>, <code>phi3.5:mini</code>).
            Les modèles sont stockés dans <strong>~/.ollama/models</strong> (WSL2 Ubuntu).
          </p>

          <div className="hf-divider"><span>— ou importer un fichier GGUF direct depuis HuggingFace —</span></div>

          <div className="form-grid">
            <input
              type="url"
              value={huggingfaceUrl}
              onChange={(e) => handleHFUrlChange(e.target.value)}
              placeholder="https://huggingface.co/…/resolve/main/model.Q4_K_M.gguf"
              aria-label="URL GGUF HuggingFace"
              style={{ gridColumn: "1 / -1" }}
            />
            <input
              type="text"
              value={hfModelName}
              onChange={(e) => setHfModelName(e.target.value)}
              placeholder="Nom local du modèle (auto-détecté)"
              aria-label="Nom local du modèle"
            />
            <button className="btn btn-secondary" onClick={() => handleImportHF(false)} disabled={loading}>
              {loading ? <><span className="spinner" /> En cours…</> : "⬇️ Importer"}
            </button>
            <button className="btn btn-primary" onClick={() => handleImportHF(true)} disabled={loading}>
              {loading ? <><span className="spinner" /> En cours…</> : "⚡ Importer & Charger"}
            </button>
          </div>
          <p className="hint">
            Colle l'URL d'un fichier <code>.gguf</code> HuggingFace (ex&nbsp;: <code>…/resolve/main/Qwen3.5-9B.Q4_K_M.gguf</code>).
            Le nom du modèle est auto-détecté depuis l'URL — tu peux le modifier avant d'importer.
          </p>
        </div>

        {/* Available models */}
        <div className="card">
          <div className="card-header-row">
            <div className="card-title">📂 Modèles disponibles</div>
            <button className="btn btn-secondary" onClick={refreshAvailableFiles} disabled={loading}>↻ Rafraîchir</button>
          </div>
          {availableFiles.length === 0 ? (
            <div className="empty-state">
              Aucun modèle. Téléchargez-en un ci-dessus ou via&nbsp;:
              <br/><code>wsl -d Ubuntu-24.04 -- bash -c 'cd ~/ollama-ipex && ./ollama pull qwen2.5:0.5b'</code>
            </div>
          ) : (
            <div className="model-grid">
              {availableFiles.map((file) => (
                <div
                  key={String(file.name)}
                  className={`model-card ${String(file.name) === activeModel ? "active-model" : ""}`}
                >
                  <div className="model-name">{String(file.name)}</div>
                  {String(file.name) === activeModel && (
                    <span className="badge badge-success">✓ Actif</span>
                  )}
                  <div className="model-meta">
                    <span>Taille : {formatBytes(file.size)}</span>
                    <span>Modifié le {new Date(Number(file.modified_at) * 1000).toLocaleDateString("fr-FR")}</span>
                  </div>
                  <div className="model-actions">
                    <button
                      className="btn btn-primary"
                      onClick={() => handleLoadFile(file.name)}
                      disabled={loading || String(file.name) === activeModel}
                    >
                      {String(file.name) === activeModel ? "✓ Actif" : "⚡ Charger"}
                    </button>
                    <button className="btn btn-danger" onClick={() => handleDeleteFile(file.name)} disabled={loading}>
                      🗑 Supprimer
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Loaded models (running in memory) */}
        <div className="card">
          <div className="card-header-row">
            <div className="card-title">🧠 Modèles en mémoire (VRAM)</div>
            <button className="btn btn-secondary" onClick={refreshLoadedModels} disabled={loading}>↻ Rafraîchir</button>
          </div>
          {loadedModels.length === 0 ? (
            <div className="empty-state">Aucun modèle chargé en VRAM. Chargez-en un depuis la liste ci-dessus.</div>
          ) : (
            <div className="model-grid">
              {loadedModels.map((item) => (
                <div
                  key={String(item.model)}
                  className={`model-card ${String(item.model) === activeModel ? "active-model" : ""}`}
                >
                  <div className="model-name">{String(item.model)}</div>
                  {String(item.model) === activeModel && (
                    <span className="badge badge-success">✓ Actif</span>
                  )}
                  <div className="model-meta">
                    <span>VRAM : {formatBytes(item.size_vram)}</span>
                    <span>Expire : {item.expires_at ? new Date(item.expires_at).toLocaleTimeString("fr-FR") : "—"}</span>
                  </div>
                  <div className="model-actions">
                    <button
                      className="btn btn-primary"
                      onClick={() => handleSelectLoaded(item.model)}
                      disabled={loading || item.model === activeModel}
                    >
                      {item.model === activeModel ? "✓ Sélectionné" : "Sélectionner"}
                    </button>
                    <button
                      className="btn btn-danger"
                      onClick={() => handleUnloadModel(item.model)}
                      disabled={loading}
                    >
                      Décharger
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Detailed status */}
        <div className="card">
          <div className="card-header-row">
            <div className="card-title">📈 Statut détaillé</div>
            <button className="btn btn-secondary" onClick={refreshStatusInfo} disabled={loading}>
              ↻ Rafraîchir
            </button>
          </div>
          {statusInfo ? (
            <>
              <div className="status-grid">
                <div className="status-item">
                  <label>Total modèles</label>
                  <div className="value">{statusInfo.total_models}</div>
                </div>
                <div className="status-item">
                  <label>GPU</label>
                  <div className="value">{statusInfo.gpu?.device ?? "N/A"}</div>
                </div>
                <div className="status-item">
                  <label>En mémoire</label>
                  <div className="value">{statusInfo.running_models ?? 0}</div>
                </div>
              </div>
              {statusInfo.models?.length > 0 && (
                <div className="model-grid">
                  {statusInfo.models.map((item) => (
                    <div key={String(item.model)} className="model-card">
                      <div className="model-name">{String(item.model)}</div>
                      <div className="model-meta">
                        <span>Device : {String(item.device ?? "—")}</span>
                        <span>VRAM : {formatBytes(item.approx_memory_bytes)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">Statut non disponible. Cliquez sur ↻ Rafraîchir.</div>
          )}
        </div>

        {/* Links */}
        <div className="card">
          <div className="card-title">🔗 Ressources</div>
          <div className="resource-links">
            <a href="https://ollama.com/library" target="_blank" rel="noopener noreferrer" className="btn btn-outline">
              🦙 Ollama Library
            </a>
            <a href="https://huggingface.co/models?library=gguf" target="_blank" rel="noopener noreferrer" className="btn btn-outline">
              🤗 Hugging Face GGUF
            </a>
            <a href="http://localhost:3001" target="_blank" rel="noopener noreferrer" className="btn btn-outline">
              💬 AnythingLLM
            </a>
          </div>
          <p className="hint">
            Modèles recommandés pour Arc 140V&nbsp;: <code>qwen2.5:0.5b</code>, <code>qwen2.5:1.5b</code>, <code>llama3.2:1b</code>, <code>phi3.5:mini</code>
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;
