Ce qui a été résolu
POST /api/models/select passe bien
host-runtime-state.json est bien mis à jour avec le bon modèle actif
GET /api/models/active retourne désormais :
{"active_model":"llama3.2-1b","source":"controller","detail":null}
Cause identifiée
le contrôleur verrouillait host-runtime-state.json pendant la lecture/écriture
cela provoquait des erreurs 500 dans le backend et des lectures stale/fallback
Correction appliquée
llama-host-controller.ps1
lecture de l’état via FileShare.ReadWrite
écriture atomique via FileShare.Read
fermeture propre des streams
j’ai aussi ajouté un log de debug interne
Found existingInstance ...
Promoting existing instance ...
Save-State called for active_model=llama3.2-1b
Vérification finale
le contrôleur est de nouveau accessible
le mode actif bascule bien
le Model Loader renvoie le bon modèle actif