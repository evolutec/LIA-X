import { useEffect, useRef, useState } from 'react';

/**
 * Modale de création de dossier.
 *
 * Isolé dans son propre composant pour deux raisons : FileExplorer est déjà
 * volumineux, et la modale a une mécanique à part — piège de focus, Échap pour
 * fermer, clic sur le fond pour annuler — qui n'a rien à voir du reste.
 *
 * Le dossier est créé DANS le dossier courant. Rien d'autre n'est possible :
 * l'utilisateur choisit le parent en naviguant dans l'arborescence, ce qui est
 * plus direct que de faire choisir un parent dans une liste déroulante.
 */
export default function NewFolderModal({ isOpen, parentName, busy, onClose, onSubmit }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  // Chaque ouverture repart d'un champ vide : réutiliser le nom de la création
  // précédente ferait créer un doublon par erreur.
  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setError('');
    // Le focus suit l'ouverture : sans cela, il resterait sur le bouton « + » et
    // l'utilisateur devrait cliquer dans le champ pour saisir.
    inputRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  async function submit(event) {
    event?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Donnez un nom au dossier.');
      return;
    }
    setError('');
    const result = await onSubmit(trimmed);
    // En cas d'échec, la modale reste ouverte et affiche la raison : c'est le
    // seul endroit où l'utilisateur peut la lire et corriger.
    if (result?.error) setError(result.error);
    else onClose();
  }

  return (
    <div
      className="explorer-modal-backdrop"
      onMouseDown={(event) => {
        // Clic sur le fond uniquement : un clic dans la modale ne doit pas
        // l'annuler, sinon la saisie disparaîtrait au moindre relâchement.
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      role="presentation"
    >
      <div
        className="explorer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-folder-title"
      >
        <h3 id="new-folder-title" className="explorer-modal-title">Nouveau dossier</h3>
        <p className="explorer-modal-sub">
          {parentName
            ? `Il sera créé dans « ${parentName} ».`
            : 'Il sera créé à la racine.'}
        </p>

        <form onSubmit={submit}>
          <input
            ref={inputRef}
            type="text"
            className="explorer-modal-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              // Échap ferme sans créer, sauf pendant l'appel réseau où le
              // dossier est peut-être déjà en cours d'enregistrement.
              if (event.key === 'Escape' && !busy) onClose();
            }}
            placeholder="Nom du dossier"
            aria-label="Nom du nouveau dossier"
            disabled={busy}
            maxLength={200}
          />
          {error && <p className="explorer-modal-error" role="alert">{error}</p>}

          <div className="explorer-modal-actions">
            <button type="button" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button type="submit" className="is-primary" disabled={busy || !name.trim()}>
              {busy ? 'Création…' : 'Créer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
