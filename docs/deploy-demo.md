# Putting the Midotel demo online

One server in AWS Mumbai runs everything: database, API, admin, hotel websites, booking engine,
and Caddy, which gets HTTPS certificates automatically. Good for a demo and the first pilot hotels.
Later we move to the larger setup in the architecture doc (managed database, separate servers).

You will end up with:

| Address | What |
| --- | --- |
| `https://app.<your domain>` | Admin for hotels |
| `https://book.<your domain>` | Booking engine |
| `https://demo.<your domain>` | Demo hotel website (any hotel domain works the same way) |
| `https://api.<your domain>` | API (used by the apps) |
| `https://sites.<your domain>` | Website previews |

## 1. Buy the domain (you)

Buy the Midotel domain (for example `midotel.in` or `midotel.com`) from any registrar (GoDaddy, Namecheap,
Cloudflare, Hostinger). Keep the login safe; you need its DNS settings in step 3.

## 2. Create the server (you)

1. Create an AWS account at aws.amazon.com and turn on multi-factor authentication for the root user.
2. Open **Lightsail** → **Create instance**.
   - Region: **Mumbai (ap-south-1)**.
   - Platform: Linux. Blueprint: **OS only → Ubuntu 24.04 LTS**.
   - Plan: at least **4 GB RAM** (building the apps needs it).
   - Name: `midotel-demo`.
3. In the instance's **Networking** tab: **Create static IP** and attach it. Note the IP address.
4. In the same tab, under IPv4 firewall, **add rules for HTTPS (443)** and **HTTP (80)**. SSH (22) is already there.
5. In the **Snapshots** tab, turn on **automatic snapshots** (daily backups).

## 3. Point the domain at the server (you)

At your registrar's DNS settings, add these records (replace `203.0.113.10` with your static IP):

| Type | Name | Value |
| --- | --- | --- |
| A | `app` | 203.0.113.10 |
| A | `api` | 203.0.113.10 |
| A | `book` | 203.0.113.10 |
| A | `sites` | 203.0.113.10 |
| A | `demo` | 203.0.113.10 |

DNS changes can take from a few minutes to a few hours.

## 4. Install and start Midotel (on the server)

Open the Lightsail instance → **Connect using SSH** (browser terminal), then run these one at a time.

Install Docker (official convenience script from docker.com):

```bash
curl -fsSL https://get.docker.com | sudo sh
```

```bash
sudo usermod -aG docker ubuntu && exit
```

Reconnect with SSH, then fetch the code. The repository is private, so GitHub asks for a username and a
**fine-grained personal access token** with read-only access to `midotel` (GitHub → Settings → Developer settings):

```bash
git clone https://github.com/Midinningsapps/midotel.git && cd midotel/deploy
```

Create the settings file and fill it in. Generate each secret with `openssl rand -hex 32`:

```bash
cp .env.example .env && nano .env
```

Build and start (the first build takes about 10 minutes):

```bash
docker compose up -d --build
```

Check that everything is running:

```bash
docker compose ps
```

## 5. Set up the demo hotel (in the browser)

1. Open `https://app.<your domain>/signup` and create your account and demo hotel.
2. Fill in **Hotel details**, **Rooms**, **Rate plans**, then prices in **Rates and availability**.
3. In **Website**, edit the pages, then under **Web address** add `demo.<your domain>` and press **Publish website**.
4. Open `https://demo.<your domain>`. The first visit takes a few seconds while the certificate is issued.

## Updating after new code is pushed

```bash
cd ~/midotel && git pull && cd deploy && docker compose up -d --build
```

## Good to know

- Payments run in demo mode until the hotel enters Razorpay keys under **Payments**.
- Emails and WhatsApp messages are saved on the server (in the `appdata` volume) until `POSTMARK_TOKEN`/`MAIL_FROM`
  and `WHATSAPP_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` are set in `deploy/.env`.
- A hotel's own domain (for example `www.yourhotel.com`) works the same way: point it to the server's IP, add it under
  **Web address**, publish.
- Logs: `docker compose logs -f api` (or `admin`, `site`, `booking`, `caddy`).
- Database backup to a file: `docker compose exec db pg_dump -U postgres midotel > backup.sql`.
