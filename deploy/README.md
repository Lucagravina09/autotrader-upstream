# VPS Deployment Notes

This service is ready to run behind `backend.lgai.co.uk` on a small VPS or any
machine you control. The goal is to keep Curio's existing hosted contract
unchanged while moving the real AutoTrader fetch off Railway egress.

## Recommended runtime shape

- Ubuntu 24.04 LTS or similar
- Node.js 20+
- `nginx` as the reverse proxy
- `systemd` as the process manager

## 1. Prepare the host

```bash
sudo apt-get update
sudo apt-get install -y nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo useradd --system --create-home --shell /usr/sbin/nologin autotrader
```

## 2. Install the service

```bash
sudo mkdir -p /srv/autotrader-upstream
sudo chown autotrader:autotrader /srv/autotrader-upstream
git clone https://github.com/Lucagravina09/autotrader-upstream.git /tmp/autotrader-upstream
sudo rsync -a --delete /tmp/autotrader-upstream/ /srv/autotrader-upstream/
cd /srv/autotrader-upstream
sudo npm ci --omit=dev
```

Create the runtime env file:

```bash
sudo cp /srv/autotrader-upstream/.env.example /etc/autotrader-upstream.env
sudo chown root:root /etc/autotrader-upstream.env
sudo chmod 640 /etc/autotrader-upstream.env
```

## 3. Install the systemd unit

```bash
sudo cp /srv/autotrader-upstream/deploy/systemd/autotrader-upstream.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now autotrader-upstream
sudo systemctl status autotrader-upstream
```

Direct service smoke:

```bash
curl http://127.0.0.1:3000/health
curl "http://127.0.0.1:3000/autotrader/search?q=fiesta"
```

## 4. Attach `backend.lgai.co.uk`

Point the Cloudflare `A` or `AAAA` record for `backend.lgai.co.uk` at the VPS,
then install the provided nginx site:

```bash
sudo cp /srv/autotrader-upstream/deploy/nginx/backend.lgai.co.uk.conf /etc/nginx/sites-available/backend.lgai.co.uk.conf
sudo ln -s /etc/nginx/sites-available/backend.lgai.co.uk.conf /etc/nginx/sites-enabled/backend.lgai.co.uk.conf
sudo nginx -t
sudo systemctl reload nginx
```

At that point, add TLS using your preferred method. A simple path is:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d backend.lgai.co.uk
```

## 5. Verify the public backend before touching the Worker

```bash
curl https://backend.lgai.co.uk/health
curl "https://backend.lgai.co.uk/autotrader/search?q=fiesta"
```

Only once those are returning real rows should Curio's Worker keep or regain:

- `AUTOTRADER_UPSTREAM_URL=https://backend.lgai.co.uk/autotrader/search`

## Notes

- The service already supports `q`, `query`, and `prompt` aliases.
- `/health` remains stable for deployment verification.
- This deploy shape preserves the Worker-facing backend contract and avoids any
  Curio frontend change.
