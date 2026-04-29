import { useState } from "react";

const Documentation = () => {
  const [activeTab, setActiveTab] = useState('installation');

  const tabs = [
    { id: 'installation', label: 'Installation' },
    { id: 'services', label: 'Services' },
    { id: 'api', label: 'API' },
    { id: 'runtime', label: 'Runtime' },
    { id: 'controller', label: 'Controller' },
    { id: 'troubleshooting', label: 'Dépannage' },
    { id: 'architecture', label: 'Architecture' },
  ];

  const renderContent = () => {
    switch (activeTab) {
      case 'installation':
        return (
          <div className="doc-content">
            <h2 className="doc-heading">Installation</h2>
            <p className="doc-lead">Démarrez rapidement LIA-X avec une installation en un clic.</p>

            <div className="doc-section">
              <h3 className="doc-subheading">Prérequis</h3>
              <ul className="doc-list">
                <li>Windows 11</li>
                <li>Docker Desktop</li>
                <li>PowerShell 7+ (recommandé) ou PowerShell 5.1</li>
                <li>16GB RAM minimum (32GB recommandé)</li>
                <li>Espace disque suffisant pour les modèles (10GB+) et Docker images</li>
              </ul>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Installation rapide</h3>
              <p className="doc-note">Exécutez ce script en tant qu'administrateur :</p>
              <pre className="doc-code"><code>.\install.ps1</code></pre>
              <p className="doc-note">Ce script :</p>
              <ol className="doc-list">
                <li>Débloque les fichiers (si nécessaire)</li>
                <li>Installe NSSM (si nécessaire)</li>
                <li>Construit les images Docker</li>
                <li>Démarre les services sur le réseau <code>lia-network</code></li>
              </ol>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Installation manuelle</h3>
              <pre className="doc-code"><code># 1. Construire les images Docker
docker build -t lia-model-loader -f Dockerfiles/Dockerfile.model-loader .
docker build -t anythingllm -f Dockerfiles/Dockerfile.anythingllm .
docker build -t openwebui -f Dockerfiles/Dockerfile.openwebui .
docker build -t librechat -f Dockerfiles/Dockerfile.librechat .

# 2. Démarrer les services
docker network create lia-network
docker run -d --name anythingllm --network lia-network -p 3001:3001 mintplexlabs/anythingllm:latest
docker run -d --name openwebui --network lia-network -p 3003:8080 ghcr.io/open-webui/open-webui:main
docker run -d --name librechat --network lia-network -p 3004:3080 ghcr.io/danny-avila/librechat:latest

# 3. Démarrer le contrôleur
.\controller\llama-host-controller.ps1</code></pre>
            </div>
          </div>
        );

      case 'services':
        return (
          <div className="doc-content">
            <h2 className="doc-heading">Services</h2>
            <p className="doc-lead">LIA-X expose plusieurs services sur le réseau local.</p>

            <div className="doc-section">
              <h3 className="doc-subheading">Tableau des services</h3>
              <table className="doc-table">
                <thead>
                  <tr>
                    <th className="doc-table-col">Service</th>
                    <th className="doc-table-col">URL</th>
                    <th className="doc-table-col">Rôle</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="doc-table-cell"><strong>Model Loader</strong></td>
                    <td className="doc-table-cell">http://localhost:3002</td>
                    <td className="doc-table-cell">Import GGUF, métadonnées, catalogue, proxy OpenAI</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><strong>AnythingLLM</strong></td>
                    <td className="doc-table-cell">http://localhost:3001</td>
                    <td className="doc-table-cell">Interface de chat principale</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><strong>Open WebUI</strong></td>
                    <td className="doc-table-cell">http://localhost:3003</td>
                    <td className="doc-table-cell">Interface de chat alternative</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><strong>LibreChat</strong></td>
                    <td className="doc-table-cell">http://localhost:3004</td>
                    <td className="doc-table-cell">Frontend OpenAI-compatible</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><strong>Contrôleur hôte</strong></td>
                    <td className="doc-table-cell">http://127.0.0.1:13579</td>
                    <td className="doc-table-cell">Contrôle des processus <code>llama-server</code></td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><strong>GPU Metrics</strong></td>
                    <td className="doc-table-cell">http://127.0.0.1:13620</td>
                    <td className="doc-table-cell">Collecte et expose les métriques GPU (utilisation, mémoire)</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>llama-server</code></td>
                    <td className="doc-table-cell">http://127.0.0.1:12434-12444</td>
                    <td className="doc-table-cell">Instance par modèle sur ports dynamiques</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Service GPU Metrics</h3>
              <p className="doc-note">Le service GPU Metrics collecte les métriques système en temps réel :</p>
              <ul className="doc-list">
                <li>Utilisation GPU (Utilization Percentage)</li>
                <li>Utilisation mémoire dédiée (Dedicated Usage)</li>
                <li>API exposée sur le port 13620</li>
                <li>Fallback vers les compteurs Windows si <code>hw-smi.exe</code> n'est pas disponible</li>
              </ul>
            </div>
          </div>
        );

      case 'api':
        return (
          <div className="doc-content">
            <h2 className="doc-heading">API</h2>
            <p className="doc-lead">LIA expose deux couches principales d'API.</p>

            <div className="doc-section">
              <h3 className="doc-subheading">Contrôleur hôte (port 13579)</h3>
              <p className="doc-note">Gestion des instances <code>llama-server</code> et du cycle de vie des modèles.</p>

              <table className="doc-table">
                <thead>
                  <tr>
                    <th className="doc-table-col">Endpoint</th>
                    <th className="doc-table-col">Méthode</th>
                    <th className="doc-table-col">Description</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="doc-table-cell"><code>GET /health</code></td>
                    <td className="doc-table-cell">GET</td>
                    <td className="doc-table-cell">Vérifie la santé du contrôleur</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>GET /status</code></td>
                    <td className="doc-table-cell">GET</td>
                    <td className="doc-table-cell">Renvoie l'état runtime actuel et les instances chargées</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>POST /start</code></td>
                    <td className="doc-table-cell">POST</td>
                    <td className="doc-table-cell">Démarre ou active un modèle</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>POST /stop</code></td>
                    <td className="doc-table-cell">POST</td>
                    <td className="doc-table-cell">Arrête un modèle</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>POST /restart</code></td>
                    <td className="doc-table-cell">POST</td>
                    <td className="doc-table-cell">Redémarre un modèle</td>
                  </tr>
                </tbody>
              </table>

              <div className="doc-code-block">
                <p className="doc-label">Payload <code>/start</code> :</p>
                <pre className="doc-code"><code>{`
{
  "model": "llama3.2-1b.gguf",
  "context": 32000,
  "activate": true
}
`}</code></pre>
              </div>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Model Loader (port 3002)</h3>
              <p className="doc-note">Serveur Node.js avec proxy OpenAI-compatible et API de gestion des modèles.</p>

              <h4 className="doc-subheading">API de gestion des modèles</h4>
              <table className="doc-table">
                <thead>
                  <tr>
                    <th className="doc-table-col">Endpoint</th>
                    <th className="doc-table-col">Méthode</th>
                    <th className="doc-table-col">Description</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="doc-table-cell"><code>GET /health</code></td>
                    <td className="doc-table-cell">GET</td>
                    <td className="doc-table-cell">Vérifie que le serveur Model Loader est disponible</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>GET /api/version</code></td>
                    <td className="doc-table-cell">GET</td>
                    <td className="doc-table-cell">Renvoie la version, le backend, et l'URL runtime</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>GET /api/models/available</code></td>
                    <td className="doc-table-cell">GET</td>
                    <td className="doc-table-cell">Liste les fichiers GGUF disponibles sur disque</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>GET /api/models</code></td>
                    <td className="doc-table-cell">GET</td>
                    <td className="doc-table-cell">Liste les modèles chargés en mémoire</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>GET /api/models/active</code></td>
                    <td className="doc-table-cell">GET</td>
                    <td className="doc-table-cell">Renvoie le modèle principal actuellement actif</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>GET /api/models/status</code></td>
                    <td className="doc-table-cell">GET</td>
                    <td className="doc-table-cell">Statut détaillé, métriques et logs</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>GET /api/models/details/:model</code></td>
                    <td className="doc-table-cell">GET</td>
                    <td className="doc-table-cell">Détails GGUF pour un modèle donné</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>POST /api/models/download</code></td>
                    <td className="doc-table-cell">POST</td>
                    <td className="doc-table-cell">Télécharge un modèle GGUF</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>POST /api/models/load</code></td>
                    <td className="doc-table-cell">POST</td>
                    <td className="doc-table-cell">Charge un modèle en mémoire sans l'activer</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>POST /api/models/select</code></td>
                    <td className="doc-table-cell">POST</td>
                    <td className="doc-table-cell">Charge et active un modèle principal</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>POST /api/models/unload</code></td>
                    <td className="doc-table-cell">POST</td>
                    <td className="doc-table-cell">Décharge un modèle</td>
                  </tr>
                </tbody>
              </table>

              <h4 className="doc-subheading">API OpenAI-compatible</h4>
              <table className="doc-table">
                <thead>
                  <tr>
                    <th className="doc-table-col">Endpoint</th>
                    <th className="doc-table-col">Méthode</th>
                    <th className="doc-table-col">Description</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="doc-table-cell"><code>GET /v1/models</code></td>
                    <td className="doc-table-cell">GET</td>
                    <td className="doc-table-cell">Renvoie le catalogue des modèles disponibles et l'état du proxy</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>POST /v1/chat/completions</code></td>
                    <td className="doc-table-cell">POST</td>
                    <td className="doc-table-cell">Génération de texte</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>POST /v1/completions</code></td>
                    <td className="doc-table-cell">POST</td>
                    <td className="doc-table-cell">Complétion de texte</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>POST /v1/embeddings</code></td>
                    <td className="doc-table-cell">POST</td>
                    <td className="doc-table-cell">Vecteurs d'embedding</td>
                  </tr>
                </tbody>
              </table>

              <div className="doc-note">
                <strong>Alias de compatibilité :</strong> Pour une compatibilité maximale avec les clients OpenAI, les endpoints racines sont également disponibles :
                <ul className="doc-list">
                  <li><code>GET /models</code> → alias vers <code>/v1/models</code></li>
                  <li><code>POST /chat/completions</code> → alias vers <code>/v1/chat/completions</code></li>
                  <li><code>POST /completions</code> → alias vers <code>/v1/completions</code></li>
                  <li><code>POST /embeddings</code> → alias vers <code>/v1/embeddings</code></li>
                </ul>
              </div>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Comportement du proxy <code>lia-local</code></h3>
              <ul className="doc-list">
                <li><code>lia-local</code> est un identifiant stable pour le modèle principal</li>
                <li>Si <code>model</code> est absent ou égal à <code>lia-local</code>, le serveur utilise le modèle actif courant</li>
                <li>Les autres modèles chargés restent consultables via <code>/api/models</code></li>
              </ul>
            </div>
          </div>
        );

      case 'runtime':
        return (
          <div className="doc-content">
            <h2 className="doc-heading">Runtime</h2>
            <p className="doc-lead">Configuration et gestion du runtime <code>llama-server</code>.</p>

            <div className="doc-section">
              <h3 className="doc-subheading">Configuration</h3>
              <p className="doc-note">Le fichier <code>runtime/host-runtime-config.json</code> contient les paramètres du runtime :</p>
              <pre className="doc-code"><code>{`
{
  "server_port_start": 12434,
  "server_port_end": 12444,
  "max_instances": 6,
  "controller_port": 13579,
  "proxy_model_id": "lia-local",
  "default_gpu_layers": 999,
  "backend": "vulkan",
  "binary_path": "C:\\Users\\evolu\\Documents\\Github-repo\\LIA-X\\runtime\\llama-releases\\...\\llama-server.exe",
  "models_dir": "C:\\Users\\evolu\\Documents\\Github-repo\\LIA-X\\models"
}
`}</code></pre>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Ports</h3>
              <p className="doc-note">Les ports sont définis dans <code>config.json</code> :</p>
              <ul className="doc-list">
                <li><code>loaderPort = 3002</code> - Model Loader</li>
                <li><code>anythingPort = 3001</code> - AnythingLLM</li>
                <li><code>openWebUiPort = 3003</code> - Open WebUI</li>
                <li><code>libreChatPort = 3004</code> - LibreChat</li>
                <li><code>libreChatInternalPort = 3080</code> - LibreChat interne</li>
                <li><code>controllerPort = 13579</code> - Contrôleur hôte</li>
                <li><code>llamaPort = 12434</code> - Base des ports llama-server</li>
              </ul>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Réseau</h3>
              <p>Tous les conteneurs sont connectés au réseau Docker <code>lia-network</code> pour permettre la communication interne : <code>host.docker.internal</code> → <code>127.0.0.1</code> (hôte) → <code>lia-local</code> (proxy).</p>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Modèles</h3>
              <p>Les modèles GGUF sont stockés dans le dossier <code>models/</code> et doivent être importés via l'interface Model Loader ou placés manuellement dans ce dossier.</p>
            </div>
          </div>
        );

      case 'controller':
        return (
          <div className="doc-content">
            <h2 className="doc-heading">Controller</h2>
            <p className="doc-lead">Le contrôleur hôte gère le cycle de vie des instances <code>llama-server</code>.</p>

            <div className="doc-section">
              <h3 className="doc-subheading">Fonctionnalités</h3>
              <ul className="doc-list">
                <li>Attribution automatique de ports dynamiques (12434-12444)</li>
                <li>Relance automatique des instances mortes</li>
                <li>Gestion du cycle de vie (start/stop/restart)</li>
                <li>Exposition d'API de contrôle sur le port 13579</li>
                <li>Relance au démarrage Windows (Windows Service)</li>
              </ul>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Fichier</h3>
              <p><code>services/controller/llama-host-controller.ps1</code></p>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">API de contrôle</h3>
              <table className="doc-table">
                <thead>
                  <tr>
                    <th className="doc-table-col">Endpoint</th>
                    <th className="doc-table-col">Méthode</th>
                    <th className="doc-table-col">Description</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="doc-table-cell"><code>GET /health</code></td>
                    <td className="doc-table-cell">GET</td>
                    <td className="doc-table-cell">Vérifie la santé du contrôleur</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>GET /status</code></td>
                    <td className="doc-table-cell">GET</td>
                    <td className="doc-table-cell">Renvoie l'état runtime actuel et les instances chargées</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>POST /start</code></td>
                    <td className="doc-table-cell">POST</td>
                    <td className="doc-table-cell">Démarre ou active un modèle</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>POST /stop</code></td>
                    <td className="doc-table-cell">POST</td>
                    <td className="doc-table-cell">Arrête un modèle</td>
                  </tr>
                  <tr>
                    <td className="doc-table-cell"><code>POST /restart</code></td>
                    <td className="doc-table-cell">POST</td>
                    <td className="doc-table-cell">Redémarre un modèle</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );

      case 'troubleshooting':
        return (
          <div className="doc-content">
            <h2 className="doc-heading">Dépannage</h2>
            <p className="doc-lead">Solutions aux problèmes courants.</p>

            <div className="doc-section">
              <h3 className="doc-subheading">lia-local ne répond pas</h3>
              <ol className="doc-list">
                <li>Vérifier la santé du contrôleur : <code>http://127.0.0.1:13579/status</code></li>
                <li>Vérifier la santé du Model Loader : <code>http://127.0.0.1:3002/api/models/status</code></li>
                <li>Redémarrer le contrôleur via l'interface ou en relançant <code>services/controller/llama-host-controller.ps1</code></li>
              </ol>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">LibreChat ne démarre pas</h3>
              <p>Consulter les logs :</p>
              <pre className="doc-code"><code>docker logs -f librechat
docker logs -f librechat-mongo</code></pre>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Frontend Docker ne voit pas model-loader</h3>
              <p>Vérifier que <code>model-loader</code> est connecté à <code>lia-network</code> et que les ports sont bien mappés.</p>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Modèle <code>.gguf</code> non trouvé</h3>
              <p>Déposer le fichier dans <code>models/</code> et relancer le chargement via l'interface Model Loader.</p>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Erreurs de mémoire</h3>
              <p>Si vous rencontrez des erreurs de mémoire (OOM) :</p>
              <ol className="doc-list">
                <li>Augmenter les <code>gpu_layers</code> dans <code>runtime/host-runtime-config.json</code></li>
                <li>Utiliser des modèles quantifiés (Q4_K, Q5_K)</li>
                <li>Limiter le contexte par défaut (paramètre <code>default_context</code>)</li>
              </ol>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Logs</h3>
              <p>Les logs sont stockés dans :</p>
              <ul className="doc-list">
                <li><code>logs/controller/</code> - Contrôleur hôte</li>
                <li><code>logs/runtime/</code> - Runtime llama-server</li>
                <li><code>logs/model-manager/</code> - Model Loader</li>
              </ul>
            </div>
          </div>
        );

      case 'architecture':
        return (
          <div className="doc-content">
            <h2 className="doc-heading">Architecture</h2>
            <p className="doc-lead">LIA-X est une plateforme locale pour tester et déployer des modèles GGUF sur Windows.</p>

            <div className="doc-section">
              <h3 className="doc-subheading">Couches principales</h3>
              <ol className="doc-list">
                <li><strong>Couche Runtime</strong> : Gestion des instances <code>llama-server</code> via un contrôleur PowerShell</li>
                <li><strong>Couche Proxy</strong> : Model Loader qui expose une API OpenAI-compatible et sert de proxy</li>
                <li><strong>Couche Frontend</strong> : Interfaces utilisateur Dockerisées (AnythingLLM, Open WebUI, LibreChat)</li>
              </ol>
            </div>

            <div className="doc-section">
              <h3 className="doc-subheading">Flux de données</h3>
              <p><strong>Flux d'inférence :</strong></p>
              <ol className="doc-list">
                <li>Utilisateur formule une requête via le frontend</li>
                <li>Le Model Loader reçoit la requête et valide le modèle actif</li>
                <li>Le Controller Host récupère l'instance active et vérifie la santé</li>
                <li>llama-server génère la réponse</li>
                <li>La réponse est formatée et renvoyée via le Model Loader</li>
              </ol>

              <p><strong>Flux de chargement de modèle :</strong></p>
              <ol className="doc-list">
                <li>L'utilisateur importe un fichier GGUF via l'interface Model Loader</li>
                <li>Le Model Loader vérifie l'espace disque et lit le fichier</li>
                <li>Le Controller Host crée une instance llama-server</li>
                <li>llama-server charge le modèle depuis disque</li>
                <li>L'instance est enregistrée dans le Runtime State</li>
              </ol>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="card doc-card">
      <div className="card-title">📚 Documentation LIA-X</div>
      <p className="card-subtitle">Guide complet de l'architecture et de l'utilisation de LIA-X</p>

      <nav className="doc-nav">
        <div className="app-nav" style={{ justifyContent: 'center' }}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`app-nav-button${activeTab === tab.id ? ' active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="doc-main">
        {renderContent()}
      </main>
    </div>
  );
};

export default Documentation;
