import { useState } from "react";
import ContainerLogs from "./Logs/ContainerLogs";
import Performance from "./Performance/Performance";
import Loader from "./Loader/Loader";
import ModelDownloads from "./ModelDownloads/ModelDownloads";
import Documentation from "./Documentation/Documentation";
import ChatPage from "./chat/ChatPage";
import DocumentsPage from "./Documents/DocumentsPage";
import StatusToasts from "./StatusToasts/StatusToasts";
import AccueilPage from "./Accueil/AccueilPage";
import SettingsPage from "./Settings/SettingsPage";
import { useModelManager } from "./Accueil/useModelManager";

// Pages dont le contenu occupe toute la hauteur de la fenetre, sans defilement
// de la page : chacune de leurs colonnes defile dans son propre conteneur.
//
// Les autres pages (Accueil, Logs, Performance, Documentation, Parametres)
// gardent un defilement normal. Verrouiller .app-shell globalement cassait la
// page d'accueil : le tableau des modeles devenait inatteignable.
const FULL_HEIGHT_PAGES = ["chat", "documents"];

// Ordre du menu, de gauche a droite, fixe : c'est la frequence d'usage qui
// guide la position, pas l'ordre historique d'ajout des pages.
// Parametres passe en dernier car c'est l'onglet le moins consulte.
const NAV_ITEMS = [
  { key: 'chat', label: 'Chat' },
  { key: 'documents', label: 'Documents' },
  { key: 'home', label: 'Accueil' },
  { key: 'performance', label: 'Performance' },
  { key: 'logs', label: 'Logs' },
  { key: 'documentation', label: 'Documentation' },
  { key: 'settings', label: 'Paramètres' },
];

// Coquille de l'application : navigation entre les pages, en-tete, barre de
// progression, overlays (loader, telechargements, toasts). Tout l'etat des
// modeles vit dans useModelManager() et n'est transmis a l'accueil qu'au
// moment du rendu : la coquille ne connait pas le contenu des pages.
function App() {
  const [currentPage, setCurrentPage] = useState("home");
  const manager = useModelManager();

  // Le shell ne detient que ce dont il a besoin pour le chrome de l'application :
  // badges d'en-tete, barre de progression et overlays. Le contenu des pages lui
  // est transmis via renderPageContent(), jamais lu ni modifie ici.
  const {
    version, versionChecked, controllerHealth,
    loading, pendingAction, loadProgress, downloads, statusToast,
    handlePauseDownload, handleResumeDownload, handleCancelDownload,
    handleDismissDownload, handleLoadDownloaded,
  } = manager;

  function renderPageContent() {
    if (currentPage === "logs") {
      return <ContainerLogs />;
    }

    if (currentPage === "performance") {
      return <Performance />;
    }

    if (currentPage === "chat") {
      return <ChatPage />;
    }

    if (currentPage === "documents") {
      return <DocumentsPage />;
    }

    if (currentPage === "documentation") {
      return <Documentation />;
    }

    if (currentPage === "settings") {
      return <SettingsPage />;
    }

    return <AccueilPage {...manager} />;
  }

  return (

      <div className={`app-shell${FULL_HEIGHT_PAGES.includes(currentPage) ? ' is-fullheight' : ''}`}>
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <img src="/logo.svg" alt="LIA Logo" width="44" height="44" />
          <div>
            <h1 style={{ margin: 0 }}>LIA-X</h1>
            <p className="hero-subtitle" style={{ margin: 0 }}>Local Intelligence Assistant XTENDED</p>
          </div>
        </div>
        <nav className="app-nav">
          {NAV_ITEMS.map((item) => (
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
            <span className={`dot ${version ? 'badge-success' : (versionChecked ? 'offline' : 'pending')}`}></span>
            <span>{version
              ? `Runtime prêt · ${version.version || 'llama.cpp'}`
              : (versionChecked ? 'Runtime hors ligne' : 'Vérification du runtime…')}</span>
          </div>
          <div className="backend-badge">
            <span className={`dot ${controllerHealth.controller_ok ? 'badge-success' : 'badge-error'}`}></span>
            <span>{controllerHealth.controller_ok ? 'Contrôleur OK' : 'Contrôleur indisponible'}</span>
          </div>
        </div>
      </header>

      {/* Le chat occupe toute la hauteur disponible et défile dans ses colonnes.
          Les autres onglets restent des pages normales, défilables. C'est cette
          classe conditionnelle qui évite à la fois la barre de défilement globale
          sur le chat et la troncature des onglets longs. */}
      <main className={`app-content${currentPage === 'chat' || currentPage === 'documents' ? ' is-fullheight' : ''}`}>
        {loadProgress && (
          <div className={`load-progress ${loadProgress.error ? 'error' : ''}`}>
            <div className="load-progress-head">
              <strong>⏳ {loadProgress.model}</strong>
              <span>{loadProgress.error ? `Erreur : ${loadProgress.error}` : (loadProgress.message || `Étape : ${loadProgress.stage || 'démarrage'}`)}</span>
            </div>
            <div className="load-progress-stages">
              {(() => {
                const order = ['parsing', 'spawning', 'warmup', 'ready'];
                const currentIndex = order.indexOf(loadProgress.stage);
                return order.map((stage, index) => {
                  const done = currentIndex >= index && !loadProgress.error;
                  const current = loadProgress.stage === stage && !loadProgress.error;
                  return (
                    <div key={stage} className={`load-progress-stage ${done ? 'done' : ''} ${current ? 'current' : ''}`}>
                      {stage}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}
        {renderPageContent()}
      </main>
      <Loader
        show={loading || !!pendingAction}
        label={pendingAction ? `${pendingAction.type} — ${pendingAction.model}` : ''}
      />
      <ModelDownloads
        downloads={downloads}
        onPause={handlePauseDownload}
        onResume={handleResumeDownload}
        onCancel={handleCancelDownload}
        onDismiss={handleDismissDownload}
        onLoad={handleLoadDownloaded}
      />

      {/* Messages système : toast discret en bas à droite, hors du flux de la
          page. Placé hors de .app-content pour rester visible quel que soit
          l'onglet, et positionné en fixed pour ne pas être contraint par la
          grille. */}
      <StatusToasts message={statusToast.message} onDismiss={statusToast.dismiss} />
    </div>
  );
}

export default App;
