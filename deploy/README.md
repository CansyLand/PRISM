# Running Uprise on the server

Uprise runs on the `cansy` server (49.13.0.233, Ubuntu 24.04) as the Linux user `uprise`, on NEAR testnet.

| What | Where |
|---|---|
| Code | `/home/uprise/uprise` (a clone of this repo) |
| Secrets (not in git) | `ops/.keys.json` (account keys), `app/.backup-key` (encrypts recovery backups), `app/.server-state.json` (onboarded wallets, backups) |
| Logs | `/home/uprise/logs/app.log`, `keeper.log`, `bots.log` |
| Services | `uprise-app` (web + API on 127.0.0.1:8795), `uprise-keeper` (prices, vault hedging, gas top-ups), `uprise-bots` (testnet crowd) |
| Web | nginx site `/etc/nginx/sites-available/uprise.wtf` (from `deploy/nginx-uprise.conf`), TLS certificate `uprise.wtf` by certbot |
| URL | https://uprise.wtf (www.uprise.wtf redirects to it) |

## Everyday commands

Check status and logs:

```bash
ssh cansy 'systemctl status uprise-app uprise-keeper uprise-bots --no-pager | grep -E "●|Active"'
```

```bash
ssh cansy 'sudo tail -f /home/uprise/logs/keeper.log'
```

Deploy the latest `main`:

```bash
ssh cansy 'sudo -u uprise git -C /home/uprise/uprise pull && sudo systemctl restart uprise-app uprise-keeper uprise-bots'
```

If `ops/package.json` changed, also run `sudo -u uprise bash -c "cd /home/uprise/uprise/ops && npm ci"` before restarting.

## Adding another domain

`uprise.wtf` (DNS at Spaceship) is set up this way. For another domain:

1. At your DNS provider, point the domain at the server: an `A` record to `49.13.0.233` and an `AAAA` record to `2a01:4f8:c014:1de6::1`, for both `example.com` and `www.example.com`.
2. Wait until `dig +short example.com` shows `49.13.0.233`.
3. Add the names to the certificate, then to the `server_name` lines in `deploy/nginx-uprise.conf`, and install it:

```bash
ssh cansy 'sudo certbot certonly --nginx --cert-name uprise.wtf -d uprise.wtf -d www.uprise.wtf -d example.com -d www.example.com --non-interactive --expand'
```

```bash
scp deploy/nginx-uprise.conf cansy:/tmp/uprise.wtf && ssh cansy 'sudo cp /tmp/uprise.wtf /etc/nginx/sites-available/uprise.wtf && sudo nginx -t && sudo systemctl reload nginx'
```

Replace `example.com` with your domain. Nothing in the app needs to change: it works on any hostname.

## Gas

The keeper checks every 10 minutes that itself, the market contract, the vault and the relayer have enough free testnet NEAR (after what their storage locks). When one runs low it gets about 10 NEAR from the public testnet faucet. If the faucet refuses, the master account sends 5 NEAR. Look for `gas:` lines in `keeper.log`.
