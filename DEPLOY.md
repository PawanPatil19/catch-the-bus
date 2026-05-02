# Catch the Bus Server + Telegram Setup

This deploys Catch the Bus as an always-on home-server watcher that sends Telegram notifications to your phone.

## 1. Create a Telegram Bot

1. Open Telegram.
2. Message `@BotFather`.
3. Send `/newbot`.
4. Choose a name and username.
5. Copy the bot token.
6. Send `hi` to your new bot from your phone.

Get your chat ID:

```bash
curl 'https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates'
```

Copy `message.chat.id`.

## 2. Copy the App to the Server

From your Mac:

```bash
rsync -av --exclude node_modules --exclude data --exclude .env \
  /Users/pawan/Documents/projects/catch_the_bus/ \
  bb_user@YOUR_SERVER:/home/bb_user/catch_the_bus/
```

## 3. Configure Environment

On the server:

```bash
cd /home/bb_user/catch_the_bus
cp .env.example .env
nano .env
```

Fill:

```bash
LTA_DATAMALL_KEY=your_lta_key
PORT=3000
TZ=Asia/Singapore
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

## 4. Test Telegram

```bash
chmod +x scripts/test-telegram.sh
./scripts/test-telegram.sh
```

You should receive a Telegram message.

## 5. Run Manually

```bash
npm install
npm run start
```

Open:

```text
http://YOUR_SERVER_IP:3000
```

Save your commute settings and click **Test phone alert**. Then click **Test commute alert** to force the server to evaluate your configured trips immediately and send the same kind of phone alert the scheduler sends.

## 6. Install systemd Service

```bash
sudo cp systemd/catch-the-bus.service.example /etc/systemd/system/catch-the-bus.service
sudo systemctl daemon-reload
sudo systemctl enable catch-the-bus
sudo systemctl start catch-the-bus
sudo systemctl status catch-the-bus
```

Logs:

```bash
journalctl -u catch-the-bus -f
```

## 7. How Notifications Work

The server checks LTA every 20 seconds near your configured leave windows. It sends Telegram alerts for useful decisions only: good bus, leave now, run faster, or working transfer. It suppresses duplicates for the same bus arrival so your phone does not get spammed.

Every commute alert includes a **Yes, I boarded** button. Tapping it makes the server stop alerts for that trip for a few hours. The default is 4 hours; change it with:

```bash
BOARDED_SUPPRESS_MS=14400000
```
