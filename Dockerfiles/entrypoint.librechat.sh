#!/bin/sh
set -e

# Supprime le fichier de config front invalide créé précédemment
CONFIG_PATH="/app/client/public/models/custom_models.json"
if [ -f "$CONFIG_PATH" ]; then
  rm -f "$CONFIG_PATH"
fi

exec "$@"
