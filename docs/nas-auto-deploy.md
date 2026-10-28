# CompanyBrain automatic NAS deployment

## Design

GitHub Actions tests on pull requests and on every push to main. The NAS
periodically pulls **only the current main commit** after that exact SHA has a
successful `CompanyBrain CI` push workflow run. No inbound NAS SSH is needed.

The deployer replaces only an allowlist of application files, never
`settings.env`, `.env`, `compose.yaml`, backups, or the PostgreSQL volume.
It builds the app with Docker Compose, checks the app health status, and
attempts to restore the previous app files/container if deployment fails.

**This does not deploy until you install and schedule it on the NAS.**
It requires Python 3, Docker Compose v2, outbound HTTPS to api.github.com,
and permissions to use Docker. No Git or GitHub token is needed for this
public repository.

## One-time installation on Synology

1. Confirm `/volume1/docker/companybrain/settings.env` is correct and
   make a backup of the database and configuration.
2. In NAS SSH, install the script from the reviewed **main** branch:

   ```sh
   cd /volume1/docker/companybrain
   mkdir -p scripts
   curl -fL --retry 3 \
     https://raw.githubusercontent.com/bai-qi-laundering/companybrain/main/scripts/nas-auto-deploy.py \
     -o scripts/nas-auto-deploy.py
   python3 -m py_compile scripts/nas-auto-deploy.py
   ```

3. Run once manually, using a NAS account with Docker permissions:

   ```sh
   cd /volume1/docker/companybrain
   python3 scripts/nas-auto-deploy.py
   ```

4. Confirm `companybrain-app-1` is healthy and the LINE assistant replies
   normally before enabling recurring execution.
5. In Synology **Control Panel → Task Scheduler**, create a recurring task
   running every 10 minutes (or preferred interval):

   ```sh
   cd /volume1/docker/companybrain && /usr/bin/python3 scripts/nas-auto-deploy.py >> /volume1/docker/companybrain/nas-deploy.log 2>&1
   ```

   Replace `/usr/bin/python3` with the result of `command -v python3`.
   Run under a dedicated account with only the required Docker/file access,
   and ensure only one scheduler task invokes this script.

## Important constraints

- A successful CI run verifies tests and Docker build, not a live LINE delivery.
- The first installation requires NAS access. GitHub changes alone cannot
  install a scheduler or directly operate your NAS.
- A failing health check triggers rollback of application files and container,
  but does not roll back database migrations. Back up the DB before major
  schema changes; review migrations separately.
- The script only updates an allowlist of application files. Changes to
  `compose.yaml` or new app files require an explicit deployment-script
  review/update, rather than silently replacing local NAS settings.
- The updater itself is **not self-updating**. Replace it intentionally after
  reviewing changes to its logic.
- `settings.env` is the source of truth; existing `scripts/apply.sh`
  overwrites `.env` from `settings.env`.
