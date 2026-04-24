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

function parseTimestamp(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTimestamp(value) {
  const date = parseTimestamp(value);
  if (!date) {
    return '—';
  }
  const pad = (value) => String(value).padStart(2, '0');
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = date.getFullYear();
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

function normalizeLogLevel(entry) {
  const type = String(entry.type || '').toLowerCase();
  const level = String(entry.level || '').toLowerCase();
  if (level === 'critical' || /critical|critique/.test(level)) {
    return 'critical';
  }
  if (level === 'error' || type === 'stderr' || /error|erreur|fail|failed/.test(level)) {
    return 'error';
  }
  return 'info';
}

function renderLogLevelLabel(level) {
  switch (level) {
    case 'critical':
      return 'Critique';
    case 'error':
      return 'Erreur';
    default:
      return 'Information';
  }
}

function ContainerLogs() {
  const [runtimeLogs, setRuntimeLogs] = useState([]);
  const [logFilter, setLogFilter] = useState('all');
  const [timeFilter, setTimeFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState('all');
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

  const timeFilterOptions = [
    { value: 'all', label: 'Tous' },
    { value: '10m', label: '10 dernières minutes' },
    { value: '1h', label: 'Dernière heure' },
  ];

  const levelFilterOptions = [
    { value: 'all', label: 'Tous' },
    { value: 'info', label: 'Information' },
    { value: 'critical', label: 'Critique' },
    { value: 'error', label: 'Erreur' },
  ];

  const visibleLogs = useMemo(() => {
    if (!Array.isArray(runtimeLogs)) {
      return [];
    }

    const now = Date.now();
    const limitMs =
      timeFilter === '10m' ? 10 * 60 * 1000 :
      timeFilter === '1h' ? 60 * 60 * 1000 :
      null;

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

      const matchesSource =
        logFilter === 'all' ||
        (logFilter === 'server' && origin === 'server') ||
        (logFilter === 'controller' && origin === 'controller') ||
        source === logFilter;
      if (!matchesSource) {
        return [];
      }

      const timestamp = entry.timestamp ? parseTimestamp(entry.timestamp) : null;
      if (limitMs !== null && (!timestamp || now - timestamp.getTime() > limitMs)) {
        return [];
      }

      const level = normalizeLogLevel(entry);
      if (levelFilter !== 'all' && levelFilter !== level) {
        return [];
      }

      const lines = String(text).split(/\r?\n/).filter(Boolean);
      return lines.map((line) => ({
        origin,
        source,
        type: entry.type || 'stdout',
        level,
        timestamp: timestamp ? timestamp.toISOString() : null,
        message: line,
      }));
    });
  }, [runtimeLogs, logFilter, timeFilter, levelFilter]);

  return (
    <div className="card logs-card">
      <div className="card-title">Logs</div>
      <p className="card-subtitle">Affichage filtré des logs runtime serveur et services projet.</p>

      {error && <div className="notification error">{error}</div>}

      <div className="log-panel">
        <div className="log-panel-header">
          <span>Logs runtime</span>
          <div className="log-filter-group">
            <select className="log-filter-select" value={logFilter} onChange={(event) => setLogFilter(event.target.value)}>
              {logSourceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select className="log-filter-select" value={timeFilter} onChange={(event) => setTimeFilter(event.target.value)}>
              {timeFilterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select className="log-filter-select" value={levelFilter} onChange={(event) => setLevelFilter(event.target.value)}>
              {levelFilterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="log-panel-body">
          <div className="log-lines">
            {visibleLogs.length === 0 ? (
              <div className="placeholder-block">Aucun log runtime disponible pour le moment.</div>
            ) : (
              visibleLogs.map((entry, index) => (
                <div
                  key={`${entry.source}-${index}`}
                  className={`log-line${entry.type === 'stderr' ? ' log-error' : ''}${entry.level === 'critical' ? ' log-critical' : ''}`}
                >
                  <div className="log-line-meta">
                    <span className="log-entry-time">{formatTimestamp(entry.timestamp)}</span>
                    <span className="log-entry-source">{entry.origin}:{entry.source}</span>
                    <span className={`log-entry-level ${entry.level}`}>{renderLogLevelLabel(entry.level)}</span>
                  </div>
                  <div className="log-entry-message">{entry.message}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

export default ContainerLogs;
