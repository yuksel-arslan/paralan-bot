// ═══════════════════════════════════════════════════════════════
// PARALAN TRADE BOT — Polymarket Prediction Intelligence
// Telegram Signal Bot with Freemium Model
// ═══════════════════════════════════════════════════════════════

const { Telegraf, Markup } = require("telegraf");
const cron = require("node-cron");

const BOT_TOKEN = process.env.BOT_TOKEN || "8760749141:AAGP9Rt1-5TwPYz3ndv2sNUfUyZSyXiqyXc";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const bot = new Telegraf(BOT_TOKEN);

// ─── State ───
const users = new Map();        // chatId -> { joinedAt, plan, signalsToday, lastDaily }
const prevMarkets = new Map();  // marketId -> { yesPrice, volume24h, liquidity, spread }
const alertHistory = [];        // recent alerts for dedup

const PLANS = {
  free:    { label: "🆓 Free", dailySignals: 5, arbitrage: true, liveAlerts: false, priority: false },
  premium: { label: "⭐ Premium", dailySignals: 999, arbitrage: true, liveAlerts: true, priority: true },
  pro:     { label: "💎 Pro", dailySignals: 999, arbitrage: true, liveAlerts: true, priority: true },
};

// Escape Markdown V2 special chars
function escMd(text) {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// ─── Helpers ───
const fmt$ = (n) => {
  if (n >= 1e9) return escMd(`$${(n/1e9).toFixed(1)}B`);
  if (n >= 1e6) return escMd(`$${(n/1e6).toFixed(1)}M`);
  if (n >= 1e3) return escMd(`$${(n/1e3).toFixed(0)}K`);
  return escMd(`$${n.toFixed(0)}`);
};
const pct = (n) => escMd(`${(n * 100).toFixed(1)}%`);
const riskGrade = (m) => {
  let s = 0;
  // Liquidity (35%)
  const liqScore = Math.min(100, Math.max(0, (Math.log10(Math.max(m.liquidity, 1)) - 3) * 25));
  s += liqScore * 0.35;
  // Volume activity (30%)
  const volRatio = m.volume24h / Math.max(m.volume, 1);
  s += Math.min(100, volRatio * 1000) * 0.30;
  // Spread (20%)
  const spreadScore = m.spread !== null ? Math.max(0, 100 - m.spread * 2000) : 50;
  s += spreadScore * 0.20;
  // Time (15%)
  const dl = m.daysLeft || 999;
  const timeScore = dl >= 30 && dl <= 180 ? 100 : dl < 3 ? 20 : dl > 365 ? 40 : 70;
  s += timeScore * 0.15;
  
  if (s >= 85) return { g: "A", emoji: "🟢", label: "Düşük Risk" };
  if (s >= 70) return { g: "B", emoji: "🔵", label: "Orta-Düşük" };
  if (s >= 55) return { g: "C", emoji: "🟡", label: "Orta" };
  if (s >= 40) return { g: "D", emoji: "🟠", label: "Orta-Yüksek" };
  return { g: "F", emoji: "🔴", label: "Yüksek Risk" };
};

const categorize = (q) => {
  const t = q.toLowerCase();
  if (/trump|biden|election|president|congress|senate|governor|vote|party|democrat|republican/i.test(t)) return "🏛 Politika";
  if (/bitcoin|btc|ethereum|eth|crypto|solana|sol|defi|nft|token|coin/i.test(t)) return "💰 Kripto";
  if (/fed|rate|inflation|gdp|recession|economy|stock|s&p|nasdaq|market cap|tariff/i.test(t)) return "📈 Ekonomi";
  if (/ai |gpt|openai|apple|google|microsoft|tesla|spacex|tech|launch|release/i.test(t)) return "🚀 Teknoloji";
  if (/nba|nfl|soccer|football|champion|world cup|premier|league|win|finals|medal/i.test(t)) return "⚽ Spor";
  if (/war|russia|ukraine|china|taiwan|iran|nato|military|ceasefire|peace/i.test(t)) return "🌍 Jeopolitik";
  return "📊 Diğer";
};

const daysUntil = (d) => Math.max(0, Math.ceil((new Date(d) - Date.now()) / 86400000));

// ─── Fetch Polymarket Data ───
async function fetchMarkets() {
  try {
    const [mRes, eRes] = await Promise.all([
      fetch(`${GAMMA}/markets?limit=100&active=true&closed=false&order=volume24hr&ascending=false`),
      fetch(`${GAMMA}/events?limit=50&active=true&closed=false&order=volume24hr&ascending=false`),
    ]);
    if (!mRes.ok || !eRes.ok) throw new Error("API error");
    const [mData, eData] = await Promise.all([mRes.json(), eRes.json()]);

    const markets = mData.filter(m => m.question && m.outcomePrices).map(m => {
      const prices = JSON.parse(m.outcomePrices || "[]");
      const tokenIds = JSON.parse(m.clobTokenIds || "[]");
      return {
        id: m.id,
        question: m.question,
        slug: m.slug,
        yesPrice: Number(prices[0] || 0),
        noPrice: Number(prices[1] || 0),
        volume: Number(m.volumeNum || 0),
        volume24h: Number(m.volume24hr || 0),
        volume1wk: Number(m.volume1wk || 0),
        liquidity: Number(m.liquidityNum || 0),
        endDate: m.endDate,
        daysLeft: m.endDate ? daysUntil(m.endDate) : 999,
        category: categorize(m.question),
        tokenId: tokenIds[0] || null,
        spread: null,
      };
    });

    // CLOB for top 5
    try {
      const top5 = markets.filter(m => m.tokenId).slice(0, 5);
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 4000);
      const results = await Promise.allSettled(
        top5.flatMap(m => [
          fetch(`${CLOB}/midpoint?token_id=${m.tokenId}`, { signal: ctrl.signal })
            .then(r => r.ok ? r.json() : null).then(d => ({ id: m.id, type: "mid", val: d })),
          fetch(`${CLOB}/spread?token_id=${m.tokenId}`, { signal: ctrl.signal })
            .then(r => r.ok ? r.json() : null).then(d => ({ id: m.id, type: "spread", val: d })),
        ])
      );
      clearTimeout(timeout);
      results.forEach(r => {
        if (r.status === "fulfilled" && r.value) {
          const { id, type, val } = r.value;
          const market = markets.find(m => m.id === id);
          if (market && val) {
            if (type === "mid" && val.mid) { market.yesPrice = Number(val.mid); market.noPrice = 1 - market.yesPrice; }
            if (type === "spread" && val.spread) { market.spread = Number(val.spread); }
          }
        }
      });
    } catch (e) { /* CLOB optional */ }

    // Arbitrage
    const arbs = [];
    eData.forEach(e => {
      if (e.markets && e.markets.length > 1) {
        const mkts = e.markets.map(m => {
          const p = JSON.parse(m.outcomePrices || "[]");
          return { question: m.question, yesPrice: Number(p[0] || 0), liquidity: Number(m.liquidityNum || 0) };
        });
        const sum = mkts.reduce((s, m) => s + m.yesPrice, 0);
        const dev = Math.abs(1 - sum);
        if (dev > 0.015) {
          arbs.push({
            title: e.title,
            markets: mkts,
            sumYes: sum,
            deviation: dev,
            profitPct: ((dev / (sum > 1 ? sum : 1)) * 100).toFixed(2),
            totalLiq: mkts.reduce((s, m) => s + m.liquidity, 0),
          });
        }
      }
    });
    arbs.sort((a, b) => b.deviation - a.deviation);

    return { markets, arbs };
  } catch (e) {
    console.error("Fetch error:", e.message);
    return { markets: [], arbs: [] };
  }
}

// ─── Signal Detection ───
function detectSignals(markets) {
  const signals = [];
  const now = Date.now();

  for (const m of markets) {
    const prev = prevMarkets.get(m.id);
    const rg = riskGrade(m);

    if (prev) {
      // Volume spike: 24h volume > 3x previous
      if (prev.volume24h > 0 && m.volume24h > prev.volume24h * 2.5) {
        signals.push({
          type: "volume_spike",
          emoji: "🔥",
          title: "Hacim Patlaması",
          market: m,
          detail: `${fmt$(prev.volume24h)} → ${fmt$(m.volume24h)} (${escMd((m.volume24h / prev.volume24h).toFixed(1))}x)`,
          priority: 2,
        });
      }

      // Price move: >5% change
      const priceMove = Math.abs(m.yesPrice - prev.yesPrice);
      if (priceMove > 0.05) {
        const direction = m.yesPrice > prev.yesPrice ? "📈" : "📉";
        signals.push({
          type: "price_move",
          emoji: direction,
          title: `Fiyat ${m.yesPrice > prev.yesPrice ? "Yükselişi" : "Düşüşü"}`,
          market: m,
          detail: `${pct(prev.yesPrice)} → ${pct(m.yesPrice)} (${priceMove > 0 ? "\\+" : ""}${escMd((priceMove * 100).toFixed(1))}pp)`,
          priority: 2,
        });
      }

      // Spread tightening (CLOB)
      if (prev.spread && m.spread && m.spread < prev.spread * 0.5 && m.spread < 0.02) {
        signals.push({
          type: "spread_tight",
          emoji: "🎯",
          title: "Spread Daralması",
          market: m,
          detail: `${escMd((prev.spread * 100).toFixed(2))}¢ → ${escMd((m.spread * 100).toFixed(2))}¢`,
          priority: 1,
        });
      }

      // Risk upgrade
      const prevRg = riskGrade(prev);
      if (rg.g < prevRg.g && (rg.g === "A" || rg.g === "B")) {
        signals.push({
          type: "risk_upgrade",
          emoji: "🛡",
          title: "Risk Notu Yükseldi",
          market: m,
          detail: `${prevRg.emoji}${prevRg.g} → ${rg.emoji}${rg.g}`,
          priority: 1,
        });
      }
    }

    // High value market closing soon
    if (m.daysLeft <= 3 && m.daysLeft > 0 && m.liquidity > 500000 && (m.yesPrice > 0.15 && m.yesPrice < 0.85)) {
      signals.push({
        type: "closing_soon",
        emoji: "⏰",
        title: "Kapanıyor",
        market: m,
        detail: `${m.daysLeft} gün kaldı · Likidite: ${fmt$(m.liquidity)}`,
        priority: 3,
      });
    }

    // Store for next comparison
    prevMarkets.set(m.id, {
      yesPrice: m.yesPrice,
      volume24h: m.volume24h,
      liquidity: m.liquidity,
      spread: m.spread,
    });
  }

  signals.sort((a, b) => b.priority - a.priority);
  return signals;
}

// ─── Format Messages ───
function formatMarketCard(m, showDetail = false) {
  const rg = riskGrade(m);
  let msg = `${m.category} *${escMd(m.question)}*\n`;
  msg += `${rg.emoji} Risk: *${rg.g}* · Olasılık: *${pct(m.yesPrice)}*\n`;
  msg += `💰 Hacim 24s: ${fmt$(m.volume24h)} · Likidite: ${fmt$(m.liquidity)}\n`;
  if (m.spread !== null) msg += `🎯 Spread: ${escMd((m.spread * 100).toFixed(2))}¢ · Kaynak: CLOB\n`;
  if (m.daysLeft < 999) msg += `⏳ Kalan: ${m.daysLeft} gün\n`;
  if (showDetail) {
    msg += `\n🔗 [Polymarket'te Gör](https://polymarket.com/event/${m.slug})`;
  }
  return msg;
}

function formatSignal(signal) {
  const m = signal.market;
  const rg = riskGrade(m);
  let msg = `${signal.emoji} *${escMd(signal.title)}*\n\n`;
  msg += `${m.category} ${escMd(m.question)}\n`;
  msg += `📊 ${signal.detail}\n`;
  msg += `${rg.emoji} Risk: ${rg.g} · Olasılık: ${pct(m.yesPrice)} · Likidite: ${fmt$(m.liquidity)}\n`;
  msg += `\n🔗 [Polymarket](https://polymarket.com/event/${m.slug}) · [Dashboard](https://paralan.trade)`;
  return msg;
}

function formatArbAlert(arb) {
  let msg = `🔺 *Arbitraj Fırsatı*\n\n`;
  msg += `📌 *${escMd(arb.title)}*\n`;
  msg += `💰 Toplam Likidite: ${fmt$(arb.totalLiq)}\n`;
  msg += `📊 Toplam Yes: ${escMd((arb.sumYes * 100).toFixed(1))}% · Sapma: ${escMd((arb.deviation * 100).toFixed(1))}%\n`;
  msg += `💵 Teorik Kâr: *%${escMd(arb.profitPct)}*\n\n`;
  arb.markets.slice(0, 6).forEach(m => {
    msg += `  · ${escMd(m.question)}: ${pct(m.yesPrice)}\n`;
  });
  if (arb.markets.length > 6) msg += `  · _\\+${arb.markets.length - 6} daha\\.\\.\\._\n`;
  msg += `\n🔗 [Paralan Dashboard](https://paralan.trade)`;
  return msg;
}

function formatDailySummary(markets, arbs) {
  const topVol = [...markets].sort((a, b) => b.volume24h - a.volume24h).slice(0, 5);
  const topLiq = [...markets].sort((a, b) => b.liquidity - a.liquidity).slice(0, 3);
  const closingSoon = markets.filter(m => m.daysLeft <= 7 && m.daysLeft > 0 && m.liquidity > 200000).slice(0, 3);
  const totalVol = markets.reduce((s, m) => s + m.volume24h, 0);
  const totalLiq = markets.reduce((s, m) => s + m.liquidity, 0);

  let msg = `☀️ *PARALAN GÜNLÜK RAPOR*\n`;
  msg += `📅 ${escMd(new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}\n\n`;
  
  msg += `📊 *Piyasa Özeti*\n`;
  msg += `Toplam Hacim \\(24s\\): ${fmt$(totalVol)}\n`;
  msg += `Toplam Likidite: ${fmt$(totalLiq)}\n`;
  msg += `Aktif Market: ${markets.length}\n`;
  msg += `Arbitraj Fırsatı: ${arbs.filter(a => a.deviation > 0.02).length}\n\n`;

  msg += `🔥 *En Yüksek Hacim*\n`;
  topVol.forEach((m, i) => {
    const rg = riskGrade(m);
    msg += `${i + 1}\\. ${rg.emoji} ${escMd(m.question.slice(0, 50))}${m.question.length > 50 ? "\\.\\.\\." : ""}\n`;
    msg += `   ${pct(m.yesPrice)} · ${fmt$(m.volume24h)} · Risk: ${rg.g}\n`;
  });

  if (arbs.length > 0) {
    msg += `\n🔺 *Arbitraj Fırsatları*\n`;
    arbs.slice(0, 3).forEach(a => {
      msg += `· ${escMd(a.title.slice(0, 45))}: Sapma ${escMd((a.deviation * 100).toFixed(1))}% \\(kâr %${escMd(a.profitPct)}\\)\n`;
    });
  }

  if (closingSoon.length > 0) {
    msg += `\n⏰ *Yakında Kapanan*\n`;
    closingSoon.forEach(m => {
      msg += `· ${escMd(m.question.slice(0, 45))}: ${m.daysLeft}g kaldı · ${pct(m.yesPrice)}\n`;
    });
  }

  msg += `\n🌐 [Tam Dashboard](https://paralan.trade) · @ParalanTradeBot`;
  return msg;
}


// ─── User Management ───
function getUser(chatId) {
  if (!users.has(chatId)) {
    users.set(chatId, { joinedAt: Date.now(), plan: "free", signalsToday: 0, lastDaily: null });
  }
  return users.get(chatId);
}

function canReceiveSignal(chatId) {
  const user = getUser(chatId);
  const plan = PLANS[user.plan];
  return user.signalsToday < plan.dailySignals;
}

function resetDailyCounters() {
  for (const [id, user] of users) {
    user.signalsToday = 0;
  }
}

// ─── Bot Commands ───

bot.start((ctx) => {
  getUser(ctx.chat.id);
  ctx.replyWithMarkdownV2(
    `🟢 *PARALAN TRADE BOT*\n` +
    `_Polymarket Prediction Intelligence_\n\n` +
    `Gerçek zamanlı sinyal, arbitraj alarmı ve piyasa analizi\\.\n\n` +
    `📊 /piyasa \\— Piyasa özeti\n` +
    `🔥 /top5 \\— En yüksek hacimli marketler\n` +
    `🔺 /arbitraj \\— Arbitraj fırsatları\n` +
    `🏛 /politika \\— Politika marketleri\n` +
    `💰 /kripto \\— Kripto marketleri\n` +
    `📈 /ekonomi \\— Ekonomi marketleri\n` +
    `🚀 /teknoloji \\— Teknoloji marketleri\n` +
    `⚽ /spor \\— Spor marketleri\n` +
    `🛡 /guvenli \\— Sadece A\\-B risk notlu marketler\n` +
    `⭐ /premium \\— Premium plan bilgisi\n` +
    `❓ /yardim \\— Komut listesi\n\n` +
    `🆓 Free planda günde 5 sinyal alırsın\\.\n` +
    `⭐ Premium ile sınırsız sinyal \\+ anlık bildirim\\!\n\n` +
    `🌐 [paralan\\.trade](https://paralan.trade)`,
    { disable_web_page_preview: true }
  );
});

bot.command("yardim", (ctx) => {
  ctx.replyWithMarkdownV2(
    `📖 *KOMUTLAR*\n\n` +
    `📊 /piyasa \\— Genel piyasa özeti\n` +
    `🔥 /top5 \\— En aktif 5 market\n` +
    `🔺 /arbitraj \\— Arbitraj fırsatları\n` +
    `🛡 /guvenli \\— A\\-B risk notlu güvenli marketler\n\n` +
    `*Kategoriler:*\n` +
    `🏛 /politika · 💰 /kripto · 📈 /ekonomi\n` +
    `🚀 /teknoloji · ⚽ /spor · 🌍 /jeopolitik\n\n` +
    `⭐ /premium \\— Plan ve fiyatlar\n` +
    `📬 /rapor \\— Günlük raporu şimdi al\n` +
    `ℹ️ /durum \\— Hesap durumun`,
    { disable_web_page_preview: true }
  );
});

bot.command("piyasa", async (ctx) => {
  const msg = await ctx.reply("⏳ Piyasa verisi yükleniyor...");
  const { markets, arbs } = await fetchMarkets();
  if (markets.length === 0) return ctx.reply("❌ Veri alınamadı, tekrar deneyin.");

  const totalVol = markets.reduce((s, m) => s + m.volume24h, 0);
  const totalLiq = markets.reduce((s, m) => s + m.liquidity, 0);
  const aCount = markets.filter(m => riskGrade(m).g === "A").length;
  const bCount = markets.filter(m => riskGrade(m).g === "B").length;

  ctx.replyWithMarkdownV2(
    `📊 *POLYMARKET PİYASA ÖZETİ*\n\n` +
    `💰 24s Hacim: *${fmt$(totalVol)}*\n` +
    `🏦 Toplam Likidite: *${fmt$(totalLiq)}*\n` +
    `📈 Aktif Market: *${markets.length}*\n` +
    `🟢 A Notu: ${aCount} · 🔵 B Notu: ${bCount}\n` +
    `🔺 Arbitraj: ${arbs.filter(a => a.deviation > 0.02).length} fırsat\n\n` +
    `🌐 [Tam Dashboard →](https://paralan.trade)`,
    { disable_web_page_preview: true }
  );
});

bot.command("top5", async (ctx) => {
  await ctx.reply("⏳ Yükleniyor...");
  const { markets } = await fetchMarkets();
  if (markets.length === 0) return ctx.reply("❌ Veri alınamadı.");

  const top = markets.sort((a, b) => b.volume24h - a.volume24h).slice(0, 5);
  let msg = `🔥 *EN AKTİF 5 MARKET*\n\n`;
  top.forEach((m, i) => {
    const rg = riskGrade(m);
    msg += `*${i + 1}\\.* ${rg.emoji} ${escMd(m.question.slice(0, 60))}\n`;
    msg += `   Olasılık: *${pct(m.yesPrice)}* · Hacim: ${fmt$(m.volume24h)}\n`;
    msg += `   Likidite: ${fmt$(m.liquidity)} · Risk: ${rg.g}`;
    if (m.spread !== null) msg += ` · Spread: ${escMd((m.spread * 100).toFixed(1))}¢`;
    msg += `\n\n`;
  });
  msg += `🌐 [Dashboard](https://paralan.trade)`;
  ctx.replyWithMarkdownV2(msg, { disable_web_page_preview: true });
});

bot.command("arbitraj", async (ctx) => {
  await ctx.reply("⏳ Arbitraj taranıyor...");
  const { arbs } = await fetchMarkets();
  if (arbs.length === 0) return ctx.reply("✅ Şu an belirgin arbitraj fırsatı yok.");

  const user = getUser(ctx.chat.id);
  const limit = PLANS[user.plan].priority ? 10 : 3;
  
  let msg = `🔺 *ARBİTRAJ FIRSATLARI*\n\n`;
  arbs.slice(0, limit).forEach((a, i) => {
    msg += `*${i + 1}\\.* ${escMd(a.title.slice(0, 50))}\n`;
    msg += `   Sapma: *${escMd((a.deviation * 100).toFixed(1))}%* · Kâr: *%${escMd(a.profitPct)}*\n`;
    msg += `   Likidite: ${fmt$(a.totalLiq)} · ${a.markets.length} market\n\n`;
  });
  
  if (arbs.length > limit) {
    msg += `\n_${arbs.length - limit} fırsat daha var\\. ⭐ Premium ile hepsini gör\\!_\n`;
  }
  msg += `\n🌐 [Dashboard](https://paralan.trade)`;
  ctx.replyWithMarkdownV2(msg, { disable_web_page_preview: true });
});

// Category commands
const categoryCommand = (category) => async (ctx) => {
  await ctx.reply("⏳ Yükleniyor...");
  const { markets } = await fetchMarkets();
  const filtered = markets.filter(m => m.category.includes(category)).sort((a, b) => b.volume24h - a.volume24h).slice(0, 7);
  
  if (filtered.length === 0) return ctx.reply(`Bu kategoride aktif market bulunamadı.`);

  let msg = `${filtered[0].category} *${category.toUpperCase()} MARKETLERİ*\n\n`;
  filtered.forEach((m, i) => {
    const rg = riskGrade(m);
    msg += `${i + 1}\\. ${rg.emoji} ${escMd(m.question.slice(0, 55))}\n`;
    msg += `   ${pct(m.yesPrice)} · ${fmt$(m.volume24h)} · Risk: ${rg.g}\n\n`;
  });
  msg += `🌐 [Dashboard](https://paralan.trade)`;
  ctx.replyWithMarkdownV2(msg, { disable_web_page_preview: true });
};

bot.command("politika", categoryCommand("Politika"));
bot.command("kripto", categoryCommand("Kripto"));
bot.command("ekonomi", categoryCommand("Ekonomi"));
bot.command("teknoloji", categoryCommand("Teknoloji"));
bot.command("spor", categoryCommand("Spor"));
bot.command("jeopolitik", categoryCommand("Jeopolitik"));

bot.command("guvenli", async (ctx) => {
  await ctx.reply("⏳ Güvenli marketler taranıyor...");
  const { markets } = await fetchMarkets();
  const safe = markets
    .filter(m => {
      const rg = riskGrade(m);
      return (rg.g === "A" || rg.g === "B") && m.liquidity > 100000;
    })
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 8);

  if (safe.length === 0) return ctx.reply("Kriterlere uyan market bulunamadı.");

  let msg = `🛡 *GÜVENLİ MARKETLER* \\(A\\-B Risk\\)\n\n`;
  safe.forEach((m, i) => {
    const rg = riskGrade(m);
    msg += `${i + 1}\\. ${rg.emoji} ${escMd(m.question.slice(0, 55))}\n`;
    msg += `   ${pct(m.yesPrice)} · ${fmt$(m.volume24h)} · ${fmt$(m.liquidity)} liq\n\n`;
  });
  msg += `🌐 [Dashboard](https://paralan.trade)`;
  ctx.replyWithMarkdownV2(msg, { disable_web_page_preview: true });
});

bot.command("rapor", async (ctx) => {
  await ctx.reply("⏳ Günlük rapor hazırlanıyor...");
  const { markets, arbs } = await fetchMarkets();
  if (markets.length === 0) return ctx.reply("❌ Veri alınamadı.");
  const msg = formatDailySummary(markets, arbs);
  ctx.replyWithMarkdownV2(msg, { disable_web_page_preview: true });
});

bot.command("durum", (ctx) => {
  const user = getUser(ctx.chat.id);
  const plan = PLANS[user.plan];
  const joined = new Date(user.joinedAt).toLocaleDateString("tr-TR");
  ctx.replyWithMarkdownV2(
    `ℹ️ *HESAP DURUMU*\n\n` +
    `Plan: ${plan.label}\n` +
    `Bugün sinyal: ${user.signalsToday}/${plan.dailySignals === 999 ? "∞" : plan.dailySignals}\n` +
    `Anlık bildirim: ${plan.liveAlerts ? "✅" : "❌"}\n` +
    `Kayıt: ${escMd(joined)}\n\n` +
    `${user.plan === "free" ? "⭐ /premium ile sınırsız sinyal aç\\!" : "✅ Premium aktif\\!"}`,
    { disable_web_page_preview: true }
  );
});

bot.command("premium", (ctx) => {
  ctx.replyWithMarkdownV2(
    `⭐ *PARALAN PREMIUM*\n\n` +
    `🆓 *Free Plan*\n` +
    `· Günde 5 sinyal\n` +
    `· Arbitraj \\(ilk 3\\)\n` +
    `· Günlük rapor\n` +
    `· Tüm komutlar\n\n` +
    `⭐ *Premium \\— $19/ay*\n` +
    `· Sınırsız sinyal\n` +
    `· Anlık bildirim \\(7/24\\)\n` +
    `· Tüm arbitraj fırsatları\n` +
    `· Öncelikli alertler\n` +
    `· Hacim patlaması alarmı\n\n` +
    `💎 *Pro \\— $49/ay*\n` +
    `· Premium'un tüm özellikleri\n` +
    `· Webhook entegrasyonu\n` +
    `· API erişimi\n` +
    `· Özel filtreler\n\n` +
    `💳 Satın almak için:\n` +
    `🔗 [Paralan Premium](https://paralan.trade/premium)\n\n` +
    `_Kripto ödeme \\(USDC/USDT\\) de kabul edilir\\._`,
    { disable_web_page_preview: true }
  );
});

// ─── Periodic Signal Scanner ───
let scanInterval;

async function scanAndBroadcast() {
  try {
    const { markets, arbs } = await fetchMarkets();
    if (markets.length === 0) return;

    const signals = detectSignals(markets);
    
    // Broadcast to premium users
    for (const [chatId, user] of users) {
      const plan = PLANS[user.plan];
      if (!plan.liveAlerts) continue;

      for (const signal of signals.slice(0, 5)) {
        // Dedup: don't send same signal twice in 30 min
        const key = `${chatId}-${signal.type}-${signal.market.id}`;
        const recent = alertHistory.find(a => a.key === key && Date.now() - a.time < 1800000);
        if (recent) continue;

        try {
          await bot.telegram.sendMessage(chatId, formatSignal(signal), {
            parse_mode: "MarkdownV2",
            disable_web_page_preview: true,
          });
          alertHistory.push({ key, time: Date.now() });
          user.signalsToday++;
        } catch (e) {
          if (e.code === 403) users.delete(chatId); // blocked
        }
      }

      // Arb alerts for premium
      for (const arb of arbs.filter(a => a.deviation > 0.03).slice(0, 2)) {
        const key = `${chatId}-arb-${arb.title}`;
        const recent = alertHistory.find(a => a.key === key && Date.now() - a.time < 3600000);
        if (recent) continue;
        try {
          await bot.telegram.sendMessage(chatId, formatArbAlert(arb), {
            parse_mode: "MarkdownV2",
            disable_web_page_preview: true,
          });
          alertHistory.push({ key, time: Date.now() });
        } catch (e) {
          if (e.code === 403) users.delete(chatId);
        }
      }
    }

    // Cleanup old alert history (keep last 2 hours)
    while (alertHistory.length > 0 && Date.now() - alertHistory[0].time > 7200000) {
      alertHistory.shift();
    }
  } catch (e) {
    console.error("Scan error:", e.message);
  }
}

// ─── Daily Summary Cron ───
cron.schedule("0 9 * * *", async () => {
  // 09:00 UTC every day
  console.log("📬 Sending daily summaries...");
  const { markets, arbs } = await fetchMarkets();
  if (markets.length === 0) return;
  const msg = formatDailySummary(markets, arbs);

  resetDailyCounters();

  for (const [chatId, user] of users) {
    try {
      await bot.telegram.sendMessage(chatId, msg, {
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      });
    } catch (e) {
      if (e.code === 403) users.delete(chatId);
    }
  }
});

// ─── Launch ───
bot.launch().then(() => {
  console.log("🟢 Paralan Trade Bot is running!");
  console.log(`📊 Scanning every 60 seconds...`);
  console.log(`📬 Daily summary at 09:00 UTC`);
  
  // Initial data load
  fetchMarkets().then(({ markets }) => {
    markets.forEach(m => {
      prevMarkets.set(m.id, {
        yesPrice: m.yesPrice,
        volume24h: m.volume24h,
        liquidity: m.liquidity,
        spread: m.spread,
      });
    });
    console.log(`✅ Loaded ${markets.length} markets as baseline`);
  });

  // Scan every 60 seconds
  scanInterval = setInterval(scanAndBroadcast, 60000);
});

process.once("SIGINT", () => { clearInterval(scanInterval); bot.stop("SIGINT"); });
process.once("SIGTERM", () => { clearInterval(scanInterval); bot.stop("SIGTERM"); });
