#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -e settings.env ]; then
  echo 'settings.env 已存在，未覆蓋。'
  exit 0
fi
umask 077
cp .env.example settings.env
DB_VALUE=$(openssl rand -hex 24)
ADMIN_VALUE=$(openssl rand -hex 16)
sed -i "s/CHANGE_ME_TO_RANDOM_32_CHARACTERS/$DB_VALUE/; s/CHANGE_ME_TO_AT_LEAST_16_CHARACTERS/$ADMIN_VALUE/" settings.env
if chgrp administrators settings.env 2>/dev/null; then
  chmod 660 settings.env
else
  chmod 600 settings.env
fi
echo '已建立 settings.env，請在 NAS 本機編輯網址、登入密碼與 API Key。'
