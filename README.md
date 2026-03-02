# Paralan Trade Bot 🟢

Polymarket Prediction Intelligence — Telegram Signal Bot

## Features

- 📊 Real-time market data (100+ markets)
- 🔺 Arbitrage detection (auto-scan every 60s)
- 🔥 Volume spike alerts
- 📈📉 Price movement signals
- 🎯 Spread anomaly detection  
- 🛡 Risk scoring (A-F grades)
- ☀️ Daily summary report (09:00 UTC)
- 🏛💰📈🚀⚽🌍 Category filters

## Commands

| Command | Description |
|---------|-------------|
| /start | Welcome + command list |
| /piyasa | Market overview |
| /top5 | Top 5 by volume |
| /arbitraj | Arbitrage opportunities |
| /guvenli | A-B grade safe markets |
| /politika | Politics markets |
| /kripto | Crypto markets |
| /ekonomi | Economy markets |
| /teknoloji | Tech markets |
| /spor | Sports markets |
| /jeopolitik | Geopolitics markets |
| /rapor | Daily summary now |
| /premium | Premium plan info |
| /durum | Account status |

## Deploy to Railway

1. Push to GitHub
2. Go to [railway.app](https://railway.app)
3. New Project → Deploy from GitHub
4. Add environment variable: `BOT_TOKEN`
5. Deploy

## Pricing

- **Free**: 5 signals/day, 3 arbitrage, daily report
- **Premium ($19/mo)**: Unlimited signals, live alerts, all arbitrage
- **Pro ($49/mo)**: API access, webhooks, custom filters

## Tech Stack

- Node.js 22 + Telegraf
- Polymarket Gamma API + CLOB API
- node-cron for scheduled tasks
