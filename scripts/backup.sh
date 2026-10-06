#!/bin/sh
set -eu
PATH=/usr/local/bin:/usr/bin:/bin:/var/packages/ContainerManager/target/usr/bin:$PATH
export PATH
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
chmod 700 backups
BACKUP_TARGET="backups/companybrain-$(date +%Y%m%d-%H%M%S).sql"
if docker compose version >/dev/null 2>&1; then
  docker compose --project-name companybrain --env-file settings.env exec -T db pg_dump -U companybrain -d companybrain > "$BACKUP_TARGET.part"
else
  docker-compose --project-name companybrain --env-file settings.env exec -T db pg_dump -U companybrain -d companybrain > "$BACKUP_TARGET.part"
fi
test -s "$BACKUP_TARGET.part"
mv "$BACKUP_TARGET.part" "$BACKUP_TARGET"
gzip "$BACKUP_TARGET"
echo '備份完成：'
ls -lh "$BACKUP_TARGET.gz"
