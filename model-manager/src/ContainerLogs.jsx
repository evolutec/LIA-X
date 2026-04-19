import { useEffect, useMemo, useState } from "react";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

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

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = date.getFullYear();
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${day}/${month}/${year} ${hours}h${minutes}m${seconds}s`;
}

function ContainerLogs() {
  const [runtimeLogs, setRuntimeLogs] = useState([]);
  const [logFilter, setLogFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${apiBase}/api/models/status`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.detail || response.statusText || 'Erreur API');
      }
      const logs = Array.isArray(payload.logs)
        ? payload.logs
        : Array.isArray(payload.log_entries)
          ? payload.log_entries
          : [];
      setRuntimeLogs(logs);
      setError('');
    } catch (err) {
      const message = err?.message || 'Erreur de récupération';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    if (!mounted) return;
    fetchStatus();
    const interval = window.setInterval(fetchStatus, 7000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  const allowedContainerSources = new Set(['model-loader', 'anythingllm', 'openwebui']);
  const logSourceOptions = [
    { value: 'all', label: 'Tous' },
    { value: 'server', label: 'Server' },
    { value: 'controller', label: 'Controller' },
    { value: 'model-loader', label: 'model-loader' },
    { value: 'anythingllm', label: 'anythingllm' },
    { value: 'openwebui', label: 'openwebui' },
  ];

  const visibleLogs = useMemo(() => {
    if (!Array.isArray(runtimeLogs)) {
      return [];
    }

    return runtimeLogs.flatMap((entry) => {
      const text = entry?.message || entry?.text || '';
      if (!text) {
        return [];
      }
      const source = entry.source || 'unknown';
      const origin = entry.origin || 'unknown';
      const isApiSource = typeof source === 'string' && /^\/(api|health)/.test(source);
      const isAllowedSource =
        origin === 'server' ||
        origin === 'controller' ||
        (origin === 'container' && allowedContainerSources.has(source));

      if (!isAllowedSource || isApiSource) {
        return [];
      }

      const matches =
        logFilter === 'all' ||
        (logFilter === 'server' && origin === 'server') ||
        (logFilter === 'controller' && origin === 'controller') ||
        source === logFilter;
      if (!matches) {
        return [];
      }

      const lines = String(text).split(/\r?\n/).filter(Boolean);
      return lines.map((line) => ({
        origin,
        source,
        type: entry.type || 'stdout',
        message: line,
      }));
    });
  }, [runtimeLogs, logFilter]);

  return (
    <div className="card logs-card">
      <div className="card-title">Logs</div>
      <p className="card-subtitle">Affichage filtré des logs runtime serveur et services projet.</p>

      {error && <div className="notification error">{error}</div>}

      <div className="log-panel">
        <div className="log-panel-header">
          <span>Logs runtime</span>
          <select className="log-filter-select" value={logFilter} onChange={(event) => setLogFilter(event.target.value)}>
            {logSourceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="log-lines">
          {visibleLogs.length === 0 ? (
            <div className="placeholder-block">Aucun log runtime disponible pour le moment.</div>
          ) : (
            visibleLogs.map((entry, index) => (
              <div key={`${entry.source}-${index}`} className={`log-line${entry.type === 'stderr' ? ' log-error' : ''}`}>
                <span className="log-entry-source">{entry.origin}:{entry.source}</span> {entry.message}
              </div>
            ))
          )}
        </div>
      </div>

    </div>
  );
}

export default ContainerLogs;
