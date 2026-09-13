// WeRun v7 · Visual Sprint 02 — artboard generator
// Emits *.dc.html artboards next to this file. Tokens are lifted verbatim from
// index.html's v6 token layer (lines 80-150) — the layer that the later
// "Soothing Green" :root block currently overrides at runtime.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* Shared system                                                        */
/* ------------------------------------------------------------------ */

const FONTS = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=Noto+Sans+TC:wght@400;500;700&family=Noto+Sans+Khmer:wght@400;700&display=swap">`;

const CSS = `
:root{
  --paper:#F6F8FA;--card:#FFFFFF;--sunk:#EFF3F7;
  --ink:#101820;--ink-mid:#3D5468;--ink-mute:#5F6E7E;
  --line:#E4E9EE;--line-hard:#CBD5DE;
  --brand:#0F66AE;--brand-fill:#0877FF;--brand-deep:#0A4D85;--brand-tint:#E8F1FB;
  --lime:#D7FF3F;--lime-ink:#101820;
  --sky-1:#6FC1F2;--sky-2:#A9DCF8;--sky-3:#DDF1FD;
  --sun:#FFB93D;--sun-tint:#FFF3DD;--leaf:#3EB489;--leaf-tint:#E2F6EE;
  --night:#12395C;--night-2:#17486F;
  --warn:#C0770A;--warn-tint:#FFF3DE;--stop:#CE4E3B;--stop-tint:#FDEBE7;
  --r:14px;
  --shadow:0 6px 22px rgba(21,105,175,.09);
  --shadow-lift:0 12px 32px rgba(21,105,175,.16);
  --sans:Inter,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.7;-webkit-font-smoothing:antialiased}
a{color:var(--brand);text-decoration:none}a:hover{color:var(--brand-deep)}
h1,h2,h3,h4,p{margin:0}
img{display:block;max-width:100%}
.phone{width:390px;position:relative;background:var(--paper);overflow:hidden}
.desk{width:1440px;position:relative;background:var(--paper);overflow:hidden}
.shell{max-width:1184px;margin:0 auto;padding:0 40px}

/* header */
.hdr{display:flex;align-items:center;gap:12px;padding:12px 16px;background:rgba(246,248,250,.92);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px}
.mark{width:28px;height:28px;border-radius:8px;background:var(--brand-fill);display:flex;align-items:center;justify-content:center}
.wordmark{font-weight:800;font-size:19px;letter-spacing:-.02em;line-height:1;color:var(--ink)}
.wordmark b{color:var(--brand);font-weight:800}
.lang{display:flex;gap:2px;background:var(--sunk);border:1px solid var(--line);border-radius:100px;padding:2px;margin-left:auto}
.lang span{font-size:12px;line-height:1;padding:7px 10px;border-radius:100px;color:var(--ink-mute);font-weight:500}
.lang span.km{font-family:"Noto Sans Khmer",var(--sans);padding-top:5px;padding-bottom:5px}
.lang .on{background:#fff;color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(16,24,32,.08)}
.nav{display:flex;gap:28px;margin-left:auto;align-items:center}
.nav span{font-size:14px;color:var(--ink-mid);font-weight:500;padding:4px 0;border-bottom:2px solid transparent}
.nav span.on{color:var(--brand);border-bottom-color:var(--brand-fill)}

/* type */
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.28em;color:var(--brand);text-transform:uppercase;line-height:1.4}
.eyebrow.mute{color:var(--ink-mute)}
.h-lat{font-family:Inter,var(--sans);font-weight:800;letter-spacing:-.02em;text-transform:uppercase;line-height:1.05}
.h-zh{font-weight:700;letter-spacing:.01em;line-height:1.35}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.mute{color:var(--ink-mute)}.mid{color:var(--ink-mid)}
.s12{font-size:12px}.s13{font-size:13px}.s14{font-size:14px}.s16{font-size:16px}.s18{font-size:18px}

/* controls */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 22px;border-radius:100px;background:var(--brand);color:#fff;font-weight:600;font-size:15px;letter-spacing:.02em;border:1px solid var(--brand);white-space:nowrap}
.btn.ghost{background:transparent;color:var(--brand)}
.btn.white{background:#fff;color:var(--brand-deep);border-color:#fff}
.btn.night{background:var(--night);border-color:var(--night)}
.btn.quiet{background:transparent;border-color:transparent;color:var(--ink-mid);padding:0 12px}
.btn.wide{width:100%}
.btn.sm{height:44px;padding:0 18px;font-size:13px}
.btn.lg{height:52px;padding:0 28px;font-size:16px}
.tag{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:.04em;line-height:1;white-space:nowrap}
.tag.lime{background:var(--lime);color:var(--lime-ink)}
.tag.tint{background:var(--brand-tint);color:var(--brand-deep)}
.tag.leaf{background:var(--leaf-tint);color:#1E7A56}
.tag.warn{background:var(--warn-tint);color:#8A5407}
.tag.stop{background:var(--stop-tint);color:var(--stop)}
.tag.night{background:var(--night);color:#fff}
.tag.ghost{background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.35)}
.chip{display:inline-flex;align-items:center;height:44px;padding:0 16px;border-radius:100px;border:1px solid var(--line-hard);background:#fff;font-size:13px;color:var(--ink-mid);font-weight:500;white-space:nowrap}
.chip.on{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:13px;font-weight:600;color:var(--ink)}
.field label small{font-weight:400;color:var(--ink-mute);margin-left:6px}
.input{height:46px;border:1px solid var(--line-hard);border-radius:10px;background:#fff;padding:0 14px;display:flex;align-items:center;font-size:15px;color:var(--ink)}
.input.ph{color:var(--ink-mute)}
.input.focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-tint)}
.seg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--line-hard);border-radius:10px;overflow:hidden}
.seg div{height:44px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:500;color:var(--ink-mid);background:#fff}
.seg .on{background:var(--brand);color:#fff;font-weight:600}
.note{border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.6}
.note.tint{background:var(--brand-tint);color:var(--brand-deep)}
.note.warn{background:var(--warn-tint);color:#7A4D06}
.note.leaf{background:var(--leaf-tint);color:#1E5E42}
.hr{height:1px;background:var(--line)}
.row{display:flex;align-items:center;gap:8px}
.between{display:flex;align-items:center;justify-content:space-between;gap:12px}
.col{display:flex;flex-direction:column}
.sec{padding:40px 20px 44px;border-bottom:1px solid var(--line)}
.sec-hd{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:20px}
.sec-hd h2{font-size:24px;font-weight:700;line-height:1.3;margin-top:6px}
.sec-hd p{font-size:13px;color:var(--ink-mute);margin-top:4px}
.stack{display:flex;flex-direction:column;gap:12px}

/* mobile nav */
.mnav{position:absolute;left:0;right:0;bottom:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));background:rgba(255,255,255,.96);border-top:1px solid var(--line-hard);padding:4px 0 14px}
.mnav div{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;height:48px;font-size:11px;color:var(--ink-mute);position:relative}
.mnav div.on{color:var(--brand);font-weight:600}
.mnav div.on::before{content:"";position:absolute;top:-5px;width:24px;height:2px;border-radius:2px;background:var(--brand-fill)}

/* steps */
.steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.steps i{display:block;height:3px;border-radius:2px;background:var(--line-hard)}
.steps i.done{background:var(--brand-fill)}
.steps i.cur{background:var(--sky-2)}
.ph-note{position:absolute;left:12px;top:12px;font-family:var(--mono);font-size:10px;letter-spacing:.12em;color:#fff;background:rgba(16,24,32,.55);padding:3px 8px;border-radius:4px}
`;

const ICON = {
  home: `<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>`,
  flag: `<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/>`,
  camera: `<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  user: `<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>`,
  arrow: `<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>`,
  back: `<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>`,
  check: `<path d="M5 12l5 5L20 7"/>`,
  search: `<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>`,
  pin: `<path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>`,
  cal: `<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>`,
  qr: `<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><path d="M14 14h3v3M20 14v6h-6"/>`,
  send: `<path d="M21 3L3 10l7 3 3 7z"/><path d="M10 13l11-10"/>`,
  medal: `<circle cx="12" cy="14" r="5"/><path d="M8.5 10L6 3h4l2 4 2-4h4l-2.5 7"/>`,
  shirt: `<path d="M8 4l4 2 4-2 4 3-2 3-2-1v11H8V9L6 10 4 7z"/>`,
  route: `<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8 17h5a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h5"/>`,
  water: `<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>`,
  shield: `<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>`,
  chevron: `<path d="M9 6l6 6-6 6"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  x: `<path d="M6 6l12 12M18 6L6 18"/>`,
  ticket: `<path d="M4 8a2 2 0 0 0 2-2V5h12v1a2 2 0 0 0 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 0-2 2v1H6v-1a2 2 0 0 0-2-2v-3a2 2 0 0 0 0-4z"/><path d="M12 5v14" stroke-dasharray="2 3"/>`,
  photo: `<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-6 6-2-2-5 5"/>`,
  history: `<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>`,
  runner: `<circle cx="15" cy="4.5" r="2"/><path d="M13 8l-4 3 2 4-4 5"/><path d="M13 8l3 3 3-1"/><path d="M11 15l4 2 1 4"/>`,
};
const icon = (n, s = 20, c = "currentColor", sw = 1.8) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

const markSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6 4 4 6-8"/><path d="M15 7h5v5"/></svg>`;

const header = (opts = {}) => `
<div class="hdr">
  <div class="brand">
    <div class="mark">${markSvg}</div>
    <div class="wordmark"><b>We</b>Run</div>
  </div>
  <div class="lang">
    <span>EN</span><span class="km">ខ្មែរ</span><span class="on">繁中</span>
  </div>
</div>`;

const mnav = (on) => {
  const items = [["home", "首頁"], ["flag", "賽事"], ["camera", "照片"], ["clock", "成績"], ["user", "我的"]];
  return `<div class="mnav">${items
    .map(([i, l]) => `<div class="${on === i ? "on" : ""}">${icon(i, 22, "currentColor", on === i ? 2 : 1.7)}<span>${l}</span></div>`)
    .join("")}</div>`;
};

const wrap = (title, body, extraCss = "") => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  ${FONTS}
  <style>${CSS}${extraCss}</style>
</helmet>
${body}
</x-dc>
</body>
</html>`;

/* ------------------------------------------------------------------ */
/* Shared fragments                                                     */
/* ------------------------------------------------------------------ */

const eventCard = ({ img, day, month, city, tag, tagCls = "lime", title, zh, dist, price, left, org = "RUN 官方" }) => `
<div class="card" style="overflow:hidden">
  <div style="position:relative;height:190px">
    <img src="${img}" alt="" style="width:100%;height:100%;object-fit:cover">
    <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(16,24,32,.35) 0%,rgba(16,24,32,0) 45%,rgba(16,24,32,.55) 100%)"></div>
    <div style="position:absolute;left:14px;top:12px;color:#fff">
      <div class="h-lat" style="font-size:24px">${day} ${month}</div>
      <div class="s12" style="opacity:.9;margin-top:2px">${city}</div>
    </div>
    <div style="position:absolute;right:12px;top:12px"><span class="tag ${tagCls}">${tag}</span></div>
    <div style="position:absolute;left:14px;bottom:12px"><span class="tag ghost">${org}</span></div>
  </div>
  <div style="padding:14px 16px 16px">
    <div class="h-lat" style="font-size:19px;line-height:1.15">${title}</div>
    <div class="s13 mute" style="margin-top:3px">${zh}</div>
    <div class="between" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
      <div class="num s14" style="font-weight:600">${dist}</div>
      <div class="row" style="gap:10px">
        <span class="s13 mute">${left}</span>
        <span class="num" style="font-weight:700;font-size:16px">${price}</span>
      </div>
    </div>
  </div>
</div>`;

const nextRaceCard = `
<div class="card" style="padding:18px 18px 16px;box-shadow:var(--shadow-lift)">
  <div class="between">
    <span class="tag lime">下一場賽事</span>
    <span class="s12 mute num">剩餘 76 名額</span>
  </div>
  <div class="h-lat" style="font-size:24px;margin-top:12px">Sihanoukville<br>Beach Run</div>
  <div class="s13 mute" style="margin-top:2px">西哈努克海濱跑 2026</div>
  <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">
    <div class="col"><span class="s12 mute">日期</span><span class="num" style="font-weight:600;font-size:14px">11 OCT</span></div>
    <div class="col"><span class="s12 mute">組別</span><span class="num" style="font-weight:600;font-size:14px">5K · 10K</span></div>
    <div class="col"><span class="s12 mute">報名費</span><span class="num" style="font-weight:600;font-size:14px">US$12 起</span></div>
  </div>
  <div class="row" style="gap:10px;margin-top:16px">
    <div class="btn" style="flex:1">立即報名</div>
    <div class="btn ghost" style="flex:1">賽事詳情</div>
  </div>
</div>`;

/* ------------------------------------------------------------------ */
/* 1 · Home (mobile)                                                    */
/* ------------------------------------------------------------------ */

const home = wrap("首頁", `
<div class="phone" style="min-height:5180px">
  ${header()}

  <!-- 01 · HERO（只留一個 hero） -->
  <section style="position:relative;height:560px;background:var(--night)">
    <img src="hero-mobile.jpg" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 40%">
    <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(16,24,32,.15) 0%,rgba(16,24,32,.1) 40%,rgba(16,24,32,.78) 100%)"></div>
    <span class="ph-note">占位素材 · AI 生成 · 不可上線</span>
    <div style="position:absolute;left:20px;right:20px;bottom:150px;color:#fff">
      <div class="eyebrow" style="color:var(--sky-2)">WE RUN · SPORTS CAMBODIA</div>
      <h1 class="h-zh" style="font-size:34px;color:#fff;margin-top:10px;text-wrap:balance">每一步，<br>都值得被記錄。</h1>
      <p class="s14" style="color:rgba(255,255,255,.82);margin-top:10px">真實賽事 · 成績 · 照片 · 跑者社群</p>
      <div class="row" style="gap:10px;margin-top:18px">
        <div class="btn white">查看賽事 ${icon("arrow", 18, "#0A4D85", 2)}</div>
        <div class="btn ghost" style="color:#fff;border-color:rgba(255,255,255,.55)">找我的照片</div>
      </div>
    </div>
  </section>

  <!-- 下一場賽事卡：壓在 hero 底部 -->
  <div style="padding:0 16px;margin-top:-120px;position:relative">${nextRaceCard}</div>

  <!-- 數字條 -->
  <div class="card" style="margin:16px 16px 0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));overflow:hidden">
    <div style="padding:16px 8px;text-align:center"><div class="num" style="font-size:22px;font-weight:600;color:var(--brand)">50+</div><div class="s12 mute">場賽事</div></div>
    <div style="padding:16px 8px;text-align:center;border-left:1px solid var(--line)"><div class="num" style="font-size:22px;font-weight:600;color:var(--brand)">20K+</div><div class="s12 mute">人次參賽</div></div>
    <div style="padding:16px 8px;text-align:center;border-left:1px solid var(--line)"><div class="num" style="font-size:22px;font-weight:600;color:var(--brand)">2023</div><div class="s12 mute">柬埔寨 · 金邊</div></div>
  </div>

  <!-- 01 UPCOMING -->
  <section class="sec">
    <div class="sec-hd">
      <div><div class="eyebrow">01 / Upcoming</div><h2>近期賽事</h2></div>
      <div class="row" style="color:var(--brand);font-weight:600;font-size:13px;white-space:nowrap">全部賽事 ${icon("chevron", 16, "currentColor", 2)}</div>
    </div>
    <div class="stack">
      ${eventCard({ img: "race-pp.jpg", day: "15", month: "NOV", city: "金邊", tag: "報名中", title: "Phnom Penh<br>Riverside Half", zh: "金邊濱河半程馬拉松 2026", dist: "21K · 10K · 5K", price: "US$12 起", left: "剩餘 556" })}
      ${eventCard({ img: "race-sunset.jpg", day: "11", month: "OCT", city: "西哈努克", tag: "報名中", title: "Sihanoukville<br>Beach Run", zh: "西哈努克海濱跑 2026", dist: "10K · 5K", price: "US$12 起", left: "剩餘 76" })}
      ${eventCard({ img: "race-angkor.jpg", day: "06", month: "DEC", city: "暹粒", tag: "即將開放", tagCls: "tint", title: "Angkor<br>Sunrise 10K", zh: "吳哥日出 10K 2026", dist: "10K · 5K", price: "US$15 起", left: "10.20 開放", org: "合作主辦" })}
    </div>
    <p class="s12 mute" style="margin-top:14px;line-height:1.6">本區只放 RUN 官方主辦與合作主辦的賽事，由 RUN 負責組織、收款與現場安全。跑友自發活動在下方單獨一區。</p>
  </section>

  <!-- 02 COMMUNITY -->
  <section class="sec">
    <div class="sec-hd">
      <div><div class="eyebrow">02 / Community</div><h2>免費活動與跑友活動</h2><p>不收報名費的官方活動，和跑友自己發起的約跑</p></div>
    </div>
    <div class="row" style="gap:8px;margin-bottom:14px"><span class="chip on">免費活動</span><span class="chip">跑友活動</span><span class="chip" style="margin-left:auto;gap:4px">${icon("plus", 14, "currentColor", 2)}發布</span></div>
    <div class="stack">
      <div class="card" style="padding:16px">
        <div class="between"><span class="tag leaf">免費 · 官方</span><span class="s12 mute">名額已滿 · 可候補</span></div>
        <div class="h-zh" style="font-size:17px;margin-top:10px">新手 5K 訓練營 · 第 4 期</div>
        <div class="s13 mid" style="margin-top:4px"><span class="num">2026.08.16</span> 起 · 連續 4 週 · 每週日 <span class="num">06:00</span></div>
        <div class="s13 mute">金邊 · 奧林匹克體育場北看台下</div>
      </div>
      <div class="card" style="padding:16px">
        <div class="between"><span class="tag leaf">免費 · 官方</span><span class="s12 mute num">剩餘 32</span></div>
        <div class="h-zh" style="font-size:17px;margin-top:10px">週三夜跑 · 濱河大道 6K</div>
        <div class="s13 mid" style="margin-top:4px"><span class="num">2026.08.20</span> 週三 <span class="num">19:00</span></div>
        <div class="s13 mute">金邊 · 洞里薩河濱公園</div>
      </div>
    </div>
    <div class="note tint" style="margin-top:14px">免費活動同樣發電子憑證、同樣計入你的跑步記錄。名額有限，報名後不來請提前取消。</div>
  </section>

  <!-- 贊助位 -->
  <section style="padding:24px 20px 0">
    <div style="background:var(--night);border-radius:var(--r);padding:20px;color:#fff;position:relative;overflow:hidden">
      <div style="position:absolute;right:-40px;top:-40px;width:180px;height:180px;border-radius:50%;background:var(--night-2)"></div>
      <div class="between" style="position:relative"><span class="eyebrow" style="color:var(--sky-2)">BlueWave · 官方補給夥伴</span><span class="tag ghost">廣告</span></div>
      <div class="h-zh" style="font-size:20px;margin-top:10px;position:relative">跑完這一場，第一口該補的是電解質</div>
      <p class="s13" style="color:rgba(255,255,255,.75);margin-top:6px;position:relative">憑任意 RUN 參賽憑證到金邊 12 家門店，全場 8 折</p>
      <div class="row" style="margin-top:14px;justify-content:space-between;position:relative">
        <div class="btn white sm">領取 8 折券</div>
        <div class="row" style="gap:5px"><i style="width:18px;height:3px;border-radius:2px;background:#fff"></i><i style="width:6px;height:3px;border-radius:2px;background:rgba(255,255,255,.35)"></i><i style="width:6px;height:3px;border-radius:2px;background:rgba(255,255,255,.35)"></i></div>
      </div>
    </div>
    <p class="s12 mute" style="margin-top:8px">贊助商品牌廣告 · 每 6 秒輪播 · 曝光與點擊計入主辦方數據看板</p>
  </section>

  <!-- 怎麼報名 -->
  <section class="sec">
    <div class="sec-hd"><div><div class="eyebrow">How it works</div><h2>三步完成報名</h2></div></div>
    <div class="stack" style="gap:0">
      ${[
        ["01", "選比賽", "挑賽事和組別，剩餘名額實時可見", "flag"],
        ["02", "填資料", "一次填寫，以後自動帶出，第二次報名只要一分鐘", "user"],
        ["03", "掃碼付款", "用任意銀行 App 掃 KHQR，參賽憑證直接發到 Telegram", "qr"],
      ].map(([n, t, d, i], k) => `
      <div class="row" style="gap:14px;align-items:flex-start;padding:14px 0;${k < 2 ? "border-bottom:1px solid var(--line)" : ""}">
        <div style="width:40px;height:40px;border-radius:12px;background:var(--brand-tint);display:flex;align-items:center;justify-content:center;color:var(--brand);flex:none">${icon(i, 20, "currentColor", 1.8)}</div>
        <div><div class="row" style="gap:8px"><span class="num s12" style="color:var(--brand);font-weight:600">${n}</span><span style="font-weight:600">${t}</span></div><div class="s13 mute" style="line-height:1.55">${d}</div></div>
      </div>`).join("")}
    </div>
  </section>

  <!-- 故事圖 -->
  <section style="position:relative;height:300px;background:var(--night)">
    <img src="story.jpg" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 30%">
    <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(16,24,32,0) 30%,rgba(16,24,32,.8) 100%)"></div>
    <span class="ph-note">占位素材 · AI 生成 · 不可上線</span>
    <div style="position:absolute;left:20px;right:20px;bottom:22px;color:#fff">
      <div class="eyebrow" style="color:var(--sky-2)">Siem Reap · 06:41 AM</div>
      <div class="h-zh" style="font-size:20px;margin-top:6px">有人來刷新 PB，<br>有人只是想第一次跑完 5K。</div>
    </div>
  </section>

  <!-- 03 AFTER THE RACE -->
  <section class="sec">
    <div class="sec-hd"><div><div class="eyebrow">03 / After the race</div><h2>比賽結束以後，它沒有消失</h2></div></div>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
      ${[
        ["clock", "Results", "成績", "你的時間、排名和每一個分段"],
        ["photo", "Photos", "照片", "用號碼布找回比賽裡的自己"],
        ["medal", "Certificate", "完賽證書", "每一次完賽永久留下，可分享"],
        ["history", "History", "跑步履歷", "5K、10K、21K，慢慢累積"],
      ].map(([i, en, zh, d]) => `
      <div class="card" style="padding:16px 14px">
        <div style="color:var(--brand)">${icon(i, 22, "currentColor", 1.7)}</div>
        <div class="eyebrow mute" style="margin-top:12px;font-size:10px">${en}</div>
        <div style="font-weight:700;font-size:16px;margin-top:2px">${zh}</div>
        <div class="s12 mute" style="margin-top:4px;line-height:1.5">${d}</div>
      </div>`).join("")}
    </div>
  </section>

  <!-- 04 PARTNERS -->
  <section class="sec">
    <div class="sec-hd"><div><div class="eyebrow">04 / Partners</div><h2>Powering the Run</h2><p>以下為演示佔位，不代表已達成的合作</p></div></div>
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px">
      ${[["water", "Hydration", "補給與飲水站"], ["clock", "Timing", "計時與晶片"], ["camera", "Photo", "賽事影像"]].map(([i, en, zh]) => `
      <div style="border:1px dashed var(--line-hard);border-radius:12px;padding:14px 10px;text-align:center;background:#fff">
        <div style="color:var(--ink-mute);display:flex;justify-content:center">${icon(i, 20)}</div>
        <div class="eyebrow mute" style="font-size:9px;margin-top:8px;letter-spacing:.2em">${en}</div>
        <div class="s12" style="font-weight:600;margin-top:2px">${zh}</div>
        <div class="s12 mute" style="margin-top:2px">待招商</div>
      </div>`).join("")}
    </div>
  </section>

  <!-- CTA -->
  <section style="background:linear-gradient(180deg,var(--sky-1) 0%,var(--sky-2) 55%,var(--sky-3) 100%);padding:44px 20px;text-align:center">
    <div class="h-lat" style="font-size:30px;color:var(--brand-deep)">Where will<br>you run next?</div>
    <div class="s14" style="color:#1B5077;margin-top:8px">下一場，你想在哪裡跑？</div>
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:22px">
      ${[["找比賽", "Find a race"], ["查成績", "My result"], ["找照片", "My photos"]].map(([zh, en]) => `
      <div style="background:rgba(255,255,255,.7);border:1px solid rgba(255,255,255,.9);border-radius:12px;padding:12px 6px"><div class="eyebrow" style="font-size:9px;letter-spacing:.18em;color:#0C4C7E">${en}</div><div style="font-weight:700;font-size:15px;color:var(--brand-deep);margin-top:2px">${zh}</div></div>`).join("")}
    </div>
  </section>

  <!-- footer -->
  <footer style="padding:28px 20px 96px;background:#fff;border-top:1px solid var(--line)">
    <div class="wordmark"><b>We</b>Run</div>
    <div class="s12 mute" style="margin-top:4px">WeRun Technology (Cambodia) Co., Ltd.<br>柬埔寨官方賽事數位基礎設施 · 金邊</div>
    <div class="row" style="gap:18px;margin-top:16px;flex-wrap:wrap" >
      ${["常見問題", "關於我們", "聯絡我們", "賽事規章", "使用條款", "個人資料政策", "退款政策"].map((t) => `<span class="s13 mid">${t}</span>`).join("")}
    </div>
    <div class="row" style="gap:8px;margin-top:18px">
      <span class="chip on" style="height:32px;font-size:12px">繁體中文</span><span class="chip" style="height:32px;font-size:12px;font-family:'Noto Sans Khmer',var(--sans)">ភាសាខ្មែរ</span><span class="chip" style="height:32px;font-size:12px">English</span>
    </div>
    <div class="s12 mute" style="margin-top:18px">© 2026 WeRun Technology (Cambodia) Co., Ltd.</div>
  </footer>

  ${mnav("home")}
</div>`);

/* ------------------------------------------------------------------ */
/* 2 · Races list                                                       */
/* ------------------------------------------------------------------ */

const races = wrap("賽事", `
<div class="phone" style="min-height:1700px">
  ${header()}
  <div style="padding:22px 20px 0">
    <div class="between" style="align-items:flex-end">
      <div><div class="eyebrow">Races</div><h1 class="h-zh" style="font-size:26px;margin-top:4px">全部賽事</h1><div class="s13 mute">報名中 · 即將開放 · 已結束</div></div>
      <div class="row" style="color:var(--brand);font-weight:600;font-size:13px;white-space:nowrap">歷史賽事 ${icon("chevron", 16, "currentColor", 2)}</div>
    </div>
    <div class="input ph" style="margin-top:16px;gap:10px">${icon("search", 18, "#5F6E7E")}搜尋賽事名稱或地點，例如「濱河」</div>
    <div style="margin-top:14px;display:flex;gap:8px;overflow:hidden">
      <span class="chip on">全部</span><span class="chip">報名中</span><span class="chip">即將開放</span><span class="chip">金邊</span><span class="chip">暹粒</span><span class="chip">西哈努克</span>
    </div>
    <div class="between" style="margin-top:14px"><span class="s13 mute">共 <b class="num" style="color:var(--ink)">8</b> 場賽事</span><span class="s13 mid row" style="gap:4px">日期 <span style="display:inline-flex;transform:rotate(90deg)">${icon("chevron", 14, "currentColor", 2)}</span></span></div>
  </div>
  <div class="stack" style="padding:16px 16px 0">
    ${eventCard({ img: "race-sunset.jpg", day: "11", month: "OCT", city: "西哈努克", tag: "報名中", title: "Sihanoukville<br>Beach Run", zh: "西哈努克海濱跑 2026", dist: "10K · 5K", price: "US$12 起", left: "剩餘 76" })}
    ${eventCard({ img: "race-pp.jpg", day: "15", month: "NOV", city: "金邊", tag: "報名中", title: "Phnom Penh<br>Riverside Half", zh: "金邊濱河半程馬拉松 2026", dist: "21K · 10K · 5K", price: "US$12 起", left: "剩餘 556" })}
    ${eventCard({ img: "race-angkor.jpg", day: "06", month: "DEC", city: "暹粒", tag: "即將開放", tagCls: "tint", title: "Angkor<br>Sunrise 10K", zh: "吳哥日出 10K 2026", dist: "10K · 5K", price: "US$15 起", left: "10.20 開放", org: "合作主辦" })}
    <div class="card" style="padding:16px;display:flex;gap:14px;align-items:center;opacity:.85">
      <div style="flex:none;width:52px;text-align:center"><div class="h-lat" style="font-size:20px;color:var(--ink-mute)">30</div><div class="eyebrow mute" style="font-size:10px;letter-spacing:.15em">AUG</div></div>
      <div style="flex:1;min-width:0"><div style="font-weight:700;font-size:15px">湄公河夜跑 2026</div><div class="s12 mute">金邊 · 濱河大道 · 10K / 5K · 1,712 人完賽</div></div>
      <span class="tag tint">榜單</span>
    </div>
  </div>
  <div style="padding:24px 20px 96px" class="row"><div class="btn ghost wide">載入更多賽事</div></div>
  ${mnav("flag")}
</div>`);

/* ------------------------------------------------------------------ */
/* 3 · Event detail                                                     */
/* ------------------------------------------------------------------ */

const detail = wrap("賽事詳情", `
<div class="phone" style="min-height:1720px">
  ${header()}
  <section style="position:relative;height:300px;background:var(--night)">
    <img src="race-pp.jpg" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
    <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(16,24,32,.3) 0%,rgba(16,24,32,.05) 35%,rgba(16,24,32,.85) 100%)"></div>
    <div style="position:absolute;left:14px;top:12px" class="row"><span class="tag ghost row" style="gap:4px;height:28px">${icon("back", 14, "#fff", 2.2)} 賽事列表</span></div>
    <div style="position:absolute;left:20px;right:20px;bottom:18px;color:#fff">
      <div class="row" style="gap:8px"><span class="tag lime">報名中</span><span class="tag ghost">RUN 官方</span></div>
      <div class="h-lat" style="font-size:28px;margin-top:10px">Phnom Penh<br>Riverside Half</div>
      <div class="s14" style="opacity:.85;margin-top:4px">金邊濱河半程馬拉松 2026</div>
    </div>
  </section>

  <div class="card" style="margin:-16px 16px 0;position:relative;padding:14px 16px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 10px">
    <div class="row" style="gap:10px;align-items:flex-start"><span style="color:var(--brand)">${icon("cal", 18)}</span><div><div class="s12 mute">日期</div><div class="s14 num" style="font-weight:600">2026.11.15 週日</div></div></div>
    <div class="row" style="gap:10px;align-items:flex-start"><span style="color:var(--brand)">${icon("clock", 18)}</span><div><div class="s12 mute">發槍</div><div class="s14 num" style="font-weight:600">05:30</div></div></div>
    <div class="row" style="gap:10px;align-items:flex-start;grid-column:span 2"><span style="color:var(--brand)">${icon("pin", 18)}</span><div><div class="s12 mute">起終點</div><div class="s14" style="font-weight:600">金邊 · 洞里薩河濱公園</div></div></div>
  </div>

  <section style="padding:24px 20px 0">
    <div class="eyebrow">Categories</div>
    <h2 class="h-zh" style="font-size:20px;margin-top:4px">選擇組別</h2>
    <div class="stack" style="margin-top:12px">
      ${[["21K", "半程馬拉松", "US$15", "剩餘 212", true], ["10K", "歡樂跑", "US$12", "剩餘 260", false], ["5K", "親子 / 新手", "US$12", "剩餘 84", false]].map(([d, n, p, l, on]) => `
      <div class="card row" style="padding:14px 16px;gap:14px;${on ? "border-color:var(--brand);box-shadow:0 0 0 2px var(--brand-tint)" : ""}">
        <div class="h-lat num" style="font-size:22px;width:52px;color:${on ? "var(--brand)" : "var(--ink)"}">${d}</div>
        <div style="flex:1"><div style="font-weight:600">${n}</div><div class="s12 mute">${l} · 含晶片計時、完賽獎牌</div></div>
        <div class="num" style="font-weight:700">${p}</div>
      </div>`).join("")}
    </div>
  </section>

  <section style="padding:28px 20px 0">
    <div class="eyebrow">About</div>
    <h2 class="h-zh" style="font-size:20px;margin-top:4px">賽事介紹</h2>
    <p class="s14 mid" style="margin-top:8px">沿洞里薩河與湄公河交匯處的濱河大道開跑，清晨 5 點半發槍。全程平坦，適合衝個人最好成績，也適合第一次跑半馬的人。終點設有補給、拉伸區和照片牆。</p>
  </section>

  <section style="padding:28px 20px 0">
    <div class="eyebrow">Course</div>
    <h2 class="h-zh" style="font-size:20px;margin-top:4px">賽道路線 · 補給與打卡點</h2>
    <div class="row" style="gap:8px;margin-top:12px"><span class="chip on">21K</span><span class="chip">10K</span><span class="chip">5K</span></div>
    <div style="margin-top:12px;height:200px;border-radius:12px;background:var(--sky-3);position:relative;overflow:hidden;border:1px solid var(--line)">
      <svg viewBox="0 0 350 200" width="100%" height="100%" style="position:absolute;inset:0">
        <path d="M30 150 C 80 60, 140 40, 200 90 S 300 150, 320 60" fill="none" stroke="#0877FF" stroke-width="4" stroke-linecap="round"/>
        <g fill="#fff" stroke="#0F66AE" stroke-width="2.5"><circle cx="30" cy="150" r="7"/><circle cx="120" cy="52" r="7"/><circle cx="200" cy="90" r="7"/><circle cx="320" cy="60" r="7"/></g>
        <g font-family="ui-monospace,Menlo,monospace" font-size="10" fill="#0A4D85" font-weight="700"><text x="20" y="176">START</text><text x="105" y="40">5K</text><text x="192" y="112">10K</text><text x="300" y="86">FINISH</text></g>
      </svg>
    </div>
    <div class="s12 mute" style="margin-top:8px">點一下地圖上的號碼，看這個點位有什麼。沿濱河大道跑一個大環，經過皇宮、獨立紀念碑和兩河交匯。</div>
  </section>

  <section style="padding:28px 20px 160px">
    <div class="eyebrow">Race pack</div>
    <h2 class="h-zh" style="font-size:20px;margin-top:4px">領物與檢錄</h2>
    <div class="stack" style="margin-top:12px;gap:8px">
      ${[["11.13–14", "金邊市中心領物點領取號碼布與裝備包"], ["04:30", "比賽日完成現場檢錄"], ["05:30", "發槍 · 21K 關門 3 小時"]].map(([t, d]) => `
      <div class="row" style="gap:12px;align-items:flex-start"><span class="num s13" style="font-weight:600;color:var(--brand);width:64px;flex:none">${t}</span><span class="s14 mid">${d}</span></div>`).join("")}
    </div>
  </section>

  <div style="position:absolute;left:0;right:0;bottom:66px;padding:12px 16px 12px;background:rgba(255,255,255,.96);border-top:1px solid var(--line)" class="between">
    <div><div class="s12 mute">21K · 半程馬拉松</div><div class="num" style="font-weight:700;font-size:18px">US$15</div></div>
    <div class="btn lg" style="min-width:170px">立即報名</div>
  </div>
  ${mnav("flag")}
</div>`);

/* ------------------------------------------------------------------ */
/* 4 · Register step 1                                                  */
/* ------------------------------------------------------------------ */

const field = (label, value, opts = {}) => `
<div class="field">
  <label>${label}${opts.hint ? `<small>${opts.hint}</small>` : ""}</label>
  <div class="input ${opts.ph ? "ph" : ""} ${opts.focus ? "focus" : ""}">${value}</div>
</div>`;

const register = wrap("報名 · 第 1 步", `
<div class="phone" style="min-height:1100px">
  ${header()}
  <div style="padding:14px 20px 0">
    <div class="steps"><i class="cur"></i><i></i><i></i><i></i></div>
    <div class="between" style="margin-top:8px"><span class="s12 mute">第 <b class="num" style="color:var(--ink)">1</b> 步 / 共 4 步 · 參賽者與組別</span><span class="s12 mute row" style="gap:4px">${icon("back", 12, "currentColor", 2.2)} 賽事詳情</span></div>
  </div>
  <div style="padding:22px 20px 0">
    <h1 class="h-zh" style="font-size:26px">誰要參加？</h1>
    <p class="s14 mute" style="margin-top:6px">金邊濱河半程馬拉松 2026 · 11 月 15 日 · 支持個人與跑團團購（單筆最多 5 人，滿 3 人享團購優惠）</p>
    <div class="note leaf" style="margin-top:14px"><b>無需註冊即可報名。</b>完成付款後可以建立 RUN 帳號，保存成績、證書和比賽照片。</div>
  </div>

  <div class="card" style="margin:18px 16px 0;overflow:hidden">
    <div class="between" style="padding:12px 16px;background:var(--sunk);border-bottom:1px solid var(--line)">
      <span class="eyebrow mute" style="letter-spacing:.18em">Participant 1</span><span style="font-weight:700">SOK DARA</span>
    </div>
    <div class="stack" style="padding:16px;gap:16px">
      ${field("姓名（拉丁字母）", "SOK DARA", { hint: "與證件一致，將印在號碼布上", focus: true })}
      <div class="field"><label>參賽者類型</label><div class="seg"><div class="on">Cambodian · 本地</div><div>International</div></div>
        <div class="note warn" style="margin-top:4px">領取 Race Pack 時需出示柬埔寨身份證件核驗，核驗不通過需現場補差價。</div></div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">
        ${field("出生日期", "1996 / 03 / 12", { hint: "以比賽當天判斷" })}
        ${field("性別", "男", {})}
      </div>
      ${field("Telegram 號碼", "+855 12 345 678", { hint: "接收參賽憑證與提醒" })}
      <div class="field"><label>組別</label>
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
          <div class="seg" style="grid-template-columns:1fr"><div class="on col" style="height:56px;line-height:1.2"><b class="num">21K</b><span class="s12" style="opacity:.85">US$15</span></div></div>
          <div class="seg" style="grid-template-columns:1fr"><div class="col" style="height:56px;line-height:1.2"><b class="num">10K</b><span class="s12 mute">US$12</span></div></div>
          <div class="seg" style="grid-template-columns:1fr"><div class="col" style="height:56px;line-height:1.2"><b class="num">5K</b><span class="s12 mute">US$12</span></div></div>
        </div></div>
      <div class="field"><label>T 恤尺碼<small>亞洲版型，偏小建議加一號</small></label>
        <div class="row" style="gap:8px">${["XS", "S", "M", "L", "XL"].map((s) => `<span class="chip ${s === "M" ? "on" : ""}" style="padding:0 0;width:52px;justify-content:center">${s}</span>`).join("")}</div></div>
    </div>
  </div>

  <div style="padding:14px 16px 0"><div class="btn ghost wide row" style="gap:6px">${icon("plus", 16, "currentColor", 2.2)} 再加一位參賽者（跑團團購）</div></div>

  <div style="position:absolute;left:0;right:0;bottom:66px;padding:12px 16px;background:rgba(255,255,255,.96);border-top:1px solid var(--line)" class="between">
    <div><div class="s12 mute">1 位參賽者 · 21K</div><div class="num" style="font-weight:700;font-size:18px">US$15</div></div>
    <div class="btn lg" style="min-width:170px">下一步 ${icon("arrow", 18, "#fff", 2)}</div>
  </div>
  ${mnav("flag")}
</div>`);

/* ------------------------------------------------------------------ */
/* 5 · Confirm & pay (KHQR)                                             */
/* ------------------------------------------------------------------ */

const pay = wrap("確認訂單 · KHQR", `
<div class="phone" style="min-height:1260px">
  ${header()}
  <div style="padding:14px 20px 0">
    <div class="steps"><i class="done"></i><i class="done"></i><i class="done"></i><i class="cur"></i></div>
    <div class="between" style="margin-top:8px"><span class="s12 mute">第 <b class="num" style="color:var(--ink)">4</b> 步 / 共 4 步 · 確認並付款</span><span class="s12 mute row" style="gap:4px">${icon("back", 12, "currentColor", 2.2)} 上一步</span></div>
  </div>
  <div style="padding:22px 20px 0">
    <h1 class="h-zh" style="font-size:26px">確認你的報名訂單</h1>
    <p class="s14 mute" style="margin-top:6px">金邊濱河半程馬拉松 2026 · 11 月 15 日 · 金邊 · 洞里薩河濱公園</p>
  </div>

  <div class="card" style="margin:18px 16px 0;padding:16px">
    <div class="between"><span style="font-weight:700">本單參賽者（1 人）</span><span class="s13" style="color:var(--brand);font-weight:600">修改</span></div>
    <div class="row" style="gap:12px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
      <div style="width:40px;height:40px;border-radius:50%;background:var(--brand-tint);display:flex;align-items:center;justify-content:center;color:var(--brand);font-weight:700;font-size:14px">SD</div>
      <div style="flex:1"><div style="font-weight:600">SOK DARA</div><div class="s12 mute">半程馬拉松 21K · Cambodian · T 恤 M · 號碼布待分配</div></div>
      <div class="num" style="font-weight:600">US$15</div>
    </div>
    <div class="s12 mute" style="margin-top:10px">付款人：SOK DARA（本單聯繫人）。付款人與參賽者是兩種角色，付款人不一定參賽。</div>
  </div>

  <div class="card" style="margin:12px 16px 0;padding:16px">
    <div style="font-weight:700">費用明細</div>
    <div class="stack" style="gap:8px;margin-top:10px">
      <div class="between s14 mid"><span>21K 半程馬拉松 × 1</span><span class="num">US$15.00</span></div>
      <div class="between s14 mid"><span>優惠碼 RUN10</span><span class="num" style="color:#1E7A56">− US$1.50</span></div>
      <div class="hr"></div>
      <div class="between"><span style="font-weight:700">合計</span><span class="num" style="font-weight:700;font-size:22px">US$13.50</span></div>
    </div>
  </div>

  <div style="padding:12px 16px 0" class="row"><div class="input" style="flex:1;border-radius:100px;gap:8px;border-color:var(--leaf)"><span style="color:#1E7A56">${icon("check", 16, "currentColor", 2.4)}</span><span class="num" style="font-weight:600">RUN10</span><span class="s12 mute">已套用 · 9 折</span></div><div class="btn ghost" style="height:46px">移除</div></div>

  <div style="padding:20px 20px 0" class="stack">
    ${[["我已閱讀並同意《賽事參賽規章》", "共 20 條官方規範", true], ["我了解參賽風險並自願參加，確認身體狀況適合本次賽事", "", true], ["同意將姓名與成績公開於榜單（可隨時關閉）", "", false]].map(([t, d, on]) => `
    <div class="row" style="gap:12px;align-items:flex-start">
      <div style="width:22px;height:22px;border-radius:6px;flex:none;margin-top:2px;${on ? "background:var(--brand);border:1px solid var(--brand)" : "border:1.5px solid var(--line-hard);background:#fff"};display:flex;align-items:center;justify-content:center">${on ? icon("check", 14, "#fff", 2.6) : ""}</div>
      <div><div class="s14">${t}</div>${d ? `<div class="s12 mute">${d}</div>` : ""}</div>
    </div>`).join("")}
  </div>

  <div style="padding:22px 20px 0">
    <div class="eyebrow">Payment</div>
    <h2 class="h-zh" style="font-size:20px;margin-top:4px">掃 KHQR 付款</h2>
    <div class="card" style="margin-top:12px;padding:18px;text-align:center">
      <div style="width:168px;height:168px;margin:0 auto;border-radius:12px;background:#fff;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--ink)">${icon("qr", 120, "currentColor", 1.2)}</div>
      <div class="s13 mid" style="margin-top:12px">用任意柬埔寨銀行 App 掃碼 · <span class="num">US$13.50</span></div>
      <div class="s12 mute">二維碼 <span class="num">14:59</span> 後失效，名額在此期間為你保留</div>
      <div class="row" style="justify-content:center;gap:8px;margin-top:12px"><span class="tag tint">ABA</span><span class="tag tint">ACLEDA</span><span class="tag tint">Wing</span><span class="tag tint">Bakong</span></div>
    </div>
  </div>

  <div style="position:absolute;left:0;right:0;bottom:66px;padding:12px 16px;background:rgba(255,255,255,.96);border-top:1px solid var(--line)" class="between">
    <div><div class="s12 mute">合計</div><div class="num" style="font-weight:700;font-size:18px">US$13.50</div></div>
    <div class="btn lg" style="min-width:190px">我已完成付款</div>
  </div>
  ${mnav("flag")}
</div>`);

/* ------------------------------------------------------------------ */
/* 6 · Done                                                             */
/* ------------------------------------------------------------------ */

const done = wrap("報名成功", `
<div class="phone" style="min-height:1290px">
  ${header()}
  <div style="padding:32px 20px 0;text-align:center">
    <div style="width:64px;height:64px;border-radius:50%;background:var(--leaf-tint);color:#1E7A56;margin:0 auto;display:flex;align-items:center;justify-content:center">${icon("check", 30, "currentColor", 2.6)}</div>
    <h1 class="h-zh" style="font-size:26px;margin-top:16px">報名成功！</h1>
    <p class="s14 mute" style="margin-top:6px">你已成功報名 金邊濱河半程馬拉松 2026</p>
  </div>

  <!-- 參賽憑證 -->
  <div style="margin:22px 16px 0;border-radius:var(--r);overflow:hidden;box-shadow:var(--shadow-lift);background:#fff;border:1px solid var(--line)">
    <div style="background:var(--night);color:#fff;padding:16px 18px;position:relative;overflow:hidden">
      <div style="position:absolute;right:-30px;top:-50px;width:160px;height:160px;border-radius:50%;background:var(--night-2)"></div>
      <div class="between" style="position:relative"><div class="wordmark" style="color:#fff"><b style="color:var(--sky-1)">We</b>Run</div><span class="tag lime">參賽憑證</span></div>
      <div class="h-lat" style="font-size:22px;margin-top:14px;position:relative">Phnom Penh<br>Riverside Half</div>
      <div class="s12" style="opacity:.8;position:relative">金邊濱河半程馬拉松 2026 · 21K</div>
    </div>
    <div style="padding:16px 18px;display:grid;grid-template-columns:1fr auto;gap:14px;align-items:center">
      <div class="stack" style="gap:8px">
        <div><div class="s12 mute">參賽者</div><div style="font-weight:700">SOK DARA</div></div>
        <div class="row" style="gap:18px"><div><div class="s12 mute">號碼布</div><div class="num" style="font-weight:700;font-size:20px">1024</div></div><div><div class="s12 mute">發槍</div><div class="num" style="font-weight:600">11.15 · 05:30</div></div></div>
      </div>
      <div style="width:96px;height:96px;border:1px solid var(--line);border-radius:10px;display:flex;align-items:center;justify-content:center">${icon("qr", 72, "#101820", 1.4)}</div>
    </div>
    <div style="border-top:1px dashed var(--line-hard);padding:10px 18px" class="s12 mute">保存好參賽憑證二維碼，領裝備包與檢錄時要用</div>
  </div>

  <div style="padding:16px 16px 0" class="row"><div class="btn wide">把憑證存到手機</div></div>
  <div class="note leaf row" style="margin:10px 16px 0;gap:8px;align-items:flex-start"><span style="flex:none;margin-top:2px">${icon("send", 16, "currentColor", 2)}</span><span>憑證已同步推送到 Telegram。賽前 3 天我們會再提醒你一次，包含天氣和領物指引。</span></div>

  <div style="padding:24px 20px 0">
    <div class="eyebrow">Next</div>
    <h2 class="h-zh" style="font-size:20px;margin-top:4px">接下來</h2>
    <div class="stack" style="margin-top:12px;gap:0">
      ${[["cal", "<span class=\"num\">11.13–14</span> 領取裝備包", "到金邊市中心領物點領取號碼布與裝備包"], ["clock", "比賽日 <span class=\"num\">04:30</span> 前檢錄", "完成現場檢錄，<span class=\"num\">05:30</span> 發槍"], ["user", "建立 RUN 帳號", "保存成績、證書和比賽照片（可選）"]].map(([i, t, d], k) => `
      <div class="row" style="gap:14px;padding:12px 0;${k < 2 ? "border-bottom:1px solid var(--line)" : ""}">
        <div style="width:36px;height:36px;border-radius:10px;background:var(--brand-tint);color:var(--brand);display:flex;align-items:center;justify-content:center;flex:none">${icon(i, 18)}</div>
        <div><div style="font-weight:600;font-size:14px">${t}</div><div class="s12 mute">${d}</div></div>
      </div>`).join("")}
    </div>
  </div>

  <div style="margin:20px 16px 0;padding:14px 16px;border-radius:12px;background:var(--sun-tint);border:1px solid #F5DDA8" class="row">
    <div style="color:#8A5407">${icon("water", 22)}</div>
    <div style="flex:1;margin-left:6px"><div class="s14" style="font-weight:600;color:#5C3A05">BlueWave 全場 8 折 · 券碼 <span class="num">RUN-BW-8842</span></div><div class="s12" style="color:#8A5407">演示贊助商 · 有效期至 <span class="num">9/30</span> · 憑本券到門店使用</div></div>
  </div>

  <div style="padding:20px 20px 100px" class="row"><div class="btn ghost wide">返回首頁</div></div>
  ${mnav("home")}
</div>`);

/* ------------------------------------------------------------------ */
/* 7 · Home (desktop 1440)                                              */
/* ------------------------------------------------------------------ */

const deskEvent = ({ img, day, month, city, tag, tagCls = "lime", title, zh, dist, price, left, org = "RUN 官方" }) => `
<div class="card" style="overflow:hidden">
  <div style="position:relative;height:210px">
    <img src="${img}" alt="" style="width:100%;height:100%;object-fit:cover">
    <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(16,24,32,.35) 0%,rgba(16,24,32,0) 45%,rgba(16,24,32,.55) 100%)"></div>
    <div style="position:absolute;left:16px;top:14px;color:#fff"><div class="h-lat" style="font-size:26px">${day} ${month}</div><div class="s13" style="opacity:.9">${city}</div></div>
    <div style="position:absolute;right:14px;top:14px"><span class="tag ${tagCls}">${tag}</span></div>
    <div style="position:absolute;left:16px;bottom:14px"><span class="tag ghost">${org}</span></div>
  </div>
  <div style="padding:16px 18px 18px">
    <div class="h-lat" style="font-size:20px">${title}</div>
    <div class="s13 mute" style="margin-top:3px">${zh}</div>
    <div class="between" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)"><span class="num s14" style="font-weight:600">${dist}</span><span class="row" style="gap:10px"><span class="s13 mute">${left}</span><span class="num" style="font-weight:700;font-size:16px">${price}</span></span></div>
  </div>
</div>`;

const homeDesktop = wrap("首頁 · 桌面", `
<div class="desk" style="min-height:3140px">
  <div class="hdr" style="padding:16px 0"><div class="shell row" style="gap:40px;width:100%">
    <div class="brand"><div class="mark" style="width:32px;height:32px">${markSvg}</div><div class="wordmark" style="font-size:22px"><b>We</b>Run</div></div>
    <div class="nav"><span class="on">首頁</span><span>賽事</span><span>成績</span><span>照片</span><span>活動</span><span>關於</span></div>
    <div class="lang" style="margin-left:0"><span>EN</span><span class="km">ខ្មែរ</span><span class="on">繁中</span></div>
    <div class="btn ghost sm">登入</div>
  </div></div>

  <section style="position:relative;height:640px;background:var(--night)">
    <img src="hero-desktop.jpg" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 35%">
    <div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(16,24,32,.72) 0%,rgba(16,24,32,.35) 55%,rgba(16,24,32,.15) 100%)"></div>
    <span class="ph-note" style="left:auto;right:16px">占位素材 · AI 生成 · 不可上線</span>
    <div class="shell" style="position:relative;height:100%;display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:60px;align-items:center">
      <div style="color:#fff;max-width:600px">
        <div class="eyebrow" style="color:var(--sky-2)">WE RUN · SPORTS CAMBODIA</div>
        <h1 class="h-zh" style="font-size:56px;color:#fff;margin-top:14px;line-height:1.2">每一步，<br>都值得被記錄。</h1>
        <p style="font-size:18px;color:rgba(255,255,255,.85);margin-top:14px">真實賽事 · 成績 · 照片 · 跑者社群</p>
        <div class="row" style="gap:12px;margin-top:28px"><div class="btn lg white">查看賽事 ${icon("arrow", 18, "#0A4D85", 2)}</div><div class="btn lg ghost" style="color:#fff;border-color:rgba(255,255,255,.6)">找我的照片</div></div>
        <div class="row" style="gap:36px;margin-top:44px;padding-top:24px;border-top:1px solid rgba(255,255,255,.25)">
          ${[["50+", "場賽事"], ["20K+", "人次參賽"], ["2023", "柬埔寨 · 金邊"]].map(([n, l]) => `<div><div class="num" style="font-size:26px;font-weight:600;color:#fff">${n}</div><div class="s13" style="color:rgba(255,255,255,.75)">${l}</div></div>`).join("")}
        </div>
      </div>
      <div>${nextRaceCard}</div>
    </div>
  </section>

  <section class="shell" style="padding:72px 40px 0">
    <div class="sec-hd" style="margin-bottom:28px"><div><div class="eyebrow">01 / Upcoming</div><h2 style="font-size:34px">近期賽事</h2><p style="font-size:14px">RUN 官方主辦與合作主辦的賽事，由 RUN 負責組織、收款與現場安全</p></div><div class="btn ghost">全部賽事 ${icon("arrow", 16, "currentColor", 2)}</div></div>
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px">
      ${deskEvent({ img: "race-pp.jpg", day: "15", month: "NOV", city: "金邊", tag: "報名中", title: "Phnom Penh Riverside Half", zh: "金邊濱河半程馬拉松 2026", dist: "21K · 10K · 5K", price: "US$12 起", left: "剩餘 556" })}
      ${deskEvent({ img: "race-sunset.jpg", day: "11", month: "OCT", city: "西哈努克", tag: "報名中", title: "Sihanoukville Beach Run", zh: "西哈努克海濱跑 2026", dist: "10K · 5K", price: "US$12 起", left: "剩餘 76" })}
      ${deskEvent({ img: "race-angkor.jpg", day: "06", month: "DEC", city: "暹粒", tag: "即將開放", tagCls: "tint", title: "Angkor Sunrise 10K", zh: "吳哥日出 10K 2026", dist: "10K · 5K", price: "US$15 起", left: "10.20 開放", org: "合作主辦" })}
    </div>
  </section>

  <section class="shell" style="padding:72px 40px 0">
    <div style="display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:24px;align-items:stretch">
      <div>
        <div class="eyebrow">02 / Community</div><h2 style="font-size:34px;font-weight:700;margin-top:6px;line-height:1.25">免費活動與<br>跑友活動</h2>
        <p class="s14 mute" style="margin-top:10px;max-width:360px">不收報名費的官方活動，和跑友自己發起的約跑，都在這裡。免費活動同樣發電子憑證、同樣計入你的跑步記錄。</p>
        <div class="row" style="gap:8px;margin-top:20px"><span class="chip on">免費活動</span><span class="chip">跑友活動</span><span class="chip row" style="gap:4px">${icon("plus", 14, "currentColor", 2)}發布活動</span></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px">
        ${[["新手 5K 訓練營 · 第 4 期", "<span class=\"num\">2026.08.16</span> 起 · 連續 4 週 · 每週日 <span class=\"num\">06:00</span>", "金邊 · 奧林匹克體育場北看台下", "名額已滿 · 可候補"], ["週三夜跑 · 濱河大道 6K", "<span class=\"num\">2026.08.20</span> 週三 <span class=\"num\">19:00</span>", "金邊 · 洞里薩河濱公園", "剩餘 32"]].map(([t, d, p, l]) => `
        <div class="card" style="padding:20px"><div class="between"><span class="tag leaf">免費 · 官方</span><span class="s12 mute">${l}</span></div><div class="h-zh" style="font-size:18px;margin-top:12px">${t}</div><div class="s13 mid" style="margin-top:6px">${d}</div><div class="s13 mute">${p}</div></div>`).join("")}
      </div>
    </div>
  </section>

  <section style="margin-top:72px;position:relative;height:420px;background:var(--night)">
    <img src="community.jpg" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 40%">
    <div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(16,24,32,.75) 0%,rgba(16,24,32,.2) 70%)"></div>
    <span class="ph-note" style="left:auto;right:16px">占位素材 · AI 生成 · 不可上線</span>
    <div class="shell" style="position:relative;height:100%;display:flex;align-items:center;color:#fff">
      <div><div class="eyebrow" style="color:var(--sky-2)">Siem Reap · 06:41 AM</div><div class="h-zh" style="font-size:36px;margin-top:10px">有人來刷新 PB，<br>有人只是想第一次跑完 5K。</div></div>
    </div>
  </section>

  <section class="shell" style="padding:72px 40px 0">
    <div class="sec-hd" style="margin-bottom:28px"><div><div class="eyebrow">03 / After the race</div><h2 style="font-size:34px">比賽結束以後，它沒有消失</h2></div></div>
    <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px">
      ${[["clock", "Results", "成績", "你的時間、排名和每一個分段"], ["photo", "Photos", "照片", "用號碼布找回比賽裡的自己"], ["medal", "Certificate", "完賽證書", "把每一次完賽永久留下，可分享"], ["history", "Running history", "跑步履歷", "5K、10K、21K，慢慢變成你的跑步履歷"]].map(([i, en, zh, d]) => `
      <div class="card" style="padding:24px 22px"><div style="color:var(--brand)">${icon(i, 26, "currentColor", 1.6)}</div><div class="eyebrow mute" style="margin-top:18px;font-size:10px">${en}</div><div style="font-weight:700;font-size:18px;margin-top:4px">${zh}</div><div class="s13 mute" style="margin-top:6px">${d}</div></div>`).join("")}
    </div>
  </section>

  <section style="margin-top:80px;background:linear-gradient(180deg,var(--sky-1) 0%,var(--sky-2) 55%,var(--sky-3) 100%);padding:72px 0;text-align:center">
    <div class="h-lat" style="font-size:56px;color:var(--brand-deep)">Where will you run next?</div>
    <div style="font-size:17px;color:#1B5077;margin-top:8px">下一場，你想在哪裡跑？</div>
    <div class="row" style="justify-content:center;gap:14px;margin-top:30px">
      ${[["找比賽", "Find a race"], ["查成績", "Find my result"], ["找照片", "Find my photos"]].map(([zh, en]) => `<div style="background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.95);border-radius:14px;padding:16px 34px;min-width:190px"><div class="eyebrow" style="font-size:10px;letter-spacing:.2em;color:#0C4C7E">${en}</div><div style="font-weight:700;font-size:18px;color:var(--brand-deep);margin-top:2px">${zh}</div></div>`).join("")}
    </div>
  </section>

  <footer style="background:#fff;border-top:1px solid var(--line);padding:48px 0 40px">
    <div class="shell" style="display:grid;grid-template-columns:2fr 1fr 1fr 1.6fr;gap:40px">
      <div><div class="wordmark" style="font-size:22px"><b>We</b>Run</div><div class="s13 mute" style="margin-top:8px">WeRun Technology (Cambodia) Co., Ltd.<br>柬埔寨官方賽事數位基礎設施 · 金邊<br>Telegram @werun_cambodia_official</div>
        <div class="row" style="gap:8px;margin-top:16px"><span class="chip on" style="height:32px;font-size:12px">繁體中文</span><span class="chip" style="height:32px;font-size:12px;font-family:'Noto Sans Khmer',var(--sans)">ភាសាខ្មែរ</span><span class="chip" style="height:32px;font-size:12px">English</span></div></div>
      <div><div class="eyebrow mute" style="font-size:10px">Support</div><div class="stack s13 mid" style="gap:8px;margin-top:12px"><span>常見問題</span><span>關於我們</span><span>聯絡我們</span></div></div>
      <div><div class="eyebrow mute" style="font-size:10px">Legal</div><div class="stack s13 mid" style="gap:8px;margin-top:12px"><span>賽事規章</span><span>使用條款</span><span>個人資料政策</span><span>安全政策</span><span>退款政策</span></div></div>
      <div class="s12 mute" style="text-align:right">本站為 WeRun App 產品演示 · © 2026 WeRun Technology (Cambodia) Co., Ltd. 版權所有</div>
    </div>
  </footer>
</div>`);

/* ------------------------------------------------------------------ */
/* 8 · Design system sheet                                              */
/* ------------------------------------------------------------------ */

const sw = (name, hex, note, ink = "#101820") => `
<div style="border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff">
  <div style="height:64px;background:${hex};display:flex;align-items:flex-end;padding:8px"><span class="num s12" style="font-weight:600;color:#101820;background:rgba(255,255,255,.92);padding:2px 7px;border-radius:5px;line-height:1.4">${hex}</span></div>
  <div style="padding:8px 10px"><div class="s13" style="font-weight:600">${name}</div><div class="s12 mute" style="line-height:1.45">${note}</div></div>
</div>`;

const system = wrap("設計系統 v7", `
<div style="width:1200px;min-height:1560px;background:#fff;padding:48px 56px;position:relative">
  <div class="between" style="align-items:flex-start">
    <div><div class="eyebrow">WeRun · Visual System v7</div><h1 class="h-zh" style="font-size:32px;margin-top:6px">一套 Token，全站只認這一套</h1><p class="s14 mute" style="margin-top:6px;max-width:720px">來源：index.html v6 Token 層（第 80–150 行）。v7 不新造顏色，只把後來追加、互相覆蓋的 WeRun mockup / Soothing Green / miniapp 三套色板收掉，讓 v6 已經算好的對比度真正落地。</p></div>
    <span class="tag night">Sprint 02</span>
  </div>

  <div class="eyebrow mute" style="margin-top:40px">Color · 用途限制比 HEX 更重要</div>
  <div style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-top:12px">
    ${sw("Ink", "#101820", "正文永遠優先 Ink", "#fff")}
    ${sw("Ink mid / mute", "#3D5468", "輔助文字 · mute #5F6E7E 白底 5.23:1", "#fff")}
    ${sw("Brand", "#0F66AE", "文字 / 按鈕 / 連結 · 白底 5.94:1 AA", "#fff")}
    ${sw("Brand fill", "#0877FF", "只做非文字圖形：指示條、路線、裝飾", "#fff")}
    ${sw("Brand deep / tint", "#0A4D85", "深色標題 · tint #E8F1FB 做淺底", "#fff")}
    ${sw("Night", "#12395C", "深色版面（贊助卡、憑證、頁腳）", "#fff")}
    ${sw("Lime", "#D7FF3F", "只做背景標籤，字色固定 #101820 · 禁止配白字")}
    ${sw("Sky 1 / 2 / 3", "#6FC1F2", "藍天漸層：#6FC1F2 → #A9DCF8 → #DDF1FD")}
    ${sw("Leaf", "#3EB489", "免費 / 成功 · tint #E2F6EE", "#fff")}
    ${sw("Sun", "#FFB93D", "贊助券 · tint #FFF3DD")}
    ${sw("Warn / Stop", "#C0770A", "提示 #C0770A · 錯誤 #CE4E3B", "#fff")}
    ${sw("Paper / Sunk", "#F6F8FA", "中性 off-white，底色不帶藍，照片不蒙冷調 · sunk #EFF3F7")}
  </div>

  <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:48px;margin-top:44px">
    <div>
      <div class="eyebrow mute">Type · 三語各走各的字體棧</div>
      <div class="stack" style="margin-top:12px;gap:14px">
        <div class="row" style="gap:16px;align-items:baseline"><span class="h-lat" style="font-size:34px">Riverside Half</span><span class="s12 mute">Inter 800 · 拉丁標題全大寫 · -0.02em</span></div>
        <div class="row" style="gap:16px;align-items:baseline"><span class="h-zh" style="font-size:28px">每一步，都值得被記錄。</span><span class="s12 mute">PingFang TC / Noto Sans TC 700</span></div>
        <div class="row" style="gap:16px;align-items:baseline"><span style="font-family:'Noto Sans Khmer',sans-serif;font-size:24px;font-weight:700;line-height:1.9">រត់ដើម្បីថ្ងៃស្អែក</span><span class="s12 mute">Noto Sans Khmer 700 · 字號 ×1.06 · 行高 1.95</span></div>
        <div class="row" style="gap:16px;align-items:baseline"><span class="eyebrow">01 / Upcoming</span><span class="s12 mute">Mono 11px · 字距 .28em · 章節眉題</span></div>
        <div class="row" style="gap:16px;align-items:baseline"><span class="num" style="font-size:26px;font-weight:600;color:var(--brand)">05:30 · 1024 · US$13.50</span><span class="s12 mute">數字一律 mono + tabular-nums</span></div>
        <div class="row" style="gap:16px;align-items:baseline"><span style="font-size:15px">正文 15px / 1.7，輔助 13px，說明 12px</span></div>
      </div>
    </div>
    <div>
      <div class="eyebrow mute">Controls · 所有可點元素高度 ≥ 44px</div>
      <div class="stack" style="margin-top:12px;gap:14px">
        <div class="row" style="gap:10px;flex-wrap:wrap"><span class="btn">主要動作</span><span class="btn ghost">次要動作</span><span class="btn night">深色版面</span><span class="btn white" style="box-shadow:0 0 0 1px var(--line)">壓在照片上</span><span class="btn quiet">安靜</span></div>
        <div class="row" style="gap:10px;flex-wrap:wrap"><span class="btn sm">小字 44px</span><span class="btn lg">大 52px</span><span class="btn" style="opacity:.4">停用</span></div>
        <div class="row" style="gap:8px;flex-wrap:wrap"><span class="tag lime">報名中</span><span class="tag tint">即將開放</span><span class="tag leaf">免費 · 官方</span><span class="tag warn">候補</span><span class="tag stop">已截止</span><span class="tag night">參賽憑證</span></div>
        <div class="row" style="gap:8px;flex-wrap:wrap"><span class="chip on">全部</span><span class="chip">報名中</span><span class="chip">金邊</span><span class="chip">暹粒</span></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="input">SOK DARA</div><div class="input focus">聚焦 · 3px tint 光暈</div></div>
        <div class="seg" style="max-width:300px"><div class="on">Cambodian</div><div>International</div></div>
        <div class="row" style="gap:12px"><span class="s12 mute">圖標：24px 描邊 1.8 · 不用 emoji</span><span style="color:var(--brand)" class="row">${["flag", "camera", "clock", "user", "qr", "send", "medal", "pin", "cal", "route", "water", "shield"].map((i) => icon(i, 22)).join("")}</span></div>
      </div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:48px;margin-top:44px">
    <div>
      <div class="eyebrow mute">Surface · 卡片 / 圓角 / 陰影</div>
      <div class="row" style="gap:14px;margin-top:12px;align-items:flex-start">
        <div class="card" style="padding:16px;flex:1"><div class="s13" style="font-weight:600">卡片</div><div class="s12 mute">白底 · 1px #E4E9EE · 圓角 14px · 陰影 0 6px 22px rgba(21,105,175,.09)</div></div>
        <div class="card" style="padding:16px;flex:1;box-shadow:var(--shadow-lift)"><div class="s13" style="font-weight:600">抬起</div><div class="s12 mute">壓在 hero 上的下一場卡：0 12px 32px rgba(21,105,175,.16)</div></div>
        <div style="padding:16px;flex:1;background:var(--sunk);border-radius:14px"><div class="s13" style="font-weight:600">下沉</div><div class="s12 mute">空狀態 · 表頭 · 次要區塊 #EFF3F7</div></div>
      </div>
    </div>
    <div>
      <div class="eyebrow mute">Mobile nav · 5 項，指示條用 Brand fill</div>
      <div style="position:relative;height:74px;margin-top:12px;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--paper)">${mnav("flag")}</div>
    </div>
  </div>

  <div style="margin-top:44px;padding:20px 24px;border-radius:14px;background:var(--brand-tint)">
    <div class="eyebrow" style="letter-spacing:.2em">Rules</div>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 32px;margin-top:8px" class="s13 mid">
      <div>· 一頁一個 hero。首頁只留照片 hero + 壓底的「下一場」卡，天空 banner 併入 CTA 段。</div>
      <div>· 品牌只有 RUN Blue：#0F66AE 承擔文字與按鈕，#0877FF 只做圖形。綠色系全部退場。</div>
      <div>· 標籤才用 Lime；Lime 上永遠黑字。按鈕不用 Lime，也不用漸層。</div>
      <div>· 圖標一律描邊 SVG，介面文案不夾 emoji（獎牌、閃光、國旗之類全部移除）。</div>
      <div>· 同一頁面只出現當前語言：繁中版介面不混 "Sign Up / Moments" 英文按鈕。</div>
      <div>· 數字（日期、號碼布、金額、倒數）一律 mono + tabular-nums，對齊不跳動。</div>
    </div>
  </div>
</div>`);

/* ------------------------------------------------------------------ */

const files = {
  "Main.dc.html": home,
  "Races.dc.html": races,
  "Detail.dc.html": detail,
  "Register.dc.html": register,
  "Pay.dc.html": pay,
  "Done.dc.html": done,
  "HomeDesktop.dc.html": homeDesktop,
  "System.dc.html": system,
};
for (const [name, html] of Object.entries(files)) writeFileSync(join(here, name), html);
console.log("wrote", Object.keys(files).join(", "));
