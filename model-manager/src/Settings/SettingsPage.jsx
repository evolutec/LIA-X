import { useCallback, useEffect, useState } from 'react';
import { useSettings, DEFAULT_SETTINGS } from './settingsStore';
import { filterVoicesByLang, getVoices } from '../chat/useSpeechOutput';
import './settings.css';

const speechInputSupported = typeof window !== 'undefined'
  && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

const speechOutputSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

/** Interrupteur accessible, piloté par une case à cocher native. */
function Toggle({ id, label, hint, checked, disabled, onChange }) {
  return (
    <label className={`settings-toggle${disabled ? ' is-disabled' : ''}`} htmlFor={id}>
      <span className="settings-toggle-text">
        <span className="settings-toggle-label">{label}</span>
        {hint && <span className="settings-toggle-hint">{hint}</span>}
      </span>
      <span className="settings-switch">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="settings-switch-track" aria-hidden="true" />
      </span>
    </label>
  );
}

/**
 * Page des réglages.
 *
 * Les réglages sont stockés dans localStorage (voir settingsStore.js) et
 * partagés en direct avec le chat : un changement s'applique immédiatement,
 * sans rechargement ni bouton « appliquer ».
 */
function SettingsPage() {
  const { settings, update, reset } = useSettings();
  const [voices, setVoices] = useState([]);

  /**
   * Les voix arrivent de façon asynchrone : au premier rendu, getVoices()
   * renvoie un tableau vide et le navigateur publie la liste ensuite via
   * l'événement `voiceschanged`. Sans cette écoute, la liste déroulante
   * resterait vide sur les navigateurs les plus courants.
   */
  const loadVoices = useCallback(() => {
    setVoices(getVoices());
  }, []);

  useEffect(() => {
    loadVoices();
    if (typeof window === 'undefined' || !window.speechSynthesis) return undefined;
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
  }, [loadVoices]);

  // Un nom de langue peut correspondre à plusieurs voix : on regroupe par
  // langue pour ne pas proposer une liste de dizaines d'entrées quasi
  // identiques.
  const langs = Array.from(new Set(voices.map((voice) => voice.lang)))
    .sort((a, b) => a.localeCompare(b));

  function previewVoice() {
    if (!speechOutputSupported) return;
    const utterance = new window.SpeechSynthesisUtterance(
      'Bonjour, ceci est un essai de la synthèse vocale de LIA-X.',
    );
    utterance.lang = settings.voiceOutputLang || 'fr-FR';
    utterance.rate = settings.voiceOutputRate;
    utterance.pitch = settings.voiceOutputPitch;
    const match = filterVoicesByLang(getVoices(), settings.voiceOutputLang)
      .find((voice) => voice.lang === settings.voiceOutputLang);
    if (match) utterance.voice = match;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  const langVoices = filterVoicesByLang(voices, settings.voiceOutputLang);
  const noVoiceForLang = settings.voiceOutput && langs.length > 0 && langVoices.length === 0;

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h2>Paramètres</h2>
        <p className="settings-subtitle">
          Les réglages sont enregistrés sur cet appareil et s'appliquent immédiatement.
        </p>
      </header>

      <section className="settings-section">
        <h3>Saisie vocale</h3>
        <p className="settings-section-hint">
          Dicter un message dans le chat avec le micro du composeur.
        </p>

        {!speechInputSupported && (
          <p className="settings-notice" role="status">
            Ce navigateur n'expose pas la reconnaissance vocale (Web Speech API).
            Elle est disponible sur Chrome, Edge et les versions récentes de
            Safari, mais pas sur Firefox. L'option reste affichée pour être
            trouvée facilement une fois le navigateur changé.
          </p>
        )}

        <Toggle
          id="settings-voice-input"
          label="Afficher le micro dans le chat"
          hint="Le micro ne s'active que lorsque vous cliquez dessus."
          checked={settings.voiceInput}
          disabled={!speechInputSupported}
          onChange={(value) => update({ voiceInput: value })}
        />

        {speechInputSupported && (
          <p className="settings-note">
            Chrome et Edge transmettent l'audio à leurs serveurs pour la
            transcription ; Firefox fait le travail en local. La dictée ne
            démarre jamais toute seule.
          </p>
        )}
      </section>

      <section className="settings-section">
        <h3>Sortie vocale</h3>
        <p className="settings-section-hint">
          Faire lire les reponses du modele a voix haute.
        </p>

        {!speechOutputSupported && (
          <p className="settings-notice" role="status">
            Ce navigateur ne fournit pas de synthese vocale.
          </p>
        )}

        <Toggle
          id="settings-voice-output"
          label="Lire les reponses a voix haute"
          hint="Ajoute un bouton Ecouter sur chaque reponse."
          checked={settings.voiceOutput}
          disabled={!speechOutputSupported}
          onChange={(value) => update({ voiceOutput: value })}
        />

        <Toggle
          id="settings-voice-output-auto"
          label="Lecture automatique"
          hint="Lit chaque nouvelle reponse des qu elle est terminee, sans cliquer."
          checked={settings.voiceOutputAuto}
          disabled={!speechOutputSupported || !settings.voiceOutput}
          onChange={(value) => update({ voiceOutputAuto: value })}
        />

        {speechOutputSupported && settings.voiceOutput && (
          <div className="settings-fields">
            <label className="settings-field" htmlFor="settings-voice-lang">
              <span className="settings-field-label">Langue</span>
              <select
                id="settings-voice-lang"
                value={settings.voiceOutputLang}
                onChange={(event) => update({ voiceOutputLang: event.target.value })}
              >
                <option value="">Langue du navigateur par defaut</option>
                {langs.map((lang) => (
                  <option key={lang} value={lang}>{lang}</option>
                ))}
              </select>
            </label>

            <label className="settings-field" htmlFor="settings-voice-rate">
              <span className="settings-field-label">
                Debit <span className="settings-field-value">{settings.voiceOutputRate.toFixed(1)}x</span>
              </span>
              <input
                id="settings-voice-rate"
                type="range"
                min="0.5"
                max="2"
                step="0.1"
                value={settings.voiceOutputRate}
                onChange={(event) => update({ voiceOutputRate: Number(event.target.value) })}
              />
            </label>

            <label className="settings-field" htmlFor="settings-voice-pitch">
              <span className="settings-field-label">
                Hauteur <span className="settings-field-value">{settings.voiceOutputPitch.toFixed(1)}</span>
              </span>
              <input
                id="settings-voice-pitch"
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={settings.voiceOutputPitch}
                onChange={(event) => update({ voiceOutputPitch: Number(event.target.value) })}
              />
            </label>

            <button type="button" className="settings-test-button" onClick={previewVoice}>
              Tester la voix
            </button>

            {langs.length === 0 && (
              <p className="settings-note">
                Aucune voix installee sur ce systeme. Sous Windows, ajoute une voix
                dans les parametres Date, heure et langue.
              </p>
            )}

            {noVoiceForLang && (
              <p className="settings-note">
                Aucune voix ne correspond a cette langue : la lecture utilisera la
                langue du navigateur.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="settings-section">
        <h3>Reinitialisation</h3>
        <p className="settings-section-hint">
          Restaure tous les reglages a leur valeur d origine.
        </p>
        <button type="button" className="settings-reset-button" onClick={reset}>
          Retablir les valeurs par defaut
        </button>
        <p className="settings-note">
          Par defaut : micro {DEFAULT_SETTINGS.voiceInput ? 'affiche' : 'masque'},
          lecture vocale {DEFAULT_SETTINGS.voiceOutput ? 'activee' : 'desactivee'}.
        </p>
      </section>
    </div>
  );
}

export default SettingsPage;
