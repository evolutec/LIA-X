import { useSyncExternalStore } from 'react';

/**
 * Réglages persistés de l'application.
 *
 * Volontairement sans dépendance : un objet en mémoire, une clé localStorage et
 * un abonnement. React 18 fournit useSyncExternalStore, qui évite d'écrire à la
 * main la logique de synchronisation (abonnement, comparaison d'instantané) et
 * supprime le risque de boucle de rendu infinie quand un composant met à jour
 * un réglage pendant qu'un autre le lit.
 *
 * Chaque réglage est validé à la lecture : un localStorage corrompu ou écrit par
 * une version antérieure ne doit pas pouvoir casser le rendu de l'application.
 */

const STORAGE_KEY = 'lia-x.settings.v1';

/**
 * Valeurs par défaut.
 *
 * - voiceOutput est false par défaut : la synthèse vocale est une fonction
 *   intrusive, elle ne doit pas démarrer sans que l'utilisateur l'ait demandé.
 * - voiceInput est true : le micro n'émet rien tant qu'on ne l'appuie pas.
 */
export const DEFAULT_SETTINGS = {
  voiceInput: true,
  voiceOutput: false,
  voiceOutputAuto: false,
  voiceOutputRate: 1,
  voiceOutputPitch: 1,
  voiceOutputLang: '',
};

function coerceBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function coerceNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function coerceString(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Fusionne des données brutes avec les valeurs par défaut, en écartant tout
 * champ inconnu ou mal typé.
 */
function sanitize(raw) {
  const source = (raw && typeof raw === 'object') ? raw : {};
  return {
    voiceInput: coerceBoolean(source.voiceInput, DEFAULT_SETTINGS.voiceInput),
    voiceOutput: coerceBoolean(source.voiceOutput, DEFAULT_SETTINGS.voiceOutput),
    voiceOutputAuto: coerceBoolean(source.voiceOutputAuto, DEFAULT_SETTINGS.voiceOutputAuto),
    voiceOutputRate: coerceNumber(source.voiceOutputRate, DEFAULT_SETTINGS.voiceOutputRate, 0.5, 2),
    voiceOutputPitch: coerceNumber(source.voiceOutputPitch, DEFAULT_SETTINGS.voiceOutputPitch, 0, 2),
    voiceOutputLang: coerceString(source.voiceOutputLang, DEFAULT_SETTINGS.voiceOutputLang),
  };
}

function readStorage() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    // Mode privé, quota dépassé ou JSON corrompu : on repart des valeurs par
    // défaut plutôt que de laisser l'application ne pas démarrer.
    return { ...DEFAULT_SETTINGS };
  }
}

let state = readStorage();
const listeners = new Set();

function persist() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Écriture impossible : les réglages restent valables pour la session en
    // cours, ils ne seront simplement pas conservés au rechargement.
  }
}

function emit() {
  listeners.forEach((listener) => listener());
}

export function getSettings() {
  return state;
}

/** Modifie un ou plusieurs réglages. Les valeurs sont revalidées ici aussi. */
export function updateSettings(patch) {
  const next = sanitize({ ...state, ...patch });
  const changed = Object.keys(next).some((key) => next[key] !== state[key]);
  if (!changed) return;
  state = next;
  persist();
  emit();
}

/** Rétablit tous les réglages par défaut. */
export function resetSettings() {
  state = { ...DEFAULT_SETTINGS };
  persist();
  emit();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Crochet React donnant accès aux réglages et à leur mise à jour.
 * @returns {{settings: typeof DEFAULT_SETTINGS, update: Function, reset: Function}}
 */
export function useSettings() {
  const settings = useSyncExternalStore(subscribe, getSettings, getSettings);
  return {
    settings,
    update: updateSettings,
    reset: resetSettings,
  };
}
