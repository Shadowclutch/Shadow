# Deploying CW Tool to the public (free)

Everything is already multi-user: Steam login, per-user libraries, agent tokens,
server-side manifest cache, and Adder 1 fallback. What's left is hosting.

## Free stack (recommended)

Oracle Cloud **Always Free** ARM VPS + **DuckDNS** (free subdomain) + **Caddy** (free HTTPS).

### 1. Get the free server (one time, ~10 min)
1. Sign up at `https://www.oracle.com/cloud/free/` (needs a card to verify, never charged).
2. Create a **Compute > VM.Standard.A1.Flex** instance — Ubuntu 22.04, 4 OCPU / 24 GB RAM, boot volume (persistent disk).
3. Note the public IP. Download the SSH key.

### 2. Put the code on it
```bash
# from your PC
scp -r C:\Users\Utkarsh Mishra\.gemini\antigravity\scratch\steam_tool_web ubuntu@<SERVER_IP>:~/cwtool
# or clone your git repo if you pushed it
```

### 3. Free subdomain + run setup
```bash
ssh ubuntu@<SERVER_IP>
sudo mv ~/cwtool /opt/cwtool
sudo bash /opt/cwtool/deploy/setup.sh cwtool    # your DuckDNS name
```
This installs Node, Caddy, registers the server as a service, and enables HTTPS.

### 4. Point the subdomain at the server
1. At `https://duckdns.org` create `cwtool` → set it to your server's public IP.
2. Oracle Cloud: open ports **80** and **443** in the instance's security list.

Done → site live at `https://cwtool.duckdns.org`.

### 5. Copy local data (optional, if you want your own library there too)
```bash
scp data.sqlite ubuntu@<SERVER_IP>:/opt/cwtool/
scp -r manifest_cache ubuntu@<SERVER_IP>:/opt/cwtool/
sudo systemctl restart cwtool
```

## Manual setup (no setup.sh)
- Install Node 22: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs`
- `cd /opt/cwtool && npm install --omit=dev`
- Caddyfile + service file live in `deploy/`.

## Notes
- `SITE_URL` must be the public HTTPS URL (set in `deploy/cwtool.service`); the agent installer and Steam login callback derive from it.
- Manifest cache + SQLite are on persistent disk at `/opt/cwtool` — they survive restarts (unlike Render's free tier).
- No Steam API key required for the core flow; `STEAM_API_KEY` is only for the optional "owned games only" matching.
