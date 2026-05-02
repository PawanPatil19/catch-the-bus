# Catch the Bus

<img width="1265" height="641" alt="image" src="https://github.com/user-attachments/assets/6908e7a5-8596-4bbe-9cb1-03b48fc0a286" />
<br>

Catch the Bus is a tiny Singapore commute copilot. It watches your usual office/home routes, checks live LTA bus arrivals, accounts for walking time, and nudges you only when there is a real decision to make.

Instead of opening a bus app and doing mental math at the door, you get messages like:

```text
Run faster
Bus 65 in 9 min (08:55 am)
Stop 09048. Walk 7 min. Buffer 2 min.

Next catchable: bus 14 in 13 min (08:59 am), buffer 6 min
```




## What It Does

- Watches separate **Office trip** and **Home trip** leave windows.
- Uses live Singapore LTA DataMall bus arrivals.
- Searches bus stops by place, road, stop description, or stop code.
- Accounts for walking time and recommends the next bus you can actually catch.
- Shows the next catchable bus if you miss the recommended one.
- Supports optional two-bus trips with transfer stop, second bus services, ride time, and transfer walking time.
- Sends Telegram phone alerts from an always-on server.
- Includes a **Yes, I boarded** Telegram button that silences more alerts for that trip for a few hours.
- Saves commute settings on the server in `data/settings.json`.

## How It Works

```text
Browser dashboard
  -> saves commute settings

Home server
  -> polls LTA near leave windows
  -> filters out buses you cannot catch
  -> checks transfer feasibility
  -> sends Telegram alerts

Telegram
  -> "Yes, I boarded" button
  -> server stops alerts for that trip
```

The browser is only the control panel. The useful part runs on the server, so your phone can get alerts even when your laptop is closed.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

```text
http://localhost:3000
```

Without an LTA key, the app uses demo arrivals so the UI can be explored immediately.

## Environment

Create `.env`:

```bash
LTA_DATAMALL_KEY=your_lta_key
PORT=3000
TZ=Asia/Singapore

TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Optional: default is 4 hours
BOARDED_SUPPRESS_MS=14400000
```

## LTA Data

The server proxies LTA requests so the key never lives in browser code.

Used endpoints:
- `BusArrival` for live arrivals.
- `BusStops` for searchable bus stop lookup.

The bus stop list is cached in memory for the day, so search gets fast after the first lookup.

## Telegram Setup

1. Open Telegram and message `@BotFather`.
2. Send `/newbot`.
3. Copy the bot token into `TELEGRAM_BOT_TOKEN`.
4. Send `hi` to your new bot.
5. Get your chat ID:

```bash
curl 'https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates'
```

Find:

```json
"chat":{"id":123456789}
```

Put that number in `TELEGRAM_CHAT_ID`.

Test Telegram:

```bash
chmod +x scripts/test-telegram.sh
./scripts/test-telegram.sh
```

Or from the running server:

```bash
curl -X POST http://localhost:3000/api/test-notification
```

## Testing Commute Logic

After saving trip settings in the UI:

```bash
curl -X POST http://localhost:3000/api/test-commute
```

This forces the server to evaluate your configured trips immediately and send a real commute-style Telegram alert.

Useful responses:
- `notified: true` means Telegram was sent.
- `No catchable bus based on walk time` means arrivals exist, but none leave enough walking buffer.
- `Outside leave windows` means the background scheduler is correctly idle.

## Server Deployment

Copy to your home server:

```bash
rsync -av --exclude node_modules --exclude data --exclude .env \
  ./ bb_user@YOUR_SERVER:/home/bb_user/catch_the_bus/
```

Install and run:

```bash
cd /home/bb_user/catch_the_bus
npm install
npm run start
```

Open from another machine on the same network:

```text
http://SERVER_LAN_IP:3000
```

If needed, allow the port:

```bash
sudo ufw allow 3000/tcp
```

## systemd

Example service lives at:

```text
systemd/catch-the-bus.service.example
```

Install:

```bash
sudo cp systemd/catch-the-bus.service.example /etc/systemd/system/catch-the-bus.service
sudo systemctl daemon-reload
sudo systemctl enable catch-the-bus
sudo systemctl start catch-the-bus
```

Logs:

```bash
journalctl -u catch-the-bus -f
```

## UI Guide

Configure:
<img width="1018" height="753" alt="image" src="https://github.com/user-attachments/assets/e59a26cc-22a9-42bd-bc7f-895f130e1b12" />
- **Office trip**: the bus stop/services used when going to office.
- **Home trip**: the bus stop/services used when going home.
- **Walk mins**: how long it takes to reach the first bus stop.
- **Window mins**: how long before/after the leave time the server should watch.
- **Add second bus**: enable transfer-aware checks.
  <br>
  <img width="426" height="490" alt="image" src="https://github.com/user-attachments/assets/0ba61300-4a3b-4523-b26d-c969e38d9970" />

Use:
- **Test phone alert** to verify Telegram credentials.
- **Test commute alert** to verify LTA + route logic + Telegram.
- **Refresh now** to update the browser dashboard.

## Notes

- Telegram button clicks are handled with long polling, so no public webhook is required.
- Only one running instance should poll the same Telegram bot, otherwise button clicks can be consumed by the wrong instance.
- Keep `.env` and `data/` out of git.
