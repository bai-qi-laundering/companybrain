#!/bin/sh
set -eu
PATH=/usr/local/bin:/usr/bin:/bin:/var/packages/ContainerManager/target/usr/bin:$PATH
export PATH
cd "$(dirname "$0")/.."
test -f settings.env || { echo '請先執行 prepare-settings.sh 並設定 settings.env'; exit 1; }
umask 077
cp settings.env .env
chmod 600 .env
if docker compose version >/dev/null 2>&1; then
  docker compose --project-name companybrain --env-file settings.env up -d --build
  docker compose --project-name companybrain --env-file settings.env ps
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose --project-name companybrain --env-file settings.env up -d --build
  docker-compose --project-name companybrain --env-file settings.env ps
else
  echo '找不到 Docker Compose，請確認 Container Manager 已安裝及啟動。'
  exit 1
fi
