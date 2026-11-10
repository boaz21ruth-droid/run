/* WeRun · 用戶端應用腳本（從 index.html 拆出，便於單獨緩存；行爲與內聯時完全一致） */
(function () {

  /* ===== Telegram Mini App 集成（審覈修復 · Phase 2）=====
     不在 Telegram 內打開時 TG.on 爲 false，下面所有方法都是空操作。
     initData 的簽名校驗（HMAC-SHA256 + bot token）必須在服務端做；前端不做任何信任判斷，
     只把 initData 原樣交給後端（本原型沒有後端，因此這裏只讀 start_param 做深鏈）。 */
  var TG = (function () {
    var wa = (window.Telegram && window.Telegram.WebApp) || null;
    var on = !!(wa && (wa.initData || (wa.platform && wa.platform !== "unknown")));
    var api = { on: on, wa: wa, startParam: null, _back: null, _main: null };
    api.back = function () {};
    api.main = function () {};
    api.haptic = function () {};
    api.closingConfirm = function () {};
    api.openLink = function (url) { window.open(url, "_blank", "noopener"); };
    if (!on) return api;
    try {
      wa.ready(); wa.expand();
      if (wa.setHeaderColor) wa.setHeaderColor("#F6F8FA");
      if (wa.setBackgroundColor) wa.setBackgroundColor("#F6F8FA");
      if (wa.disableVerticalSwipes) wa.disableVerticalSwipes();
      document.body.classList.add("tg-mode");
      api.startParam = (wa.initDataUnsafe && wa.initDataUnsafe.start_param) || null;
      var applyViewport = function () {
        var h = wa.viewportStableHeight || wa.viewportHeight || window.innerHeight;
        var sa = wa.safeAreaInset || {}, ca = wa.contentSafeAreaInset || {};
        var root = document.documentElement.style;
        root.setProperty("--tg-vh", h + "px");
        root.setProperty("--tg-safe-bottom", (sa.bottom || 0) + "px");
        root.setProperty("--tg-safe-top", ((sa.top || 0) + (ca.top || 0)) + "px");
      };
      applyViewport();
      if (wa.onEvent) {
        wa.onEvent("viewportChanged", applyViewport);
        wa.onEvent("safeAreaChanged", applyViewport);
        wa.onEvent("contentSafeAreaChanged", applyViewport);
      }
    } catch (e) {}
    api.back = function (show, fn) {
      try {
        var b = wa.BackButton; if (!b) return;
        if (api._back && b.offClick) b.offClick(api._back);
        if (show) { api._back = fn; b.onClick(fn); b.show(); } else { api._back = null; b.hide(); }
      } catch (e) {}
    };
    api.main = function (text, fn) {
      try {
        var m = wa.MainButton; if (!m) return;
        if (api._main && m.offClick) m.offClick(api._main);
        if (!text) { api._main = null; m.hide(); return; }
        api._main = fn; m.setText(text); m.onClick(fn); m.show();
      } catch (e) {}
    };
    api.haptic = function (kind) {
      try { var hf = wa.HapticFeedback; if (!hf) return; kind ? hf.notificationOccurred(kind) : hf.impactOccurred("light"); } catch (e) {}
    };
    api.closingConfirm = function (flag) {
      try { flag ? wa.enableClosingConfirmation() : wa.disableClosingConfirmation(); } catch (e) {}
    };
    api.openLink = function (url) { try { wa.openLink(url); } catch (e) { window.open(url, "_blank", "noopener"); } };
    return api;
  })();

  /* 每次換屏同步 Telegram 原生控件：非首頁顯示返回鍵；賽事詳情把「立即報名」放到 MainButton；報名 / 付款中啓用關閉確認 */
  function tgSync(name) {
    if (!TG.on) return;
    TG.back(name !== "home", function () { if (history.length > 1) history.back(); else go("home"); });
    if (name === "detail") {
      var b = document.querySelector("#s-detail .btn[data-go='reg1']");
      TG.main(b ? b.textContent.trim() : "立即報名", function () { go("reg1"); });
    } else {
      TG.main(null);
    }
    TG.closingConfirm(["reg1", "reg2", "reg4", "pay"].indexOf(name) >= 0);
  }

  "use strict";
  var RF = { q: "", month: "all", loc: "all", state: "all" };

  /* ================================================================
     構建信息 —— 與頁面底部原型導航、HTML 註釋三處保持一致
     ================================================================ */
  /* ================================================================
     D-092 · 共享 Mock 業務域（assets/run-domain.js）
     用戶端與運營後臺引用同一份 Order / Participant / Registration /
     Refund / BibAssignment / 周邊商品全域 / Audit。
     ⚠️ Demo 載體，不是後端、不是數據庫、不凍結任何 API。
     ================================================================ */
  var RD = window.RUNDomain;
  var MY_UID = "u1";

  var BUILD = { version: "v6.0", date: "2026-08-10", commit: "__BUILD_COMMIT__",
                branch: "main · 正式版" };

  /* ================================================================
     定時器登記表：任何 setTimeout / setInterval 都從這裏走，
     離開頁面、重置演示、快速切換場景時統一清理，避免疊加與幽靈跳轉。
     ================================================================ */
  var TIMERS = { t: [], i: [] };
  function later(fn, ms) { var id = setTimeout(fn, ms); TIMERS.t.push(id); return id; }
  function every(fn, ms) { var id = setInterval(fn, ms); TIMERS.i.push(id); return id; }
  function clearAllTimers() {
    TIMERS.t.forEach(clearTimeout); TIMERS.i.forEach(clearInterval);
    TIMERS.t = []; TIMERS.i = [];
  }

  /* 處理中鎖：防止連點造成重複報名 / 重複領取 / 重複扣名額 */
  var LOCKS = {};
  function withLock(key, btn, label, fn) {
    if (LOCKS[key]) return false;
    LOCKS[key] = true;
    var old = null;
    if (btn) { old = btn.textContent; btn.disabled = true; if (label) btn.textContent = label; }
    try { fn(); } finally {
      later(function () {
        LOCKS[key] = false;
        if (btn && document.body.contains(btn)) {
          btn.disabled = false;
          // 只有當按鈕還停在「處理中」文案時才還原；
          // 如果處理過程中重新渲染改了文案（比如「加入候補」→「已在候補名單」），不要蓋回去
          if (old !== null && label && btn.textContent === label) btn.textContent = old;
        }
      }, 420);
    }
    return true;
  }

  /* ================================================================
     統一演示數據源 —— 全站所有頁面都從這裏讀，避免各處數字打架。
     所有內容均爲演示數據，不對應任何真實賽事、品牌或個人。
     ================================================================ */

  var DEMO = {
    note: "演示數據",

    user: {
      id: "u1", name: "SOK DARA", gender: "男", dob: "1996-04-18",
      phone: "+855 12 345 678", nation: "柬埔寨", size: "M（胸圍 102）",
      ec: "SOK SREY", ecPhone: "+855 12 987 654", idNo: "012345678"
    },

    sponsors: [
      { id: "sp1", n: "BlueWave Sports Drink", short: "BLUE", role: "官方補給夥伴",
        color: "linear-gradient(135deg,#3FA9E8,#0F66AE)" },
      { id: "sp2", n: "Mekong Bib Co.", short: "MEKO", role: "號碼布合作伙伴",
        color: "linear-gradient(135deg,#F0A93C,#E2762C)" },
      { id: "sp3", n: "Angkor Timing", short: "ANGK", role: "賽事計時夥伴",
        color: "linear-gradient(135deg,#3EB489,#1E8A66)" }
    ],

    events: [
      { id: "e1", org: "official", t: "金邊濱河半程馬拉松 2026", d: "2026.09.20", loc: "金邊 · 洞裏薩河濱公園",
        dist: "5K / 10K / 21K", price: 15, left: 483, state: "open", seed: 11,
        detail: true, hasPhotos: true, hasResults: true, photoSponsor: "sp1" },
      { id: "e2", org: "official", t: "西哈努克海濱跑 2026", d: "2026.10.11", loc: "西哈努克 · 奧切迪海灘",
        dist: "5K / 10K", price: 12, left: 76, state: "low", seed: 27 },
      { id: "e3", org: "official", t: "吳哥日出跑 2026", d: "2026.12.06", loc: "暹粒 · 吳哥窟",
        dist: "10K / 21K", price: 25, left: 0, state: "soon", seed: 43 },

      { id: "f1", org: "official", t: "RUN 週六晨跑 · 第 128 期", d: "每週六 05:45", loc: "金邊 · 鑽石島環島",
        dist: "5K 自由跑", price: 0, left: 64, state: "free", seed: 5, free: true,
        meet: "05:30 鑽石島 A 門集合", who: "任何人都可以來，跑走都行",
        supply: "終點提供飲用水與香蕉", cancelH: 6,
        desc: "RUN 每週六固定的社區晨跑，已經連續辦了 128 期。不計時、不排名，跑完一起喫個早飯。第一次來的人建議提前十分鐘到，我們會有人帶你熟悉路線。" },
      { id: "f2", org: "partner", t: "湄公河公益跑 2026", d: "2026.09.06", loc: "金邊 · 濱河大道",
        dist: "3K / 5K 親子同行", price: 0, left: 210, state: "free", seed: 33, free: true,
        meet: "06:00 濱河公園草坪集合", who: "親子家庭優先，小朋友需家長陪同",
        supply: "沿途 1 個補給點 + 終點補給", cancelH: 12,
        desc: "和本地公益機構一起辦的公益跑，報名免費，現場可以自願捐贈。3K 組適合帶小孩的家庭，5K 組沿濱河大道跑一個來回。" },
      { id: "f3", org: "official", t: "新手 5K 訓練營 · 第 4 期", d: "2026.08.16 起 · 連續 4 周",
        loc: "金邊 · 奧林匹克體育場", dist: "5K 漸進訓練", price: 0, left: 0, state: "free",
        seed: 47, free: true, meet: "每週日 06:00 體育場北看臺下",
        who: "零基礎、想在 4 周內跑完 5K 的人", supply: "每次訓練提供飲用水", cancelH: 24,
        desc: "四周從走跑結合到連續跑完 5K，教練帶練。名額少是因爲一個教練最多帶 12 個人，報滿會開下一期。" },

      { id: "e4", org: "partner", t: "金邊企業接力賽 2026", d: "2026.11.15", loc: "金邊 · 演示商圈",
        dist: "4×5K 接力", price: 60, left: 0, state: "full", seed: 58 },
      { id: "e5", org: "official", t: "湄公河夜跑 2026", d: "2026.08.30", loc: "金邊 · 濱河大道",
        dist: "5K / 10K", price: 12, left: 0, state: "done", seed: 71, hasResults: true, hasPhotos: true },
      { id: "e6", org: "partner", t: "磅湛鄉村越野 2025", d: "2025.12.14", loc: "磅湛 · 湄公河東岸",
        dist: "12K / 25K", price: 18, left: 0, state: "done", seed: 89 }
    ],

    metrics: {
      signups: 1268, paid: 1105, freeSignups: 420, waitlist: 37, cancelled: 46, revenue: 24870,
      checkin: 1042, finish: 1007, dns: 63, dnf: 35, avgTime: "2:14:38",
      photosUp: 28560, photosTagged: 24560, runnersFound: 86, photoSearch: 914,
      photoClaims: 3280, photoOrders: 214, photoRevenue: 1420,
      adImpr: 41280, freeClaims: 2860, couponGet: 607, couponUse: 83, shares: 512, aidImpr: 9840,
      bnImpr: 18420, bnClick: 763, ugcPosts: 96, ugcPending: 4, ugcRejected: 11,
      ugcJoins: 1140, ugcReports: 7, ugcFrozen: 2, ugcViews: 3140
    }
  };

  /* ---- 跑友活動：用戶自己發佈的活動（演示種子數據） ---- */
  DEMO.ugc = [
    {
      id: "g1", t: "週三夜跑 · 濱河大道 8 公里勻速", tag: "夜跑",
      by: "CHEA VUTHY", byId: "u9", av: "CV", byNote: "跑齡 4 年 · 已辦 12 次跑友活動",
      d: "2026.08.12（週三）19:30", loc: "金邊 · 濱河大道",
      meet: "19:15 王宮廣場旗杆下集合，19:30 準時出發，晚到不等",
      dist: "8 km · 配速 6:00–6:30", cap: 20, joined: 11, fee: "免費",
      imgs: [211, 212, 213], contact: { tg: "@vuthy_run", ph: "" }, vis: "joined",
      body: "每週三固定的夜跑，從王宮廣場出發沿濱河大道往北，到日本友誼橋折返，全程 8 公里，路燈全程都有，路面平。\n\n配速 6:00–6:30，會有人押尾，掉隊不會丟下你。跑完在夜市那邊喫個粿條，各付各的。\n\n帶一瓶水就夠了，中間沒有補給點。第一次來的在羣裏說一聲，我會在集合點舉個藍色的燈。",
      status: "published", at: "2026.08.05 21:14", reports: 0
    },
    {
      id: "g2", t: "週日長距離 · 機場路 20K 拉練（有配速要求）", tag: "訓練",
      by: "LY SOKHA", byId: "u12", av: "LS", byNote: "跑齡 7 年 · 全馬 3:12",
      d: "2026.08.16（週日）05:00", loc: "金邊 · 機場路輔道",
      meet: "04:50 加油站門口集合，自己解決往返交通",
      dist: "20 km · 配速 5:15–5:30", cap: 8, joined: 8, fee: "AA 均攤",
      imgs: [217, 218], contact: { tg: "@sokha_ly", ph: "+855 96 555 0142" }, vis: "public",
      body: "備戰 12 月吳哥的長距離拉練，不是新手團，請量力而行。\n\n配速 5:15–5:30，掉出配速區間超過 1 公里就自己跑回來，我不會等。中間 10 公里處我會放一箱水在路邊，水錢最後 AA。\n\n路上有車，靠邊跑，天沒亮建議穿反光背心。",
      status: "published", at: "2026.08.03 08:40", reports: 0
    }
  ];

  /* ---- 派生：賽事列表（舊代碼沿用 RACES） ---- */
  var RACES = DEMO.events;

  var BADGE = {
    open: ["報名中", ""], low: ["名額緊張", "warn"], soon: ["即將開放", "flat"],
    full: ["已滿額", "stop"], done: ["已結束", "flat"], free: ["免費報名", "free"],
    closed: ["報名已截止", "warn"],
    /* ⚖️ D-117 A2 · 只是卡片上的一個<b>展示</b>標籤，不是新的 Event 狀態：
       共享 Event.status 仍然只有 DRAFT / PUBLISHED，這裏讀的是 registrationOpen。 */
    paused: ["報名已暫停", "warn"],
    /* ⚖️ D-118 R7 · 「還沒發佈」與「發佈了但停了報名」是兩回事，別共用一個標籤。
       正常情況下草稿賽事根本進不了發現面，這一條是兜底，不是主路徑。 */
    draft: ["尚未發佈", "flat"]
  };

  /* ================================================================
     ==================  v6 · 首頁視覺 Sprint 01  ===================
     三語 / Next Race / 1 大 + 2 小馬賽克 / Activities 分頁
     作用域僅限首頁；其餘 34 個 screen 不受影響。
     ================================================================ */

  /* ---- 語言：ខ្មែរ / 繁體中文 / English ----
     規則（已凍結）：
       Brand copy 不翻譯 —— RUN · CAMBODIA、賽事拉丁名、21K、RACE DAY、RESULTS
       Product copy 與情緒整句跟語言走
     ⚠️ 高棉文爲佔位翻譯，需柬埔寨本地同事校對後才能上線。 */

  var I18N = {
    zh: {},   /* 繁中即 DOM 裏的默認文案，切回時用 ORIG 快照還原 */
    km: {
      "nav.reg": "ចុះឈ្មោះ",
      "proto.bar": "គំរូសាកល្បង · <b>RUN</b> · ទិន្នន័យគំរូ ការទូទាត់សាកល្បង",
      "nav.shop": "ទំនិញ",
                        "shop.tag": "ការបញ្ជាទិញដាច់ដោយឡែក",
      "shop.sub": "ទំនិញ និងការចុះឈ្មោះជា <b>ការបញ្ជាទិញដាច់ដោយឡែកពីរផ្សេងគ្នា</b>៖ ការទិញ ឬមិនទិញទំនិញ មិនប៉ះពាល់ដល់ការចុះឈ្មោះឡើយ។",
      "res.h2": "ទិន្នន័យលទ្ធផល", "res.new": "ថ្មី",
      "res.sub": "ទិន្នន័យលទ្ធផលការប្រកួត ៣ ឆ្នាំ។ ស្វែងរកតាមលេខ Bib ឬឈ្មោះ។",
      "res.demobar": "តារាងលទ្ធផល ចំណាត់ថ្នាក់ និងចន្លោះពេលវេលា ជា <b>ទិន្នន័យគំរូ</b>។",
      "me.h2": "គណនីរបស់ខ្ញុំ", "me.tag": "គណនីគំរូ",
      "races.h2": "ការប្រកួតទាំងអស់",
      "races.sub": "បើកចុះឈ្មោះ · ជិតបើក · បានបញ្ចប់",
      "races.hist": "មើលការប្រកួតកន្លងមកទាំងអស់ →",
      "races.clear": "សម្អាត",
      "races.empty": "<b>មិនមានការប្រកួតត្រូវតាមលក្ខខណ្ឌទេ</b><br>សូមសាកល្បងជ្រើសខែ ឬទីតាំងផ្សេងទៀត។",
      "ph.h2": "រករូបថតរបស់ខ្ញុំ",
      "ph.sub": "បញ្ចូលលេខ Bib របស់អ្នក ឬមើលរូបថតទាំងអស់នៃការប្រកួត។",
      "ph.demobar": "<b>គំរូសាកល្បង។</b> ការភ្ជាប់រូបថតជាមួយលេខ Bib ធ្វើឡើងដោយបុគ្គលិក។ រូបថតទាំងអស់ជាទិន្នន័យគំរូ។",
      "ph.selrace": "ជ្រើសរើសការប្រកួត",
      "ph.bybib": "ស្វែងរកតាមលេខ Bib",
      "ph.bybib.d": "វិធីសុក្រឹតបំផុត។ បញ្ចូលលេខ Bib ដើម្បីរករាល់រូបថតដែលមានលេខរបស់អ្នក។",
      "ph.bybib.btn": "ចាប់ផ្តើមស្វែងរក",
      "ph.byselfie": "ស្វែងរកតាមរូប Selfie",
      "ph.byselfie.d": "បើលេខ Bib ត្រូវបាំង សូមប្រើរូបថតមុខត្រង់ច្បាស់ដើម្បីស្វែងរក។",
      "ph.drop": "ចុចទីនេះដើម្បីជ្រើសរូប Selfie<br><span style=\"font-size:.76rem\">ដំណើរការក្នុងកម្មវិធីរុករកប៉ុណ្ណោះ មិនបង្ហោះទៅម៉ាស៊ីនបម្រើឡើយ</span>",
      "ph.byselfie.btn": "ចាប់ផ្តើមសម្គាល់",
      "ph.all": "មើលរូបថតទាំងអស់",
      "ph.all.d": "មើលរូបថតតាមទីតាំងកាមេរ៉ា និងគីឡូម៉ែត្រ។ ចុចទទួលយករូបថតពេលឃើញខ្លួនឯង។",
      "ph.all.btn": "មើលរូបថតទាំងអស់នៃការប្រកួត",
      "ph.myhist": "ប្រវត្តិរូបថតរបស់ខ្ញុំ",
      "ph.myhist.btn": "បើក «រូបថតរបស់ខ្ញុំ»",
      "ph.privacy": "គោលការណ៍ឯកជនភាព",
      "ph.privacy.d": "លេខ Bib ដែលបញ្ចូលត្រូវបានប្រើសម្រាប់ការស្វែងរកលើកនេះប៉ុណ្ណោះ។ អ្នកអាចស្នើសុំលុបរូបថត ឬកែប្រែការអនុញ្ញាតរូបភាពក្នុងកម្រងព័ត៌មានបានគ្រប់ពេល។",
            "ft.about": "អំពីយើង",
      "about.back": "← ត្រឡប់ទៅទំព័រដើម",
      "about.h2": "អំពីយើង About Us",
      "about.lead": "Built in Cambodia, for the community.<br><span style=\"font-size:.9rem;color:#64748b;font-weight:600\">WeRun — Register. Connect. Move Together.</span>",
      "about.story.t": "រឿងរ៉ាវរបស់យើង",
      "about.story.d1": "WeRun ត្រូវបានបង្កើតឡើងរួមគ្នាដោយជនបរទេសបីនាក់ដែលរស់នៅក្នុងប្រទេសកម្ពុជា។",
      "about.story.d2": "ដោយសារការរស់នៅ ធ្វើការ និងចូលរួមក្នុងសកម្មភាពកីឡា និងសហគមន៍នៅកម្ពុជាជាយូរមក យើងបានកត់សម្គាល់ឃើញថា ដំណើរការចុះឈ្មោះចូលរួមព្រឹត្តិការណ៍ជាច្រើននៅតែបែកខ្ញែកគ្នានៅលើវេទិកា ទម្រង់បែបបទ និងវិធីសាស្ត្រទូទាត់ផ្សេងៗគ្នា។ នេះបានបង្កការលំបាកដល់អ្នកចូលរួម ហើយអ្នករៀបចំព្រឹត្តិការណ៍ក៏ត្រូវចំណាយពេលវេលាច្រើនដើម្បីគ្រប់គ្រងទិន្នន័យផងដែរ។",
      "about.story.d3": "ដូច្នេះហើយ យើងបានបង្កើត WeRun ឡើង។",
      "about.story.d4": "យើងមានបំណងបង្កើតវេទិកាចុះឈ្មោះ និងគ្រប់គ្រងព្រឹត្តិការណ៍ដែលកាន់តែងាយស្រួល ស្និទ្ធស្នាល និងសមស្របបំផុតសម្រាប់កម្ពុជា ដើម្បីឱ្យអ្នករត់ និងអ្នកចូលរួមអាចស្វែងរកព្រឹត្តិការណ៍ និងចុះឈ្មោះបានយ៉ាងងាយស្រួល ព្រមទាំងជួយអ្នករៀបចំគ្រប់គ្រងព្រឹត្តិការណ៍របស់ពួកគេប្រកបដោយប្រសិទ្ធភាពខ្ពស់។",
      "about.story.d5": "ទោះបីជាយើងមកពីកន្លែងផ្សេងៗគ្នាក៏ដោយ យើងទាំងអស់គ្នាចាត់ទុកកម្ពុជាជាផ្នែកដ៏សំខាន់នៃជីវិត និងការអភិវឌ្ឍរបស់យើង។ យើងសង្ឃឹមថានឹងប្រើប្រាស់បទពិសោធន៍ និងជំនាញរបស់យើង ដើម្បីកសាងលំហឌីជីថលដែលកាន់តែងាយស្រួល និងមានការតភ្ជាប់កាន់តែរឹងមាំសម្រាប់សហគមន៍កីឡា អ្នករៀបចំព្រឹត្តិការណ៍ និងអ្នកចូលរួមទាំងអស់។",
      "about.pillars.t": "សសរស្តម្ភអាជីវកម្មស្នូលទាំង ៤",
      "about.p1.t": "ប្រតិបត្តិការការប្រកួតអាជីព",
      "about.p1.d": "ផ្លូវរត់ស្តង់ដារ ការទូទាត់ KHQR ការចាត់ចែងលេខ Bib និងបន្ទះឈីបកត់ត្រាពេលវេលា ធានាសុវត្ថិភាព និងយុត្តិធម៌។",
      "about.p2.t": "ប័ណ្ណសារលទ្ធផលអចិន្ត្រៃយ៍",
      "about.p2.d": "កត់ត្រាពេលកាំភ្លើង និងពេលសុទ្ធ រក្សាទុកលទ្ធផលលើ Cloud និងទាញយកវិញ្ញាបនបត្រផ្លូវការបានគ្រប់ពេល។",
      "about.p3.t": "រូបភាពការប្រកួត និងភាពឯកជន",
      "about.p3.d": "អ្នកថតរូបអាជីពតាមដងផ្លូវ ស្វែងរកតាមលេខ Bib លឿនរហ័ស គោរពយ៉ាងម៉ឺងម៉ាត់នូវសិទ្ធិឯកជនភាពរបស់អ្នករត់។",
      "about.p4.t": "សហគមន៍អ្នករត់",
      "about.p4.d": "រៀបចំការរត់ហ្វឹកហាត់ឥតគិតថ្លៃ និងផ្តល់ឧបករណ៍បង្ហោះសកម្មភាពអ្នករត់ ដើម្បីគាំទ្រសហគមន៍រត់ក្នុងស្រុក។",
      "about.values.t": "គោលការណ៍ និងស្តង់ដារបច្ចេកវិទ្យា",
      "about.v1.t": "🏛️ ឫសគល់ក្នុងស្រុក · សមាហរណកម្ម KHQR",
      "about.v1.d": "ភ្ជាប់ផ្ទាល់ជាមួយ Bakong KHQR របស់ធនាគារជាតិនៃកម្ពុជា ទូទាត់រហ័ស និងចេញប័ណ្ណភ្លាមៗ។",
      "about.v2.t": "🌐 បទពិសោធន៍ ៣ ភាសា",
      "about.v2.d": "គាំទ្រភាសាខ្មែរ អង់គ្លេស និងចិន បម្រើអ្នករត់ក្នុងស្រុក និងអន្តរជាតិ។",
      "about.v3.t": "🔒 ព្រំដែនច្បាស់លាស់ · គ្មានហានិភ័យហិរញ្ញវត្ថុ",
      "about.v3.d": "ការចុះឈ្មោះ ទំនិញ និងសកម្មភាពដាច់ដោយឡែកពីគ្នា មិនប៉ះពាល់ការផ្ទេរប្រាក់ផ្ទាល់ខ្លួន។",
      "about.v4.t": "📜 សវនកម្មពេញលេញ · សុវត្ថិភាពខ្ពស់",
      "about.v4.d": "រាល់ការទទួលកញ្ចប់សម្ភារៈ ប្តូរលេខ Bib និងការសងប្រាក់ មានកំណត់ត្រាសវនកម្មមិនអាចកែបន្លំបាន។",
      "about.office.t": "ទំនាក់ទំនង និងការិយាល័យ",
      "about.office.loc": "ទីស្នាក់ការ",
      "about.office.locval": "មហាវិថីមាត់ទន្លេ រាជធានីភ្នំពេញ កម្ពុជា",
      "about.office.email": "អ៊ីមែលផ្លូវការ",
      "about.office.tg": "Telegram ផ្លូវការ",
      "about.office.hours": "ម៉ោងធ្វើការ",
      "about.office.hval": "ច័ន្ទ–សុក្រ ០៨:៣០–១៧:៣០ (ថ្ងៃប្រកួតបើក ២៤ ម៉ោង)",
      "about.btn.races": "មើលការប្រកួតឆាប់ៗនេះ",
      "about.btn.contact": "ទាក់ទងយើង",
      "post.back": "← ត្រឡប់ទៅទំព័រដើម",
      "post.h2": "បង្ហោះសកម្មភាព",
      "post.lead": "រៀបចំរូបថត និងអត្ថបទដូចជាការបង្ហោះសារ។ ដាក់ស្នើដើម្បីពិនិត្យ ក្រោយអនុម័តនឹងបង្ហាញនៅទំព័រដើម។",
      "post.demobar": "អ្នកកំពុងបង្ហោះ <b>សកម្មភាពរៀបចំដោយអ្នករត់ខ្លួនឯង</b> <b>មិនមែនជាការប្រកួតផ្លូវការរបស់ RUN ទេ</b>។ RUN គ្រាន់តែផ្តល់ការផ្សព្វផ្សាយប៉ុណ្ណោះ។",
      "post.s0": "០ · សូមអានមុនពេលបង្ហោះ",
      "post.s0.nofee": "បច្ចុប្បន្នមិនគាំទ្រការប្រមូលថ្លៃណាមួយឡើយ",
      "post.s0.feenote": "ប្រសិនបើសកម្មភាពមានការចំណាយ សូមបញ្ជាក់ក្នុងអត្ថបទដើម្បីទូទាត់ក្រៅបណ្តាញ។ សូមកុំផ្ទេរប្រាក់ទៅគណនីផ្ទាល់ខ្លួនដែលមិនស្គាល់។",
      "post.s0.noban": "ខ្លឹមសារខាងក្រោមត្រូវបានហាមឃាត់ដាច់ខាត",
      "post.s1": "១ · រូបថតសកម្មភាព", "post.s1.hint": "អតិបរមា ៩ សន្លឹក រូបទី១ ជាគម្រប",
      "post.s1.note": "អាចជ្រើសរើសពីរូបថតរបស់អ្នក។ ការបង្ហាញជាគំរូក្នុងម៉ាស៊ីនប៉ុណ្ណោះ។",
      "post.s2": "២ · សរសេរខ្លឹមសារ", "post.s2.title": "ចំណងជើង", "post.s2.title.err": "ចំណងជើងមិនអាចទទេបានទេ",
      "post.s2.body": "ខ្លឹមសារ", "post.s2.body.hint": "ផ្លូវ ល្បឿន និងសម្ភារៈដែលត្រូវយកមក", "post.s2.body.err": "សូមសរសេរយ៉ាងហោចណាស់ ២០ តួអក្សរ",
      "post.s2.type": "ប្រភេទសកម្មភាព",
      "post.s3": "៣ · ព័ត៌មានលម្អិត", "post.s3.time": "ពេលវេលា", "post.s3.time.err": "សូមបំពេញពេលវេលា",
      "post.s3.dist": "ចម្ងាយ / ល្បឿន", "post.s3.loc": "ទីតាំង", "post.s3.loc.err": "សូមបំពេញទីតាំង",
      "post.s3.meet": "វិធីជួបជុំ", "post.s3.cap": "ចំនួនមនុស្សអតិបរមា", "post.s3.fee": "ថ្លៃចំណាយ", "post.s3.fee.hint": "ប្រព័ន្ធមិនប្រមូលប្រាក់ជំនួសទេ",
      "post.s4": "៤ · ព័ត៌មានទំនាក់ទំនង", "post.s4.hint": "បំពេញយ៉ាងហោចណាស់មួយ", "post.s4.ph": "ទូរស័ព្ទ", "post.s4.err": "សូមទុកទំនាក់ទំនងយ៉ាងហោចណាស់មួយ", "post.s4.vis": "អ្នកដែលអាចឃើញទំនាក់ទំនង",
      "post.s5": "៥ · ការបដិសេធទំនួលខុសត្រូវ", "post.s5.hint": "ត្រូវបញ្ជាក់គ្រប់ចំណុចដើម្បីបង្ហោះ", "post.s5.disctitle": "ការបដិសេធទំនួលខុសត្រូវ", "post.s5.more": "ពង្រីកមើលទាំងអស់ ▾", "post.s5.agree": "ការគូសធីកមានន័យថាអ្នកបានអាន និងយល់ព្រមតាមការបដិសេធខាងលើ។",
      "post.submit": "បង្ហោះសកម្មភាព",
      "post.preview": "មើលសាកល្បងសិន",
      "post.demo": "បំពេញខ្លឹមសារគំរូ",
      "nav.races": "ការប្រកួត", "nav.photos": "រករូបថត", "nav.results": "លទ្ធផល",
      "nav.post": "បង្ហោះសកម្មភាព", "nav.me": "គណនីរបស់ខ្ញុំ", "nav.about": "អំពីយើង",
      "mn.races": "ប្រកួត", "mn.results": "លទ្ធផល", "mn.photos": "រូបថត", "mn.acts": "សកម្មភាព", "mn.me": "គណនី",
      "hero.h1": "រាល់ជំហានរបស់អ្នក<br>សុទ្ធតែសមនឹងកត់ត្រាទុក។",
      "hero.sub": "ការប្រកួតពិត · លទ្ធផល · រូបថត · សហគមន៍អ្នករត់",
      "hero.cta": "មើលការប្រកួត",
      "stat.events": "ការប្រកួត",
      "stat.parts": "អ្នកចូលរួម",
      "stat.since": "កម្ពុជា · ភ្នំពេញ",
      "up.h2": "ការប្រកួតឆាប់ៗនេះ",
      "up.all": "ការប្រកួតទាំងអស់ →",
      "up.note": "ផ្នែកនេះមានតែការប្រកួតដែលរៀបចំដោយ RUN និងដៃគូផ្លូវការប៉ុណ្ណោះ។ សកម្មភាពដែលអ្នករត់រៀបចំដោយខ្លួនឯង ស្ថិតនៅផ្នែកខាងក្រោមដោយឡែក។",
      "act.h2": "សកម្មភាពឥតគិតថ្លៃ និងសកម្មភាពអ្នករត់",
      "act.sub": "សកម្មភាពផ្លូវការឥតគិតថ្លៃ និងការរត់ដែលអ្នករត់រៀបចំដោយខ្លួនឯង",
      "act.post": "＋ បង្ហោះសកម្មភាព",
      "act.tab1": "ឥតគិតថ្លៃ",
      "act.tab2": "សកម្មភាពអ្នករត់",
      "act.free.note": "មិនគិតថ្លៃចុះឈ្មោះទេ គ្រាន់តែចុះឈ្មោះទុក ដើម្បីឲ្យយើងរៀបចំទឹក និងធានារ៉ាប់រង។",
      "act.free.fine": "សកម្មភាពឥតគិតថ្លៃក៏ទទួលបានប័ណ្ណចូលរួម និងរាប់បញ្ចូលក្នុងប្រវត្តិរត់របស់អ្នកដែរ។ ចំនួនកន្លែងមានកំណត់ ព្រោះទឹក និងបុគ្គលិកមានកំណត់ បើចុះឈ្មោះហើយមកមិនបាន សូមលុបចោលជាមុន។",
      "act.ugc.note": "ផ្នែកនេះជាសកម្មភាពរៀបចំដោយអ្នករត់ខ្លួនឯង មិនមែនរៀបចំដោយ RUN ទេ។",
      "act.ugc.fine": "សកម្មភាពរៀបចំដោយអ្នករត់ខ្លួនឯង · មិនមែនរៀបចំដោយ RUN។ RUN ផ្តល់តែកន្លែងផ្សព្វផ្សាយ និងកត់ត្រាចំណាប់អារម្មណ៍ចូលរួមប៉ុណ្ណោះ មិនចូលរួមរៀបចំនៅទីកន្លែងទេ។ ការបង្ហាញនៅទំព័រនេះ មិនមែនជាការធានាពី RUN អំពីសុវត្ថិភាព គុណភាព ឬភាពពិតប្រាកដឡើយ។ RUN មិនទទួលប្រាក់ជំនួសឡើយ។",
      "how.1t": "ជ្រើសរើសការប្រកួត", "how.1d": "ជ្រើសការប្រកួត និងចម្ងាយ មើលកន្លែងនៅសល់ភ្លាមៗ",
      "how.2t": "បំពេញព័ត៌មាន",     "how.2d": "បំពេញម្តង លើកក្រោយចេញមកស្វ័យប្រវត្តិ ត្រឹមមួយនាទី",
      "how.3t": "ស្កេនបង់ប្រាក់",   "how.3d": "ស្កេន KHQR ដោយកម្មវិធីធនាគារណាក៏បាន ប័ណ្ណចូលរួមផ្ញើទៅ Telegram",
      "mem.quote": "អ្នកខ្លះមកបំបែកកំណត់ត្រាថ្មី<br>អ្នកខ្លះគ្រាន់តែចង់រត់ ៥ គ.ម ជាលើកដំបូង។",
      "mem.h2": "បន្ទាប់ពីការប្រកួតចប់ វាមិនបាត់ទៅណាទេ",
      "mem.r1t": "លទ្ធផល",       "mem.r1d": "ពេលវេលា ចំណាត់ថ្នាក់ និងរាល់ចន្លោះរបស់អ្នក",
      "mem.r2t": "រូបថត",         "mem.r2d": "ស្វែងរករូបខ្លួនឯងតាមលេខ Bib",
      "mem.r3t": "វិញ្ញាបនបត្រ",  "mem.r3d": "រក្សាទុកជារៀងរហូត និងអាចចែករំលែកបាន",
      "mem.r4t": "ប្រវត្តិរត់",    "mem.r4d": "៥ គ.ម ១០ គ.ម ២១ គ.ម ក្លាយជាប្រវត្តិរបស់អ្នក",
      "part.sub": "ខាងក្រោមជាកន្លែងបង្ហាញសាកល្បង មិនតំណាងឲ្យកិច្ចសហការដែលបានព្រមព្រៀងទេ",
      "part.1": "ទឹក និងស្ថានីយ៍ផ្គត់ផ្គង់", "part.2": "ការកត់ត្រាពេលវេលា", "part.3": "រូបភាពការប្រកួត",
      "part.open": "កំពុងស្វែងរកដៃគូ", "part.ph": "រូបភាពនៅទីកន្លែង នឹងបំពេញក្រោយ",
      "close.sub": "លើកក្រោយ អ្នកចង់រត់នៅឯណា?",
      "close.1": "រកការប្រកួត", "close.2": "រកលទ្ធផល", "close.3": "រករូបថត",
      "ft.who": "ប្រតិបត្តិការការប្រកួតនៅកម្ពុជា · ភ្នំពេញ",
      "ft.faq": "សំណួរញឹកញាប់", "ft.contact": "ទាក់ទងយើង",
      "ft.terms": "លក្ខខណ្ឌប្រើប្រាស់", "ft.privacy": "គោលការណ៍ទិន្នន័យផ្ទាល់ខ្លួន",
      "ft.security": "គោលការណ៍សុវត្ថិភាព", "ft.refund": "គោលការណ៍សងប្រាក់វិញ",
      "ft.demo": "គេហទំព័រនេះជាគំរូបង្ហាញផលិតផល។ ការបង់ប្រាក់ លទ្ធផល រូបថត និងការជូនដំណឹង សុទ្ធតែជាការក្លែងធ្វើ។ រូបភាពជារូបបង្កើតដោយ AI សម្រាប់តែការបង្ហាញ។"
    },
    en: {
      "nav.reg": "Register",
      "proto.bar": "Prototype Demo · <b>RUN</b> · Sample Data, Simulated Payments",
      "nav.shop": "Merchandise",
                        "shop.tag": "Separate Orders · Separate Payments",
      "shop.sub": "Merchandise and race registration are <b>two completely independent orders</b>: purchasing merchandise does not affect race entry, and refunds are handled separately.",
      "res.h2": "Results Hub", "res.new": "NEW",
      "res.sub": "Three years of race results. Search by Bib or name, or browse leaderboards.",
      "res.demobar": "Leaderboards, splits, and rankings are <b>simulated sample data</b>.",
      "me.h2": "My Account", "me.tag": "Demo Account",
      "races.h2": "All Races",
      "races.sub": "Open · Coming Soon · Finished",
      "races.hist": "View All Past Races →",
      "races.clear": "Clear",
      "races.empty": "<b>No races match your filter</b><br>Try selecting another month or location, or browse past races.",
      "ph.h2": "Find My Photos",
      "ph.sub": "Enter your Bib number or browse all photos from this race.",
      "ph.demobar": "<b>Prototype Demo.</b> Photo-to-Bib associations are recorded by on-site staff. All photos and queries are simulated sample data.",
      "ph.selrace": "Select Race",
      "ph.bybib": "Search by Bib",
      "ph.bybib.d": "Most accurate way. Enter your Bib number to find all photos tagged with your number.",
      "ph.bybib.btn": "Find Photos",
      "ph.byselfie": "Search by Selfie",
      "ph.byselfie.d": "If your Bib was covered, find photos using a clear front-facing portrait.",
      "ph.drop": "Click to select a selfie<br><span style=\"font-size:.76rem\">Processed locally in your browser, not uploaded to any server</span>",
      "ph.byselfie.btn": "Start Recognition",
      "ph.all": "Browse All Photos",
      "ph.all.d": "Browse by camera station and kilometer markers. Click to claim when you spot yourself.",
      "ph.all.btn": "Browse All Photos",
      "ph.myhist": "My Photo History",
      "ph.myhist.btn": "Open 'My Photos'",
      "ph.privacy": "Privacy Notice",
      "ph.privacy.d": "Bib numbers entered are used solely for this query. You can request deletion of your photos or adjust likeness permissions in Profile at any time.",
            "ft.about": "About Us",
      "about.back": "← Back to Home",
      "about.h2": "About Us",
      "about.lead": "Built in Cambodia, for the community.<br><span style=\"font-size:.9rem;color:#64748b;font-weight:600\">WeRun — Register. Connect. Move Together.</span>",
      "about.story.t": "Our Story",
      "about.story.d1": "WeRun was co-founded by three expatriates living in Cambodia.",
      "about.story.d2": "Having lived, worked, and actively participated in sports and community activities across Cambodia for years, we noticed that event registration processes were scattered across fragmented platforms, forms, and payment methods. This created unnecessary friction for participants and consumed extensive time for event organizers managing entries and data.",
      "about.story.d3": "That is why we founded WeRun.",
      "about.story.d4": "We aspire to build a simpler, more user-friendly, and truly localized event registration and management platform for Cambodia. A platform where runners and participants can effortlessly discover events and complete registrations, while organizers can streamline and manage their events with maximum efficiency.",
      "about.story.d5": "Though we come from different corners of the world, we all consider Cambodia an integral part of our lives and growth. Combining our experience and professional expertise, our mission is to establish a connected, seamless digital ecosystem for the local sports community, event organizers, and active participants.",
      "about.pillars.t": "Four Core Pillars",
      "about.p1.t": "Professional Race Operations",
      "about.p1.d": "Certified routes, seamless KHQR instant payments, Bib management, and precision chip timing mats for safety and fairness.",
      "about.p2.t": "Permanent Results Archive",
      "about.p2.d": "Gun and net timing records preserved on cloud storage with downloadable verified finisher certificates.",
      "about.p3.t": "Race Photography & Privacy",
      "about.p3.d": "Comprehensive course photo coverage with quick Bib lookup, strictly adhering to participant consent and privacy rules.",
      "about.p4.t": "Runner Community Ecosystem",
      "about.p4.d": "Official free training camps and community run posting tools to nurture Cambodia's vibrant running culture.",
      "about.values.t": "Principles & Technical Standards",
      "about.v1.t": "🏛️ Local Roots · Native KHQR Integration",
      "about.v1.d": "Seamless integration with National Bank of Cambodia Bakong KHQR for zero-latency instant passes across all major banks.",
      "about.v2.t": "🌐 Trilingual Accessibility",
      "about.v2.d": "Full support for Khmer (ខ្មែរ), English, and Traditional Chinese for both local runners and international visitors.",
      "about.v3.t": "🔒 Clean Boundaries · Zero Fund Risk",
      "about.v3.d": "Strict isolation between race entries, shop merchandise, and community runs. No personal fund handling.",
      "about.v4.t": "📜 Immutable Audit Trails",
      "about.v4.d": "Pack handoffs, Bib swaps, and refunds are logged with tamper-proof audit trails to prevent disputes.",
      "about.office.t": "Offices & Contact",
      "about.office.loc": "Headquarters",
      "about.office.locval": "Riverside Boardwalk, Phnom Penh, Cambodia",
      "about.office.email": "Official Email",
      "about.office.tg": "Official Telegram",
      "about.office.hours": "Working Hours",
      "about.office.hval": "Mon–Fri 08:30–17:30 ICT (24/7 on-site support on race days)",
      "about.btn.races": "Browse Upcoming Races",
      "about.btn.contact": "Contact Us",
      "post.back": "← Back to Home",
      "post.h2": "Post an Activity",
      "post.lead": "Add photos and text, just like a social post. Reviewed by the platform and listed under Community Runs on the home page.",
      "post.demobar": "You are posting a <b>community runner activity</b>, <b>NOT an official RUN event</b>. RUN only provides listing and interest tracking, does not organize on-site, and does not guarantee safety. Organizers and participants must assess risks and leave contacts.",
      "post.s0": "0 · Please Read Before Posting",
      "post.s0.nofee": "Platform Currently Does Not Collect Any Fees",
      "post.s0.feenote": "If there are costs (shared, venue, carpool), explain clearly in the text for offline settlement. <b>Do not pay unknown personal accounts in advance.</b>",
      "post.s0.noban": "The Following Content is Strictly Prohibited",
      "post.s1": "1 · Photos", "post.s1.hint": "Up to 9 photos, 1st is cover",
      "post.s1.note": "You can pick photos from your album or test with sample images. Preview is local only and will not be uploaded to any server.",
      "post.s2": "2 · Details", "post.s2.title": "Title", "post.s2.title.err": "Title cannot be empty",
      "post.s2.body": "Description", "post.s2.body.hint": "Route, pace, what to bring — write clearly", "post.s2.body.err": "Write at least 20 characters so others understand the activity",
      "post.s2.type": "Activity Type",
      "post.s3": "3 · Schedule & Location", "post.s3.time": "Time", "post.s3.time.err": "Please enter time",
      "post.s3.dist": "Distance / Pace", "post.s3.loc": "Location", "post.s3.loc.err": "Please enter location",
      "post.s3.meet": "Meeting Point", "post.s3.cap": "Max Participants", "post.s3.fee": "Fee", "post.s3.fee.hint": "Not collected by platform",
      "post.s4": "4 · Contact Info", "post.s4.hint": "Fill at least one", "post.s4.ph": "Phone", "post.s4.err": "Leave at least one contact so people can reach you", "post.s4.vis": "Who can see your contact info",
      "post.s5": "5 · Disclaimer & Agreement", "post.s5.hint": "Confirm all items to submit", "post.s5.disctitle": "Community Runner Activity Disclaimer", "post.s5.more": "View Full Text ▾", "post.s5.agree": "Checking confirms you have read and agreed to the disclaimer. The platform reserves the right to unpublish or freeze violating posts.",
      "post.submit": "Submit Activity",
      "post.preview": "Preview",
      "post.demo": "Fill Sample Content",
      "nav.races": "Races", "nav.photos": "My photos", "nav.results": "Results",
      "nav.post": "Post an activity", "nav.me": "My account", "nav.about": "About",
      "mn.races": "Races", "mn.results": "Results", "mn.photos": "Photos", "mn.acts": "Activities", "mn.me": "Me",
      "hero.h1": "Every step<br>deserves to be kept.",
      "hero.sub": "Real races · Results · Photos · Community",
      "hero.cta": "See the races",
      "stat.events": "EVENTS", "stat.parts": "PARTICIPATIONS", "stat.since": "Cambodia · Phnom Penh",
      "up.h2": "Upcoming races",
      "up.all": "All races →",
      "up.note": "This section only lists races organised by RUN and its official partners. RUN handles the organisation, payment and on-site safety. Runner-initiated activities live in their own section below.",
      "act.h2": "Free runs & community",
      "act.sub": "Free official activities, and runs organised by runners themselves",
      "act.post": "＋ Post an activity",
      "act.tab1": "Free runs", "act.tab2": "Community runs",
      "act.free.note": "No entry fee — just sign up here so we can plan water and insurance.",
      "act.free.fine": "Free activities still issue a digital pass and still count towards your running history. Places are limited by our supplies and marshals, so please cancel in advance if you cannot make it.",
      "act.ugc.note": "Everything here is organised by runners themselves and is NOT a RUN official event.",
      "act.ugc.fine": "Runner-organised activity · not organised by RUN. RUN only provides listing and interest registration, and does not take part in on-site organisation or execution. Listing here is not a RUN guarantee of safety, quality or accuracy. Organisers and participants must verify details and assess risk themselves. RUN does not collect any fees on their behalf.",
      "how.1t": "Pick a race", "how.1d": "Choose the race and distance, with live remaining places",
      "how.2t": "Fill in details", "how.2d": "Enter once, reused next time — a minute for your second entry",
      "how.3t": "Scan to pay", "how.3d": "Scan the KHQR with any bank app; your pass goes straight to Telegram",
      "mem.quote": "Some come to chase a PB.<br>Some just want to finish 5K for the first time.",
      "mem.h2": "The race does not end when you cross the line",
      "mem.r1t": "Results", "mem.r1d": "Your time, your ranking and every split",
      "mem.r2t": "Photos", "mem.r2d": "Find yourself in the race photos by your Bib number",
      "mem.r3t": "Certificate", "mem.r3d": "Keep every finish for good, and share it",
      "mem.r4t": "Running history", "mem.r4d": "5K, 10K, 21K — slowly becoming your record",
      "part.sub": "Placeholders for the demo; these do not represent agreed partnerships",
      "part.1": "Hydration & aid stations", "part.2": "Timing & chips", "part.3": "Race photography",
      "part.open": "Open for partners", "part.ph": "On-site image to come",
      "close.sub": "So — where will you run next?",
      "close.1": "Find a race", "close.2": "Find my result", "close.3": "Find my photos",
      "ft.who": "Race operations in Cambodia · Phnom Penh",
      "ft.faq": "FAQ", "ft.contact": "Contact us",
      "ft.terms": "Terms of use", "ft.privacy": "Personal data policy",
      "ft.security": "Security policy", "ft.refund": "Refund policy",
      "ft.demo": "This site is a product prototype. Payment, results, photos and notifications are all front-end simulations. Photography is AI-generated placeholder material."
    }
  };

  /* 動態渲染用的短語（卡片、狀態、價格） */
  var I18N_D = {
    zh: { open:"報名中", low:"名額緊張", soon:"即將開放", full:"已滿額", done:"已結束", closed:"報名截止", free:"免費報名",
          paused:"報名已暫停", pausedFoot:"主辦方已暫停接受新報名",
          draft:"尚未發布", draftFoot:"賽事尚未發布",
          next:"下一場賽事", regNow:"立即報名", allRaces:"全部賽事 →", detail:"賽事詳情 →",
          seats:function(n){return "剩餘 "+n+" 個名額";}, price:function(v){return "US$"+v+" 起";},
          freeTxt:"免費", noSeat:"名額已滿，可候補", openAt:"8 月 20 日開放", packing:"報名已截止 · 領物期",
          resultOut:"賽事已結束 · 成績已發布", empty:"目前沒有開放報名的賽事", meet:"集合" },
    km: { open:"បើកចុះឈ្មោះ", low:"ជិតពេញ", soon:"ជិតបើក", full:"ពេញហើយ", done:"បញ្ចប់", closed:"បិទចុះឈ្មោះ", free:"ឥតគិតថ្លៃ",
          paused:"ផ្អាកការចុះឈ្មោះ", pausedFoot:"អ្នករៀបចំបានផ្អាកការទទួលចុះឈ្មោះថ្មី",
          draft:"មិនទាន់ចេញផ្សាយ", draftFoot:"ការប្រកួតមិនទាន់ចេញផ្សាយ",
          next:"ការប្រកួតបន្ទាប់", regNow:"ចុះឈ្មោះឥឡូវនេះ", allRaces:"ការប្រកួតទាំងអស់ →", detail:"ព័ត៌មានលម្អិត →",
          seats:function(n){return "នៅសល់ "+n+" កន្លែង";}, price:function(v){return "ចាប់ពី US$"+v;},
          freeTxt:"ឥតគិតថ្លៃ", noSeat:"ពេញហើយ · អាចចុះបញ្ជីរង់ចាំ", openAt:"បើក ២០ សីហា", packing:"បិទចុះឈ្មោះ · ដល់ពេលទទួលឥវ៉ាន់",
          resultOut:"ការប្រកួតបានបញ្ចប់ · លទ្ធផលចេញហើយ", empty:"មិនទាន់មានការប្រកួតបើកចុះឈ្មោះទេ", meet:"ជួបគ្នា" },
    en: { open:"OPEN", low:"LIMITED", soon:"SOON", full:"FULL", done:"FINISHED", closed:"CLOSED", free:"FREE",
          paused:"PAUSED", pausedFoot:"Organiser has paused new entries",
          draft:"UNPUBLISHED", draftFoot:"Race not published yet",
          next:"NEXT RACE", regNow:"Register now", allRaces:"All races →", detail:"Race details →",
          seats:function(n){return n+" spots left";}, price:function(v){return "FROM US$"+v;},
          freeTxt:"FREE", noSeat:"Full — waiting list open", openAt:"Opens 20 Aug", packing:"Entries closed · pack collection",
          resultOut:"Finished · results published", empty:"No races are open for entry right now", meet:"Meet" }
  };

  /* 賽事的三語殼：拉丁名不翻譯，城市與副標題跟語言走 */
  var RACE_L10N = {
    e1: { lat:"PHNOM PENH<br>RIVERSIDE HALF", flat:"PHNOM PENH RIVERSIDE HALF",
          city:{zh:"金邊",km:"ភ្នំពេញ",en:"PHNOM PENH"},
          sub:{zh:"金邊濱河半程馬拉松 2026",km:"ព្រះអាទិត្យរះ តាមមាត់ទន្លេ ភ្នំពេញ ២០២៦",en:"Riverside Half Marathon 2026"},
          img:"assets/race-pp.webp" },
    e2: { lat:"SIHANOUKVILLE<br>BEACH RUN", flat:"SIHANOUKVILLE BEACH RUN",
          city:{zh:"西哈努克",km:"ក្រុងព្រះសីហនុ",en:"SIHANOUKVILLE"},
          sub:{zh:"西哈努克海濱跑 2026",km:"ការរត់តាមឆ្នេរ ក្រុងព្រះសីហនុ ២០២៦",en:"Beach Run 2026"},
          img:"assets/race-sunset.webp" },
    e3: { lat:"ANGKOR<br>SUNRISE RUN", flat:"ANGKOR SUNRISE RUN",
          city:{zh:"暹粒",km:"សៀមរាប",en:"SIEM REAP"},
          sub:{zh:"吳哥日出跑 2026",km:"ការរត់ព្រះអាទិត្យរះ អង្គរ ២០២៦",en:"Sunrise Run 2026"},
          img:"assets/race-angkor.webp" },
    e4: { lat:"PHNOM PENH<br>CORPORATE RELAY", flat:"PHNOM PENH CORPORATE RELAY",
          city:{zh:"金邊",km:"ភ្នំពេញ",en:"PHNOM PENH"},
          sub:{zh:"金邊企業接力賽 2026",km:"ការរត់បញ្ជូនបន្ត ភ្នំពេញ ២០២៦",en:"Corporate Relay 2026"} },
    e5: { lat:"MEKONG<br>NIGHT RUN", flat:"MEKONG NIGHT RUN",
          city:{zh:"金邊",km:"ភ្នំពេញ",en:"PHNOM PENH"},
          sub:{zh:"湄公河夜跑 2026",km:"ការរត់ពេលយប់ មេគង្គ ២០២៦",en:"Night Run 2026"} },
    e6: { lat:"KAMPONG CHAM<br>TRAIL", flat:"KAMPONG CHAM TRAIL",
          city:{zh:"磅湛",km:"កំពង់ចាម",en:"KAMPONG CHAM"},
          sub:{zh:"磅湛鄉村越野 2025",km:"ការរត់តាមទីជនបទ កំពង់ចាម ២០២៥",en:"Countryside Trail 2025"} }
  };

  var FREE_L10N = {
    f1: {
      zh:{t:"RUN 週六晨跑 · 第 128 期", d:"每週六 05:45", loc:"金邊 · 鑽石島環島", dist:"5K 自由跑", meet:"05:30 鑽石島 A 門集合"},
      km:{t:"RUN រត់ព្រឹកថ្ងៃសៅរ៍ · លើកទី 128", d:"រៀងរាល់ថ្ងៃសៅរ៍ 05:45", loc:"ភ្នំពេញ · កោះពេជ្រ", dist:"5K រត់សេរី", meet:"05:30 ច្រកទ្វារ A កោះពេជ្រ"},
      en:{t:"RUN Saturday Morning Run · No. 128", d:"Every Saturday 05:45", loc:"Phnom Penh · Koh Pich loop", dist:"5K free run", meet:"05:30 at Koh Pich Gate A"}
    },
    f2: {
      zh:{t:"湄公河公益跑 2026", loc:"金邊 · 濱河大道", dist:"3K / 5K 親子同行", meet:"06:00 濱河公園草坪集合"},
      km:{t:"ការរត់សប្បុរសធម៌ មេគង្គ 2026", loc:"ភ្នំពេញ · មហាវិថីមាត់ទន្លេ", dist:"3K / 5K ជាមួយគ្រួសារ", meet:"06:00 ស្មៅសួនមាត់ទន្លេ"},
      en:{t:"Mekong Charity Run 2026", loc:"Phnom Penh · Riverside Blvd", dist:"3K / 5K family", meet:"06:00 on the riverside lawn"}
    },
    f3: {
      zh:{t:"新手 5K 訓練營 · 第 4 期", d:"2026.08.16 起 · 連續 4 週", loc:"金邊 · 奧林匹克體育場", dist:"5K 漸進訓練", meet:"每週日 06:00 體育場北看臺下"},
      km:{t:"ជំរុំហ្វឹកហាត់ 5K សម្រាប់អ្នកចាប់ផ្តើម · លើកទី 4", d:"ចាប់ពី 16 AUG 2026 · រយៈពេល 4 សប្តាហ៍", loc:"ភ្នំពេញ · ពហុកីឡដ្ឋានអូឡាំពិក", dist:"ហ្វឹកហាត់ 5K ជាដំណាក់កាល", meet:"រាល់ថ្ងៃអាទិត្យ 06:00 ក្រោមទីតាំងខាងជើង"},
      en:{t:"Beginner 5K Camp · Series 4", d:"From 16 AUG 2026 · 4 weeks", loc:"Phnom Penh · Olympic Stadium", dist:"Progressive 5K training", meet:"Every Sunday 06:00, under the north stand"}
    }
  };

  var LANG = "zh";
  var ORIG = null;          /* 繁中原文快照 */
  var MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

  function D() { return I18N_D[LANG] || I18N_D.zh; }

  /* 日期一律 "20 SEP 2026"：避開 8/10 在歐美之間的歧義，且三語共用 */
  function fmtDate(d, withYear) {
    var m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(d || "");
    if (!m) return d || "";
    return parseInt(m[3], 10) + " " + MON[parseInt(m[2], 10) - 1] + (withYear ? " " + m[1] : "");
  }
  function dateNum(d) {
    var m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(d || "");
    return m ? parseInt(m[1] + m[2] + m[3], 10) : 99999999;
  }

  function snapshotOrig() {
    ORIG = {};
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      ORIG[el.getAttribute("data-i18n")] = el.innerHTML;
    });
  }

  
  
  /* ================================================================
     GLOBAL UNIVERSAL I18N SYSTEM FOR ALL 35+ SCREENS IN RUN APP
     ================================================================ */

  var GLOBAL_I18N_MAP = {
    en: {
      // General & Common
      "返回首頁": "Back to Home",
      "← 返回首頁": "← Back to Home",
      "← 返回賽事列表": "← Back to Races",
      "← 返回成績查詢": "← Back to Results",
      "← 返回搜索結果": "← Back to Search Results",
      "← 重新查找": "← Search Again",
      "清空": "Clear",
      "搜索": "Search",
      "篩選": "Filter",
      "確定": "Confirm",
      "取消": "Cancel",
      "下一步": "Next Step",
      "上一步": "Previous Step",
      "立即報名": "Register Now",
      "立即支付": "Pay Now",
      "查看全部": "View All",
      "已截止": "Closed",
      "名額已滿": "Full",
      "報名開放中": "Open for Registration",
      "報名中": "Open",
      "即將開放": "Coming Soon",
      "已結束": "Finished",
      "免費": "Free",

      // Screen: s-races & s-detail
      "全部賽事": "All Races",
      "查看全部歷史賽事 →": "View All Past Races →",
      "全部歷史賽事": "All Past Races",
      "歷史賽事": "Past Races",
      "賽事詳情": "Race Details",
      "選擇組別": "Select Category",
      "賽程與關門時間": "Race Schedule & Cut-off Times",
      "領物": "Race Pack Collection",
      "路線圖": "Course Map",
      "報名須知": "Entry Notice & Requirements",
      "退改政策": "Refund & Cancellation Policy",
      "組別": "Category",
      "集合": "Meet / Assembly",
      "起跑": "Start Time",
      "關門": "Cut-off Time",
      "年齡限制": "Age Limit",
      "地點": "Location",
      "地址": "Address",
      "日期": "Date",
      "時間": "Time",
      "距離 / 強度": "Distance / Pace",
      "集合方式": "Meeting Point",
      "人數上限": "Max Runners",
      "費用": "Fee",
      "贊助商": "Sponsor",

      // Screen: s-photos, s-photores, s-photo
      "找我的照片": "Find My Photos",
      "輸入你的號碼布，或者直接翻這場比賽的全部照片。": "Enter your Bib number or browse all photos from this race.",
      "選擇賽事": "Select Race",
      "用號碼布找": "Search by Bib",
      "最準的方式。輸入你的號碼布號碼，系統會找出所有拍到這個號碼的照片。": "Most accurate. Enter your Bib number to find all photos tagged with your number.",
      "開始查找": "Find Photos",
      "用自拍找": "Search by Selfie",
      "一期不做": "Later Phase",
      "瀏覽全部照片": "Browse All Photos",
      "不確定就自己翻。可以按機位和公里數篩選，看到自己的點一下認領。": "Browse by camera station and kilometer markers. Click to claim when you spot yourself.",
      "瀏覽本場全部照片": "Browse All Photos",
      "我的歷史照片": "My Photo History",
      "打開「我的照片」": "Open 'My Photos'",
      "隱私說明": "Privacy Notice",
      "搜索結果": "Search Results",
      "沒找到自己？": "Can't find yourself?",
      "換個號碼布再查": "Search with another Bib",
      "瀏覽尚未關聯號碼布的照片": "Browse unassociated photos",
      "提交人工補充查找": "Submit manual review request",
      "照片信息": "Photo Information",
      "✓ 確認是我": "✓ Confirm This Is Me",
      "✕ 不是我的照片": "✕ Not My Photo",
      "回報號碼布標記有誤": "Report Wrong Bib Tag",
      "申請刪除這張照片": "Request Photo Takedown",

      // Screen: s-results, s-resultev, s-presult, s-result
      "成績庫": "Results Hub",
      "三年比賽的成績都在這裏。輸號碼布或姓名可以直接查到人，也可以按賽事瀏覽榜單。": "Three years of race results. Search by Bib or name, or browse leaderboards.",
      "我的跑步履歷": "My Running Record",
      "單場成績榜": "Race Leaderboard",
      "個人永久成績頁": "Permanent Runner Profile",
      "成績詳情 + 證書": "Result Details & Certificate",
      "排名": "Rank",
      "分段": "Splits",
      "槍聲成績": "Gun Time",
      "淨計時": "Net Time",
      "平均配速": "Avg Pace",
      "分段點": "Split Point",
      "分段用時": "Split Time",
      "下載成績證書": "Download Certificate",
      "下載成績證書 (PDF)": "Download Finisher Certificate (PDF)",

      // Screen: s-shop, s-shopitem, s-moconfirm, s-mopay, s-moorders, s-moorder
      "RUN 周邊": "RUN Merchandise",
      "RUN 周邊 · 商品列表": "RUN Shop · Product Catalog",
      "周邊商品詳情 · 選規格": "Product Details · Select SKU",
      "周邊訂單確認": "Order Confirmation",
      "周邊 KHQR 支付（獨立）": "KHQR Payment (Shop)",
      "我的周邊訂單": "My Merchandise Orders",
      "周邊訂單詳情": "Order Details",
      "商品詳情": "Product Details",
      "規格": "Option / SKU",
      "尺碼": "Size",
      "顏色": "Color",
      "數量": "Quantity",
      "庫存": "In Stock",
      "立即購買": "Buy Now",
      "加入購物車": "Add to Cart",
      "收貨地址": "Shipping Address",
      "收件人": "Recipient",
      "配送方式": "Delivery Method",
      "現場領物點自提": "Pick up at Race Pack Station",
      "快遞寄送（金邊市內）": "Courier Delivery (Phnom Penh)",
      "商品總額": "Item Total",
      "運費": "Shipping Fee",
      "應付金額": "Amount Due",

      // Screen: s-reg1, s-reg2, s-reg4, s-pay, s-done, s-regdetail
      "1 · 參賽者與組別": "1 · Runners & Category",
      "2 · 參賽資料": "2 · Runner Information",
      "3 · 確認報名訂單": "3 · Order Review",
      "4 · KHQR 支付": "4 · KHQR Payment",
      "報名成功 + 賬號認領": "Registration Confirmed",
      "報名詳情 · 快照 / 資料 / 退款": "Registration Details · Snapshot / Info / Refund",
      "姓名": "Full Name",
      "證件類型": "ID Type",
      "護照": "Passport",
      "身份證": "National ID",
      "護照 / 身份證號": "Passport / ID Number",
      "性別": "Gender",
      "男": "Male",
      "女": "Female",
      "出生日期": "Date of Birth",
      "聯繫電話": "Phone Number",
      "緊急聯繫人": "Emergency Contact",
      "緊急聯繫電話": "Emergency Phone",
      "衣服尺碼": "T-Shirt Size",
      "健康聲明與免責同意": "Health & Liability Agreement",
      "總計費用": "Total Amount",
      "掃碼支付": "Scan to Pay",
      "請使用任意支持 KHQR 的銀行 App 掃碼": "Scan with any KHQR-supported banking app",
      "查看參賽憑證": "View Digital Pass",

      // Screen: s-me, s-dash
      "我的（個人中心）": "My Account (Profile)",
      "我的報名": "My Registrations",
      "我的照片": "My Photos",
      "優惠券": "Coupons",
      "個人資料": "Profile Settings",
      "主辦方數據看板": "Organizer Analytics Dashboard",
      "報名總人數": "Total Registrations",
      "收款總金額": "Total Revenue",
      "實到率": "Turnout Rate",
      "完賽率": "Finisher Rate",

      // Screen: s-acts, s-freedetail, s-freereg, s-freedone, s-ugc, s-post, s-postdone
      "活動（免費 + 跑友）": "Activities (Free + Community)",
      "免費活動詳情": "Free Activity Details",
      "免費活動報名": "Free Activity Registration",
      "免費活動憑證": "Free Activity Digital Pass",
      "發佈活動": "Post an Activity",
      "活動詳情": "Activity Details",
      "發佈結果 · 留痕": "Post Confirmation",
      "我發佈的": "My Posts",

      // Policy & Staff
      "常見問題": "FAQ",
      "聯繫我們": "Contact Us",
      "使用條款": "Terms of Use",
      "個人數據政策": "Privacy Policy",
      "安全政策": "Security Policy",
      "退款政策": "Refund Policy",
      "工作人員門戶": "Staff Portal",
      "Race Pack 工作臺": "Race Pack Station",
      "Bib 運營工作臺": "Bib Operations Console"
    },
    km: {
      // General & Common
      "返回首頁": "ត្រឡប់ទៅទំព័រដើម",
      "← 返回首頁": "← ត្រឡប់ទៅទំព័រដើម",
      "← 返回賽事列表": "← ត្រឡប់ទៅបញ្ជីការប្រកួត",
      "← 返回成績查詢": "← ត្រឡប់ទៅការស្វែងរកលទ្ធផល",
      "← 返回搜索結果": "← ត្រឡប់ទៅលទ្ធផលស្វែងរក",
      "← 重新查找": "← ស្វែងរកម្តងទៀត",
      "清空": "សម្អាត",
      "搜索": "ស្វែងរក",
      "篩選": "ចម្រាញ់",
      "確定": "យល់ព្រម",
      "取消": "បោះបង់",
      "下一步": "ជំហានបន្ទាប់",
      "上一步": "ត្រឡប់ក្រោយ",
      "立即報名": "ចុះឈ្មោះឥឡូវនេះ",
      "立即支付": "បង់ប្រាក់ឥឡូវនេះ",
      "查看全部": "មើលទាំងអស់",
      "已截止": "បានបិទ",
      "名額已滿": "ពេញហើយ",
      "報名開放中": "កំពុងបើកចុះឈ្មោះ",
      "報名中": "បើកចុះឈ្មោះ",
      "即將開放": "ជិតបើក",
      "已結束": "បានបញ្ចប់",
      "免費": "ឥតគិតថ្លៃ",

      // Screen: s-races & s-detail
      "全部賽事": "ការប្រកួតទាំងអស់",
      "查看全部歷史賽事 →": "មើលការប្រកួតកន្លងមកទាំងអស់ →",
      "全部歷史賽事": "ការប្រកួតកន្លងមកទាំងអស់",
      "歷史賽事": "ការប្រកួតកន្លងមក",
      "賽事詳情": "ព័ត៌មានលម្អិតការប្រកួត",
      "選擇組別": "ជ្រើសរើសវិញ្ញាសា",
      "賽程與關門時間": "កាលវិភាគ និងពេលវេលាកំណត់",
      "領物": "ការទទួលកញ្ចប់សម្ភារៈ",
      "路線圖": "ផែនទីផ្លូវរត់",
      "報名須知": "លក្ខខណ្ឌនៃការចុះឈ្មោះ",
      "退改政策": "គោលការណ៍សងប្រាក់",
      "組別": "វិញ្ញាសា",
      "集合": "ជួបជុំ",
      "起跑": "ចេញដំណើរ",
      "關門": "បិទផ្លូវ",
      "年齡限制": "កម្រិតអាយុ",
      "地點": "ទីតាំង",
      "地址": "អាសយដ្ឋាន",
      "日期": "កាលបរិច្ឆេទ",
      "時間": "ពេលវេលា",
      "距離 / 強度": "ចម្ងាយ / ល្បឿន",
      "集合方式": "វិធីជួបជុំ",
      "人數上限": "ចំនួនមនុស្សអតិបរមា",
      "費用": "ថ្លៃចំណាយ",
      "贊助商": "អ្នកឧបត្ថម្ភ",

      // Screen: s-photos, s-photores, s-photo
      "找我的照片": "រករូបថតរបស់ខ្ញុំ",
      "輸入你的號碼布，或者直接翻這場比賽的全部照片。": "បញ្ចូលលេខ Bib របស់អ្នក ឬមើលរូបថតទាំងអស់នៃការប្រកួត។",
      "選擇賽事": "ជ្រើសរើសការប្រកួត",
      "用號碼布找": "ស្វែងរកតាមលេខ Bib",
      "最準的方式。輸入你的號碼布號碼，系統會找出所有拍到這個號碼的照片。": "វិធីសុក្រឹតបំផុត។ បញ្ចូលលេខ Bib ដើម្បីរករាល់រូបថតដែលមានលេខរបស់អ្នក។",
      "開始查找": "ចាប់ផ្តើមស្វែងរក",
      "用自拍找": "ស្វែងរកតាមរូប Selfie",
      "一期不做": "ដំណាក់កាលក្រោយ",
      "瀏覽全部照片": "មើលរូបថតទាំងអស់",
      "不確定就自己翻。可以按機位和公里數篩選，看到自己的點一下認領。": "មើលរូបថតតាមទីតាំងកាមេរ៉ា និងគីឡូម៉ែត្រ។ ចុចទទួលយករូបថតពេលឃើញខ្លួនឯង។",
      "瀏覽本場全部照片": "មើលរូបថតទាំងអស់នៃការប្រកួត",
      "我的歷史照片": "ប្រវត្តិរូបថតរបស់ខ្ញុំ",
      "打開「我的照片」": "បើក «រូបថតរបស់ខ្ញុំ»",
      "隱私說明": "គោលការណ៍ឯកជនភាព",
      "搜索結果": "លទ្ធផលស្វែងរក",
      "沒找到自己？": "រកមិនឃើញខ្លួនឯង?",
      "換個號碼布再查": "ស្វែងរកដោយប្រើលេខ Bib ផ្សេងទៀត",
      "瀏覽尚未關聯號碼布的照片": "មើលរូបថតដែលមិនទាន់ភ្ជាប់លេខ Bib",
      "提交人工補充查找": "ស្នើសុំការពិនិត្យដោយផ្ទាល់",
      "照片信息": "ព័ត៌មានរូបថត",
      "✓ 確認是我": "✓ ពិតជារូបខ្ញុំ",
      "✕ 不是我的照片": "✕ មិនមែនជារូបខ្ញុំទេ",
      "回報號碼布標記有誤": "រាយការណ៍លេខ Bib មិនត្រឹមត្រូវ",
      "申請刪除這張照片": "ស្នើសុំលុបរូបថតនេះ",

      // Screen: s-results, s-resultev, s-presult, s-result
      "成績庫": "ទិន្នន័យលទ្ធផល",
      "三年比賽的成績都在這裏。輸號碼布或姓名可以直接查到人，也可以按賽事瀏覽榜單。": "ទិន្នន័យលទ្ធផលការប្រកួត ៣ ឆ្នាំ។ ស្វែងរកតាមលេខ Bib ឬឈ្មោះ។",
      "我的跑步履歷": "ប្រវត្តិរត់របស់ខ្ញុំ",
      "單場成績榜": "តារាងលទ្ធផល",
      "個人永久成績頁": "ទំព័រលទ្ធផលអចិន្ត្រៃយ៍",
      "成績詳情 + 證書": "លទ្ធផលលម្អិត និងវិញ្ញាបនបត្រ",
      "排名": "ចំណាត់ថ្នាក់",
      "分段": "ចន្លោះ",
      "槍聲成績": "ពេលវេលាកាំភ្លើង",
      "淨計時": "ពេលវេលាសុទ្ធ",
      "平均配速": "ល្បឿនមធ្យម",
      "分段點": "ចំណុចចន្លោះ",
      "分段用時": "ពេលចន្លោះ",
      "下載成績證書": "ទាញយកវិញ្ញាបនបត្រ",
      "下載成績證書 (PDF)": "ទាញយកវិញ្ញាបនបត្រ (PDF)",

      // Screen: s-shop, s-shopitem, s-moconfirm, s-mopay, s-moorders, s-moorder
      "RUN 周邊": "ទំនិញ RUN",
      "RUN 周邊 · 商品列表": "ហាងទំនិញ RUN · បញ្ជីទំនិញ",
      "周邊商品詳情 · 選規格": "ព័ត៌មានលម្អិតទំនិញ · ជ្រើសរើសទំហំ",
      "周邊訂單確認": "បញ្ជាក់ការបញ្ជាទិញ",
      "周邊 KHQR 支付（獨立）": "ការទូទាត់ KHQR (ទំនិញ)",
      "我的周邊訂單": "ការបញ្ជាទិញទំនិញរបស់ខ្ញុំ",
      "周邊訂單詳情": "ព័ត៌មានលម្អិតការបញ្ជាទិញ",
      "商品詳情": "ព័ត៌មានលម្អិតទំនិញ",
      "規格": "ជម្រើសទំនិញ",
      "尺碼": "ទំហំ",
      "顏色": "ពណ៌",
      "數量": "ចំនួន",
      "庫存": "ក្នុងស្តុក",
      "立即購買": "ទិញឥឡូវនេះ",
      "加入購物車": "ដាក់ចូលកន្ត្រក",
      "收貨地址": "អាសយដ្ឋានដឹកជញ្ជូន",
      "收件人": "អ្នកទទួល",
      "配送方式": "វិធីដឹកជញ្ជូន",
      "現場領物點自提": "ទទួលនៅស្តង់ចែកសម្ភារៈ",
      "快遞寄送（金邊市內）": "ដឹកជញ្ជូនក្នុងភ្នំពេញ",
      "商品總額": "តម្លៃទំនិញសរុប",
      "運費": "ថ្លៃដឹកជញ្ជូន",
      "應付金額": "ចំនួនប្រាក់ត្រូវបង់",

      // Screen: s-reg1, s-reg2, s-reg4, s-pay, s-done, s-regdetail
      "1 · 參賽者與組別": "១ · អ្នកចូលរួម និងវិញ្ញាសា",
      "2 · 參賽資料": "២ · ព័ត៌មានអ្នកចូលរួម",
      "3 · 確認報名訂單": "៣ · ពិនិត្យការបញ្ជាទិញ",
      "4 · KHQR 支付": "៤ · ការទូទាត់ KHQR",
      "報名成功 + 賬號認領": "ចុះឈ្មោះជោគជ័យ",
      "報名詳情 · 快照 / 資料 / 退款": "ព័ត៌មានលម្អិតការចុះឈ្មោះ",
      "姓名": "ឈ្មោះពេញ",
      "證件類型": "ប្រភេទឯកសារ",
      "護照": "លិខិតឆ្លងដែន",
      "身份證": "អត្តសញ្ញាណប័ណ្ណ",
      "護照 / 身份證號": "លេខលិខិតឆ្លងដែន / អត្តសញ្ញាណប័ណ្ណ",
      "性別": "ភេទ",
      "男": "ប្រុស",
      "女": "ស្រី",
      "出生日期": "ថ្ងៃខែឆ្នាំកំណើត",
      "聯繫電話": "លេខទូរស័ព្ទ",
      "緊急聯繫人": "អ្នកទាក់ទងបន្ទាន់",
      "緊急聯繫電話": "លេខទូរស័ព្ទបន្ទាន់",
      "衣服尺碼": "ទំហំអាវ",
      "健康聲明與免責同意": "សេចក្តីថ្លែងការណ៍សុខភាព និងការបដិសេធ",
      "總計費用": "ចំនួនប្រាក់សរុប",
      "掃碼支付": "ស្កេនដើម្បីបង់ប្រាក់",
      "請使用任意支持 KHQR 的銀行 App 掃碼": "សូមស្កេនដោយប្រើកម្មវិធីធនាគារ KHQR ណាមួយ",
      "查看參賽憑證": "មើលប័ណ្ណចូលរួម",

      // Screen: s-me, s-dash
      "我的（個人中心）": "គណនីរបស់ខ្ញុំ",
      "我的報名": "ការចុះឈ្មោះរបស់ខ្ញុំ",
      "我的照片": "រូបថតរបស់ខ្ញុំ",
      "優惠券": "ប័ណ្ណបញ្ចុះតម្លៃ",
      "個人資料": "ការកំណត់កម្រងព័ត៌មាន",
      "主辦方數據看板": "ផ្ទាំងគ្រប់គ្រងអ្នករៀបចំ",
      "報名總人數": "ចំនួនអ្នកចុះឈ្មោះសរុប",
      "收款總金額": "ប្រាក់ចំណូលសរុប",
      "實到率": "អត្រាអ្នកមកជាក់ស្តែង",
      "完賽率": "អត្រាអ្នករត់ចប់",

      // Screen: s-acts, s-freedetail, s-freereg, s-freedone, s-ugc, s-post, s-postdone
      "活動（免費 + 跑友）": "សកម្មភាព (ឥតគិតថ្លៃ + អ្នករត់)",
      "免費活動詳情": "ព័ត៌មានលម្អិតសកម្មភាពឥតគិតថ្លៃ",
      "免費活動報名": "ចុះឈ្មោះសកម្មភាពឥតគិតថ្លៃ",
      "免費活動憑證": "ប័ណ្ណចូលរួមសកម្មភាព",
      "發佈活動": "បង្ហោះសកម្មភាព",
      "活動詳情": "ព័ត៌មានលម្អិតសកម្មភាព",
      "發佈結果 · 留痕": "លទ្ធផលបង្ហោះ",
      "我發佈的": "សកម្មភាពដែលខ្ញុំបានបង្ហោះ",

      // Policy & Staff
      "常見問題": "សំណួរញឹកញាប់",
      "聯繫我們": "ទាក់ទងយើង",
      "使用條款": "លក្ខខណ្ឌប្រើប្រាស់",
      "個人數據政策": "គោលការណ៍ទិន្នន័យឯកជន",
      "安全政策": "គោលការណ៍សុវត្ថិភាព",
      "退款政策": "គោលការណ៍សងប្រាក់",
      "工作人員門戶": "ច្រកបុគ្គលិក",
      "Race Pack 工作臺": "ស្ថានីយចែកកញ្ចប់សម្ភារៈ",
      "Bib 運營工作臺": "ស្ថានីយប្រតិបត្តិការ Bib"
    }
  };

  /* 深度 DOM 文本自動國際化遍歷引擎 */
  var DOM_ORIG_TEXTS = new WeakMap();

  function translateDOMTree(root, lang) {
    if (!root) return;
    if (lang === "zh") {
      // Restore original text
      restoreDOMTree(root);
      return;
    }
    var map = GLOBAL_I18N_MAP[lang];
    if (!map) return;

    var walker = document.createTreeWalker(root, (typeof NodeFilter !== "undefined" ? NodeFilter.SHOW_TEXT : 4), null, false);
    var node;
    while (node = walker.nextNode()) {
      var txt = node.nodeValue.trim();
      if (!txt) continue;
      if (!DOM_ORIG_TEXTS.has(node)) {
        DOM_ORIG_TEXTS.set(node, node.nodeValue);
      }
      var orig = DOM_ORIG_TEXTS.get(node);
      var origTrim = orig.trim();
      if (map[origTrim]) {
        node.nodeValue = orig.replace(origTrim, map[origTrim]);
      }
    }

    // Also translate buttons, inputs and placeholders
    root.querySelectorAll("button, input[placeholder], textarea[placeholder], h1, h2, h3, h4, h5, h6, label, p, span, em, b, th, td").forEach(function(el) {
      if (el.hasAttribute("data-i18n")) return; // handled by data-i18n
      
      // Placeholders
      if (el.placeholder) {
        var pTrim = el.placeholder.trim();
        if (map[pTrim]) el.placeholder = map[pTrim];
      }
      // Value for inputs
      if (el.tagName === "INPUT" && (el.type === "button" || el.type === "submit") && el.value) {
        var vTrim = el.value.trim();
        if (map[vTrim]) el.value = map[vTrim];
      }
    });
  }

  function restoreDOMTree(root) {
    if (!root) return;
    var walker = document.createTreeWalker(root, (typeof NodeFilter !== "undefined" ? NodeFilter.SHOW_TEXT : 4), null, false);
    var node;
    while (node = walker.nextNode()) {
      if (DOM_ORIG_TEXTS.has(node)) {
        node.nodeValue = DOM_ORIG_TEXTS.get(node);
      }
    }
  }

  var PROTO_PANEL_I18N = {
    en: {
      "fab": "☰ Prototype Nav",
      "h_pages": "Pages",
      "home": "Home",
      "about": "About Us",
      "races": "Races · Search & Filters",
      "history": "Past Races",
      "acts": "Activities (Free + Community)",
      "detail": "Race Details",
      "photos": "Find My Photos",
      "me": "My Account (Profile)",
      "me-history": "My Running Record",
      "dash": "Organizer Dashboard",
      "h_results": "Results Hub",
      "results": "Results Home",
      "resultev": "Race Leaderboard",
      "presult": "Permanent Runner Profile",
      "result": "Result Details + Certificate",
      "h_shop": "Merchandise · Separate Order Domain (D-092)",
      "shop": "RUN Shop · Product List",
      "shopitem": "Product Details · Select SKU",
      "moconfirm": "Order Confirmation",
      "mopay": "KHQR Payment (Shop)",
      "moorders": "My Merchandise Orders",
      "moorder": "Order Details",
      "h_reg": "Registration Flow",
      "reg1": "1 · Runners & Category",
      "reg2": "2 · Runner Details",
      "reg4": "3 · Order Review",
      "pay": "4 · KHQR Payment",
      "done": "Confirmation + Claim Pass",
      "regdetail": "Registration Details · Snapshot / Info / Refund",
      "h_staff": "On-Site Staff Portal",
      "staff": "Staff Home",
      "racepack": "Race Pack Handoff Station",
      "bibmgmt": "Bib Operations Console",
      "h_admin": "Operations Admin · Prototype Only",
      "admin_btn": "Admin Console Demo →<br><span style='font-size:.66rem;color:var(--ink-mute)'>Standalone Page · Full Mock Data · No Backend</span>",
      "h_base": "Information & Policy Pages",
      "faq": "FAQ",
      "contact": "Contact Us",
      "terms": "Terms of Use",
      "privacy": "Privacy Policy",
      "security": "Security Policy",
      "refund": "Refund Policy",
      "h_free": "Free Activity Flow",
      "freedetail": "Free Activity Details",
      "freereg": "Free Activity Registration",
      "freedone": "Free Activity Digital Pass",
      "h_ugc": "Community Runs (UGC)",
      "post": "Post an Activity",
      "ugc": "Activity Details",
      "postdone": "Post Confirmation",
      "me-posts": "My Posted Activities",
      "h_scenarios": "Demo Scenarios"
    },
    km: {
      "fab": "☰ មឺនុយគំរូ",
      "h_pages": "ទំព័រ",
      "home": "ទំព័រដើម",
      "about": "អំពីយើង",
      "races": "ការប្រកួត · ស្វែងរក",
      "history": "ការប្រកួតកន្លងមក",
      "acts": "សកម្មភាព (ឥតគិតថ្លៃ + អ្នករត់)",
      "detail": "ព័ត៌មានលម្អិតការប្រកួត",
      "photos": "រករូបថតរបស់ខ្ញុំ",
      "me": "គណនីរបស់ខ្ញុំ",
      "me-history": "ប្រវត្តិរត់របស់ខ្ញុំ",
      "dash": "ផ្ទាំងគ្រប់គ្រងអ្នករៀបចំ",
      "h_results": "ទិន្នន័យលទ្ធផល",
      "results": "ទំព័រដើមលទ្ធផល",
      "resultev": "តារាងលទ្ធផល",
      "presult": "ទំព័រលទ្ធផលអចិន្ត្រៃយ៍",
      "result": "លទ្ធផលលម្អិត + វិញ្ញាបនបត្រ",
      "h_shop": "ទំនិញ · ការបញ្ជាទិញដាច់ដោយឡែក (D-092)",
      "shop": "ហាង RUN · បញ្ជីទំនិញ",
      "shopitem": "ព័ត៌មានលម្អិតទំនិញ · ជ្រើសរើសទំហំ",
      "moconfirm": "បញ្ជាក់ការបញ្ជាទិញ",
      "mopay": "ការទូទាត់ KHQR (ទំនិញ)",
      "moorders": "ការបញ្ជាទិញទំនិញរបស់ខ្ញុំ",
      "moorder": "ព័ត៌មានលម្អិតការបញ្ជាទិញ",
      "h_reg": "ដំណើរការចុះឈ្មោះ",
      "reg1": "១ · អ្នកចូលរួម និងវិញ្ញាសា",
      "reg2": "២ · ព័ត៌មានអ្នកចូលរួម",
      "reg4": "៣ · ពិនិត្យការបញ្ជាទិញ",
      "pay": "៤ · ការទូទាត់ KHQR",
      "done": "ចុះឈ្មោះជោគជ័យ + ទទួលប័ណ្ណ",
      "regdetail": "ព័ត៌មានលម្អិតការចុះឈ្មោះ",
      "h_staff": "ច្រកបុគ្គលិក",
      "staff": "ទំព័រដើមបុគ្គលិក",
      "racepack": "ស្ថានីយចែកកញ្ចប់សម្ភារៈ",
      "bibmgmt": "ស្ថានីយប្រតិបត្តិការ Bib",
      "h_admin": "ផ្ទាំងគ្រប់គ្រង Admin",
      "admin_btn": "ផ្ទាំងគ្រប់គ្រង Admin Demo →<br><span style='font-size:.66rem;color:var(--ink-mute)'>ទំព័រដាច់ដោយឡែក · ទិន្នន័យគំរូ</span>",
      "h_base": "ទំព័រគោលការណ៍",
      "faq": "សំណួរញឹកញាប់",
      "contact": "ទាក់ទងយើង",
      "terms": "លក្ខខណ្ឌប្រើប្រាស់",
      "privacy": "គោលការណ៍ទិន្នន័យឯកជន",
      "security": "គោលការណ៍សុវត្ថិភាព",
      "refund": "គោលការណ៍សងប្រាក់",
      "h_free": "សកម្មភាពឥតគិតថ្លៃ",
      "freedetail": "ព័ត៌មានលម្អិតសកម្មភាព",
      "freereg": "ចុះឈ្មោះសកម្មភាពឥតគិតថ្លៃ",
      "freedone": "ប័ណ្ណចូលរួមសកម្មភាព",
      "h_ugc": "សកម្មភាពអ្នករត់ (UGC)",
      "post": "បង្ហោះសកម្មភាព",
      "ugc": "ព័ត៌មានលម្អិតសកម្មភាព",
      "postdone": "លទ្ធផលបង្ហោះ",
      "me-posts": "សកម្មភាពដែលខ្ញុំបានបង្ហោះ",
      "h_scenarios": "សេណារីយ៉ូគំរូ"
    }
  };

  var PROTO_ORIG = null;

  function snapshotProto() {
    PROTO_ORIG = {
      fab: $("proto-fab") ? $("proto-fab").textContent : "☰ 原型導航",
      btns: {},
      h6s: []
    };
    var panel = $("proto-panel");
    if (!panel) return;
    panel.querySelectorAll("button[data-go]").forEach(function(b) {
      PROTO_ORIG.btns[b.getAttribute("data-go")] = b.textContent;
    });
    panel.querySelectorAll("h6").forEach(function(h) {
      PROTO_ORIG.h6s.push(h.textContent);
    });
  }

  function translateProtoPanel(l) {
    if (!PROTO_ORIG) snapshotProto();
    var fab = $("proto-fab");
    var panel = $("proto-panel");
    if (!panel) return;

    if (l === "zh") {
      if (fab) fab.textContent = PROTO_ORIG.fab;
      panel.querySelectorAll("button[data-go]").forEach(function(b) {
        var key = b.getAttribute("data-go");
        if (PROTO_ORIG.btns[key]) b.textContent = PROTO_ORIG.btns[key];
      });
      var h6s = panel.querySelectorAll("h6");
      PROTO_ORIG.h6s.forEach(function(txt, i) {
        if (h6s[i]) h6s[i].textContent = txt;
      });
      return;
    }

    var dict = PROTO_PANEL_I18N[l];
    if (!dict) return;

    if (fab && dict.fab) fab.textContent = dict.fab;

    panel.querySelectorAll("button[data-go]").forEach(function(b) {
      var key = b.getAttribute("data-go");
      if (dict[key]) b.textContent = dict[key];
    });

    var h6Map = {
      0: "h_pages",
      1: "h_results",
      2: "h_shop",
      3: "h_reg",
      4: "h_staff",
      5: "h_admin",
      6: "h_base",
      7: "h_free",
      8: "h_ugc",
      9: "h_scenarios"
    };

    var h6List = panel.querySelectorAll("h6");
    h6List.forEach(function(h, idx) {
      var tKey = hMapKey(h.textContent.trim());
      if (tKey && dict[tKey]) h.textContent = dict[tKey];
    });
  }

  function hMapKey(txt) {
    if (txt.indexOf("頁面") >= 0 || txt.indexOf("Pages") >= 0 || txt.indexOf("ទំព័រ") >= 0) return "h_pages";
    if (txt.indexOf("成績庫") >= 0 || txt.indexOf("Results Hub") >= 0) return "h_results";
    if (txt.indexOf("周邊商品") >= 0 || txt.indexOf("Merchandise") >= 0) return "h_shop";
    if (txt.indexOf("報名流程") >= 0 || txt.indexOf("Registration Flow") >= 0) return "h_reg";
    if (txt.indexOf("工作人員端") >= 0 || txt.indexOf("Staff Portal") >= 0) return "h_staff";
    if (txt.indexOf("運營後臺") >= 0 || txt.indexOf("Operations Admin") >= 0) return "h_admin";
    if (txt.indexOf("基礎頁面") >= 0 || txt.indexOf("Information & Policy") >= 0) return "h_base";
    if (txt.indexOf("免費活動流程") >= 0 || txt.indexOf("Free Activity") >= 0) return "h_free";
    if (txt.indexOf("跑友活動") >= 0 || txt.indexOf("Community Runs") >= 0) return "h_ugc";
    if (txt.indexOf("演示場景") >= 0 || txt.indexOf("Demo Scenarios") >= 0) return "h_scenarios";
    return null;
  }

  function setLang(l, silent) {
    if (!I18N[l]) l = "zh";
    LANG = l;
    if (!ORIG) snapshotOrig();

    var dict = (l === "zh") ? ORIG : I18N[l];
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var k = el.getAttribute("data-i18n");
      var v = dict[k];
      if (v === undefined) v = ORIG[k];          /* 缺翻譯時回落繁中，絕不留空 */
      if (v !== undefined) el.innerHTML = v;
    });

    /* 只給首頁掛 lang，避免高棉文字體套到其餘 34 箇中文 screen 上 */
    var langTag = l === "zh" ? "zh-Hant" : (l === "km" ? "km" : "en");
    var home = $("s-home");
    if (home) home.setAttribute("lang", langTag);
    /* 整頁 lang 一起切：讀屏語音、:lang(km) 排版規則與瀏覽器翻譯都靠它 */
    document.documentElement.setAttribute("lang", langTag);

    [$("lang6"), $("foot-lang")].forEach(function (box) {
      if (!box) return;
      box.querySelectorAll("[data-lang]").forEach(function (b) {
        b.classList.toggle("on", b.getAttribute("data-lang") === l);
      });
    });

    try { localStorage.setItem("run.lang", l); } catch (e) {}
    renderNextRace();
    renderHomeMosaic();
    renderFreeLight();
    syncLangNote();
    translateProtoPanel(l);
    translateDOMTree(document.body, l);

    // Refresh dynamic screens
    if (typeof renderPostForm === "function" && document.querySelector("#s-post.on")) {
      renderPostForm();
    }
    if (typeof renderPhotoHome === "function" && document.querySelector("#s-photos.on")) {
      renderPhotoHome();
    }
    if (typeof applyRF === "function" && document.querySelector("#s-races.on")) {
      applyRF();
    }
    if (typeof renderDetailSide === "function" && document.querySelector("#s-detail.on")) {
      renderDetailSide();
      renderEventInfo();
    }
    if (typeof renderResultsHome2 === "function" && document.querySelector("#s-results.on")) {
      renderResultsHome2();
    }
    if (typeof renderSummary === "function" && document.querySelector("#s-reg4.on")) {
      renderSummary();
    }
    if (typeof renderHistory === "function" && document.querySelector("#s-history.on")) {
      renderHistory();
    }
    if (typeof renderShop === "function" && document.querySelector("#s-shop.on")) {
      renderShop();
    }
    if (typeof renderMe === "function" && document.querySelector("#s-me.on")) {
      renderMe();
    }
    if (!silent) requestAnimationFrame(paintAll);
  }

  /* Visual Sprint 01 的三語只覆蓋首頁 v6 模塊。離開首頁就必須說清楚，
     否則語言選擇器會讓人以爲整站已經有對應語言版本。 */
  function syncLangNote() {
    var note = $("langnote");
    if (!note) return;
    /* 不再展示干擾性全寬橫幅 */
    document.body.classList.toggle("lang-partial", false);
  }

  /* ---------------- Next Race ---------------- */

  function upcoming() {
    /* ⚖️ D-117 A5 · 「隱藏公開展示」的賽事不進任何公開發現面 —— Hero 的
       Next Race、Upcoming Races 大卡都從這裏取數。 */
    return publicRaces().filter(function (r) {
      return !r.free && ["open", "low", "soon"].indexOf(r.state) >= 0;
    }).sort(function (a, b) { return dateNum(a.d) - dateNum(b.d); });
  }

  /* Featured Race —— 只服務 Upcoming Races 的大卡。可以被人工置頂。 */
  function featuredRace() {
    var up = upcoming();
    var f = up.filter(function (r) { return r.featured; })[0];
    return f || up[0] || null;   /* 沒有人工置頂 → 自動取最近一場 */
  }

  /* Next Race —— 只服務 Hero 的「下一場賽事」。永遠按日期取最近的一場，
     絕不受 featured 影響：運營把 12 月的賽事置頂時，Hero 仍必須顯示 9 月那場。
     優先「報名中 / 名額緊張」，都沒有才退到「即將開放」。 */
  function nextRace() {
    var up = upcoming();   /* upcoming() 已按日期升序 */
    var open = up.filter(function (r) { return r.state === "open" || r.state === "low"; });
    return open[0] || up[0] || null;
  }

  /* ⚖️ D-111 根 A · 映射到共享賽事的那些賽事，業務事實<b>只有一份</b>。
     ----------------------------------------------------------------
     展示外殼（名字、圖片、文案）仍歸前端；但「還剩多少名額」「比賽哪天」
     這種東西是<b>業務事實</b>，不能前端一套、共享域一套。
     以前首頁讀 r.left（一個寫死的裝飾數字）、列表讀 cap−used（漏掉了付款
     窗口裏的 reserved），於是同一個賽事在三個地方能給出三個答案。

     現在：映射得到共享賽事的，一律走 RD.capacityLeft()——它本來就把
     used + reserved 都算進去了，所以有人進 KHQR 佔住一個位子，
     首頁 / 列表 / 詳情<b>立刻</b>一起少一個。
     沒有映射的純展示賽事，仍用它自己的裝飾數字（A3：不強行把每個都拽進共享域）。 */
  function sharedEventOf(feEvId) {
    var adminEv = RD.adminEventId(feEvId);
    return adminEv ? RD.eventById(adminEv) : null;
  }
  /* 單個組別的剩餘：含 reserved */
  function sharedCatLeft(feEvId, catAdminId) {
    var adminEv = RD.adminEventId(feEvId);
    return adminEv ? RD.capacityLeft(adminEv, catAdminId) : 0;
  }
  /* 整場賽事的剩餘 = 各組別當前剩餘之和 */
  function sharedSeatsLeft(feEvId) {
    var e = sharedEventOf(feEvId);
    if (!e) return null;
    var adminEv = RD.adminEventId(feEvId);
    return e.categories.reduce(function (a, c) { return a + RD.capacityLeft(adminEv, c.id); }, 0);
  }
  /* ⚖️ A5 / A6 · 比賽日期同樣是業務事實：資格判定按「比賽當天年齡」算，
     所以對外展示的日期與判定用的日期<b>必須是同一個</b>。
     以前前端寫死 2026-09-20，共享 EV-A 卻是 2026-11-15 —— 用戶看到一個日期，
     系統按另一個日期判他夠不夠年齡。 */
  function sharedEventDate(feEvId) {
    var e = sharedEventOf(feEvId);
    return e && e.date ? e.date : null;          /* "YYYY-MM-DD" */
  }

  /* ⚖️ D-117 A1 · 兩個運營開關同樣是<b>共享業務事實</b>，不是後臺的內部標記。
     ----------------------------------------------------------------
     共享 Event 裏早就有 registrationOpen 與 publicVisible，後臺也一直在正確
     地改它們 —— 只是用戶端從來沒讀過。於是 OPS 點了「停止報名」，前臺照樣
     顯示「立即報名」並且真的能下單；點了「隱藏公開展示」，前臺照樣在首頁
     和賽事列表裏推它。開關成了擺設。
     現在映射到共享賽事的那些賽事，這兩件事一律以共享 Event 爲準，
     <b>不在前端複製第二份 registrationOpen / publicVisible</b>。
     沒有映射的純展示賽事（f1/f2/f3、e2…）保留它們原來的本地行爲（A1）。
     ⚠️ 兩個開關<b>互相獨立</b>：這裏分別讀，任何一個都不會去推斷另一個（A7）。 */
  /* ⚖️ D-118 R7 / R8 · 映射賽事的對外形態由<b>三個各自獨立的共享事實</b>共同決定：
       Event.status（DRAFT / PUBLISHED）· registrationOpen · publicVisible
     一場還是 DRAFT 的賽事<b>根本還沒對外存在</b>，所以它不該像一場正常發佈的
     公開賽事那樣出現在發現面、也不該開着報名入口 —— 那與兩個運營開關是不同的事。
     ⚠️ 三者<b>互不聯動</b>：發佈不會順手改寫任何一個開關，開關也不會改寫狀態（R8）。
     ⚠️ 前端不另立發佈標誌：這裏讀的就是共享 Event 自己那三個字段。 */
  function sharedPublished(feEvId) {
    var e = sharedEventOf(feEvId);
    return e ? e.status === "PUBLISHED" : true;      /* 未映射 → 保持既有本地行爲 */
  }
  function regSwitchOpen(feEvId) {
    var e = sharedEventOf(feEvId);
    return e ? (e.status === "PUBLISHED" && e.registrationOpen === true) : true;
  }
  function publiclyVisible(feEvId) {
    var e = sharedEventOf(feEvId);
    return e ? (e.status === "PUBLISHED" && e.publicVisible === true) : true;
  }
  /* 公開發現面（首頁 / 賽事列表 / 搜索 / 推薦卡）只呈現「公開展示中」的賽事。
     ⚠️ 這只是<b>不再對外推薦</b>：賽事數據一條沒刪，詳情頁仍可達，
     「我的」裏已有的報名 / 訂單 / 參賽人 / 號碼布 / 參賽包一律不受影響（A5 / A6）。 */
  function publicRaces() {
    return RACES.filter(function (r) { return publiclyVisible(r.id); });
  }

  function seatsOf(r) {
    var shared = sharedSeatsLeft(r.id);
    if (shared !== null) return shared;          /* 映射賽事：共享域說了算 */
    var used = S.regs ? S.regs.filter(function (x) { return x.ev === r.id && x.status === "registered"; }).length : 0;
    return Math.max(0, (r.left || 0) - used);
  }

  /* D-122 · chip 上寫的狀態同樣是派生事實，不是卡片自己那個 r.state */
  function stateChip(r, F) {
    var d = D(), st = (F || mappedCardFacts(r)).uiState;
    var cls = st === "open" ? "" : (st === "low" ? "deep" : "mute");
    return '<span class="chip6 ' + cls + ' l10n">' + (d[st] || d.open) + '</span>';
  }

  function renderNextRace() {
    var box = $("nx");
    if (!box) return;
    var r = nextRace(), d = D();
    if (!r) {
      box.innerHTML = '<div class="nx-card"><span class="chip6 mute l10n">' + d.next +
        '</span><p class="nx-empty l10n">' + d.empty + '</p>' +
        '<div class="nx-cta"><button class="btn6 sm ghost l10n" data-go="races">' + d.allRaces + '</button></div></div>';
      return;
    }
    var L = RACE_L10N[r.id] || {};
    var F = mappedCardFacts(r), seats = F.seats;          /* D-122 · 同一份派生事實 */
    box.innerHTML =
      '<div class="nx-card">' +
        '<span class="chip6 lat">' + (LANG === "en" ? "NEXT RACE" : d.next) + '</span>' +
        '<h2 class="nx-name display lat">' + (L.lat || r.t) + '</h2>' +
        '<p class="nx-local l10n">' + ((L.sub && L.sub[LANG]) || r.t) + '</p>' +
        '<div class="nx-row"><span class="num">' + fmtDate(r.d, true) + '</span>' +
          '<span class="l10n">· ' + ((L.city && L.city[LANG]) || r.loc) + '</span></div>' +
        '<div class="nx-row"><span class="nx-dist num lat">' + h(F.dist.replace(/\s*\/\s*/g, " · ")) + '</span></div>' +
        '<div class="nx-row"><span class="nx-price num">' +
            (r.free ? d.freeTxt : (F.priceLabel ? h(F.priceLabel) : d.price(F.price))) + '</span>' +
          '<span class="nx-left l10n">' +
            (F.uiState === "paused" ? d.pausedFoot : (seats > 0 ? d.seats(seats) : d.noSeat)) + '</span></div>' +
        '<div class="nx-cta">' +
          /* ⚖️ D-117 A2 · 報名停了，Hero 這顆主 CTA 就不能再寫「立即報名」。
             按鈕仍然通向詳情頁（詳情本身不是報名入口），只是不再冒充報名入口。 */
          '<button class="btn6 sm l10n" data-go="detail" data-race="' + h(r.id) + '">' +
            (regSwitchOpen(r.id) ? d.regNow : d.paused) + '</button>' +
          '<button class="btn6 sm ghost l10n" data-go="races">' + d.allRaces + '</button>' +
        '</div>' +
      '</div>';
  }

  /* ---------------- 1 大 + 2 小馬賽克（五級降級） ---------------- */

  function raceCard6(r, big) {
    var L = RACE_L10N[r.id] || {}, d = D();
    var F = mappedCardFacts(r), seats = F.seats;          /* D-122 · 同一份派生事實 */
    var opens = raceOpensDetail(r);
    var el = document.createElement(opens ? "button" : "div");
    el.className = "rc" + (big ? " big" : "");
    if (opens) { el.setAttribute("data-go", "detail"); el.setAttribute("data-race", r.id); }
    else el.setAttribute("data-todo", "這場比賽在演示模型裏只做了卡片，沒有做詳情頁。可點開的是「金邊濱河半程馬拉松 2026」。");

    var media = L.img
      ? '<img src="' + L.img + '" alt="" loading="lazy" decoding="async"><span class="ph-note">AI 生成佔位</span>'
      : '<canvas data-art="race-' + r.seed + '"></canvas>';

    var foot = F.uiState === "draft" ? d.draftFoot
      : F.uiState === "paused" ? d.pausedFoot
      : F.uiState === "done" ? d.resultOut
      : F.uiState === "soon" ? d.openAt
      : F.uiState === "closed" ? d.packing
      : seats > 0 ? d.seats(seats) : d.noSeat;

    el.innerHTML =
      '<div class="rc-img">' + media +
        '<div class="rc-when"><b class="num">' + fmtDate(r.d) + '</b>' +
          '<span class="l10n">' + ((L.city && L.city[LANG]) || r.loc) + '</span></div>' +
        '<div class="rc-st">' + stateChip(r, F) + '</div>' +
        '<span class="rc-org l10n">' + (r.org === "partner" ? (LANG === "en" ? "PARTNER" : "合作主辦") : (LANG === "en" ? "OFFICIAL" : "RUN 官方")) + '</span>' +
      '</div>' +
      '<div class="rc-body">' +
        '<h3 class="rc-name display lat">' + (L.flat || r.t) + '</h3>' +
        '<p class="rc-local l10n">' + ((L.sub && L.sub[LANG]) || r.t) + '</p>' +
        '<p class="rc-dist num lat">' + h(F.dist.replace(/\s*\/\s*/g, " · ")) + '</p>' +
        '<div class="rc-foot">' +
          '<span class="rc-price num">' +
            (r.free ? d.freeTxt : (F.priceLabel ? h(F.priceLabel) : d.price(F.price))) + '</span>' +
          '<span class="rc-left l10n" style="font-size:.78rem;color:var(--ink-mute)">' + foot + '</span>' +
        '</div>' +
      '</div>';
    return el;
  }

  function renderHomeMosaic() {
    var wrap = $("home-races");
    if (!wrap) return;
    var d = D();
    var up = upcoming();
    var f = featuredRace();
    var rest = up.filter(function (r) { return r !== f; });

    wrap.innerHTML = "";
    wrap.className = "mosaic";

    if (!up.length) {                                  /* 0 場 → 緊湊空狀態 */
      wrap.className = "mosaic is-empty";
      wrap.innerHTML = '<div class="empty6"><span class="l10n">' + d.empty + '</span>' +
        '<button class="btn6 ghost sm l10n" data-go="races">' + d.allRaces + '</button></div>';
      return;
    }
    if (up.length === 1) {                             /* 1 場 → 單張大橫卡 */
      wrap.className = "mosaic n1";
      wrap.appendChild(raceCard6(f, true));
      return;
    }
    if (up.length === 2) {                             /* 2 場 → 兩張等寬 */
      wrap.className = "mosaic n2";
      wrap.appendChild(raceCard6(f, false));
      wrap.appendChild(raceCard6(rest[0], false));
      return;
    }
    wrap.appendChild(raceCard6(f, true));              /* ≥3 場 → 1 大 + 2 小 */
    rest.slice(0, 2).forEach(function (r) { wrap.appendChild(raceCard6(r, false)); });
  }

  /* ---------------- 免費活動：輕量卡（不帶大圖） ---------------- */

  function renderFreeLight() {
    var wrap = $("free-races");
    if (!wrap) return;
    var d = D();
    wrap.innerHTML = "";
    publicRaces().filter(function (r) { return r.free; }).forEach(function (r) {
      var seats = seatsOf(r);
      var el = document.createElement("button");
      el.className = "race";
      el.addEventListener("click", function () { curFree = r.id; go("freedetail"); });
      var F = (FREE_L10N[r.id] && FREE_L10N[r.id][LANG]) || {};
      var when = F.d || (/^\d{4}\./.test(r.d) ? fmtDate(r.d, true) : r.d);
      el.innerHTML =
        '<div class="race-body">' +
          '<div style="margin-bottom:.3rem"><span class="chip6 mute l10n">' + d.free + '</span></div>' +
          '<h3 class="l10n">' + (F.t || r.t) + '</h3>' +
          '<div class="race-meta"><span class="num lat">' + when + '</span>' +
            '<span class="l10n">' + (F.loc || r.loc) + '　' + (F.dist || r.dist) + '</span>' +
            (r.meet ? '<span class="l10n" style="color:var(--ink-mute)">' + d.meet + '：' + (F.meet || r.meet) + '</span>' : '') +
          '</div>' +
          '<div class="race-foot">' +
            '<span class="race-price free">' + d.freeTxt + '</span>' +
            '<span class="race-left l10n">' + (seats > 0 ? d.seats(seats) : d.noSeat) + '</span>' +
          '</div>' +
        '</div>';
      wrap.appendChild(el);
    });
  }

  /* ---------------- 綁定 ---------------- */

  (function bindV6() {
    ["lang6", "foot-lang"].forEach(function (id) {
      var box = $(id);
      if (!box) return;
      box.addEventListener("click", function (e) {
        var b = e.target.closest("[data-lang]");
        if (b) setLang(b.getAttribute("data-lang"));
      });
    });

    var tabs = document.querySelector(".tabs6");
    if (tabs) {
      tabs.addEventListener("click", function (e) {
        var b = e.target.closest("[data-tab]");
        if (!b) return;
        tabs.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
        var k = b.getAttribute("data-tab");
        ["free", "ugc"].forEach(function (n) {
          var pane = $("tab-" + n);
          if (pane) pane.classList.toggle("on", n === k);
        });
        requestAnimationFrame(paintAll);
      });
    }

    /* go() 之後同步「非首頁只有中文」提示條 */
    var _go = go;
    go = function (n, f) { _go(n, f); syncLangNote(); };
  })();

  /* ⚖️ D-097 · 組別 / 名額 / 價格檔只有<b>一套</b>事實，來自共享域裏的那一個 Event。
     用戶端這裏只做展示殼（中文名與距離文案），業務數字一律現算現取。
     「親子跑 2K」在共享域裏沒有對應組別 —— 它本來就是「價格與規則尚未確定」，
     不編造，因此保留爲無價格的展示項。 */
  /* 「本屆演示賽事」——成績 / 照片 / 領物 / 號碼布這些模塊仍然只服務它。
     D-121 R10 明確不把這些模塊動態化，所以這個常量保持不變。 */
  var FE_EVENT = "e1";

  /* ⚖️ D-121 · <b>用戶點的是哪一場？</b>
     ----------------------------------------------------------------
     D-118 之後 EV-B 真的能被髮布了，可用戶端還把 e3 當一張裝飾卡片：
     點不開詳情，報名殼子又永久綁死在 e1 上，最後建單永遠寫 EV-A。
     於是「發佈了一場新賽事」在用戶這一側根本沒有落點。

     這裏只引入<b>一個</b>輕量上下文：當前選中的映射賽事。
     它<b>只</b>服務兩件事 —— <b>賽事詳情</b> 與 <b>新報名（第 1–4 步 + 建單）</b>。
     不把整個應用改造成通用多賽事框架：成績、照片、證書、領物、號碼布
     一律不動（R10）。
     ⚠️ 已經存在的訂單/付款一律讀<b>訂單自己的 eventId</b>，絕不被當前選中項改寫（R8）。 */
  var selectedRaceId = FE_EVENT;
  function selRace() { return selectedRaceId; }
  function selSharedEvent() { return sharedEventOf(selRace()); }
  /* 切換選中賽事＝換了一場比賽，正在填的那半張單必須作廢：
     組別 id、價格檔、年齡門檻全是另一場的，留着就是串場（R8）。 */
  function setSelectedRace(feId) {
    if (!feId || feId === selectedRaceId) return false;
    if (!evById(feId)) return false;
    selectedRaceId = feId;
    if (typeof resetOrder === "function") resetOrder();
    return true;
  }

  /* ⚖️ D-111 A6 · 對外展示的比賽日期與判定用的比賽日期<b>必須是同一個</b>。
     展示點有十幾處（首頁卡、列表、詳情、證書、照片頁…），與其一處處去改，
     不如在<b>源頭</b>把映射賽事的日期變成共享事實的鏡像：
     從此前端的 r.d 不再是一個獨立事實，而是共享 Event.date 的派生。
     沒有映射的演示賽事保持原樣（A3）。 */
  (function syncMappedEventDates(){
    (DEMO.events || []).forEach(function (r) {
      var d = sharedEventDate(r.id);
      if (!d) return;                                  /* 未映射：保留裝飾日期 */
      r.d = d.replace(/-/g, ".");                      /* 展示格式 YYYY.MM.DD，底層同一個事實 */
      r.iso = d;
    });
    /* 靜態模板裏那幾句寫死的「9 月 20 日」同樣是<b>對外聲明的比賽日期</b>，
       不能與判定用的日期打架（A6）。一併回填。 */
    var iso = sharedEventDate(FE_EVENT);
    if (!iso) return;
    var dt = new Date(iso + "T00:00:00");
    var WD = ["週日","週一","週二","週三","週四","週五","週六"];
    var md = (dt.getMonth() + 1) + " 月 " + dt.getDate() + " 日";
    var full = dt.getFullYear() + " 年 " + md + "（" + WD[dt.getDay()] + "）";
    var set = function (id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; };
    set("ev-date-hero", full);
    set("ev-date-reg", md);
    set("ev-date-pay", md);
  })();

  function domCats() {
    var evId = RD.adminEventId(selRace());
    var ev = evId ? RD.eventById(evId) : null;
    return ev ? ev.categories : [];
  }
  /* ⚖️ D-121 R3 · 組別列表來自<b>當前選中的共享賽事</b>，不再永久取 EV-A。
     EV-B 的組別沒有 feId / feName / feDist 這些純前端字段 —— 那就用共享
     Category 自己的 id / name 兜底，<b>不爲了 Demo 去新增一個 Category 模型</b>。
     也絕不因爲 e3 那張老卡片上寫着「10K / 21K」就給 EV-B 編一個 21K 出來：
     共享業務事實說了算。 */
  function CATS_LIVE() {
    var evId = RD.adminEventId(selRace());
    var out = domCats().map(function (c) {
      return { id: c.feId || c.id, n: c.feName || c.name, d: c.feDist || "",
               adminId: c.id, minAge: c.minAge || 0,
               left: RD.capacityLeft(evId, c.id) };
    });
    /* 「親子跑 2 km」是本屆演示賽事卡片上那個沒有價格的裝飾項（Price TBA），
       它不屬於任何共享賽事，別把它帶到別的賽事上去。 */
    if (selRace() === FE_EVENT) {
      out.push({ id: "2k", n: "親子跑", d: "2 km", adminId: null, minAge: 0, left: 0 });
    }
    return out;
  }

  /* D-085：原來掛在報名流程第 3 步的周邊 SKU 列表已移除。
     周邊商品是一期範圍（D-041），但按 D-048 它有**獨立的訂單域與獨立支付**，
     不與報名訂單混合結算——所以報名流程裏不再持有任何周邊 SKU、數量或金額。
     周邊的用戶端形態由後續獨立設計，本次不在這裏造商店。 */

  var RT = {
    start: { c: "#1583D8", n: "起終點" },
    aid:   { c: "#F0A93C", n: "補給點" },
    spot:  { c: "#3EB489", n: "景點" },
    med:   { c: "#CE4E3B", n: "醫療點" },
    time:  { c: "#12395C", n: "計時毯" }
  };

  var P21 = "M85,258 C130,262 165,240 190,212 C215,184 205,150 235,132 C268,112 310,130 340,120 C375,108 385,72 425,66 C470,59 505,85 520,120 C534,153 522,190 490,205 C455,221 415,205 385,220 C352,236 340,268 300,272 C258,276 235,252 200,255 C160,258 122,272 95,266";
  var P10 = "M85,258 C130,262 165,240 190,212 C215,184 205,150 235,132 C268,112 310,130 340,120 C372,110 390,140 372,170 C352,203 300,196 258,214 C214,233 190,258 150,262 C124,265 108,264 95,266";
  var P05 = "M85,258 C130,262 165,240 190,212 C214,186 240,182 262,196 C286,211 282,240 254,254 C222,270 170,252 132,260 C114,264 104,265 95,266";

  /* 同一場賽事，不同組別是不同的路線與點位 */
  DEMO.routes = {
    "21k": {
      label: "半程馬拉松 21.1 km", path: P21, gain: "累計爬升 18 m",
      note: "沿濱河大道跑一個大環，經過皇宮、獨立紀念碑和兩河交匯，全程平坦，適合衝個人最好成績。",
      points: [
        { n: 1, t: "start", x: 85, y: 258, ly: -18, lb: "起 / 終點", name: "起點 / 終點 · 濱河公園", km: "0 km · 21.1 km",
          d: "檢錄、存包、發槍都在這片草坪。衝線後往裏走就是完賽區：補給、拉伸、獎牌合影牆。" },
        { n: 2, t: "spot", x: 190, y: 212, ly: 27, lb: "皇宮", name: "打卡點 · 皇宮金頂", km: "1.5 km",
          d: "繞過皇宮廣場，這個點日出剛好打在金頂上，官方攝影師的第一個固定機位在左手邊。" },
        { n: 3, t: "aid", x: 235, y: 132, name: "3 號補給點", km: "3 km",
          d: "飲用水、電解質飲料。桌子擺兩側，靠左取水不用跟人搶。", sp: "由 BlueWave Sports Drink 冠名（演示）" },
        { n: 4, t: "spot", x: 340, y: 120, ly: -17, lb: "獨立紀念碑", name: "打卡點 · 獨立紀念碑", km: "5.5 km",
          d: "經過獨立紀念碑與西哈努克像，第二個官方攝影機位，也是最多人自拍的一段。" },
        { n: 5, t: "aid", x: 425, y: 66, name: "5 號補給點 + 醫療", km: "8 km",
          d: "水、香蕉、鹽丸。旁邊有醫療帳篷和噴霧降溫門，熱的話從這裏穿過去。" },
        { n: 6, t: "time", x: 520, y: 120, name: "折返 · 計時毯", km: "10.5 km",
          d: "半程折返點。計時毯記錄分段成績，沒踩到毯子的成績不作數。" },
        { n: 7, t: "spot", x: 490, y: 205, ly: 26, lb: "兩河交匯", name: "打卡點 · 兩河交匯", km: "13 km",
          d: "洞裏薩河與湄公河在這裏匯合，全程視野最好的一段，值得抬頭看一眼。" },
        { n: 8, t: "aid", x: 385, y: 220, name: "8 號補給點", km: "15.5 km",
          d: "水、電解質、能量膠。大部分人在這一段掉速，所以補給擺得最密。", sp: "由 Mekong Bib Co. 冠名（演示）" },
        { n: 9, t: "med", x: 300, y: 272, name: "醫療點", km: "18.5 km",
          d: "隨隊醫生與救護車待命，配 AED。跑不動了在這裏上收容車，不影響完賽記錄的補錄。" }
      ]
    },
    "10k": {
      label: "健康跑 10 km", path: P10, gain: "累計爬升 9 m",
      note: "半馬路線的內圈，同樣經過皇宮和獨立紀念碑，在第 6 公里折返，1.5 小時關門。",
      points: [
        { n: 1, t: "start", x: 85, y: 258, ly: -18, lb: "起 / 終點", name: "起點 / 終點 · 濱河公園", km: "0 km · 10 km",
          d: "和半馬共用同一個起終點，10K 在半馬發槍後 15 分鐘出發。" },
        { n: 2, t: "spot", x: 190, y: 212, ly: 27, lb: "皇宮", name: "打卡點 · 皇宮金頂", km: "1.5 km",
          d: "官方攝影師第一個固定機位，10K 和半馬在這裏是同一段路。" },
        { n: 3, t: "aid", x: 235, y: 132, name: "3 號補給點", km: "3 km",
          d: "飲用水、電解質飲料，與半馬共用。", sp: "由 BlueWave Sports Drink 冠名（演示）" },
        { n: 4, t: "spot", x: 340, y: 120, ly: -17, lb: "獨立紀念碑", name: "打卡點 · 獨立紀念碑", km: "5 km",
          d: "第二個官方攝影機位，10K 組在這之後就折返了。" },
        { n: 5, t: "time", x: 372, y: 170, name: "折返 · 計時毯", km: "6 km",
          d: "10K 組折返點，獨立計時毯。走錯折返口成績不作數，現場有人舉牌。" },
        { n: 6, t: "aid", x: 258, y: 214, name: "6 號補給點 + 醫療", km: "8 km",
          d: "水與香蕉，旁邊是醫療點。10K 組唯一的回程補給。" },
        { n: 7, t: "med", x: 150, y: 262, name: "醫療點", km: "9 km", d: "最後一公里的醫療點，配 AED 與收容車。" }
      ]
    },
    "5k": {
      label: "歡樂跑 5 km", path: P05, gain: "全程平坦",
      note: "最短的一組，沿濱河公園與皇宮廣場跑一個小圈，1 小時關門，走完也能拿完賽牌。",
      points: [
        { n: 1, t: "start", x: 85, y: 258, ly: -18, lb: "起 / 終點", name: "起點 / 終點 · 濱河公園", km: "0 km · 5 km",
          d: "5K 最後出發，人最多。終點衝線後直接進完賽區領獎牌。" },
        { n: 2, t: "spot", x: 190, y: 212, ly: 27, lb: "皇宮", name: "打卡點 · 皇宮金頂", km: "1.5 km",
          d: "5K 組唯一的官方攝影機位，想拍照的話這裏放慢一點。" },
        { n: 3, t: "aid", x: 262, y: 196, name: "3 號補給點", km: "2.5 km",
          d: "飲用水。5K 組只設一個補給點，天熱建議在這裏喝一杯再走。", sp: "由 BlueWave Sports Drink 冠名（演示）" },
        { n: 4, t: "time", x: 254, y: 254, name: "折返 · 計時毯", km: "3 km", d: "5K 組折返點。" },
        { n: 5, t: "med", x: 132, y: 260, name: "醫療點", km: "4.2 km", d: "親子跑與 5K 共用的醫療點，隨隊醫生在這裏。" }
      ]
    }
  };

  /* ---- 照片（演示） ---- */
  DEMO.photos = (function () {
    var spots = [
      ["起點", "start", 0.2], ["皇宮機位", "course", 1.5], ["3 號補給點", "aid", 3],
      ["獨立紀念碑機位", "course", 5.5], ["8 號補給點", "aid", 15.5], ["終點衝線", "finish", 21.1],
      ["終點完賽區", "finish", 21.1]
    ];
    var shooters = ["Sopheak", "Ratha", "Dara", "Vichea"];
    var out = [], i, k = 0;
    for (i = 0; i < 14; i++) {
      var s = spots[i % spots.length];
      k++;
      out.push({
        id: "p" + k, ev: "e1", seed: 100 + k * 7,
        bib: [3247, 3247, 3247, 3247, 3247, 3247, 1188, 1188, 2077, 2077, 3247, 3247, 0, 0][i],
        spot: s[0], zone: s[1], km: s[2],
        time: ["05:31", "05:38", "05:52", "06:07", "07:04", "07:41", "07:43"][i % 7],
        by: shooters[i % 4],
        conf: [98, 96, 94, 91, 88, 97, 93, 90, 95, 89, 62, 47, 0, 0][i],
        blocked: i === 10 || i === 11,
        unmatched: i >= 12
      });
    }
    return out;
  })();

  /* ---- 成績（演示） ---- */
  DEMO.results = [
    { ev: "e1", bib: 3247, name: "SOK DARA", cat: "半程馬拉松 21.1 km", status: "FIN",
      gun: "2:07:44", net: "2:06:12", rank: 148, total: 1007, gRank: 121, gTotal: 742,
      aRank: 32, aTotal: 214, ageGroup: "M25-29", start: "05:30:00",
      splits: [["5 km", "29:18", "5:52/km"], ["10 km", "59:44", "6:05/km"], ["15 km", "1:30:51", "6:14/km"], ["21.1 km", "2:06:12", "5:58/km"]] },
    { ev: "e1", bib: 1188, name: "CHAN SREY", cat: "歡樂跑 5 km", status: "FIN",
      gun: "38:12", net: "37:40", rank: 96, total: 312, gRank: 21, gTotal: 158,
      aRank: 7, aTotal: 44, ageGroup: "F30-34", start: "05:45:00",
      splits: [["2.5 km", "18:44", "7:30/km"], ["5 km", "37:40", "7:32/km"]] },
    { ev: "e1", bib: 2077, name: "LIM PISETH", cat: "健康跑 10 km", status: "DNF",
      gun: "—", net: "—", rank: 0, total: 0, gRank: 0, gTotal: 0, aRank: 0, aTotal: 0,
      ageGroup: "M40-44", start: "05:45:00",
      note: "在 8 km 補給點因中暑退賽，醫療組已處理，狀況良好。",
      splits: [["5 km", "31:02", "6:12/km"], ["8 km", "51:47", "6:55/km"]] },
    { ev: "e1", bib: 4501, name: "KEO MONY", cat: "半程馬拉松 21.1 km", status: "DNS",
      gun: "—", net: "—", rank: 0, total: 0, gRank: 0, gTotal: 0, aRank: 0, aTotal: 0,
      ageGroup: "M35-39", start: "—", note: "已報名但未到起點檢錄，成績記爲 DNS。", splits: [] },
    { ev: "e1", bib: 5120, name: "NOU CHANDA", cat: "健康跑 10 km", status: "PENDING",
      gun: "—", net: "—", rank: 0, total: 0, gRank: 0, gTotal: 0, aRank: 0, aTotal: 0,
      ageGroup: "F25-29", start: "05:45:00", note: "計時芯片讀數異常，成績處理中，出成績後會通知你。", splits: [] }
  ];

  /* ================================================================
     可變演示狀態：存 localStorage，可一鍵重置
     ================================================================ */

  var STORE_KEY = "run-demo-v3";
  var SCHEMA = 8;

  function freshStore() {
    return {
      schemaVersion: SCHEMA,
      regs: [
        { id: "r0", ev: "e5", kind: "paid", cat: "健康跑 10 km", bib: 1042,
          code: "RUN26NR1042", status: "finished", paid: 12, at: "2026.08.30" }
      ],
      seatDelta: {},
      claims: [],          // 已認領 / 已購買 / 免費領取的照片
      notMine: [],         // 標記「不是我的」
      delReq: [],          // 申請刪除
      coupons: [],         // 領到的券
      shares: 0,
      authz: { shoot: true, promo: true, ai: true },
      scenario: "default",
      selfiePreview: false,
      posts: [],           // 我發佈的跑友活動（含免責聲明留痕）
      joins: [],           // 我報名的跑友活動
      reports: [],         // 我舉報過的活動
      frozen: [],          // 被平臺緊急凍結的活動 id
      views: [],           // 聯繫方式查看留痕（演示級，正式需服務端記錄）
      banner: { impr: 0, click: 0 },   // 首頁 Banner 曝光 / 點擊

      /* ---- v5 ---- */
      account: { claimed: false, phone: "" },   // 遊客報名後的賬號認領狀態
      bibOps: [],        // 號碼布運營流水：分配 / 預留 / 作廢 / 換號（只追加，不覆蓋）
      /* D-100 B6 · packs 已退役：領物是否完成的唯一權威在共享域 RacePackFact。
         這裏只保留離線<b>運輸</b>隊列與一份同步結果提示。 */
      packQueue: [],     // 離線模式下待同步的核銷記錄（transport only，唯一鍵 regId）
      syncReport: null,  // 上一次同步的結果提示（純展示）
      legacyRacePackAdopted: true,  // 新裝無歷史可收編（D-102）
      phase: "open",     // 賽事階段：open 報名中 / closed 報名已截止·領物期 / post 賽後
      packs: [],         // 退役字段：領物是否完成的權威在共享域 RacePackFact
      idChecked: [],     // 退役字段：覈驗事實已上移到共享域，保留僅爲老存檔兼容
      net: "online",     // 工作臺網絡狀態（演示）
      device: "A",       // 當前工作臺設備（演示）

      // 上下文：刷新後能恢復到一個有效狀態，而不是白屏
      ctx: { screen: "home", freeEv: "f1", photo: null, phEvent: "e1", phBib: 3247,
             phMode: "bib", resBib: null, meTab: "races", rmGroup: "21k", ugc: "g1", selRace: "e1",
             reEvent: "h0", reDist: "21K", reBoard: "all", prUid: null,
             rpEv: "e1", bmEv: "e1" }
    };
  }

  /* 任何髒數據都必須能被收斂回一個可用狀態：缺字段補默認、類型不對換默認、
     數值異常歸零、引用不存在的對象直接丟掉。演示原型不允許因爲舊數據白屏。 */
  function sanitize(o) {
    var base = freshStore();
    if (!o || typeof o !== "object" || Array.isArray(o)) return base;
    if (o.schemaVersion !== SCHEMA) return base;   // v2 或未來版本一律重建

    function num(v, d, min) {
      var n = Number(v);
      if (!isFinite(n) || isNaN(n)) return d;
      if (min != null && n < min) return d;
      return n;
    }
    function arr(v) { return Array.isArray(v) ? v : []; }
    function obj(v) { return (v && typeof v === "object" && !Array.isArray(v)) ? v : {}; }

    var out = {
      schemaVersion: SCHEMA,
      regs: arr(o.regs).filter(function (r) {
        return r && typeof r === "object" && typeof r.ev === "string" && evById(r.ev) &&
          ["registered", "waitlist", "cancelled", "finished", "unpaid"].indexOf(r.status) >= 0;
      }).map(function (r) {
        return { id: String(r.id || ("r" + Math.abs(num(r.bib, 0)))), ev: r.ev,
          kind: r.kind === "free" ? "free" : "paid", status: r.status,
          domainId: typeof r.domainId === "string" ? r.domainId : null,
          cat: String(r.cat || "—"), code: String(r.code || "—"),
          bib: r.bib, paid: num(r.paid, 0, 0), at: String(r.at || "—"),
          domainId: typeof r.domainId === "string" ? r.domainId : undefined,
          parts: arr(r.parts).filter(function (x) { return x && typeof x.pid === "string"; })
            .map(function (x) {
              return { pid: x.pid, name: String(x.name || "—"), catId: String(x.catId || "5k"),
                aud: x.aud === "exp" ? "exp" : "cam", size: String(x.size || "M"),
                bib: num(x.bib, 0, 0), fee: num(x.fee, 0, 0),
                status: x.status === "cancelled" ? "cancelled" : "registered" };
            }) };
      }),
      seatDelta: {},
      claims: arr(o.claims).filter(function (c) {
        return c && photoById(c.id) && ["free", "buy", "claim"].indexOf(c.kind) >= 0;
      }),
      notMine: arr(o.notMine).filter(function (id) { return !!photoById(id); }),
      delReq: arr(o.delReq).filter(function (id) { return !!photoById(id); }),
      coupons: arr(o.coupons).filter(function (c) { return c && c.id && c.n && c.code; })
        .map(function (c) { return { id: c.id, n: c.n, code: c.code, exp: c.exp || "—", used: !!c.used }; }),
      shares: num(o.shares, 0, 0),
      authz: { shoot: obj(o.authz).shoot !== false, promo: obj(o.authz).promo !== false,
               ai: obj(o.authz).ai !== false },
      scenario: typeof o.scenario === "string" ? o.scenario : "default",
      selfiePreview: false,     // 自拍預覽不跨會話保留

      // 跑友活動：沒有免責聲明留痕的帖子一律丟掉——這條記錄是發佈的前提，不是附屬品
      posts: arr(o.posts).filter(function (p) {
        return p && typeof p === "object" && typeof p.id === "string" && typeof p.t === "string" &&
          p.consent && typeof p.consent === "object" && typeof p.consent.recId === "string" &&
          ["reviewing", "published", "rejected", "closed"].indexOf(p.status) >= 0;
      }).map(function (p) {
        return {
          id: p.id, t: String(p.t).slice(0, 30), tag: String(p.tag || "其他"),
          by: String(p.by || DEMO.user.name), byId: String(p.byId || DEMO.user.id),
          av: String(p.av || "ME"), byNote: String(p.byNote || "演示賬號"),
          d: String(p.d || "—"), loc: String(p.loc || "—"), meet: String(p.meet || "—"),
          dist: String(p.dist || "—"), cap: Math.max(1, Math.floor(num(p.cap, 20, 1))),
          joined: Math.max(0, Math.floor(num(p.joined, 0, 0))), fee: String(p.fee || "免費"),
          imgs: arr(p.imgs).filter(function (n) { return isFinite(Number(n)); }).slice(0, 9),
          contact: { tg: String(obj(p.contact).tg || ""), ph: String(obj(p.contact).ph || "") },
          vis: p.vis === "public" ? "public" : "joined",
          body: String(p.body || "").slice(0, 1000),
          status: p.status, at: String(p.at || "—"), mine: true,
          reports: Math.max(0, Math.floor(num(p.reports, 0, 0))),
          consent: p.consent
        };
      }),
      joins: arr(o.joins).filter(function (x) { return typeof x === "string"; }),
      reports: arr(o.reports).filter(function (x) { return typeof x === "string"; }),
      frozen: arr(o.frozen).filter(function (x) { return typeof x === "string"; }),
      views: arr(o.views).filter(function (v) {
        return v && typeof v.act === "string" && typeof v.at === "string" &&
          ["tg", "phone"].indexOf(v.type) >= 0;
      }).map(function (v) {
        return { act: v.act, user: String(v.user || "u1"), at: v.at, type: v.type, joined: v.joined !== false };
      }).slice(-50),
      banner: { impr: num(obj(o.banner).impr, 0, 0), click: num(obj(o.banner).click, 0, 0) },

      /* ---- v5 ---- */
      account: { claimed: obj(o.account).claimed === true,
                 phone: String(obj(o.account).phone || "") },
      bibOps: arr(o.bibOps).filter(function (x) {
        return x && typeof x === "object" &&
          ["assign", "reserve", "void", "change"].indexOf(x.op) >= 0;
      }).map(function (x) {
        return { op: x.op, ev: String(x.ev || "e1"), rid: String(x.rid || ""),
          from: num(x.from, 0, 0), to: num(x.to, 0, 0), reason: String(x.reason || "—"),
          by: String(x.by || "Staff A"), at: String(x.at || "—") };
      }).slice(-80),
      /* ⚖️ D-102 F-003 · 離線待同步隊列的<b>唯一業務鍵是 regId</b>。
         入隊、落盤、清洗、渲染、重連同步、同步後清除，全部認同一個鍵。
         這裏以前只認舊的 rid，於是新寫的 {regId} 行一刷新就被整條丟掉 ——
         包已經交出去了，共享事實卻還說沒發，後臺還能再發一次。
         現在兩種形態都收，但<b>歸一化成 regId 這一種</b>存回去。 */
      packQueue: arr(o.packQueue).map(function (x) {
        if (!x || typeof x !== "object") return null;
        var key = (typeof x.regId === "string" && x.regId) ? x.regId : x.rid;
        var regId = RD.resolveLegacyRegId(key);
        if (!regId) return null;                 /* 映射不出來的髒數據：丟掉，絕不張冠李戴 */
        var row = { regId: regId, at: String(x.at || "—"),
                    device: String(x.device || x.dev || "A"),
                    by: String(x.by || ("Staff " + (x.device || x.dev || "A"))) };
        if (x.blocked === true) { row.blocked = true; row.why = String(x.why || "同步被當前事實拒絕"); }
        return row;
      }).filter(Boolean).filter(function (row, i, all) {
        /* 同一個 regId 只保留一條待同步：反覆刷新不該變成多條待辦 */
        return all.findIndex(function (y) { return y.regId === row.regId; }) === i;
      }),
      phase: ["open", "closed", "post"].indexOf(o.phase) >= 0 ? o.phase : "open",
      /* 這兩個是<b>退役</b>字段：真正的權威在共享域 RacePackFact。
         留在這裏只爲把老存檔裏的歷史事實讀出來交給共享域收編（見下方 adopt），
         收編完就清空，絕不再參與任何當前業務判定。 */
      packs: [],
      idChecked: [],
      legacyRacePackAdopted: o.legacyRacePackAdopted === true,
      net: o.net === "offline" ? "offline" : "online",
      device: ["A", "B", "C"].indexOf(o.device) >= 0 ? o.device : "A",

      ctx: (function () {
        var c = obj(o.ctx), b = base.ctx;
        return {
          screen: typeof c.screen === "string" ? c.screen : b.screen,
          freeEv: evById(c.freeEv) ? c.freeEv : b.freeEv,
          photo: photoById(c.photo) ? c.photo : null,
          phEvent: evById(c.phEvent) ? c.phEvent : b.phEvent,
          phBib: num(c.phBib, b.phBib, 0),
          phMode: ["bib", "selfie", "all", "unmatched"].indexOf(c.phMode) >= 0 ? c.phMode : b.phMode,
          resBib: num(c.resBib, 0, 0) || null,
          meTab: ["races", "history", "posts", "photos", "coupons", "profile"].indexOf(c.meTab) >= 0 ? c.meTab : b.meTab,
          rmGroup: ["5k", "10k", "21k"].indexOf(c.rmGroup) >= 0 ? c.rmGroup : b.rmGroup,
          /* D-121 · 選中賽事只認真實存在的映射賽事，髒值一律回落到本屆 */
          selRace: evById(c.selRace) ? c.selRace : "e1",
          ugc: typeof c.ugc === "string" ? c.ugc : b.ugc,
          reEvent: typeof c.reEvent === "string" ? c.reEvent : b.reEvent,
          reDist: typeof c.reDist === "string" ? c.reDist : b.reDist,
          reBoard: ["all", "gender", "cat", "age"].indexOf(c.reBoard) >= 0 ? c.reBoard : b.reBoard,
          prUid: typeof c.prUid === "string" ? c.prUid : null,
          rpEv: typeof c.rpEv === "string" ? c.rpEv : b.rpEv,
          bmEv: typeof c.bmEv === "string" ? c.bmEv : b.bmEv
        };
      })()
    };

    // 名額增減：必須是非負整數，且不超過該賽事總名額
    var sd = obj(o.seatDelta);
    for (var k in sd) {
      var ev = evById(k);
      if (!ev) continue;
      var v = Math.floor(num(sd[k], 0, 0));
      out.seatDelta[k] = Math.min(v, ev.left);
    }
    // 同一場賽事不允許有兩條“生效中”的報名（防重複報名）
    var seen = {};
    out.regs = out.regs.filter(function (r) {
      if (r.status === "cancelled") return true;
      var key = r.ev + "|" + r.kind;
      if (seen[key]) return false;
      seen[key] = 1; return true;
    });
    // 同一張照片只能有一條認領記錄
    var seenP = {};
    out.claims = out.claims.filter(function (c) {
      if (seenP[c.id]) return false; seenP[c.id] = 1; return true;
    });
    var seenC = {};
    out.coupons = out.coupons.filter(function (c) {
      if (seenC[c.id]) return false; seenC[c.id] = 1; return true;
    });

    /* ⚖️ D-102 F-003 兼容收口 · 把升級前存在工作人員端本地的<b>歷史</b>領物事實
       （S.packs 已發包 / S.idChecked 已覈驗）收編進共享域的唯一權威表。
       不收編就會出現「工作人員端歷史說領過、後臺說沒領 → 後臺還能再發一次」。
       映射一律走共享域的確定性解析（reg:OP-21 → OP-21 → REG-21）；
       映射不出來的髒數據直接忽略，<b>絕不</b>爲此給另一個人造出領物記錄。
       收編本身是冪等且單調的（已 true 不動、永不 true → false），
       而且<b>不寫 Audit</b> —— 否則每刷新一次就多一條流水。 */
    if (!out.legacyRacePackAdopted) {
      var adopted = true;
      try {
        var legacyPicked = arr(o.packs).map(function (x) {
          if (!x || typeof x !== "object") return null;
          var regId = RD.resolveLegacyRegId(x.regId || x.rid);
          if (!regId) return null;
          return { regId: regId, at: x.at || null,
                   by: x.by || (x.dev ? "Staff " + x.dev : null),
                   device: x.dev || x.device || null, offline: x.off === true };
        }).filter(Boolean);
        var legacyVerified = arr(o.idChecked).map(function (k) {
          return RD.resolveLegacyRegId(k);
        }).filter(Boolean);
        if (legacyPicked.length || legacyVerified.length) {
          RD.load();
          /* ⚖️ D-104 · 落盤由收編自己負責：檢查點必須和事實同一次寫進磁盤。
             它已經遷移過就直接跳過，不再有權改動當前事實。 */
          var mig = RD.adoptLegacyRacePackFacts({ picked: legacyPicked, verified: legacyVerified });
          /* Rule 4 · 只有共享側確實落盤成功，本地纔敢把這批歷史退役；
             失敗就把標記留在 false，下次加載重試，絕不丟掉合法的歷史領物記錄。 */
          if (mig && mig.ok === false) adopted = false;
        }
      } catch (e) { adopted = false; /* 兼容步驟失敗不允許白屏，但也不許假裝成功 */ }
      out.legacyRacePackAdopted = adopted;
      if (!adopted) {
        /* 沒遷移成功就<b>原樣留着</b>這批歷史，下次加載再試 */
        out.packs = arr(o.packs);
        out.idChecked = arr(o.idChecked);
      }
    }
    return out;
  }

  var S = (function () {
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }
    if (!raw) return freshStore();
    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      try { localStorage.removeItem(STORE_KEY); } catch (e2) {}
      return freshStore();
    }
    try {
      var clean = sanitize(parsed);
      /* ⚖️ D-104 Rule 3 · 清洗結果<b>必須馬上落盤</b>。
         以前只在內存裏改（歷史已退役、隊列已歸一化、遷移標記已置位），
         磁盤上卻還是老樣子；於是下一次刷新又把同一批舊數據重放一遍。
         磁盤狀態不允許和內存狀態長期不一致。 */
      try { localStorage.setItem(STORE_KEY, JSON.stringify(clean)); } catch (e2) {}
      return clean;
    }
    catch (e) {
      try { localStorage.removeItem(STORE_KEY); } catch (e2) {}
      return freshStore();
    }
  })();

  // 清掉更早版本可能留下的 key，避免舊數據干擾
  try {
    ["run-demo", "run-demo-v1", "run-demo-v2"].forEach(function (k) { localStorage.removeItem(k); });
  } catch (e) {}

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) {}
  }

  function resetDemo() {
    clearAllTimers();
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    /* 共享業務域（含參賽者姓名 / 電話 / 證件號）與評論 / 故事一起清掉，重置後設備上不留 PII */
    try { if (window.RUNDomain && typeof RUNDomain.reset === "function") RUNDomain.reset(); } catch (e) {}
    ["run-demo-domain-v1", "werun_event_comments", "werun_stories"].forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) {}
    });
    S = freshStore();
    try { location.hash = ""; } catch (e) {}
    location.reload();
  }

  /* ---------------- state ---------------- */

  var state = { cat: null, discount: 0, code: "" };   /* D-085：不再持有周邊選購與周邊尺碼 */

  /* ---------------- helpers ---------------- */

  function $(id) { return document.getElementById(id); }
  function money(n) { return "$" + n.toFixed(2); }

  // deterministic pseudo-random so art is stable across renders
  function rng(seed) {
    var s = seed * 9301 + 49297;
    return function () { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  }

  /* ---------------- generative art ---------------- */

  function cloud(c, x, y, s, alpha) {
    c.save();
    c.fillStyle = "rgba(255,255,255," + alpha + ")";
    var puffs = [[0, 0, 1], [-0.95, 0.28, .66], [0.98, 0.24, .7], [-0.36, -0.42, .68], [0.44, -0.34, .6]];
    for (var i = 0; i < puffs.length; i++) {
      c.beginPath();
      c.arc(x + puffs[i][0] * s, y + puffs[i][1] * s, puffs[i][2] * s, 0, Math.PI * 2);
      c.fill();
    }
    c.beginPath();
    c.ellipse(x, y + s * 0.42, s * 1.5, s * 0.42, 0, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  function paintScape(cv, seed) {
    var w = cv.clientWidth || 400, h = cv.clientHeight || 160;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = w * dpr; cv.height = h * dpr;
    var c = cv.getContext("2d");
    c.scale(dpr, dpr);
    var r = rng(seed);

    // 天空
    var g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#6FC1F2");
    g.addColorStop(0.55, "#B6E1FA");
    g.addColorStop(1, "#EAF7FE");
    c.fillStyle = g; c.fillRect(0, 0, w, h);

    // 太陽
    var sx = w * (0.1 + r() * 0.24), sy = h * (0.16 + r() * 0.14);
    var sg = c.createRadialGradient(sx, sy, 0, sx, sy, h * 0.72);
    sg.addColorStop(0, "rgba(255,214,128,.6)");
    sg.addColorStop(1, "rgba(255,214,128,0)");
    c.fillStyle = sg; c.fillRect(0, 0, w, h);
    c.beginPath(); c.arc(sx, sy, h * 0.085, 0, Math.PI * 2);
    c.fillStyle = "rgba(255,235,180,.95)"; c.fill();

    // 白雲
    var n = 3 + Math.floor(r() * 2);
    for (var i = 0; i < n; i++) {
      cloud(c, w * (0.08 + r() * 0.9), h * (0.12 + r() * 0.42), h * (0.055 + r() * 0.055), 0.7 + r() * 0.25);
    }

    // 遠處丘陵與草地
    var tone = ["rgba(150,216,188,.6)", "rgba(108,196,163,.72)", "rgba(74,175,140,.9)"];
    for (var L = 0; L < 3; L++) {
      c.beginPath(); c.moveTo(0, h);
      var base = h * (0.74 + L * 0.09), amp = h * (0.075 - L * 0.018);
      for (var x = 0; x <= w; x += 6) {
        var y = base + Math.sin((x / w) * (2 + L) * Math.PI + seed + L) * amp;
        c.lineTo(x, y);
      }
      c.lineTo(w, h); c.closePath();
      c.fillStyle = tone[L];
      c.fill();
    }
    return true;
  }

  function paintProduct(cv, seed) {
    var w = cv.clientWidth || 70, h = cv.clientHeight || 70;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = w * dpr; cv.height = h * dpr;
    var c = cv.getContext("2d"); c.scale(dpr, dpr);
    var r = rng(seed);
    c.fillStyle = "#7FC6F3"; c.fillRect(0, 0, w, h);
    c.globalAlpha = 0.6;
    for (var i = 0; i < 5; i++) {
      c.beginPath();
      c.arc(w * r(), h * r(), (0.18 + r() * 0.3) * w, 0, Math.PI * 2);
      c.fillStyle = ["#1583D8", "#FFFFFF", "#F0A93C"][i % 3];
      c.fill();
    }
    c.globalAlpha = 1;
  }

  // QR-like matrix (visual placeholder, encodes nothing)
  function paintQR(cv, seed) {
    var size = 33, box = cv.clientWidth || 180;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.width = box * dpr; cv.height = box * dpr;
    var c = cv.getContext("2d"); c.scale(dpr, dpr);
    var u = box / size;
    var r = rng(seed);

    c.fillStyle = "#fff"; c.fillRect(0, 0, box, box);
    c.fillStyle = "#12293F";

    var grid = [];
    for (var y = 0; y < size; y++) { grid[y] = []; for (var x = 0; x < size; x++) grid[y][x] = 0; }

    function finder(ox, oy) {
      for (var y = 0; y < 7; y++) for (var x = 0; x < 7; x++) {
        var edge = (x === 0 || x === 6 || y === 0 || y === 6);
        var core = (x >= 2 && x <= 4 && y >= 2 && y <= 4);
        grid[oy + y][ox + x] = (edge || core) ? 1 : 0;
      }
    }
    finder(0, 0); finder(size - 7, 0); finder(0, size - 7);

    function inFinder(x, y) {
      return (x < 8 && y < 8) || (x >= size - 8 && y < 8) || (x < 8 && y >= size - 8);
    }
    for (var y2 = 0; y2 < size; y2++)
      for (var x2 = 0; x2 < size; x2++)
        if (!inFinder(x2, y2)) grid[y2][x2] = r() > 0.52 ? 1 : 0;

    // timing lines
    for (var t = 8; t < size - 8; t++) { grid[6][t] = t % 2 === 0 ? 1 : 0; grid[t][6] = t % 2 === 0 ? 1 : 0; }

    for (var yy = 0; yy < size; yy++)
      for (var xx = 0; xx < size; xx++)
        if (grid[yy][xx]) c.fillRect(xx * u, yy * u, u + 0.4, u + 0.4);
  }

  function paintAll(root) {
    /* 只畫當前可見屏幕裏的畫布（隱藏屏尺寸爲 0，畫了也是白畫）；換屏時由 go() 再爲那一屏調用一次 */
    root = (root && root.querySelectorAll) ? root : (document.querySelector(".screen.on") || document);
    root.querySelectorAll("canvas[data-art]").forEach(function (cv) {
      var k = cv.getAttribute("data-art");
      if (!k) return;
      if (k === "hero") paintScape(cv, 7);
      else if (k === "detail") paintScape(cv, 11);
      else if (k === "detail2") paintScape(cv, 23);
      else if (k.indexOf("qr") === 0) {
        var qs = 19;
        if (k === "qr-pay") qs = 5;
        else if (k === "qr-free") qs = 31;
        else if (k.indexOf("qr-bib-") === 0) qs = 61 + (parseInt(k.slice(7), 10) || 0);
        else if (k.indexOf("qr-pass-") === 0) qs = 19 + (parseInt(k.slice(8), 10) || 0) * 3;
        paintQR(cv, qs);
      }
      else if (k.indexOf("race-") === 0) paintScape(cv, parseInt(k.slice(5), 10));
      else if (k.indexOf("prod-") === 0) paintProduct(cv, parseInt(k.slice(5), 10));
    });
    root.querySelectorAll("canvas[data-photo]").forEach(function (cv) {
      var p = photoById(cv.getAttribute("data-photo"));
      if (p) paintPhoto(cv, p.seed, { bib: p.bib, blocked: p.blocked });
    });
    root.querySelectorAll("canvas[data-photo-big]").forEach(function (cv) {
      var p = photoById(cv.getAttribute("data-photo-big"));
      if (p) paintPhoto(cv, p.seed, { bib: p.bib, blocked: p.blocked, ratio: 0.66 });
    });
    var cert = root.querySelector("canvas[data-cert]");
    if (cert && curRes) paintCert(cert, curRes, evById(curRes.ev));
  }

  /* ---------------- 賽道路線圖 ---------------- */

  var NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
    return e;
  }

  var rmGroup = "21k";
  function ROUTE() { return DEMO.routes[rmGroup].points; }

  function pickPoint(n) {
    var pts = ROUTE(), p = null, i;
    for (i = 0; i < pts.length; i++) if (pts[i].n === n) p = pts[i];
    if (!p) return;

    document.querySelectorAll(".rm-pin").forEach(function (g) {
      g.classList.toggle("on", g.getAttribute("data-n") === String(n));
    });
    document.querySelectorAll(".rm-chip").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-n") === String(n));
    });

    var col = RT[p.t].c;
    $("rm-detail").innerHTML =
      '<div class="rm-num" style="background:' + col + '">' + p.n + '</div>' +
      '<div><h4>' + p.name + '<span class="rm-km">' + p.km + '</span></h4>' +
      '<p>' + p.d + '</p>' +
      (p.sp ? '<span class="rm-spon adslot" data-ad="廣告位 · 點位冠名">' + p.sp + '</span>' : '') +
      '</div>';
    syncAdTags();
  }

  function renderRoute(group) {
    if (group) rmGroup = group;
    var conf = DEMO.routes[rmGroup];
    var pins = document.getElementById("rm-pins");
    var strip = $("rm-strip");
    if (!pins || !strip) return;

    $("rm-path").setAttribute("d", conf.path);
    $("rm-path2").setAttribute("d", conf.path);
    $("rm-note").textContent = conf.note;
    $("rm-gain").textContent = conf.gain + " · 示意圖，非精確比例";

    pins.innerHTML = "";
    strip.innerHTML = "";

    var seg = $("rm-seg");
    if (seg && !seg.dataset.built) {
      seg.dataset.built = "1";
      ["5k", "10k", "21k"].forEach(function (g) {
        var b = document.createElement("button");
        b.textContent = { "5k": "5 km", "10k": "10 km", "21k": "21.1 km" }[g];
        b.setAttribute("data-g", g);
        b.addEventListener("click", function () { renderRoute(g); });
        seg.appendChild(b);
      });
    }
    if (seg) {
      seg.querySelectorAll("button").forEach(function (b) {
        b.classList.toggle("on", b.getAttribute("data-g") === rmGroup);
      });
    }

    conf.points.forEach(function (p) {
      var col = RT[p.t].c;
      var g = svgEl("g", { "class": "rm-pin", "data-n": p.n, tabindex: "0", role: "button" });
      g.appendChild(svgEl("circle", { "class": "halo", cx: p.x, cy: p.y, r: 15 }));
      g.appendChild(svgEl("circle", { "class": "body", cx: p.x, cy: p.y, r: 9, fill: col, stroke: "#fff", "stroke-width": 2.5 }));
      var t = svgEl("text", { x: p.x, y: p.y + 3.2, "text-anchor": "middle" });
      t.textContent = p.n;
      g.appendChild(t);
      if (p.lb) {
        var lt = svgEl("text", { "class": "rm-label", x: p.x, y: p.y + p.ly, "text-anchor": "middle" });
        lt.textContent = p.lb;
        g.appendChild(lt);
      }
      g.addEventListener("click", function () { pickPoint(p.n); });
      g.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickPoint(p.n); }
      });
      pins.appendChild(g);

      var chip = document.createElement("button");
      chip.className = "rm-chip";
      chip.setAttribute("data-n", p.n);
      chip.innerHTML = '<i style="background:' + col + '"></i>' + p.km.split(" ·")[0] + ' · ' + RT[p.t].n;
      chip.addEventListener("click", function () { pickPoint(p.n); });
      strip.appendChild(chip);
    });

    pickPoint(conf.points[2] ? conf.points[2].n : conf.points[0].n);
  }

  /* ---------------- 廣告位標註 ---------------- */

  var adTagsOn = false;
  function syncAdTags() {
    document.querySelectorAll(".adslot").forEach(function (el) {
      el.classList.toggle("tagged", adTagsOn);
    });
  }

  /* ---------------- router ---------------- */

  var SCREENS = ["home", "races", "detail", "reg1", "reg2", "reg4", "pay", "done",
    "freedetail", "freereg", "freedone", "photos", "photores", "photo",
    "results", "result", "me", "dash",
    "post", "postdone", "ugc", "about", "rules",
    /* v5 */ "history", "resultev", "presult", "racepack", "bibmgmt", "faq", "contact",
    "terms", "privacy", "security", "refund", /* v5.1 */ "acts", "staff",
    /* D-092 · 報名詳情 + 獨立的周邊商品鏈路（與報名流程完全分開） */
    "regdetail", "shop", "shopitem", "moconfirm", "mopay", "modone", "moorders", "moorder"];

  // 進入某一頁之前，先確認這一頁需要的上下文還在；不在就退到最近的安全頁
  function guard(name) {
    if (SCREENS.indexOf(name) < 0) return "home";
    /* ⚖️ D-117 A2 · 報名開關關着時，不能從這個賽事<b>開始</b>一段新的結賬。
       詳情頁的按鈕已經變成「報名已暫停」，但入口不止那一個：URL hash、
       原型面板、「上一步」都能直接落到 reg1。所以在路由這一層統一擋住。
       ⚠️ 擋的是<b>新報名</b>：pay / done / 我的訂單一律不擋 ——
       開關關上之前就已經存在的那張單必須照常走完（D-033）。
       真正的寫入邊界仍然在共享域的 createRegistrationOrder()，這裏只是不讓人白走一趟。 */
    /* ⚖️ D-121 R9 · 還是 DRAFT 的映射賽事<b>根本還沒對外存在</b>：
       就算靠 URL / 陳舊上下文摸到詳情頁，也要退回賽事列表。
       ⚠️ 只攔 DRAFT。「已發佈但隱藏公開展示」仍然可達 —— 那是 D-117 A6
       明確保住的：藏起來不等於取消，已報名的人必須還能進來看自己的賽事。 */
    if (name === "detail" && sharedEventOf(selRace()) && !sharedPublished(selRace())) {
      later(function () { toast("這場賽事尚未發佈，暫時看不到詳情。"); }, 0);
      return "races";
    }
    if (["reg1", "reg2", "reg4"].indexOf(name) >= 0 && !regSwitchOpen(selRace())) {
      later(function () { toast("主辦方已暫停接受新報名，無法開始新的報名。已報名的訂單不受影響。"); }, 0);
      return "detail";
    }
    if (name === "freedetail" || name === "freereg" || name === "freedone") {
      if (!evById(curFree)) curFree = "f1";
      if (name === "freedone" && !lastFreeReg &&
          !S.regs.some(function (r) { return r.kind === "free" && r.status === "registered"; })) return "freedetail";
    }
    if (name === "photo" && !photoById(curPhoto)) {
      if (phCtx.list && phCtx.list.length) curPhoto = phCtx.list[0].id;
      else return "photores";
    }
    if (name === "photores" && (!phCtx.list || !phCtx.list.length) && phCtx.mode !== "bib" && phCtx.mode !== "selfie") {
      search__silent();
    }
    if (name === "result" && !curRes) return "results";
    if (name === "presult" && !curPerma) {
      curPerma = board("h0", "10K").filter(function (r) { return r.bib === 1001; })[0] || null;
      if (!curPerma) return "results";
    }
    if (name === "ugc" && !ugcById(curUgc)) {
      var lst = allUgc();
      if (!lst.length) return "home";
      curUgc = lst[0].id;
    }
    if (name === "postdone" && !lastPost) return "post";
    return name;
  }

  var navLock = false;

  function go(name, fromHash) {
    // me-photos / me-profile 之類：切到個人中心的某個頁籤
    var meTabJump = null;
    if (typeof name !== "string") name = "home";
    if (name.indexOf("me-") === 0) { meTabJump = name.slice(3); name = "me"; }
    name = guard(name);

    /* 切屏時先對一次賬：渲染出去的必須是<b>結算之後</b>的真實狀態（D-111 C3） */
    if (typeof reconcileMerchDeadlines === "function") {
      reconcileMerchDeadlines();
      scheduleMerchDeadlineSweep();
    }
    cancelSim();
    closeModals();

    document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("on"); });
    var el = $("s-" + name);
    if (el) {
      el.classList.add("on");
      if (LANG !== "zh") translateDOMTree(el, LANG);
    }
    window.scrollTo(0, 0);

    S.ctx.screen = name;
    if (meTabJump) S.ctx.meTab = meTabJump;
    S.ctx.freeEv = curFree;
    S.ctx.photo = curPhoto;
    S.ctx.phEvent = phEvent;
    S.ctx.phBib = phCtx.bib;
    S.ctx.phMode = phCtx.mode;
    S.ctx.resBib = curRes ? curRes.bib : null;
    S.ctx.rmGroup = rmGroup;
    S.ctx.selRace = selectedRaceId;          /* D-121 · 刷新後仍然停在同一場賽事 */
    S.ctx.ugc = curUgc;
    S.ctx.reEvent = reCtx.hid;
    S.ctx.reDist = reCtx.dist;
    S.ctx.reBoard = reCtx.board;
    S.ctx.prUid = (curPerma && curPerma.uid) || null;
    save();

    if (!fromHash) {
      navLock = true;
      try { location.hash = "#/" + name; } catch (e) {}
      later(function () { navLock = false; }, 0);
    }

    document.querySelectorAll("#proto-panel button").forEach(function (b) {
      b.classList.toggle("cur", b.getAttribute("data-go") === name);
    });
    $("proto-panel").classList.remove("open");

    if (name === "reg4") renderSummary();
    if (name === "pay") startPay();
    else stopPay();
    /* ⚖️ D-098 A2 · 必須<b>先</b>確認支付（PENDING_PAYMENT → PAID，
       Registration PENDING → CONFIRMED），<b>再</b>渲染參賽憑證。
       順序反了的話，憑證讀到的還是那一刻的 PENDING，會把剛付完款的人
       顯示成「已取消 · 憑證已失效」。 */
    if (name === "done") { if (!curCred) recordPaidReg(); fillPass(); }
    if (name !== "done") curCred = null;

    if (name === "freedetail") renderFreeDetail();
    if (name === "freereg") renderFreeReg();
    if (name === "freedone") renderFreeDone();
    if (name === "photos") renderPhotoHome();
    if (name === "photores") renderPhotoRes();
    if (name === "photo") renderPhotoDetail();
    if (name === "results") renderResultsHome2();
    if (name === "history") renderHistory();
    if (name === "resultev") renderResultEvent();
    if (name === "presult") renderPerma();
    if (name === "racepack") renderRacePack();
    if (name === "bibmgmt") renderBibMgmt();
    if (name === "faq") renderFaq();
    if (name === "contact") renderContact();
    if (POL[name]) renderPolicy(name);
    if (name === "acts") renderActs();
    if (name === "staff") renderStaffPortal();
    if (name === "detail") { renderDetailSide(); renderEventInfo(); }
    if (name === "reg1") renderParts();
    if (name === "reg2") renderPartDetails();
    if (name === "result") renderResultDetail();
    if (name === "me") renderMe(meTabJump || meTab);
    if (name === "dash") renderDash();
    if (name === "post") renderPostForm();
    if (name === "postdone") renderPostDone();
    if (name === "ugc") renderUgcDetail();
    /* D-092 */
    if (name === "regdetail") renderRegDetail();
    if (name === "shop") renderShop();
    if (name === "shopitem") renderShopItem();
    if (name === "moconfirm") renderMoConfirm();
    if (name === "mopay") renderMoPay();
    if (name === "modone") renderMoDone();
    if (name === "moorders") renderMoOrders();
    if (name === "moorder") renderMoOrder();

    document.body.classList.toggle("staff-mode",
      name === "racepack" || name === "bibmgmt" || name === "staff");
    syncMnav(name);
    tgSync(name);
    paintAll(document.getElementById("s-" + name));

    /* ⚖️ D-111 A2 · 容量是<b>會變的</b>業務事實：別人剛進 KHQR 佔住一個位子，
       首頁與列表這一刻就該少一個。以前這兩屏是一次性渲染的，切回來還是舊數字，
       於是「公開剩餘名額」變成了一個陳舊快照。 */
    /* D-121 R2 · 報名殼子的抬頭（賽事名 / 日期 / 城市）也必須是<b>這一場</b>的 */
    if (["detail", "reg1", "reg2", "reg4", "pay"].indexOf(name) >= 0) renderSelectedEventHead();
    if (name === "home" || name === "races" || name === "detail") renderRaceLists();
    /* ⚖️ D-117 A5 / B8 · 賽事列表這一屏有自己的篩選渲染。共享開關剛被後臺改過時
       （RD.watch 會把當前屏重新走一遍 go()），不重跑一次篩選就會留着舊結果，
       一個已經「隱藏公開展示」的賽事還掛在列表上。 */
    if (name === "races") applyRF();
    if (name === "home") startBanner(); else stopBanner();

    requestAnimationFrame(paintAll);
  }

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-go]");
    if (!t) return;
    /* ⚖️ D-121 R8 · 帶 data-race 的入口＝用戶<b>明確選了這一場</b>，先切上下文再進頁面。
       報名流程裏那些「← 返回賽事詳情」不帶這個屬性，所以不會把選中項改掉。 */
    var rid = t.getAttribute("data-race");
    if (rid) setSelectedRace(rid);
    go(t.getAttribute("data-go"));
  });

  $("proto-fab").addEventListener("click", function () {
    $("proto-panel").classList.toggle("open");
  });

  /* ---- 瀏覽器前進後退 / 直接刷新 ---- */

  function screenFromHash() {
    var h = (location.hash || "").replace(/^#\/?/, "").trim();
    return SCREENS.indexOf(h) >= 0 ? h : null;
  }

  window.addEventListener("hashchange", function () {
    if (navLock) return;
    var s = screenFromHash();
    go(s || "home", true);
  });

  /* 所有彈窗走同一個開關，避免以後新增彈窗時漏掉 Esc / 返回 / 換頁的收尾 */
  var MODALS = ["share-bg", "disc-bg", "rep-bg"];
  function closeModals() {
    var closed = false;
    MODALS.forEach(function (id) {
      var bg = $(id);
      if (bg && bg.classList.contains("on")) { bg.classList.remove("on"); closed = true; }
    });
    return closed;
  }

  // 彈窗打開時，瀏覽器返回優先關掉彈窗，而不是退出當前頁
  window.addEventListener("popstate", closeModals);

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (closeModals()) return;
    var p = $("proto-panel");
    if (p && p.classList.contains("open")) p.classList.remove("open");
  });

  /* ---------------- render: races ---------------- */

  /* ⚖️ D-121 R1 · 一張卡片<b>能不能點開詳情</b>不再看寫死的 detail 標誌：
     映射到共享賽事、並且那場賽事真的<b>已發佈且公開展示中</b>的，就能點開。
     這樣 EV-B 一被髮布，e3 立刻成爲一張正常的賽事卡；還是草稿的時候，
     它根本不會出現在發現面裏，也就談不上被點開（R9）。
     沒有映射的純展示賽事保持原樣：有 detail 標誌的纔可點。 */
  function raceOpensDetail(r) {
    if (!r) return false;
    if (sharedEventOf(r.id)) return publiclyVisible(r.id);
    return !!r.detail;
  }

  /* ⚖️ D-122 · <b>公開卡片上的業務事實同樣只能有一份。</b>
     ----------------------------------------------------------------
     D-121 之後 e3 點進去是 EV-B、報名建的是 EV-B 的單、收的是 P-STD2 的 $18。
     可那張公開卡片還印着它自己的舊裝飾事實：<code>10K / 21K</code>、
     <code>$25 起</code>、<code>即將開放</code> —— 卡片當場和它自己的詳情頁打架：
     用戶看着「21K · $25 · 即將開放」點進去，看到的是「10K / 親子 5K · $18 · 立即報名」。

     所以映射賽事的四類<b>業務</b>事實一律現取共享域：
       ① 發佈 / 報名狀態   ② 組別與距離摘要   ③ 報名價格   ④ 剩餘名額
     裝飾的東西照舊歸前端：配圖、畫布種子、三語營銷副標題、視覺風格。

     ⚠️ 一處派生，三個卡片入口（Hero / 首頁馬賽克 / 賽事列表）共用 ——
     不給 EV-B 到處打三個特例補丁（R5）。
     ⚠️ 不新增 Event 狀態：uiState 只是一個<b>派生的界面標籤</b>。
     ⚠️ 不新造價格政策：起價就是<b>現在真的報得上的那一檔裏最便宜的</b>，
     用的是共享域既有的 matchPriceRule()，與詳情頁側欄、報名流程同一條路。 */
  function mappedCardFacts(r) {
    var f = { mapped: false, seats: seatsOf(r), dist: r.dist,
              price: r.price, priceLabel: null, uiState: r.state };
    if (!r) return f;
    if (r.free) { f.uiState = "free"; return f; }
    /* 本屆演示賽事的階段（賽後 / 領物期）說的是<b>比賽本身走到哪一步</b>，
       它優先於報名開關，這條既有行爲原樣保留（R2）。 */
    if (r.id === FE_EVENT) {
      if (isPostRace()) { f.uiState = "done"; }
      else if (packOpen()) { f.uiState = "closed"; }
    }
    var evId = RD.adminEventId(r.id);
    var ev = evId ? RD.eventById(evId) : null;
    if (!ev) return f;                       /* 沒有映射的純展示賽事：保留它自己的裝飾事實 */
    f.mapped = true;

    /* ① 組別 / 距離摘要 —— 有前端短標籤就用它（21K / 10K / 5K），
       沒有的（EV-B）就用共享 Category 自己的名字。絕不編一個不存在的組別。 */
    var labels = ev.categories.map(function (c) {
      return c.feId ? String(c.feId).toUpperCase() : c.name;
    });
    if (labels.length) f.dist = labels.join(" / ");

    /* ② 起價 —— 與詳情頁側欄、報名流程同一條判定路徑：
       在<b>還有名額</b>的組別裏，取當前身份真的命中得到的最便宜的一檔。
       一檔都命中不到就不報數字，給一句中性文案（R3）。 */
    var lowest = null;
    ev.categories.forEach(function (c) {
      if (RD.capacityLeft(evId, c.id) <= 0) return;
      var m = RD.matchPriceRule(evId, c.id, feAudience("cam"));
      if (m && m.ok && (lowest === null || m.rule.price < lowest)) lowest = m.rule.price;
    });
    f.price = lowest;
    if (lowest === null) f.priceLabel = "查看報名價格";

    /* ③ 發佈 / 報名狀態。三個共享事實各自獨立，判定順序也就固定：
       還沒發佈 → 發佈了但停了報名 → 開着但沒名額 → 可以報。 */
    if (f.uiState === "done" || f.uiState === "closed") return f;   /* 階段優先 */
    if (!sharedPublished(r.id)) { f.uiState = "draft"; return f; }
    if (!regSwitchOpen(r.id))   { f.uiState = "paused"; return f; }
    f.uiState = (f.seats <= 0) ? "full" : "open";
    return f;
  }

  function raceCard(r, i) {
    var l = (typeof LANG !== "undefined" && LANG) ? LANG : "zh";
    /* D-122 · 業務事實（狀態 / 組別 / 價格 / 名額）一律來自共享域 */
    var F = mappedCardFacts(r);
    var seats = F.seats, rstate = F.uiState;
    var BADGE_I18N = {
      zh: {
        open: ["報名中", ""], low: ["名額緊張", "warn"], soon: ["即將開放", "flat"],
        full: ["已滿額", "stop"], done: ["已結束", "flat"], free: ["免費報名", "free"],
        closed: ["報名已截止", "warn"], paused: ["報名已暫停", "warn"], draft: ["尚未發佈", "flat"]
      },
      en: {
        open: ["OPEN", ""], low: ["LIMITED", "warn"], soon: ["SOON", "flat"],
        full: ["FULL", "stop"], done: ["FINISHED", "flat"], free: ["FREE", "free"],
        closed: ["CLOSED", "warn"], paused: ["PAUSED", "warn"], draft: ["DRAFT", "flat"]
      },
      km: {
        open: ["បើកចុះឈ្មោះ", ""], low: ["ជិតពេញ", "warn"], soon: ["ជិតបើក", "flat"],
        full: ["ពេញហើយ", "stop"], done: ["បញ្ចប់", "flat"], free: ["ឥតគិតថ្លៃ", "free"],
        closed: ["បិទចុះឈ្មោះ", "warn"], paused: ["ផ្អាក", "warn"], draft: ["ព្រាង", "flat"]
      }
    };
    var bMap = BADGE_I18N[l] || BADGE_I18N.zh;
    var b = bMap[rstate] || bMap.open;
    var opens = raceOpensDetail(r);
    var clickable = opens || r.free;
    var el = document.createElement(clickable ? "button" : "div");
    el.className = "race";
    if (opens) { el.setAttribute("data-go", "detail"); el.setAttribute("data-race", r.id); }
    else if (r.free) el.addEventListener("click", function () { curFree = r.id; go("freedetail"); });
    else {
      el.style.cursor = "default";
      el.setAttribute("data-todo", "這場比賽在演示模型裏只做了卡片，沒有做詳情頁。可點開的是「金邊濱河半程馬拉松 2026」和三場免費活動。");
    }

    var left = LANG === 'en' ? (
      rstate === "draft" ? "Not Published"
      : rstate === "paused" ? "Entries Paused"
      : rstate === "closed" ? "Closed · Pack Collection"
      : rstate === "done" ? "Finished · Results Out"
      : rstate === "soon" ? "Opens Aug 20"
      : rstate === "full" ? "Full"
      : seats <= 0 ? "Full · Waiting List"
      : seats + " spots left"
    ) : (LANG === 'km' ? (
      rstate === "draft" ? "មិនទាន់ចេញផ្សាយ"
      : rstate === "paused" ? "ផ្អាកទទួលការចុះឈ្មោះ"
      : rstate === "closed" ? "បិទចុះឈ្មោះ · ទទួលឥវ៉ាន់"
      : rstate === "done" ? "បានបញ្ចប់ · ចេញលទ្ធផល"
      : rstate === "soon" ? "បើក ២០ សីហា"
      : rstate === "full" ? "ពេញហើយ"
      : seats <= 0 ? "ពេញ · បញ្ជីរង់ចាំ"
      : "នៅសល់ " + seats + " កន្លែង"
    ) : (
      rstate === "draft" ? "賽事尚未發佈"
      : rstate === "paused" ? "主辦方已暫停接受新報名"
      : rstate === "closed" ? "報名已截止 · 領物期"
      : rstate === "done" ? "賽事已結束 · 成績已發佈"
      : rstate === "soon" ? "8 月 20 日開放"
      : rstate === "full" ? "名額已滿"
      : seats <= 0 ? "名額已滿，可候補"
      : "剩餘 " + seats + " 個名額"
    ));

    var price = r.free
      ? (LANG === 'en' ? '<span class="race-price free">FREE<small> Reg Req.</small></span>'
         : (LANG === 'km' ? '<span class="race-price free">ឥតគិតថ្លៃ<small> ត្រូវចុះឈ្មោះ</small></span>'
         : '<span class="race-price free">免費<small> 需報名</small></span>'))
      : F.priceLabel
        ? '<span class="race-price"><small>' + h(F.priceLabel) + '</small></span>'
        : (LANG === 'en' ? '<span class="race-price">$' + F.price + '<small> FROM</small></span>'
           : (LANG === 'km' ? '<span class="race-price">$' + F.price + '<small> ចាប់ពី</small></span>'
           : '<span class="race-price">$' + F.price + '<small> 起</small></span>'));

    var rTitle = (typeof RACE_L10N !== "undefined" && RACE_L10N[r.id] && (RACE_L10N[r.id].sub[l] || RACE_L10N[r.id].flat)) ||
      (typeof FREE_L10N !== "undefined" && FREE_L10N[r.id] && FREE_L10N[r.id][l] && FREE_L10N[r.id][l].t) || r.t;

    var rLoc = (typeof FREE_L10N !== "undefined" && FREE_L10N[r.id] && FREE_L10N[r.id][l] && FREE_L10N[r.id][l].loc) ||
      (typeof RACE_L10N !== "undefined" && RACE_L10N[r.id] && RACE_L10N[r.id].city && RACE_L10N[r.id].city[l]) || r.loc;

    var metaMap = {
      en: {
        "每週六 05:45": "Every Saturday 05:45",
        "5K 自由跑": "5K Free Run",
        "3K / 5K 親子同行": "3K / 5K Family & Kids",
        "2026.08.16 起 · 連續 4 周": "From Aug 16 · 4 Weeks",
        "5K 漸進訓練": "5K Progressive Training",
        "4×5K 接力": "4×5K Corporate Relay",
        "12K / 25K": "12K / 25K Trail",
        "5K / 10K / 21K": "5K / 10K / 21K",
        "5K / 10K": "5K / 10K",
        "10K / 21K": "10K / 21K"
      },
      km: {
        "每週六 05:45": "រៀងរាល់ថ្ងៃសៅរ៍ ០៥:៤៥",
        "5K 自由跑": "5K រត់សេរី",
        "3K / 5K 親子同行": "3K / 5K គ្រួសារ និងកុមារ",
        "2026.08.16 起 · 連續 4 周": "ចាប់ពី ១៦ សីហា · ៤ សប្តាហ៍",
        "5K 漸進訓練": "5K វគ្គហ្វឹកហាត់",
        "4×5K 接力": "4×5K រត់បន្តវេន",
        "12K / 25K": "12K / 25K ផ្លូវលំ",
        "5K / 10K / 21K": "5K / 10K / 21K",
        "5K / 10K": "5K / 10K",
        "10K / 21K": "10K / 21K"
      }
    };
    var currMeta = metaMap[l] || {};
    var rawDist = (F.dist || r.dist || "").trim();
    var rawDate = (r.d || "").trim();
    var rDist = (typeof FREE_L10N !== "undefined" && FREE_L10N[r.id] && FREE_L10N[r.id][l] && FREE_L10N[r.id][l].dist) || currMeta[rawDist] || rawDist;
    var rDate = (typeof FREE_L10N !== "undefined" && FREE_L10N[r.id] && FREE_L10N[r.id][l] && FREE_L10N[r.id][l].d) || currMeta[rawDate] || rawDate;

    el.innerHTML =
      '<div class="race-img"><canvas data-art="race-' + r.seed + '"></canvas>' +
      '<span class="race-badge ' + b[1] + '">' + b[0] + '</span>' +
      orgTag(r.org === "partner" ? "partner" : "official") + '</div>' +
      '<div class="race-body">' +
        '<h3>' + h(rTitle) + '</h3>' +
        '<div class="race-meta"><span>' + h(rDate) + '　' + h(rDist) + '</span><span>' + h(rLoc) + '</span></div>' +
        '<div class="race-foot">' +
          price +
          '<span class="race-left">' + left + '</span>' +
        '</div>' +
      '</div>';
    return el;
  }

  var homeWrap = $("home-races"), freeWrap = $("free-races"), allWrap = $("all-races");
  renderHomeMosaic();   /* v6 首頁：1 大 + 2 小 */
  renderFreeLight();    /* v6 首頁：免費活動輕量卡 */
  renderNextRace();
  publicRaces().forEach(function (r, i) { allWrap.appendChild(raceCard(r, i)); });

  /* ---------------- 組別選擇已遷到 v5 多參賽者構建器（見文件末尾 v5 段） ---------------- */

  /* ---------------- render: merch ----------------
     D-085：報名流程內的周邊選購渲染整段移除（原 reg3）。
     周邊是一期範圍（D-041），但按 D-048 走獨立訂單域與獨立支付，
     不與報名混合結算，因此報名流程不再渲染任何周邊商品。
     ------------------------------------------------ */

  /* ---------------- summary ---------------- */

  function lines() {
    var out = [];
    ORD.parts.forEach(function (pt, i) {
      var pr = ptPrice(pt);
      if (!pr) return;
      out.push([(pt.name || ("參賽者 " + (i + 1))) + " · " + catById(pt.cat).n + " " + catById(pt.cat).d +
        "（" + AUD[pt.aud].s + " · " + pr.phaseName + "）", pr.amount]);
    });
    /* D-085 / D-048：報名訂單隻結算報名相關費用。
       周邊商品走獨立訂單域與獨立支付，任何周邊行項都不得進入這裏。 */
    return out;
  }

  function subtotal() {
    return lines().reduce(function (a, l) { return a + l[1]; }, 0);
  }

  function total() {
    return Math.max(0, subtotal() - state.discount);
  }

  function renderSummary() {
    if (typeof ORD === "undefined" || !ORD || !ORD.parts) return;
    renderOrderParts();
    $("sum-runner").textContent = "共 " + ORD.parts.length + " 名參賽者 · 一筆訂單統一付款";

    var box = $("sum-lines");
    box.innerHTML = "";
    lines().forEach(function (l) {
      var d = document.createElement("div");
      d.className = "sum-line";
      d.innerHTML = "<span>" + l[0] + "</span><span>" + money(l[1]) + "</span>";
      box.appendChild(d);
    });
    if (state.discount > 0) {
      var dd = document.createElement("div");
      dd.className = "sum-line dis";
      dd.innerHTML = "<span>優惠碼 " + state.code + "</span><span>−" + money(state.discount) + "</span>";
      box.appendChild(dd);
    }
    var t = document.createElement("div");
    t.className = "sum-line total";
    var tot = total();
    t.innerHTML = "<span>合計</span><span>" + money(tot) + "</span>";
    box.appendChild(t);

    var payBox = $("pay-box");
    if (tot === 0 && payBox) {
      payBox.innerHTML = '<div class="note" style="border-left-color:var(--ok);background:#f2fbf6;margin-bottom:1rem">' +
        '<b>🎉 100% VIP 特邀全額優免</b> · 應付金額 $0.00，點擊下方按鈕直接生成正式報名與參賽憑證，免掃碼即刻出票。</div>';
      var payBtn = $("to-pay");
      if (payBtn) payBtn.textContent = "立即確認報名（VIP 優免 $0.00）";
    }
  }

  $("code-btn").addEventListener("click", function () {
    var v = $("code-in").value.trim().toUpperCase();
    var msg = $("code-msg");
    msg.hidden = false;
    var sub = subtotal();
    var pCount = ORD && ORD.parts ? ORD.parts.length : 1;
    var res = (typeof RD !== "undefined" && RD.verifyCoupon) ? RD.verifyCoupon(v, curEvent ? curEvent.id : "EV-A", sub, pCount) : null;
    if (res && res.ok) {
      state.discount = res.discount;
      state.code = v;
      msg.className = "code-msg ok";
      msg.textContent = res.msg;
    } else {
      state.discount = 0; state.code = "";
      msg.className = "code-msg no";
      msg.textContent = res ? res.msg : (v ? "優惠碼無效或已過期" : "請輸入優惠碼");
    }
    renderSummary();
  });

  var agrees = document.querySelectorAll(".ag");
  agrees.forEach(function (a) {
    a.addEventListener("change", function () {
      var all = Array.prototype.every.call(agrees, function (x) { return x.checked; });
      $("to-pay").disabled = !(all && S.authz.shoot && S.authz.promo);
    });
  });
  $("to-pay").addEventListener("click", function () { go("pay"); });

  /* ---------------- payment: countdown + simulated polling ---------------- */

  var payTimer = null, pollTimer = null, secsLeft = 600, polls = 0;
  /* 當前付款頁對應的<b>共享訂單 id</b>：倒計時、超時、支付確認全都認它，
     而不是認頁面裏那個會被重渲染刷掉的計數器。 */
  var payOrderId = null;

  function fmtLeft(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  /* 超時後的界面：不許再「模擬支付成功」直接跳過去，必須先重新生成 KHQR。
     ⚖️ D-111 B6 · 但<b>「錢其實已經到了」這條路必須留着</b>——
     現實裏錢確實可能在截止之後纔到賬，把入口全關掉等於假裝這件事不會發生。
     所以「人工覈查」保持可用 —— 但它的含義<b>始終</b>只是一條待覈查的訴求
     （D-125 R2），不是一筆到賬：訂單仍然過期、報名仍然取消、名額不恢復。
     真到賬了走既有的授權入口（財務覈對流水 / 通道入賬事件 → LATE_ARRIVAL）。 */
  function showPayTimeout() {
    stopPay();
    $("pay-live").hidden = true;
    $("pay-timeout").hidden = false;
    $("sim-paid").disabled = true;
    $("sim").hidden = true;
    $("sim-paid2").disabled = false;
  }

  function startPay() {
    stopPay();
    /* ⚖️ D-098 A1 · 進 KHQR = 共享域裏<b>真的</b>產生一張 PENDING_PAYMENT 訂單，
       Registration=PENDING，名額與配額 RESERVED。下面那句「名額爲你保留」
       從這一刻起有事實支撐。佔不住（整單累計校驗不過）就不讓進付款。 */
    var rv = reserveRegOrder();
    if (!rv.ok) {
      toast(String(rv.msg || "名額不足，無法進入付款").replace(/<[^>]+>/g, ""));
      /* ⚖️ D-117 A3 · 這個人是在 OPS 點「停止報名」<b>之前</b>就進的結賬頁。
         共享域已經拒絕建單（沒有訂單、沒有報名、沒有佔用任何名額），
         這裏把他送回賽事詳情——那裏現在寫的就是「報名已暫停」。
         留在第 4 步只會讓他一直點、一直被拒。 */
      go(rv.registrationClosed ? "detail" : "reg4");
      return;
    }
    payOrderId = rv.order.id;
    polls = 0;
    $("pay-amt").textContent = money(total() || 30);
    $("poll-n").textContent = "已查詢 0 次";

    /* ⚖️ D-100 A3 · 剩餘時間是 <b>Order.deadline − 當前時間</b> 派生出來的<b>視圖</b>，
       不是每次進頁面就重發一個 10:00。離開 4 分鐘再回來，看到的就該是 6 分鐘。 */
    secsLeft = RD.secondsLeft(rv.order);
    if (secsLeft == null) secsLeft = SC.payFast ? 20 : 600;
    if (secsLeft <= 0) { showPayTimeout(); return; }

    $("hold-t").textContent = fmtLeft(secsLeft);
    $("pay-timeout").hidden = true;
    $("pay-live").hidden = false;
    $("sim-paid").disabled = false;
    $("sim-paid2").disabled = false;
    $("sim").hidden = false;

    payTimer = every(function () {
      /* 每一拍都重新從共享訂單的截止時刻算，不自己維護一個會走偏的計數器。
         標籤頁被掛起過、系統睡眠過，回來看到的仍然是真實剩餘時間。 */
      RD.load();
      var o = RD.findOrder(payOrderId);
      var left = o ? RD.secondsLeft(o) : 0;
      if (left == null) left = 0;
      secsLeft = left;
      if (left <= 0) {
        stopPay();
        /* ⚖️ D-098 A3 / D-100 A5 · 超時不是隻改一句 UI 文案：共享域裏那筆預留
           <b>真的</b>放回公共池，訂單 → EXPIRED，報名 → CANCELLED(ORDER_EXPIRED)。
           計時回調只是觸發器之一，真正判定的是截止時刻；<b>恰好一次</b>。 */
        expireRegOrder();
        showPayTimeout();
        toast("名額保留已超時，名額已放回公共池（演示）");
        renderRaceLists();
        return;
      }
      $("hold-t").textContent = fmtLeft(left);
    }, 1000);

    // mirrors the real design: front-end polls check_transaction_by_md5 every 3s
    pollTimer = every(function () {
      polls++;
      $("poll-n").textContent = "已查詢 " + polls + " 次";
    }, 3000);
  }

  function stopPay() {
    if (payTimer) { clearInterval(payTimer); payTimer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* ⚖️ D-125 R1 · <b>這兩顆按鈕是兩件完全不同的事，不能共用一個處理器。</b>
     ----------------------------------------------------------------
       「模擬支付成功」  = Demo 裏那個代表<b>支付通道</b>的模擬器：錢真的到了。
       「點這裏人工覈查」 = <b>用戶自稱</b>付過了，請人幫忙查。

     以前兩顆都綁在同一個 paid() 上，而且在截止之前那條路會直接
     confirmRegistrationPayment(role: USER) → 訂單 PAID、報名 CONFIRMED。
     於是<b>用戶自稱當場變成銀行到賬</b>——正是 D-112 立過的那條線被繞過去了。
     上一輪只在「已經過期」那一支修對了，截止之前那一支沒修：
     同一顆按鈕的含義不該因爲窗口過沒過期而改變。 */

  /* A · 支付通道模擬器。actor 代表<b>通道</b>，絕不冒充用戶自己確認自己付了款。
     ⚠️ 這是 Demo 控件：真實產品裏這一步來自通道回調 / 對賬文件。 */
  var DEMO_PAYMENT_PROVIDER = { who: "demo:khqr-simulator", role: "PAYMENT_PROVIDER" };

  /* ⚖️ D-100 A2 · 「模擬支付成功」不直接跳成功頁：先問共享域這張單現在
     還能不能正常付款。過期了就當場按既有語義過期並停在超時界面 ——
     絕不出現「EXPIRED 的單被正常確認成 PAID」。 */
  function simulateProviderReceipt() {
    RD.load();
    var o = (payOrderId && RD.findOrder(payOrderId)) || RD.orderByNo(ORD.orderNo);
    /* ⚖️ D-125 R6 · <b>沒有訂單就沒有付款可確認</b>，更不能直接跳成功頁 ——
       那等於「點一下就成功了」，成功頁會渲染出一筆並不存在的報名。 */
    if (!o) {
      toast("沒有找到對應的付款訂單，請重新走一次報名流程。");
      return;
    }
    var res = RD.confirmRegistrationPayment(o.id, DEMO_PAYMENT_PROVIDER, null);
    RD.save();
    if (!res.ok) {
      showPayTimeout();
      renderRaceLists();
      toast(String(res.msg || "支付確認失敗").replace(/<[^>]+>/g, "").slice(0, 80));
      return;
    }
    stopPay();
    go("done");
  }

  /* B · 用戶自稱付過款。<b>任何時候都不是一筆錢</b>：
     截止之前不變 PAID，截止之後也不復活訂單。它只登記一條待覈查的訴求。 */
  function requestPaymentCheck() {
    RD.load();
    var o = (payOrderId && RD.findOrder(payOrderId)) || RD.orderByNo(ORD.orderNo);
    if (!o) { toast("沒有找到對應的訂單，請重新下單。"); return; }
    var res = RD.requestPaymentCheck(o.id, rdActor(), "用戶在 KHQR 付款頁提交");
    RD.save();
    /* ⚠️ 這裏<b>不</b>調用 showPayTimeout()，也不改任何界面狀態：
       覈查請求不會暫停倒計時、不會延長付款窗口、不會多佔一秒名額（R8）。 */
    if (o.status === "EXPIRED") {
      toast("已收到你的付款覈查請求。這筆訂單的付款窗口已經過期、名額已放回公共池，" +
            "覈查請求不會讓它恢復。如果你確實付過款，我們會用銀行流水去核對；" +
            "覈對到賬之後由運營按既有流程決定是恢復報名還是把錢退還給你。");
      return;
    }
    toast(String(res.msg || "已收到你的付款覈查請求。").replace(/<[^>]+>/g, "") +
          (res.duplicate ? "" : "付款窗口仍按原有時間繼續，請不要關閉頁面。"));
  }

  $("sim-paid").addEventListener("click", simulateProviderReceipt);
  $("sim-paid2").addEventListener("click", requestPaymentCheck);
  $("pay-again").addEventListener("click", function () {
    SC.payFast = false;
    /* ⚖️ D-100 A4 · 重新生成 KHQR = <b>一筆新的結賬</b>：新訂單號、新的業務窗口、
       重新走整單累計校驗去搶當前名額。舊單保持 EXPIRED 留作歷史，
       絕不「悄悄延長那張已經過期的單」。鑄號交給 reserveRegOrder 統一判斷。 */
    startPay();
  });

  /* ---------------- pass ---------------- */

  function fillPass() { renderDonePasses(); }

  $("restart").addEventListener("click", function () {
    state = { cat: null, discount: 0, code: "" };
    resetOrder();
    agrees.forEach(function (a) { a.checked = false; });
    $("to-pay").disabled = true;
    $("code-in").value = ""; $("code-msg").hidden = true;
    go("home");
  });

  /* ================================================================
     v3 · 通用小工具
     ================================================================ */

  var SC = { ai: "ok", sponsorFree: true, payFast: false, freeEv: "f1", resBib: 3247 };

  function evById(id) {
    for (var i = 0; i < DEMO.events.length; i++) if (DEMO.events[i].id === id) return DEMO.events[i];
    return null;
  }
  function sponsorById(id) {
    for (var i = 0; i < DEMO.sponsors.length; i++) if (DEMO.sponsors[i].id === id) return DEMO.sponsors[i];
    return null;
  }
  function seatsLeft(ev) {
    /* ⚖️ D-111 A1 · 與首頁走<b>同一個</b>解析器。
       以前這裏算的是 cap − used，把付款窗口裏的 reserved 漏掉了，
       於是「名額爲你保留」對別人不成立。現在含 reserved。 */
    var shared = sharedSeatsLeft(ev.id);
    if (shared !== null) return shared;
    return Math.max(0, ev.left - usedSeats(ev.id));
  }
  function regOf(evId) {
    for (var i = 0; i < S.regs.length; i++) {
      if (S.regs[i].ev === evId && S.regs[i].status !== "cancelled") return S.regs[i];
    }
    return null;
  }
  function photoById(id) {
    for (var i = 0; i < DEMO.photos.length; i++) if (DEMO.photos[i].id === id) return DEMO.photos[i];
    return null;
  }
  function claimOf(pid) {
    for (var i = 0; i < S.claims.length; i++) if (S.claims[i].id === pid) return S.claims[i];
    return null;
  }
  /* 官方 / 合作 / 跑友自主：三類活動必須在任何列表裏都一眼分得開。
     寫成函數聲明而不是 var，是因爲首屏渲染比這一行先執行。 */
  function orgTag(kind) {
    var l = (typeof LANG !== "undefined" && LANG) ? LANG : "zh";
    var m = {
      zh: { official: "RUN 官方主辦", partner: "合作主辦", ugc: "跑友自主活動" },
      en: { official: "RUN Official", partner: "Partner Event", ugc: "Community Run" },
      km: { official: "RUN ផ្លូវការ", partner: "ដៃគូសហការ", ugc: "សកម្មភាពអ្នករត់" }
    };
    var map = m[l] || m.zh;
    var txt = map[kind] || map.official;
    return '<span class="org-tag ' + (kind || "official") + '">' + txt + '</span>';
  }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  /* ⚖️ D-100 A4 · 訂單號必須<b>真的</b>是新的。
     原來這個生成器只看 S.regs.length，是確定性的：一筆訂單過期後重新生成 KHQR
     並不會增加 S.regs，於是鑄出來的還是同一個號 —— 新結賬被當成舊訂單的重放，
     「重新生成」等於沒生成。這裏加一個單調遞增序號兜底。 */
  var codeSeq = 0;
  function newCode(prefix) {
    codeSeq++;
    var n = 1000 + (S.regs.length * 137 + codeSeq * 991 + 421) % 8999;
    return prefix + n;
  }
  /* 再兜一層：鑄出來的號絕不能撞上共享域裏已經存在的訂單 */
  function newOrderNo() {
    var no = newCode("RUN26PP"), guard = 0;
    while (RD.orderByNo(no) && guard++ < 200) no = newCode("RUN26PP");
    return no;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    TG.haptic();
    t.textContent = msg;
    t.classList.add("on");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = later(function () { t.classList.remove("on"); }, 2600);
  }

  function openShare(title, text) {
    $("share-title").textContent = title;
    $("share-txt").textContent = text;
    $("share-bg").classList.add("on");
    // 多壓一條同 hash 的歷史，瀏覽器返回時先消耗掉它（用來關彈窗）
    try { history.pushState(null, "", location.hash || "#/"); } catch (e) {}
    S.shares++; save();
  }
  $("share-close").addEventListener("click", function () { $("share-bg").classList.remove("on"); });
  $("share-bg").addEventListener("click", function (e) { if (e.target === this) this.classList.remove("on"); });
  $("share-copy").addEventListener("click", function () {
    var txt = $("share-txt").textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { toast("文案已複製"); }, function () { toast("複製失敗，請手動選中"); });
    else toast("請手動選中複製");
  });

  var TOAST_TODO_I18N = {
    en: {
      "「關於我們」不在這次演示範圍裏。本次只補業務閉環相關的頁面，公司介紹頁等正式做站時再寫。": "'About Us' is outside the scope of this prototype demo. This prototype focuses strictly on end-to-end race business logic.",
      "這場比賽在演示模型裏只做了卡片，沒有做詳情頁。可點開的是「金邊濱河半程馬拉松 2026」。": "This race is represented as a card in the demo model. The interactive detail page is available for 'Riverside Half Marathon 2026'.",
      "演示模型裏資料是隻讀的。正式版這裏可以編輯，並且改完之後下次報名會自動帶出新資料。": "Profile is read-only in this demo. In production, updating your details will automatically populate future race entries.",
      "賬號註銷涉及訂單、成績和照片的留存規則，需要先定清楚政策再做。演示階段先不實現。": "Account deletion involves data retention rules for orders, results, and photos. Not implemented in demo."
    },
    km: {
      "「關於我們」不在這次演示範圍裏。本次只補業務閉環相關的頁面，公司介紹頁等正式做站時再寫。": "«អំពីយើង» មិនស្ថិតក្នុងវិសាលភាពនៃគំរូសាកល្បងនេះទេ។ គំរូនេះផ្តោតលើតក្កវិជ្ជាអាជីវកម្មនៃការប្រកួតពេញលេញ។",
      "這場比賽在演示模型裏只做了卡片，沒有做詳情頁。可點開的是「金邊濱河半程馬拉松 2026」。": "ការប្រកួតនេះបង្ហាញជាកាតក្នុងគំរូ។ ទំព័រលម្អិតដែលមានអន្តរកម្មគឺ «ការរត់ពាក់កណ្តាលម៉ារ៉ាតុង មាត់ទន្លេភ្នំពេញ ២០២៦»។",
      "演示模型裏資料是隻讀的。正式版這裏可以編輯，並且改完之後下次報名會自動帶出新資料。": "កម្រងព័ត៌មានជាទម្រង់អានប៉ុណ្ណោះក្នុងគំរូនេះ។",
      "賬號註銷涉及訂單、成績和照片的留存規則，需要先定清楚政策再做。演示階段先不實現。": "ការលុបគណនីមិនទាន់អនុវត្តក្នុងគំរូនេះទេ។"
    }
  };

  // 任何帶 data-todo 的按鈕都會說明爲什麼沒做，不留死鏈
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-todo]");
    if (t) {
      var raw = t.getAttribute("data-todo");
      var msg = (TOAST_TODO_I18N[LANG] && TOAST_TODO_I18N[LANG][raw]) || raw;
      toast(msg);
    }
  });

  /* ================================================================
     v3 · 演示用圖片生成（賽事照片 / 完賽證書）
     ================================================================ */

  function paintPhoto(cv, seed, opts) {
    opts = opts || {};
    var w = cv.clientWidth || 320, h = cv.clientHeight || 210;
    if (opts.ratio) h = Math.round(w * opts.ratio);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.height = opts.ratio ? h + "px" : "";
    var c = cv.getContext("2d"); c.scale(dpr, dpr);
    var r = rng(seed);

    var g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#7BC5F0"); g.addColorStop(.55, "#BEE4F8"); g.addColorStop(1, "#E7F5FD");
    c.fillStyle = g; c.fillRect(0, 0, w, h);

    c.beginPath(); c.arc(w * (.12 + r() * .2), h * .2, h * .075, 0, Math.PI * 2);
    c.fillStyle = "rgba(255,236,182,.95)"; c.fill();

    // 遠景綠化
    c.fillStyle = "rgba(120,198,166,.75)";
    c.beginPath(); c.moveTo(0, h * .66);
    for (var x = 0; x <= w; x += 8) c.lineTo(x, h * .66 + Math.sin(x / w * 3 + seed) * h * .03);
    c.lineTo(w, h); c.lineTo(0, h); c.closePath(); c.fill();

    // 路面
    c.fillStyle = "#5D6B74"; c.fillRect(0, h * .72, w, h * .28);
    c.strokeStyle = "rgba(255,255,255,.6)"; c.lineWidth = 2; c.setLineDash([12, 10]);
    c.beginPath(); c.moveTo(0, h * .88); c.lineTo(w, h * .88); c.stroke(); c.setLineDash([]);

    // 跑者剪影
    var n = 1 + Math.floor(r() * 3);
    for (var i = 0; i < n; i++) {
      var bx = w * (.2 + r() * .55), by = h * (.72 + r() * .06), s = h * (.3 + r() * .1);
      var body = ["#123A5E", "#1E5C86", "#0F4E77"][i % 3];
      c.fillStyle = body;
      c.beginPath(); c.arc(bx, by - s, s * .16, 0, Math.PI * 2); c.fill();          // 頭
      c.fillRect(bx - s * .13, by - s * .84, s * .26, s * .46);                       // 軀幹
      c.save(); c.translate(bx, by - s * .4);
      c.rotate(.35); c.fillRect(-s * .06, 0, s * .12, s * .42); c.restore();          // 腿
      c.save(); c.translate(bx, by - s * .4);
      c.rotate(-.3); c.fillRect(-s * .06, 0, s * .12, s * .42); c.restore();
      c.save(); c.translate(bx, by - s * .72);
      c.rotate(-.7); c.fillRect(-s * .05, 0, s * .1, s * .3); c.restore();            // 手
      if (i === 0) {                                                                  // 號碼布
        c.fillStyle = "#fff"; c.fillRect(bx - s * .12, by - s * .62, s * .24, s * .16);
        c.fillStyle = "#123A5E"; c.font = "600 " + (s * .1) + "px ui-monospace, monospace";
        c.textAlign = "center";
        c.fillText(opts.bib && !opts.blocked ? String(opts.bib) : "▨▨▨", bx, by - s * .5);
      }
    }
    if (opts.blocked) {
      c.fillStyle = "rgba(206,78,59,.14)"; c.fillRect(0, 0, w, h);
    }
  }

  function paintCert(cv, res, ev) {
    var w = cv.clientWidth || 640, h = Math.round(w * 0.70);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + "px";
    var c = cv.getContext("2d"); c.scale(dpr, dpr);
    var k = w / 640;

    var g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#EAF6FE"); g.addColorStop(1, "#FFFFFF");
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.strokeStyle = "#C4DCEF"; c.lineWidth = 2 * k;
    c.strokeRect(12 * k, 12 * k, w - 24 * k, h - 24 * k);

    c.textAlign = "center";
    c.fillStyle = "#1583D8";
    c.font = "700 " + (26 * k) + "px ui-monospace, monospace";
    c.fillText("R U N", w / 2, 62 * k);

    c.fillStyle = "#7690A8"; c.font = (12 * k) + "px sans-serif";
    c.fillText("電子完賽證書 · CERTIFICATE OF FINISH（演示）", w / 2, 84 * k);

    c.fillStyle = "#12293F"; c.font = "600 " + (19 * k) + "px sans-serif";
    c.fillText(ev.t, w / 2, 118 * k);

    c.fillStyle = "#3D5C78"; c.font = (13 * k) + "px sans-serif";
    c.fillText("茲證明以下參賽者完成本次比賽", w / 2, 146 * k);

    c.fillStyle = "#0B3457"; c.font = "700 " + (34 * k) + "px sans-serif";
    c.fillText(res.name, w / 2, 190 * k);

    c.fillStyle = "#3D5C78"; c.font = (14 * k) + "px sans-serif";
    c.fillText("號碼布 " + res.bib + "　·　" + res.cat, w / 2, 214 * k);

    c.fillStyle = "#1583D8"; c.font = "600 " + (44 * k) + "px ui-monospace, monospace";
    c.fillText(res.net, w / 2, 268 * k);
    c.fillStyle = "#7690A8"; c.font = (12 * k) + "px sans-serif";
    c.fillText("淨成績 NET TIME", w / 2, 288 * k);

    var cols = [["總排名", res.rank + " / " + res.total], ["性別排名", res.gRank + " / " + res.gTotal], [res.ageGroup + " 組", res.aRank + " / " + res.aTotal]];
    cols.forEach(function (col, i) {
      var cx = w * (0.25 + i * 0.25);
      c.fillStyle = "#12293F"; c.font = "600 " + (16 * k) + "px ui-monospace, monospace";
      c.fillText(col[1], cx, 326 * k);
      c.fillStyle = "#7690A8"; c.font = (11 * k) + "px sans-serif";
      c.fillText(col[0], cx, 344 * k);
    });

    c.fillStyle = "#C4DCEF"; c.fillRect(w * 0.18, 362 * k, w * 0.64, 1 * k);
    c.fillStyle = "#7690A8"; c.font = (11 * k) + "px sans-serif";
    c.fillText("完賽日期 " + ev.d + "　·　RUN 柬埔寨賽事運營", w / 2, 382 * k);

    // 贊助冠名位
    var sp = sponsorById("sp3");
    c.fillStyle = "#EAF4FE"; c.fillRect(w * 0.22, 392 * k, w * 0.56, 24 * k);
    c.fillStyle = "#0F66AE"; c.font = "600 " + (11 * k) + "px sans-serif";
    c.fillText("成績計時由 " + sp.n + " 提供（演示贊助商冠名位）", w / 2, 408 * k);
  }

  /* ================================================================
     v3 · 免費活動閉環
     ================================================================ */

  var curFree = "f1";

  function authzRows(container, onChange) {
    var rows = [
      { k: "shoot", t: "賽事現場拍攝授權", d: "允許賽事攝影師在賽事現場和公共賽道拍攝我。", req: true },
      { k: "promo", t: "賽事宣傳使用授權", d: "允許 RUN 在賽事回顧與賽事宣傳中使用相關照片。", req: true },
      /* 一期凍結：影像檢索（自拍 / 人臉）能力不做，因此不再向用戶索取這項授權。
         保留定義僅供未來版本使用，默認不渲染，只有原型導航「一期不做 · Later」打開纔出現。 */
      { k: "ai", t: "影像檢索授權（二期能力，一期不啓用）", d: "留待未來版本：允許用影像特徵幫你本人在賽事照片裏找到自己。一期不提供該功能，也不索取該授權。", req: false, later: true }
    ];
    container.innerHTML = "";
    rows.filter(function (r) {
      return !r.later || document.body.classList.contains("show-later");
    }).forEach(function (r) {
      var lab = document.createElement("label");
      lab.className = "authz-row" + (r.req ? "" : " opt-in");
      lab.innerHTML =
        '<input type="checkbox"' + (S.authz[r.k] ? " checked" : "") + '>' +
        '<span><b>' + r.t + (r.req ? '<span class="tagreq">必選</span>' : '<span class="tagopt">可拒絕</span>') + '</b>' +
        '<span>' + r.d + '</span></span>';
      var box = lab.querySelector("input");
      box.addEventListener("change", function () {
        S.authz[r.k] = box.checked; save();
        if (onChange) onChange();
      });
      container.appendChild(lab);
    });
  }

  function renderFreeDetail(id) {
    if (id) curFree = id;
    var ev = evById(curFree);
    if (!ev) return;
    var left = seatsLeft(ev), reg = regOf(ev.id), ended = ev.state === "done";

    $("fd-title").textContent = ev.t;
    $("fd-meta").innerHTML =
      "<span>" + ev.d + "</span><span>" + ev.loc + "</span><span>" + ev.dist + "</span>";
    $("fd-desc").textContent = ev.desc || "—";

    var rows = [
      ["集合時間", ev.meet || "—"], ["地點", ev.loc], ["距離", ev.dist],
      ["適合人羣", ev.who || "—"], ["補給", ev.supply || "—"],
      ["剩餘名額", left > 0 ? left + " 個" : "已滿，可加入候補"],
      ["取消截止", "活動開始前 " + (ev.cancelH || 6) + " 小時"]
    ];
    $("fd-info").innerHTML = rows.map(function (r) {
      return "<tr><td style='width:7.5rem;color:var(--ink-mute)'>" + r[0] + "</td><td>" + r[1] + "</td></tr>";
    }).join("");

    $("fd-left").textContent = left > 0 ? ("剩餘 " + left + " 個名額") : "名額已滿";
    var cta = $("fd-cta"), why = $("fd-why"), note = $("fd-note");
    cta.disabled = false; why.hidden = true;
    cta.className = "btn wide lg";

    if (ended) {
      cta.textContent = "活動已結束"; cta.disabled = true;
      why.hidden = false; why.textContent = "這場活動已經結束，不能再報名。可以去成績查詢看當天的記錄。";
      note.textContent = "已結束的活動仍可在「我的賽事」裏查看憑證。";
    } else if (reg && reg.status === "registered") {
      cta.textContent = "已報名 · 查看憑證";
      note.textContent = "你已經報名這場活動。來不了請在「我的賽事」裏取消，名額會放給候補。";
    } else if (reg && reg.status === "waitlist") {
      cta.textContent = "已在候補名單 · 查看";
      cta.className = "btn wide lg ghost";
      note.textContent = "有人取消時會按候補順序通知你（演示模擬）。";
    } else if (left <= 0) {
      cta.textContent = "加入候補";
      cta.className = "btn wide lg ghost";
      note.textContent = "名額滿了。加入候補後，有人取消會第一時間通知你。";
    } else {
      cta.textContent = "免費報名";
      note.textContent = "免費，但需要登記。我們靠這個數字準備補給、保險和現場人手。";
    }
    cta.onclick = function () {
      if (ended) return;
      if (reg) { go("me"); return; }
      if (left <= 0) {
        withLock("waitlist-" + ev.id, cta, "處理中…", function () {
          if (regOf(ev.id)) { renderFreeDetail(); return; }
          var wreg = { id: "r" + Date.now(), ev: ev.id, kind: "free", status: "waitlist",
            cat: ev.dist, code: newCode("RUNW"), at: ev.d };
          S.regs.push(wreg);
          mirrorFreeReg(ev, wreg, "WAITLIST");
          save(); toast("已加入候補名單（演示）"); renderFreeDetail();
        });
        return;
      }
      go("freereg");
    };
  }

  function renderFreeReg() {
    var ev = evById(curFree);
    $("fr-lead").textContent = ev.t + " · " + ev.d + " · " + ev.loc;
    var u = DEMO.user;
    $("fr-kv").innerHTML = [
      ["姓名", u.name], ["性別", u.gender], ["出生日期", u.dob], ["手機", u.phone],
      ["國籍", u.nation], ["緊急聯繫人", u.ec + " " + u.ecPhone]
    ].map(function (r) { return "<div><span>" + r[0] + "</span><b>" + r[1] + "</b></div>"; }).join("");

    authzRows($("fr-authz"), checkFree);
    var box = document.querySelector(".fag");
    box.checked = false;
    checkFree();
    box.onchange = checkFree;
  }

  function checkFree() {
    var box = document.querySelector(".fag");
    $("fr-submit").disabled = !(box.checked && S.authz.shoot && S.authz.promo);
  }

  $("fr-submit").addEventListener("click", function () {
    var btn = this;
    withLock("freereg", btn, "提交中…", function () {
      var ev = evById(curFree);
      if (!ev) { go("home"); return; }
      var exist = regOf(ev.id);
      if (exist && exist.status === "registered") {   // 連點或回退重提交
        lastFreeReg = exist; go("freedone"); return;
      }
      if (seatsLeft(ev) <= 0) { toast("名額剛好被搶完了，可以加入候補"); go("freedetail"); return; }
      var reg = { id: "r" + Date.now(), ev: ev.id, kind: "free", status: "registered",
        cat: ev.dist, code: newCode("RUNF"), at: ev.d };
      S.regs.push(reg);
      mirrorFreeReg(ev, reg, "REGISTERED");
      save();
      lastFreeReg = reg;
      renderRaceLists();
      go("freedone");
    });
  });

  var lastFreeReg = null;

  /* D-130 · 免費活動登記同步進共享業務域：以前只寫本地 S.regs，運營後臺完全看不到 */
  function mirrorFreeReg(ev, reg, status) {
    try {
      if (!RD || !RD.freeRegister) return;
      var r = RD.freeRegister({ feId: ev.id, title: ev.t, holder: DEMO.user.name, phone: DEMO.user.phone,
        cap: ev.left, code: reg.code, status: status, channel: TG.on ? "telegram-miniapp" : "web" },
        { who: DEMO.user.id, role: "USER" });
      if (r.ok) { reg.domainId = r.reg.id; RD.save(); }
    } catch (e) {}
  }
  function mirrorFreeCancel(reg) {
    try { if (reg && reg.domainId && RD && RD.freeCancel) { RD.freeCancel(reg.domainId, { who: DEMO.user.id, role: "USER" }); RD.save(); } } catch (e) {}
  }

  function renderFreeDone() {
    var reg = lastFreeReg;
    if (!reg) {
      for (var i = S.regs.length - 1; i >= 0; i--) {
        if (S.regs[i].kind === "free" && S.regs[i].status === "registered") { reg = S.regs[i]; break; }
      }
    }
    if (!reg) { go("home"); return; }
    var ev = evById(reg.ev);
    $("fdone-sub").textContent = DEMO.user.name + "，你已登記 " + ev.t;
    $("fp-name").textContent = DEMO.user.name;
    $("fp-ev").textContent = ev.t;
    $("fp-time").textContent = ev.meet || ev.d;
    $("fp-code").textContent = reg.code;
  }

  /* ================================================================
     v3 · 找照片
     ================================================================ */

  var phEvent = "e1", phCtx = { mode: "bib", bib: 3247, list: [] }, curPhoto = null;

  function photoEvents() {
    return DEMO.events.filter(function (e) { return e.hasPhotos; });
  }

  function renderPhotoHome() {
    var wrap = $("ph-events");
    wrap.innerHTML = "";
    photoEvents().forEach(function (e) {
      var b = document.createElement("button");
      b.className = "tab" + (e.id === phEvent ? " on" : "");
      var name = (RACE_L10N[e.id] && (RACE_L10N[e.id].sub[LANG] || RACE_L10N[e.id].flat)) || e.t;
      b.textContent = name;
      b.addEventListener("click", function () { phEvent = e.id; renderPhotoHome(); });
      wrap.appendChild(b);
    });
    var ev = evById(phEvent);

    /* 賽前不可能有照片。給出明確狀態和一鍵切換，不做成死路。 */
    var gate = $("ph-pre");
    if (!gate) {
      gate = document.createElement("div");
      gate.id = "ph-pre";
      gate.className = "empty";
      gate.style.margin = "0 0 1.2rem";
      $("ph-evnote").parentNode.insertBefore(gate, $("ph-evnote").nextSibling);
    }
    var pre = (phEvent === "e1" && !isPostRace());
    gate.hidden = !pre;
    if (pre) {
      if (LANG === "en") {
        gate.innerHTML = "<b>This race has not taken place yet; photos are not available</b>" +
          "Race date: 2026.09.20. Photographers upload within 48h after the race. Photos can be searched once Bibs are tagged." +
          '<div class="btn-row" style="margin-top:.8rem;justify-content:center">' +
          '<button class="btn sm" data-postrace="1">Simulate Post-Race</button>' +
          '<button class="btn ghost sm" data-go="history">View Past Race Photos</button></div>';
      } else if (LANG === "km") {
        gate.innerHTML = "<b>ការប្រកួតមិនទាន់ប្រព្រឹត្តទៅទេ រូបថតមិនទាន់មានឡើយ</b>" +
          "ថ្ងៃប្រកួត ២០ កញ្ញា ២០២៦ អ្នកថតរូបនឹងបង្ហោះក្នុងរយៈពេល ៤៨ ម៉ោងក្រោយប្រកួត។" +
          '<div class="btn-row" style="margin-top:.8rem;justify-content:center">' +
          '<button class="btn sm" data-postrace="1">ក្លែងធ្វើក្រោយប្រកួត</button>' +
          '<button class="btn ghost sm" data-go="history">មើលរូបថតការប្រកួតកន្លងមក</button></div>';
      } else {
        gate.innerHTML = "<b>本場比賽還沒有舉行，照片還沒有拍</b>" +
          "比賽日 2026.09.20，攝影師會在賽後 48 小時內上傳，運營打完號碼布標籤後才能查找。" +
          '<div class="btn-row" style="margin-top:.8rem;justify-content:center">' +
          '<button class="btn sm" data-postrace="1">模擬進入賽後</button>' +
          '<button class="btn ghost sm" data-go="history">看往期賽事照片</button></div>';
      }
    }

    var sp = ev.photoSponsor ? sponsorById(ev.photoSponsor) : null;
    var photoCnt = DEMO.photos.filter(function (p) { return p.ev === phEvent; }).length;
    var evCity = (RACE_L10N[ev.id] && RACE_L10N[ev.id].city && RACE_L10N[ev.id].city[LANG]) || ev.loc;

    if (LANG === "en") {
      $("ph-bib").placeholder = "e.g. 3247";
      $("ph-evnote").innerHTML = ev.d + " · " + evCity + " · " + photoCnt + " sample photos" +
        (sp ? "　·　<b style='color:var(--leaf)'>Photos sponsored by " + sp.n + " (Free to claim)</b>" : "");
    } else if (LANG === "km") {
      $("ph-bib").placeholder = "ឧ. 3247";
      $("ph-evnote").innerHTML = ev.d + " · " + evCity + " · " + photoCnt + " រូបថតគំរូ" +
        (sp ? "　·　<b style='color:var(--leaf)'>ឧបត្ថម្ភរូបថតដោយ " + sp.n + " (ទទួលឥតគិតថ្លៃ)</b>" : "");
    } else {
      $("ph-bib").placeholder = "例如 3247";
      $("ph-evnote").innerHTML = ev.d + " · " + ev.loc + " · 共 " + photoCnt + " 張演示照片" +
        (sp ? "　·　<b style='color:var(--leaf)'>本場照片由 " + sp.n + " 贊助，可免費領取</b>" : "");
    }

    // 自拍入口受 AI 授權控制
    var selfieBtn = $("ph-selfie-go"), why = $("ph-selfie-why"), drop = $("ph-drop");
    if (!S.authz.ai) {
      selfieBtn.disabled = true;
      why.hidden = false;
      why.textContent = LANG === 'en'
        ? "You opted out of AI photo matching at registration. Use Bib search or enable AI permission in Profile."
        : (LANG === 'km'
          ? "អ្នកបានបដិសេធការផ្គូផ្គងរូបថត AI ពេលចុះឈ្មោះ។ សូមប្រើលេខ Bib ឬបើកសិទ្ធិក្នុងកម្រងព័ត៌មាន។"
          : "你在報名時拒絕了「AI 識別與照片匹配授權」，所以自拍找圖不可用。可以用號碼布查找，或在「我的 → 個人資料」裏重新開啓授權。");
      drop.style.opacity = ".5";
    } else {
      why.hidden = true;
      drop.style.opacity = "1";
      selfieBtn.disabled = !S.selfiePreview;
    }

    $("ph-hist").textContent = S.claims.length
      ? (LANG === 'en' ? "You have claimed " + S.claims.length + " photos." : (LANG === 'km' ? "អ្នកបានទទួលរូបថត " + S.claims.length + " សន្លឹក។" : "你已經認領或領取了 " + S.claims.length + " 張照片。"))
      : (LANG === 'en' ? "No photos claimed yet. Click 'Confirm This Is Me' to save photos here." : (LANG === 'km' ? "មិនទាន់បានទទួលរូបថតទេ។ ចុច «ពិតជារូបខ្ញុំ» ដើម្បីរក្សាទុកនៅទីនេះ។" : "還沒有認領過照片。找到自己的照片後點「確認是我」就會存到這裏。"));
  }

  $("ph-drop").addEventListener("click", function () { if (S.authz.ai) $("ph-file").click(); });
  /* 審覈修復 · 上傳只收圖片且限制大小：FileReader 結果會直接進 <img src> 與 localStorage */
  function acceptImage(f) {
    if (!f) return false;
    if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(f.type || "")) { toast("只支持 JPG / PNG / WebP / HEIC 圖片"); return false; }
    if (f.size > 5 * 1024 * 1024) { toast("圖片超過 5 MB，請壓縮後再傳"); return false; }
    return true;
  }
  $("ph-file").addEventListener("change", function () {
    var f = this.files && this.files[0];
    if (!acceptImage(f)) { this.value = ""; return; }
    var fr = new FileReader();
    fr.onload = function (e) {
      S.selfiePreview = true;
      $("ph-drop").innerHTML = '<img src="' + e.target.result + '" alt="自拍預覽"><br>已選好照片，點下面開始識別<br><span style="font-size:.76rem">圖片只在瀏覽器裏讀取，沒有上傳到任何服務器</span>';
      $("ph-selfie-go").disabled = false;
    };
    fr.readAsDataURL(f);
  });

  var simToken = 0;
  function cancelSim() {
    simToken++;
    var box = $("ph-sim");
    if (box) box.hidden = true;
    ["ph-bib-go", "ph-selfie-go", "ph-all-go"].forEach(function (id) {
      var b = $(id); if (b && b.dataset.busy) { b.disabled = false; b.textContent = b.dataset.old || b.textContent; delete b.dataset.busy; }
    });
  }

  function simSteps(titles, btn, done) {
    var my = ++simToken;
    var box = $("ph-sim"), list = $("ph-sim-steps");
    box.hidden = false;
    if (btn) { btn.dataset.busy = "1"; btn.dataset.old = btn.textContent; btn.disabled = true; btn.textContent = "查找中…"; }
    list.innerHTML = titles.map(function (t) { return "<li><b></b>" + t + "</li>"; }).join("");
    var items = list.querySelectorAll("li"), i = 0;
    (function tick() {
      if (my !== simToken) return;                       // 已被取消（離開頁面 / 重新發起）
      if (!$("s-photos").classList.contains("on")) { cancelSim(); return; }
      if (i > 0) { items[i - 1].classList.remove("doing"); items[i - 1].classList.add("on"); }
      if (i >= items.length) {
        later(function () {
          if (my !== simToken) return;
          box.hidden = true;
          if (btn) { btn.disabled = false; btn.textContent = btn.dataset.old; delete btn.dataset.busy; }
          done();
        }, 320);
        return;
      }
      items[i].classList.add("doing", "on");
      i++;
      later(tick, 620);
    })();
    box.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function search(mode) {
    if (phEvent === "e1" && !isPostRace()) {
      toast("本場比賽還沒有舉行，賽後纔有照片（演示）");
      go("photos");
      return;
    }
    phCtx.mode = mode;
    var all = DEMO.photos.filter(function (p) { return p.ev === phEvent; });
    var list;
    if (mode === "all") {
      list = all;
    } else if (mode === "unmatched") {
      list = all.filter(function (p) { return p.unmatched; });
    } else {
      var want = origBib(phCtx.bib);
      var hits = all.filter(function (p) { return p.bib === want && !p.unmatched; });
      if (SC.ai === "none") list = [];
      else if (SC.ai === "low") list = hits.filter(function (p) { return p.conf < 70; });
      else list = hits;
    }
    phCtx.list = list;
    go("photores");
  }

  $("ph-bib-go").addEventListener("click", function () {
    var v = $("ph-bib").value.trim();
    var err = $("ph-bib-err");
    if (!/^\d{3,6}$/.test(v)) {
      err.hidden = false; err.textContent = "請輸入 3–6 位數字的號碼布號碼。演示可查：3247、1188、2077、1001（換號後用新號也能搜到）";
      return;
    }
    err.hidden = true;
    phCtx.bib = parseInt(v, 10);
    simSteps(["讀取號碼布 " + v, "在 " + DEMO.metrics.photosUp.toLocaleString() + " 張照片裏檢索（演示模擬）", "整理匹配結果"],
      this, function () { search("bib"); });
  });

  $("ph-selfie-go").addEventListener("click", function () {
    if (!S.authz.ai) { toast("你已拒絕 AI 識別授權，自拍找圖不可用"); return; }
    phCtx.bib = 3247;
    simSteps(["上傳中（演示：圖片未離開瀏覽器）", "正在分析人臉特徵", "正在與本場照片匹配", "找到結果"],
      this, function () { search("selfie"); });
  });

  $("ph-all-go").addEventListener("click", function () { search("all"); });
  $("pr-try-selfie").addEventListener("click", function () { go("photos"); setTimeout(function () { $("ph-drop").scrollIntoView({ block: "center", behavior: "smooth" }); }, 60); });
  $("pr-browse-un").addEventListener("click", function () { search("unmatched"); });
  $("pr-manual").addEventListener("click", function () {
    toast("已提交人工補充查找（演示）。真實產品裏這會進運營後臺的待辦隊列。");
  });

  var prFilter = "all";
  var FILTERS = [["all", "全部"], ["start", "起點"], ["course", "賽道"], ["aid", "補給點"], ["finish", "終點"], ["hi", "號碼布清晰"], ["mid", "待人工確認"]];

  function filtered() {
    return phCtx.list.filter(function (p) {
      if (prFilter === "all") return true;
      if (prFilter === "hi") return p.conf >= 90;
      if (prFilter === "mid") return p.conf > 0 && p.conf < 90;
      return p.zone === prFilter;
    });
  }

  function confCls(v) { return v >= 90 ? "hi" : v >= 70 ? "mid" : "low"; }

  function renderPhotoRes() {
    var ev = evById(phEvent);
    var modeTxt = { bib: "號碼布 " + phCtx.bib, selfie: "自拍識別", all: "瀏覽全部照片", unmatched: "尚未關聯號碼布的照片" }[phCtx.mode];
    $("pr-sub").innerHTML = ev.t + "　·　查找方式：<b>" + modeTxt + "</b>　·　找到 <b>" + phCtx.list.length + "</b> 張";

    var sp = ev.photoSponsor ? sponsorById(ev.photoSponsor) : null;
    $("pr-sponsor").hidden = !(sp && SC.sponsorFree);

    var fw = $("pr-filters");
    fw.innerHTML = "";
    FILTERS.forEach(function (f) {
      var b = document.createElement("button");
      b.className = "tab" + (f[0] === prFilter ? " on" : "");
      b.textContent = f[1];
      b.addEventListener("click", function () { prFilter = f[0]; renderPhotoRes(); });
      fw.appendChild(b);
    });

    var grid = $("pr-grid"), list = filtered();
    grid.innerHTML = "";
    var emptyBox = $("pr-empty");

    if (!phCtx.list.length) {
      emptyBox.innerHTML = '<div class="empty"><b>這場比賽沒有找到你的照片</b>' +
        (SC.ai === "none"
          ? "可能是號碼布被衣服或補給擋住了，也可能攝影師只拍到了你的背影。"
          : "請確認賽事和號碼布號碼，或者瀏覽本場全部照片。") +
        "</div>";
      return;
    }
    emptyBox.innerHTML = "";
    if (SC.ai === "low" && phCtx.mode !== "all") {
      emptyBox.innerHTML = '<div class="demo-bar" style="margin-top:1rem">這幾張照片<b>號碼布拍得不清楚</b>，工作人員標記時不太確定。請自己確認一下，點「確認是我」或「不是我的照片」，你的反饋會回到後臺由人工複覈。</div>';
    }

    list.forEach(function (p) {
      var cl = claimOf(p.id), mine = S.notMine.indexOf(p.id) >= 0;
      var b = document.createElement("button");
      b.className = "pcard";
      b.innerHTML =
        '<div class="pcard-img"><canvas data-photo="' + p.id + '"></canvas>' +
        (p.bib ? '' : '<span class="conf low">待關聯號碼布</span>') +
        (SC.sponsorFree && evById(p.ev).photoSponsor ? '<span class="pfree">可免費領</span>' : '') +
        (cl ? '<span class="pflag">' + (cl.kind === "buy" ? "已購買" : cl.kind === "free" ? "已領取" : "已認領") + '</span>' : (mine ? '<span class="pflag">已標記不是我</span>' : '')) +
        (SC.sponsorFree && evById(p.ev).photoSponsor ? '<span class="wm">RUN · BLUEWAVE SPORTS DRINK（演示水印）</span>' : '') +
        '</div>' +
        '<div class="pcard-body"><b style="font-size:.88rem">' + p.spot + '</b>' +
        '<span class="meta">' + p.km + ' km · ' + p.time + ' · ' + p.by + '</span></div>';
      b.addEventListener("click", function () { curPhoto = p.id; go("photo"); });
      grid.appendChild(b);
    });
    requestAnimationFrame(paintAll);
  }

  function renderPhotoDetail() {
    var p = photoById(curPhoto);
    if (!p) { go("photores"); return; }
    var ev = evById(p.ev);
    var sp = ev.photoSponsor ? sponsorById(ev.photoSponsor) : null;
    var free = !!(sp && SC.sponsorFree);
    var cl = claimOf(p.id);

    $("pd-big").innerHTML = '<canvas data-photo-big="' + p.id + '"></canvas>' +
      (free ? '<span class="wm">RUN · ' + sp.n.toUpperCase() + '　演示水印</span>' : '');

    $("pd-kv").innerHTML = [
      ["賽事", ev.t], ["號碼布", p.blocked ? "拍攝中被遮擋" : (p.bib || "尚未關聯")],
      ["拍攝時間", p.time], ["拍攝位置", p.spot],
      ["公里數", p.km + " km"], ["攝影師", p.by],
      ["號碼布關聯", p.bib ? "已由工作人員關聯" : "尚未關聯號碼布"]
    ].map(function (r) { return "<div><span>" + r[0] + "</span><b>" + r[1] + "</b></div>"; }).join("");

    var box = $("pd-buybox");
    if (cl) {
      box.innerHTML = '<div class="side-price" style="color:var(--leaf);font-size:1.1rem">' +
        (cl.kind === "buy" ? "已購買" : cl.kind === "free" ? "已免費領取" : "已認領") + '</div>' +
        '<p class="side-note">這張照片已經在「我的照片」裏了。</p>' +
        '<button class="btn wide" id="pd-share">分享這張照片</button>' +
        (free ? '<button class="btn wide ghost" id="pd-coupon">領取 ' + sp.n + ' 優惠券</button>' : '') +
        '<button class="btn wide ghost" data-go="me-photos">去「我的照片」</button>';
    } else if (free) {
      box.innerHTML =
        '<div class="sponsor-strip" style="margin:0 0 .8rem"><div class="ad-sq">' + sp.short + '</div>' +
        '<div><b>本場照片由 ' + sp.n + ' 贊助</b><span>演示贊助商 · 原價 $4 的原圖，你可以免費領</span></div></div>' +
        '<div class="price-rows">' +
        '<button class="price-row free-row" id="pd-free"><span><b>免費領取這張原圖</b><span>帶賽事與品牌水印</span></span><span class="amt"><s>$4.00</s>免費</span></button>' +
        '<button class="price-row" id="pd-buy2"><span><b>無水印精修版</b><span>調色修圖，不含品牌水印</span></span><span class="amt">$9.00</span></button>' +
        '</div>' +
        '<button class="btn wide" id="pd-coupon">領取 ' + sp.n + ' 優惠券</button>' +
        '<div class="btn-row" style="margin-top:.5rem">' +
        '<button class="btn ghost sm" id="pd-fb">分享到 Facebook</button>' +
        '<button class="btn ghost sm" id="pd-tg">分享到 Telegram</button></div>' +
        '<p class="side-note">已有 ' + (DEMO.metrics.freeClaims + S.claims.length).toLocaleString() + ' 人領取本場贊助照片</p>';
    } else {
      box.innerHTML =
        '<div class="price-rows" style="margin-top:0">' +
        '<button class="price-row" id="pd-b1"><span><b>單張原圖</b><span>高清原圖，無修圖</span></span><span class="amt">$4.00</span></button>' +
        '<button class="price-row" id="pd-b2"><span><b>單張精修</b><span>調色 + 裁切</span></span><span class="amt">$9.00</span></button>' +
        '<button class="price-row" id="pd-b3"><span><b>本場全部照片包</b><span>你的所有照片，一次打包</span></span><span class="amt">$19.00</span></button>' +
        '</div>' +
        '<p class="side-note">演示模擬購買，不會進入真實 KHQR 支付。</p>';
    }

    var spBox = $("pd-sponsorbox");
    if (sp) {
      spBox.hidden = false;
      spBox.innerHTML = '<h5>本場照片贊助</h5><div class="ad-row">' +
        '<div class="ad-sq" style="background:' + sp.color + '">' + sp.short + '</div>' +
        '<div><b>' + sp.n + '</b><span>演示贊助商 · ' + sp.role + ' · 買斷本場照片權益</span></div></div>';
    } else spBox.hidden = true;

    function claim(kind, msg, btn) {
      withLock("claim-" + p.id, btn, "處理中…", function () {
        if (!claimOf(p.id)) { S.claims.push({ id: p.id, kind: kind, ev: p.ev }); save(); }
        toast(msg);
        renderPhotoDetail();
      });
    }
    var el;
    if ((el = $("pd-free"))) el.onclick = function () { claim("free", "已免費領取（演示）· 看板的領取量已 +1", this); };
    if ((el = $("pd-buy2"))) el.onclick = function () { claim("buy", "模擬支付成功 $9.00 · 已加入「我的照片」", this); };
    if ((el = $("pd-b1"))) el.onclick = function () { claim("buy", "模擬支付成功 $4.00 · 已加入「我的照片」", this); };
    if ((el = $("pd-b2"))) el.onclick = function () { claim("buy", "模擬支付成功 $9.00 · 已加入「我的照片」", this); };
    if ((el = $("pd-b3"))) el.onclick = function () { claim("buy", "模擬支付成功 $19.00 · 本場照片已全部解鎖", this); };
    if ((el = $("pd-coupon"))) el.onclick = function () {
      var b = this;
      withLock("coupon-bw", b, "領取中…", function () {
        if (S.coupons.some(function (c) { return c.id === "cp-bw"; })) { toast("這張券已經領過了"); return; }
        S.coupons.push({ id: "cp-bw", n: sp.n + " 全場 8 折", code: "RUN-BW-8842", exp: "2026.09.30", used: false });
        save(); toast("優惠券已領取 · 去「我的 → 我的優惠券」查看");
      });
    };
    function shareTxt() {
      return "我在 " + ev.t + " 的照片！" + p.spot + " · " + p.km + " km" +
        (free ? "　照片由 " + sp.n + " 贊助免費提供。" : "") + " #RUN #柬埔寨跑步（演示文案）";
    }
    if ((el = $("pd-fb"))) el.onclick = function () { openShare("分享到 Facebook", shareTxt()); };
    if ((el = $("pd-tg"))) el.onclick = function () { openShare("分享到 Telegram", shareTxt()); };
    if ((el = $("pd-share"))) el.onclick = function () { openShare("分享照片", shareTxt()); };

    var msg = $("pd-msg");
    msg.hidden = true;
    $("pd-yes").onclick = function () {
      if (!claimOf(p.id)) { S.claims.push({ id: p.id, kind: "claim", ev: p.ev }); }
      var ix = S.notMine.indexOf(p.id); if (ix >= 0) S.notMine.splice(ix, 1);
      save(); toast("已確認是你，照片已存入「我的照片」"); renderPhotoDetail();
    };
    $("pd-no").onclick = function () {
      if (S.notMine.indexOf(p.id) < 0) S.notMine.push(p.id);
      S.claims = S.claims.filter(function (c) { return c.id !== p.id; });
      save();
      msg.hidden = false;
      msg.textContent = "已標記「不是我的照片」。演示裏這條反饋會回到後臺，由工作人員複覈號碼布標記，並把這張照片從你的結果裏移除。";
      renderPhotoRes();
    };
    $("pd-report").onclick = function () {
      msg.hidden = false;
      msg.textContent = "已回報號碼布標記有誤（演示）。真實產品裏會進人工複覈隊列，處理結果將在照片狀態中更新。";
    };
    $("pd-del").onclick = function () {
      if (S.delReq.indexOf(p.id) < 0) S.delReq.push(p.id);
      save();
      msg.hidden = false;
      msg.textContent = "已提交刪除申請（演示）。真實產品裏需要覈驗你確實是照片中本人，覈驗通過後從公開檢索中移除。";
      toast("刪除申請已提交，可在「我的照片」裏查看狀態");
    };

    requestAnimationFrame(paintAll);
  }

  /* ================================================================
     v3 · 成績查詢與完賽證書
     ================================================================ */

  var rsEvent = "e1", curRes = null;

  function resultEvents() { return DEMO.events.filter(function (e) { return e.hasResults; }); }

  function renderResultDetail() {
    var r = curRes;
    if (!r) { go("results"); return; }
    var ev = evById(r.ev);

    /* ⚖️ D-117 B1 / B5 / B6 · 所有成績入口共用<b>同一份</b>發佈事實：
       比賽得先發生（階段），而且這一組的 ResultBatch 得是 PUBLISHED。
       缺任何一個，這一頁都不能把它當作「當前正式成績」展示，證書一併暫停。
       ⚠️ 判定按組別算（r.cat 解析成共享 Category），不會一撤全撤。 */
    if (r.ev === "e1" && !published("h0", r.cat)) {
      var rdNote = resultBlockNote("h0", r.cat);
      $("rd-title").textContent = ev.t;
      $("rd-sub").textContent = ev.d + " · " + (rdNote.key === "notyet" ? phaseLabel() : rdNote.title);
      $("rd-body").innerHTML =
        '<div class="card"><h4>' + h(rdNote.title) + '</h4>' +
        '<p class="mut">' + h(r.cat) + '：' + rdNote.body + '</p>' +
        '<div class="btn-row" style="margin-top:.9rem">' +
        '<button class="btn ghost" disabled>' +
        (rdNote.key === "review" ? "成績複覈中，證書暫不可生成" : "完賽證書暫不可生成") + '</button>' +
        (rdNote.key === "notyet" ? '<button class="btn sm" data-phase="post">模擬進入賽後</button>' : '') +
        '<button class="btn ghost sm" data-go="results">去成績庫看往期比賽</button></div></div>';
      return;
    }
    $("rd-title").textContent = r.name + " · " + r.cat;
    $("rd-sub").textContent = ev.t + " · " + ev.d + " · 號碼布 " + r.bib;

    var body = $("rd-body");
    var stCls = r.status === "FIN" ? "ok" : r.status === "PENDING" ? "wait" : "no";
    var stTxt = { FIN: "完賽 FINISHED", DNF: "DNF · 未完賽", DNS: "DNS · 未出發", PENDING: "成績處理中" }[r.status];

    var html = "";

    if (r.status === "FIN") {
      html += '<div class="res-hero">' +
        '<span class="res-state ' + stCls + '">' + stTxt + '</span>' +
        '<div class="res-time" style="margin-top:.6rem">' + r.net + '<small>淨成績 · 槍聲成績 ' + r.gun + ' · 起跑 ' + r.start + '</small></div>' +
        '<div class="res-ranks">' +
        '<div><b>' + r.rank + '/' + r.total + '</b><span>總排名</span></div>' +
        '<div><b>' + r.gRank + '/' + r.gTotal + '</b><span>性別排名</span></div>' +
        '<div><b>' + r.aRank + '/' + r.aTotal + '</b><span>' + r.ageGroup + ' 組</span></div>' +
        '</div></div>';
    } else {
      html += '<div class="res-hero"><span class="res-state ' + stCls + '">' + stTxt + '</span>' +
        '<p style="margin:.7rem 0 0;color:var(--ink-mid);font-size:.9rem">' + (r.note || "") + '</p></div>';
    }

    if (r.splits.length) {
      html += '<div class="card"><h4>分段成績</h4><div class="scroll-x"><table class="tbl">' +
        '<thead><tr><th>分段</th><th class="n">累計用時</th><th class="n">配速</th></tr></thead><tbody>' +
        r.splits.map(function (s) {
          return "<tr><td>" + s[0] + "</td><td class='n'>" + s[1] + "</td><td class='n'>" + s[2] + "</td></tr>";
        }).join("") + '</tbody></table></div></div>';
    }

    if (r.status === "FIN") {
      html += '<h4 style="margin:1.6rem 0 .7rem;font-size:1rem">電子完賽證書<span class="new-tag">新</span><span class="demo-tag">演示</span></h4>' +
        '<div class="cert-wrap is-new"><canvas data-cert="1"></canvas></div>' +
        '<div class="btn-row"><button class="btn" id="rd-dl">下載證書</button>' +
        '<button class="btn ghost" id="rd-share">分享證書</button>' +
        '<button class="btn ghost" id="rd-photos">查找我這場的照片</button></div>';
    } else {
      html += '<div class="card"><h4>完賽證書</h4><p class="mut">只有完賽（FIN）的成績纔會生成電子完賽證書。' +
        (r.status === "PENDING" ? "成績處理完成後，證書會自動出現在這裏。" : "") + '</p>' +
        '<div class="btn-row" style="margin-top:.8rem"><button class="btn ghost" disabled>生成證書</button>' +
        '<button class="btn ghost" id="rd-photos2">仍然可以找照片</button></div></div>';
    }

    body.innerHTML = html;

    var el;
    if ((el = $("rd-dl"))) el.onclick = function () {
      var cv = document.querySelector("[data-cert]");
      try {
        var a = document.createElement("a");
        a.href = cv.toDataURL("image/png");
        a.download = "RUN-完賽證書-演示.png";
        a.click();
        toast("證書已下載爲圖片（演示：正式版會出 PDF）");
      } catch (e) { toast("演示環境無法導出，正式版會生成 PDF"); }
    };
    if ((el = $("rd-share"))) el.onclick = function () {
      openShare("分享完賽證書", "我完成了 " + ev.t + " " + r.cat + "，淨成績 " + r.net + "！ #RUN #柬埔寨跑步（演示文案）");
    };
    function toPhotos() { phEvent = r.ev; phCtx.bib = r.bib; $("ph-bib").value = String(r.bib); go("photos"); }
    if ((el = $("rd-photos"))) el.onclick = toPhotos;
    if ((el = $("rd-photos2"))) el.onclick = toPhotos;

    requestAnimationFrame(function () {
      var cv = document.querySelector("[data-cert]");
      if (cv) paintCert(cv, r, ev);
    });
  }

  /* ================================================================
     v3 · 個人中心
     ================================================================ */

  var meTab = "races";
  var ME_TABS_I18N = {
    zh: [["races", "我的賽事"], ["history", "我的跑步履歷"], ["posts", "我發佈的"], ["photos", "我的照片"], ["coupons", "我的優惠券"], ["profile", "個人資料"]],
    en: [["races", "My Races"], ["history", "My Running Record"], ["posts", "My Posts"], ["photos", "My Photos"], ["coupons", "My Coupons"], ["profile", "Profile Settings"]],
    km: [["races", "ការប្រកួតរបស់ខ្ញុំ"], ["history", "ប្រវត្តិរត់របស់ខ្ញុំ"], ["posts", "ការបង្ហោះរបស់ខ្ញុំ"], ["photos", "រូបថតរបស់ខ្ញុំ"], ["coupons", "ប័ណ្ណបញ្ចុះតម្លៃ"], ["profile", "ការកំណត់កម្រងព័ត៌មាន"]]
  };

  function renderMe(tab) {
    if (tab) meTab = tab;
    var subNote = LANG === 'en' ? ' · Demo Account, No Login Required'
      : (LANG === 'km' ? ' · គណនីគំរូ មិនបាច់ចូលប្រើ'
      : ' · 演示賬號，不需要登錄');
    $("me-sub").textContent = DEMO.user.name + " · " + DEMO.user.phone + subNote;
    var tw = $("me-tabs");
    tw.innerHTML = "";
    var tabList = ME_TABS_I18N[LANG] || ME_TABS_I18N.zh;
    tabList.forEach(function (t) {
      var b = document.createElement("button");
      b.className = "tab" + (t[0] === meTab ? " on" : "");
      b.textContent = t[1];
      b.addEventListener("click", function () { renderMe(t[0]); });
      tw.appendChild(b);
    });
    var body = $("me-body");
    body.innerHTML = "";
    if (meTab === "races") renderMeRaces(body);
    else if (meTab === "history") renderMeHistory(body);
    else if (meTab === "posts") renderMePosts(body);
    else if (meTab === "photos") renderMePhotos(body);
    else if (meTab === "coupons") renderMeCoupons(body);
    else renderMeProfile(body);
    requestAnimationFrame(paintAll);
  }

  function renderMeRaces(body) {
    /* D-092 · 付費報名來自<b>共享 Mock 業務域</b>：與運營後臺是同一批對象。
       免費活動仍然是用戶端本地的演示數據（不在 D-092 範圍內）。 */
    var dom = RD.myOrders(MY_UID);
    var localRegs = S.regs.filter(function (r) { return r.kind === "free" || !r.domainId; });
    if (!localRegs.length && !dom.length) {
      body.innerHTML = '<div class="empty"><b>還沒有報名記錄</b>去首頁挑一場比賽，或者先參加一次免費活動。</div>';
      body.appendChild(merchEntryCard());
      return;
    }
    dom.slice().reverse().forEach(function (o) { body.appendChild(domainOrderCard(o)); });
    localRegs.slice().reverse().forEach(function (reg) {
      var ev = evById(reg.ev);
      if (!ev) return;
      body.appendChild(reg.kind === "free" ? freeRegCard(reg, ev) : orderCard(reg, ev));
    });
    body.appendChild(merchEntryCard());
  }

  /* 周邊入口：放在「我的賽事」裏，但明確寫清它是<b>另一條訂單鏈路</b> */
  function merchEntryCard() {
    var d = document.createElement("div");
    d.className = "card";
    d.style.marginTop = "1.2rem";
    d.innerHTML = '<h4>RUN 周邊商品</h4>' +
      '<p class="mut">周邊是<b>獨立的訂單與獨立的支付</b>：報名流程裏不會出現周邊選購，' +
      '周邊訂單也不會影響你的參賽資格。</p>' +
      '<div class="btn-row" style="margin-top:.7rem">' +
      '<button class="btn sm" data-go="shop">去看周邊</button>' +
      '<button class="btn sm ghost" data-go="moorders">我的周邊訂單</button></div>';
    return d;
  }

  function stTag(k) {
    var m = { registered: ["已報名", "ok"], waitlist: ["候補中", "warn"], cancelled: ["已取消", "bad"],
      finished: ["已完賽", "free"], unpaid: ["待支付", "warn"] }[k] || ["—", ""];
    return '<span class="st ' + m[1] + '">' + m[0] + '</span>';
  }
  function mkBtn(label, fn, ghost) {
    var b = document.createElement("button");
    b.className = "btn sm" + (ghost ? " ghost" : "");
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  /* ---- 免費活動：一條一人 ---- */
  function freeRegCard(reg, ev) {
    var d = document.createElement("div");
    d.className = "me-item";
    d.innerHTML = '<div class="me-main"><b>' + h(ev.t) + '　' + stTag(reg.status) +
      ' <span class="st free">免費活動</span></b>' +
      '<div class="me-meta">' + h(ev.d) + " · " + h(reg.cat) + " · 編號 " + h(reg.code) + '</div>' +
      (reg.status === "cancelled" ? '<div class="me-meta" style="color:var(--stop)">電子憑證已失效</div>' : '') +
      '<div class="me-acts"></div></div>';
    var acts = d.querySelector(".me-acts");
    if (reg.status === "registered") {
      acts.appendChild(mkBtn("查看憑證", function () { lastFreeReg = reg; go("freedone"); }));
      acts.appendChild(mkBtn("取消報名", function () {
        var btn = this;
        withLock("cancel-" + reg.id, btn, "取消中…", function () {
          if (reg.status === "cancelled") return;
          reg.status = "cancelled"; mirrorFreeCancel(reg); save();
          toast("報名已取消，名額已釋放（演示）"); renderRaceLists(); renderMe();
        });
      }, true));
    }
    if (reg.status === "waitlist") {
      acts.appendChild(mkBtn("退出候補", function () {
        reg.status = "cancelled"; mirrorFreeCancel(reg); save(); toast("已退出候補"); renderRaceLists(); renderMe();
      }, true));
    }
    if (reg.status === "cancelled") {
      acts.appendChild(mkBtn("重新報名", function () { curFree = ev.id; go("freedetail"); }));
    }
    return d;
  }

  /* ---- 付費賽事：Order 外層 + 每位 Participant 一行 ---- */
  function orderCard(reg, ev) {
    var parts = reg.parts && reg.parts.length ? reg.parts : null;
    var alive = parts ? parts.filter(function (p) { return p.status !== "cancelled"; }).length : (reg.status === "cancelled" ? 0 : 1);
    if (parts && !alive) reg.status = "cancelled";

    var d = document.createElement("div");
    d.className = "me-item";
    d.innerHTML =
      '<div class="me-main">' +
        '<b>' + h(ev.t) + '　' + stTag(reg.status) + '</b>' +
        '<div class="me-meta">' + h(ev.d) + ' · 訂單 ' + h(reg.code) +
          (parts ? ' · ' + parts.length + ' 名參賽者（有效 ' + alive + '）' : ' · ' + h(reg.cat)) +
          ' · ' + money(reg.paid) + '</div>' +
        (parts ? '<div class="ord-parts"></div>' : '') +
        '<div class="me-acts"></div>' +
      '</div>';

    var box = d.querySelector(".ord-parts");
    if (parts) parts.forEach(function (pt, i) { box.appendChild(partRow(reg, ev, pt, i)); });

    var acts = d.querySelector(".me-acts");
    if (reg.status === "cancelled") {
      acts.appendChild(mkBtn("重新報名", function () { go("detail"); }));
    } else if (isPostRace() && ev.hasPhotos) {
      acts.appendChild(mkBtn("找這場的照片", function () { phEvent = ev.id; go("photos"); }, true));
    } else if (!isPostRace()) {
      var note = document.createElement("span");
      note.className = "mut";
      note.style.fontSize = ".78rem";
      note.textContent = packOpen()
        ? "領物期：憑電子憑證到領物點領取參賽包。成績與照片在賽後發佈。"
        : "成績、證書與照片將在比賽結束後發佈。";
      acts.appendChild(note);
    }
    return d;
  }

  var curCred = null;   // {reg, pid} —— 從「我的賽事」進入憑證時的上下文

  function partRow(reg, ev, pt, i) {
    var cancelled = pt.status === "cancelled";
    var row = document.createElement("div");
    row.className = "ord-part" + (cancelled ? " off" : "");
    row.innerHTML =
      '<div class="op-main">' +
        '<b>' + h(pt.name) + '</b>' +
        '<span>' + h(catById(pt.catId).n + " " + catById(pt.catId).d) + ' · Bib ' +
        (cancelled ? '—' : '<code>' + effBib(pt.bib) + '</code>') +
        ' · 尺碼 ' + h(pt.size) + ' · ' + AUD[pt.aud].s + '</span>' +
      '</div>' +
      '<span class="op-st ' + (cancelled ? "bad" : "ok") + '">' + (cancelled ? "已取消" : "已確認") + '</span>' +
      '<div class="op-acts"></div>';

    var acts = row.querySelector(".op-acts");
    if (cancelled) {
      var x = document.createElement("span");
      x.className = "mut"; x.style.fontSize = ".76rem";
      x.textContent = "憑證已失效，不可用於領物";
      acts.appendChild(x);
      return row;
    }
    acts.appendChild(mkBtn("查看憑證", function () { curCred = { reg: reg, pid: pt.pid }; go("done"); }));
    if (isPostRace()) {
      acts.appendChild(mkBtn("查看成績", function () {
        var hit = findBoardRowByBib(effBib(pt.bib));
        if (hit) { curPerma = hit; go("presult"); }
        else { curPerma = { pending: true, bib: effBib(pt.bib) }; go("presult"); }
      }, true));
    }
    /* D-092 §5 · 已刪除「取消報名 → 直接取消並釋放名額」這個 Magic UI。
       付費報名一期是<b>人工退款</b>：用戶只能提出訴求，Refund 由客服 / 財務在後臺創建，
       名額也只有在退款<b>結算</b>那一步才釋放，而且只釋放一次。 */
    var noCancel = document.createElement("span");
    noCancel.className = "mut";
    noCancel.style.fontSize = ".76rem";
    noCancel.textContent = "需要退款請聯繫客服（付費報名不支持自助取消）";
    acts.appendChild(noCancel);
    return row;
  }

  function renderMePhotos(body) {
    if (!S.claims.length && !S.delReq.length) {
      body.innerHTML = '<div class="empty"><b>還沒有照片</b>去「找我的照片」輸入號碼布查一下，找到後點「確認是我」就會存到這裏。' +
        '<div style="margin-top:.9rem"><button class="btn sm" data-go="photos">去找照片</button></div></div>';
      return;
    }
    var groups = [["free", "贊助商免費領取"], ["buy", "已購買"], ["claim", "已認領 · 未購買"]];
    groups.forEach(function (g) {
      var list = S.claims.filter(function (c) { return c.kind === g[0]; });
      if (!list.length) return;
      var h = document.createElement("h4");
      h.style.cssText = "margin:1.2rem 0 .7rem;font-size:1rem";
      h.textContent = g[1] + "（" + list.length + "）";
      body.appendChild(h);
      var grid = document.createElement("div");
      grid.className = "pgrid";
      list.forEach(function (c) {
        var p = photoById(c.id); if (!p) return;
        var b = document.createElement("button");
        b.className = "pcard";
        b.innerHTML = '<div class="pcard-img"><canvas data-photo="' + p.id + '"></canvas>' +
          '<span class="pflag">' + g[1] + '</span></div>' +
          '<div class="pcard-body"><b style="font-size:.86rem">' + p.spot + '</b>' +
          '<span class="meta">' + p.km + ' km · ' + p.time + '</span></div>';
        b.addEventListener("click", function () { curPhoto = p.id; go("photo"); });
        grid.appendChild(b);
      });
      body.appendChild(grid);
    });
    if (S.delReq.length) {
      var d = document.createElement("div");
      d.className = "card";
      d.style.marginTop = "1.3rem";
      d.innerHTML = "<h4>刪除申請處理中（" + S.delReq.length + "）</h4>" +
        '<p class="mut">演示狀態：已提交，等待人工覈驗你確實是照片中本人。覈驗通過後會從公開檢索裏移除。</p>';
      body.appendChild(d);
    }
  }

  function renderMeCoupons(body) {
    var all = S.coupons.slice();
    if (!all.length) {
      body.innerHTML = '<div class="empty"><b>還沒有優惠券</b>報名成功頁和贊助商照片頁可以領券。' +
        '<div style="margin-top:.9rem"><button class="btn sm" data-go="photos">去看贊助商照片</button></div></div>';
      return;
    }
    all.forEach(function (c) {
      var d = document.createElement("div");
      d.className = "me-item";
      d.innerHTML = '<div class="me-main"><b>' + c.n + '　<span class="st ' + (c.used ? "" : "ok") + '">' +
        (c.used ? "已使用" : "可使用") + '</span></b>' +
        '<div class="me-meta">券碼 ' + c.code + " · 有效期至 " + c.exp + '</div>' +
        '<div class="me-acts"></div></div>';
      var acts = d.querySelector(".me-acts");
      if (!c.used) {
        var b = document.createElement("button");
        b.className = "btn sm";
        b.textContent = "模擬核銷";
        b.addEventListener("click", function () {
          var bb = this;
          withLock("redeem-" + c.id, bb, "覈銷中…", function () {
            if (c.used) return;
            c.used = true; save();
            toast("已覈銷（演示）· 看板的券覈銷數 +1，這就是給贊助商看的轉化數據");
            renderMe();
          });
        });
        acts.appendChild(b);
      }
      body.appendChild(d);
    });
    var tip = document.createElement("div");
    tip.className = "card";
    tip.style.marginTop = "1rem";
    tip.innerHTML = '<h4>爲什麼券碼值錢</h4><p class="mut">曝光量只能說"有多少人看到"，' +
      '券的領取和核銷能說清"有多少人真的到店了"。這是招商時最有說服力的一組數字，' +
      '在主辦方看板的「贊助數據」裏可以看到它實時變化。</p>';
    body.appendChild(tip);
  }

  function renderMeProfile(body) {
    var u = DEMO.user;
    var card = document.createElement("div");
    card.className = "card";
    card.innerHTML = '<h4>個人資料<span class="demo-tag">演示賬號</span></h4><div class="kv">' +
      [["姓名", u.name], ["手機號", u.phone], ["性別", u.gender], ["出生日期", u.dob],
       ["國籍", u.nation], ["T恤尺碼", u.size], ["證件號", u.idNo], ["緊急聯繫人", u.ec + " " + u.ecPhone]]
        .map(function (r) { return "<div><span>" + r[0] + "</span><b>" + r[1] + "</b></div>"; }).join("") +
      '</div><div class="btn-row" style="margin-top:1rem">' +
      '<button class="btn ghost sm" data-todo="演示模型裏資料是隻讀的。正式版這裏可以編輯，並且改完之後下次報名會自動帶出新資料。">編輯資料</button>' +
      '<button class="btn quiet sm" data-todo="賬號註銷涉及訂單、成績和照片的留存規則，需要先定清楚政策再做。演示階段先不實現。">刪除賬號</button>' +
      '</div>';
    body.appendChild(card);

    var az = document.createElement("div");
    az.className = "card is-new";
    az.innerHTML = '<h4>照片與肖像授權<span class="new-tag">新</span><span class="demo-tag">演示流程</span></h4>' +
      '<p class="mut" style="margin-bottom:.8rem">可以隨時改。這兩項決定我們能不能在賽事現場拍到你，以及能不能把照片用在賽事回顧與宣傳裏。用號碼布查找自己的照片不受這裏影響。</p>' +
      '<div class="authz" id="me-authz"></div>' +
      '<p class="mut" style="margin-top:.8rem">正式條款需要柬埔寨當地律師起草與審覈，這裏只是把授權層級表現出來。</p>';
    body.appendChild(az);
    authzRows($("me-authz"), function () {
      toast("照片與肖像授權已更新（演示）");
    });
  }

  /* ================================================================
     v3 · 主辦方數據看板
     ================================================================ */

  function liveMetrics() {
    var m = DEMO.metrics;
    var freeClaims = S.claims.filter(function (c) { return c.kind === "free"; }).length;
    var buys = S.claims.filter(function (c) { return c.kind === "buy"; }).length;
    var myFree = S.regs.filter(function (r) { return r.kind === "free" && r.status === "registered"; }).length;
    var wl = S.regs.filter(function (r) { return r.status === "waitlist"; }).length;
    var cancel = S.regs.filter(function (r) { return r.status === "cancelled"; }).length;
    var used = S.coupons.filter(function (c) { return c.used; }).length;
    return {
      signups: m.signups + myFree, paid: m.paid, freeSignups: m.freeSignups + myFree,
      waitlist: m.waitlist + wl, cancelled: m.cancelled + cancel, revenue: m.revenue,
      checkin: m.checkin, finish: m.finish, dns: m.dns, dnf: m.dnf,
      finishRate: Math.round(m.finish / m.checkin * 100), avgTime: m.avgTime,
      photosUp: m.photosUp, photosTagged: m.photosTagged, runnersFound: m.runnersFound,
      photoSearch: m.photoSearch + (S.claims.length ? 1 : 0),
      photoClaims: m.photoClaims + S.claims.length,
      photoOrders: m.photoOrders + buys, photoRevenue: m.photoRevenue + buys * 9,
      adImpr: m.adImpr, freeClaims: m.freeClaims + freeClaims,
      couponGet: m.couponGet + S.coupons.length, couponUse: m.couponUse + used,
      shares: m.shares + S.shares, aidImpr: m.aidImpr,
      bnImpr: m.bnImpr + S.banner.impr, bnClick: m.bnClick + S.banner.click,
      bnCtr: ((m.bnClick + S.banner.click) / (m.bnImpr + S.banner.impr) * 100).toFixed(2),
      ugcPosts: m.ugcPosts + S.posts.length,
      ugcPending: m.ugcPending + S.posts.filter(function (p) { return p.status === "reviewing"; }).length,
      ugcRejected: m.ugcRejected + S.posts.filter(function (p) { return p.status === "rejected"; }).length,
      ugcJoins: m.ugcJoins + S.joins.length,
      ugcReports: m.ugcReports + S.reports.length,
      ugcFrozen: m.ugcFrozen + S.frozen.length,
      ugcViews: m.ugcViews + S.views.length,
      ugcConsent: m.ugcPosts + S.posts.length      // 留痕數必須等於發佈數
    };
  }

  function renderDash() {
    var m = liveMetrics();
    function kpi(v, label, live, bar) {
      return '<div class="kpi' + (live ? " live" : "") + '"><b>' + v + '</b><span>' + label + '</span>' +
        (bar != null ? '<div class="bar"><i style="width:' + bar + '%"></i></div>' : '') + '</div>';
    }
    var html = "";

    html += '<div class="dash-sec"><h3>1 · 報名數據</h3><div class="kpis">' +
      kpi(m.signups.toLocaleString(), "報名人數", true) +
      kpi(m.paid.toLocaleString(), "已支付") +
      kpi(m.freeSignups.toLocaleString(), "免費活動報名", true) +
      kpi(m.waitlist, "候補人數", true) +
      kpi(m.cancelled, "取消人數", true) +
      kpi("$" + m.revenue.toLocaleString(), "報名收入") +
      '</div></div>';

    html += '<div class="dash-sec"><h3>2 · 賽事數據</h3><div class="kpis">' +
      kpi(m.checkin.toLocaleString(), "簽到人數") +
      kpi(m.finish.toLocaleString(), "完賽人數") +
      kpi(m.dns, "DNS 未出發") +
      kpi(m.dnf, "DNF 未完賽") +
      kpi(m.finishRate + "%", "完賽率", false, m.finishRate) +
      kpi(m.avgTime, "平均成績") +
      '</div></div>';

    html += '<div class="dash-sec"><h3>3 · 照片數據</h3><div class="kpis">' +
      kpi(m.photosUp.toLocaleString(), "上傳照片") +
      kpi(m.photosTagged.toLocaleString(), "已關聯照片") +
      kpi(m.runnersFound + "%", "Bib 關聯率", false, m.runnersFound) +
      kpi(m.photoSearch.toLocaleString(), "照片搜索人數", true) +
      kpi(m.photoClaims.toLocaleString(), "照片領取量", true) +
      kpi(m.photoOrders, "照片購買訂單", true) +
      kpi("$" + m.photoRevenue.toLocaleString(), "照片收入", true) +
      '</div></div>';

    html += '<div class="dash-sec"><h3>4 · 贊助數據<span class="demo-tag">給贊助商看的</span></h3><div class="kpis">' +
      kpi(m.adImpr.toLocaleString(), "贊助曝光次數") +
      kpi(m.aidImpr.toLocaleString(), "補給點冠名展示") +
      kpi(m.freeClaims.toLocaleString(), "免費照片領取", true) +
      kpi(m.couponGet, "優惠券領取", true) +
      kpi(m.couponUse, "優惠券覈銷", true) +
      kpi(m.shares.toLocaleString(), "分享次數", true) +
      '</div>' +
      '<div class="card" style="margin-top:1rem"><h4>這一塊爲什麼重要</h4>' +
      '<p class="mut">曝光次數只能證明"有人看到"，而領取、分享和核銷能證明"有人真的動了"。' +
      '把這三個數字交給贊助商，談的就不是橫幅位價格，而是一次可衡量的品牌活動。</p></div>' +
      '</div>';

    html += '<div class="dash-sec"><h3>5 · 首頁 Banner<span class="demo-tag">新</span></h3><div class="kpis">' +
      kpi(m.bnImpr.toLocaleString(), "Banner 曝光", true) +
      kpi(m.bnClick.toLocaleString(), "Banner 點擊", true) +
      kpi(m.bnCtr + "%", "點擊率") +
      kpi("4", "輪播位數量") +
      kpi("1", "空位待招商") +
      '</div>' +
      '<div class="card" style="margin-top:1rem"><h4>怎麼賣這個位置</h4>' +
      '<p class="mut">四個位置裏兩個自用（賽事導流、拉 UGC）、一個已售、一個空着。' +
      '空着的那一張本身就是招商廣告，點進來直接看到這一頁的數字——不用另做媒體報價單。</p></div>' +
      '</div>';

    html += '<div class="dash-sec"><h3>6 · 跑友活動（用戶發佈）<span class="demo-tag">非官方主辦</span></h3><div class="kpis">' +
      kpi(m.ugcPosts.toLocaleString(), "累計發佈", true) +
      kpi(m.ugcPending, "待審覈", true) +
      kpi(m.ugcRejected, "審覈駁回", true) +
      kpi(m.ugcJoins.toLocaleString(), "報名意向登記", true) +
      kpi(m.ugcReports, "被舉報次數", true) +
      kpi(m.ugcFrozen, "緊急凍結", true) +
      kpi(m.ugcViews.toLocaleString(), "聯繫方式查看", true) +
      kpi(m.ugcConsent.toLocaleString(), "免責聲明留痕", true) +
      '</div>' +
      '<div class="card" style="margin-top:1rem"><h4>這兩個數字必須永遠相等</h4>' +
      '<p class="mut"><b>累計發佈 = 免責聲明留痕</b>。只要對不上，就說明有活動繞過了簽署流程發出去了，' +
      '這在出事時是沒法解釋的。上線後建議做成日巡檢告警，而不是等出事再查。</p></div>' +
      '<div class="card"><h4>這一區的邊界</h4>' +
      '<p class="mut">跑友活動全部爲<b>用戶自主發佈、非 RUN 官方主辦</b>，平臺只做信息發佈與報名意向記錄，' +
      '<b>不代收任何費用</b>，展示不構成對活動安全、質量或真實性的擔保；平臺責任範圍以正式平臺規則、用戶協議及適用法律爲準。' +
      '「聯繫方式查看」是演示級前端留痕，正式系統必須由服務端記錄並接入風控。</p></div>' +
      '</div>';

    $("dash-body").innerHTML = html;
  }

  $("dash-reset").addEventListener("click", function () {
    if (confirmReset()) resetDemo();
  });
  function confirmReset() { return true; }

  /* ================================================================
     v4 · 首頁廣告 Banner（輪播）
     ================================================================ */

  var BANNERS = [
    { id: "bn1", kind: "ad", eyebrow: "BLUEWAVE · 官方補給夥伴",
      title: "跑完這一場，第一口該補的是電解質",
      sub: "憑任意 RUN 參賽憑證到金邊 12 家門店，全場 8 折",
      cta: "領取 8 折券", act: "coupon",
      bg: "linear-gradient(115deg,#0F66AE,#3FA9E8 68%,#6FC1F2)",
      note: "第 1 張 · 贊助商品牌廣告（按週售賣）" },
    { id: "bn2", kind: "own", eyebrow: "RUN 官方 · 早鳥報名",
      title: "吳哥日出跑 2026 · 8 月 20 日開搶",
      sub: "06:00 從吳哥窟護城河出發，限 1200 人，早鳥價 $25",
      cta: "看賽事詳情", act: "detail",
      bg: "linear-gradient(115deg,#E2762C,#F0A93C 65%,#FFC96B)",
      note: "第 2 張 · 自家賽事導流（不賣，留給自己）" },
    { id: "bn3", kind: "own", eyebrow: "跑友活動 · 新功能",
      title: "你也可以在這裡發起一次跑步",
      sub: "發布圖文活動，聯絡方式預設脫敏，報名意向登記後按你的設定顯示",
      cta: "去發布活動", act: "post",
      bg: "linear-gradient(115deg,#1E8A66,#3EB489 65%,#6FD9B0)",
      note: "第 3 張 · 平臺自運營（拉 UGC 供給）" },
    { id: "bn4", kind: "open", eyebrow: "招商中",
      title: "這個位置正在招商",
      sub: "首頁橫幅版位，日均約 1,400 次曝光，可按週或按賽事週期投放",
      cta: "看廣告位數據", act: "adinfo",
      bg: "linear-gradient(115deg,#12395C,#17486F 68%,#2C6B9C)",
      note: "第 4 張 · 空位。談廣告時就把這一張指給客戶看" }
  ];

  var bnIdx = 0, bnTimer = null, bnPaused = false;

  function buildBanner() {
    var track = $("hb-track"), dots = $("hb-dots");
    if (!track) return;
    track.innerHTML = ""; dots.innerHTML = "";
    BANNERS.forEach(function (b, i) {
      var s = document.createElement("button");
      s.type = "button";
      s.className = "hbanner-slide";
      s.style.background = b.bg;
      s.innerHTML =
        '<p class="bn-eyebrow">' + b.eyebrow +
          (b.kind === "ad" ? '<span class="bn-tag">廣告</span>' : '') +
          (b.kind === "open" ? '<span class="bn-tag">空位</span>' : '') + '</p>' +
        '<h3>' + b.title + '</h3>' +
        '<p>' + b.sub + '</p>' +
        '<span class="bn-cta">' + b.cta + ' →</span>';
      s.addEventListener("click", function () { bannerClick(b); });
      track.appendChild(s);

      var d = document.createElement("button");
      d.type = "button";
      d.setAttribute("aria-label", "第 " + (i + 1) + " 張");
      d.addEventListener("click", function () { showBanner(i, true); });
      dots.appendChild(d);
    });
    showBanner(0, false);

    $("hb-prev").addEventListener("click", function () { showBanner(bnIdx - 1, true); });
    $("hb-next").addEventListener("click", function () { showBanner(bnIdx + 1, true); });

    var box = $("hbanner");
    box.addEventListener("mouseenter", function () { bnPaused = true; });
    box.addEventListener("mouseleave", function () { bnPaused = false; });
    box.addEventListener("focusin", function () { bnPaused = true; });
    box.addEventListener("focusout", function () { bnPaused = false; });
  }

  function showBanner(i, manual) {
    var n = BANNERS.length;
    bnIdx = ((i % n) + n) % n;
    var track = $("hb-track");
    if (track) track.style.transform = "translateX(-" + (bnIdx * 100) + "%)";
    var ds = $("hb-dots").children;
    for (var k = 0; k < ds.length; k++) ds[k].classList.toggle("on", k === bnIdx);
    $("hb-note").textContent = BANNERS[bnIdx].note;
    // 每次展示計一次曝光，主辦方看板裏能看到它在漲
    S.banner.impr++; save();
    if (manual) startBanner();
  }

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function startBanner() {
    stopBanner();
    if (reduceMotion) return;                 // 用戶關了動效就不自動輪播
    bnTimer = every(function () { if (!bnPaused) showBanner(bnIdx + 1, false); }, 6000);
  }
  function stopBanner() { if (bnTimer) { clearInterval(bnTimer); bnTimer = null; } }

  function bannerClick(b) {
    S.banner.click++; save();
    if (b.act === "coupon") {
      if (!S.coupons.some(function (c) { return c.id === "cp-bw"; })) {
        S.coupons.push({ id: "cp-bw", n: "BlueWave Sports Drink 全場 8 折", code: "RUN-BW-8842",
          exp: "2026.09.30", used: false });
        save();
        toast("8 折券已放進「我的優惠券」（演示）");
      } else toast("這張券你已經領過了");
      go("me-coupons");
    } else if (b.act === "detail") {
      toast("演示裏只有金邊濱河半馬做了完整詳情頁");
      go("detail");
    } else if (b.act === "post") {
      go("post");
    } else {
      toast("Banner 的曝光與點擊都進了這一頁，談廣告時拿這個數字說話");
      go("dash");
    }
  }

  /* ================================================================
     v4 · 跑友活動（C 端用戶自己發佈）
     ================================================================ */

  var UGC_TAGS = ["晨跑", "夜跑", "長距離", "越野", "訓練", "親子", "騎行", "其他"];
  var UGC_VIS = [
    ["joined", "報名後可見", "只有點了「我要參加」的人能看到你的 Telegram 和電話。推薦這個，能擋掉大部分騷擾。"],
    ["public", "所有人可見", "任何打開這條活動的人都能看到你的聯繫方式，包括沒登錄的人。"]
  ];

  /* 平臺目前不碰錢：這幾條是產品邊界，不是文案 */
  var NO_FEE = [
    "RUN 不代收跑友活動的報名費",
    "不支持發佈者上傳個人 KHQR 收款碼",
    "不支持平臺代收後轉賬給組織者",
    "不支持任何形式的活動押金",
    "不支持住宿、拼車、裝備代購等代收費"
  ];

  /* 禁止發佈類別。code 同時用作審覈駁回原因代碼，兩邊不能各寫一套 */
  var BAN_RULES = [
    { code: "R01", t: "賭博、下注或以非法獎金爲賣點的活動" },
    { code: "R02", t: "冒充 RUN 或其他官方機構、僞造合作關係" },
    { code: "R03", t: "涉嫌詐騙，或要求用戶提供短信驗證碼" },
    { code: "R04", t: "引導用戶向不明個人賬戶預先付款" },
    { code: "R05", t: "非法商品、違禁品或違法宣傳" },
    { code: "R06", t: "無基本安全措施的高風險活動" },
    { code: "R07", t: "要求未成年人脫離監護人單獨參加" },
    { code: "R08", t: "虛假的活動地點、時間或主辦身份" }
  ];
  var REJECT_CODES = BAN_RULES.concat([
    { code: "R09", t: "涉及平臺代收費用（目前不支持）" },
    { code: "R00", t: "信息不完整或表述不清，需補充後重投" }
  ]);

  /* 免責聲明全文。版本號一旦發佈不可改，改文案必須發新版本號，
     老版本要一直留着——因爲老帖子籤的是老版本。 */
  var DISCLAIMER = {
    version: "UGC-DISC-v1.1",
    date: "2026.08.06",
    lang: "zh-CN",
    sections: [
      ["一、平臺角色",
       "本活動爲跑友自主活動，非 RUN 官方主辦。RUN（以下稱「平臺」）僅提供活動信息發佈與報名意向記錄工具，不是本活動的主辦方、承辦方或協辦方，不參與活動的策劃、組織、執行與現場管理。活動在平臺頁面上的展示，不代表平臺爲該活動的安全、質量或真實性提供擔保。平臺責任範圍以正式平臺規則、用戶協議及適用法律爲準。"],
      ["二、組織者責任",
       "發佈人是本活動唯一的組織者與責任人。發佈人保證所填寫的時間、地點、路線、人數、費用與聯繫方式真實有效；保證活動本身合法，並已自行取得活動所需的場地許可、路權或其他必要許可；負責活動現場的秩序與安全提示。"],
      ["三、參與風險自擔",
       "跑步、越野及相關戶外活動存在受傷、中暑、交通事故等風險。參與者應自行評估身體狀況，自行投保意外險。活動過程中發生的人身傷害、財產損失、交通事故及其他糾紛，由發佈人與參與者依法自行解決。平臺不是本活動主辦方，不參與現場組織和執行；平臺責任範圍以正式平臺規則、用戶協議及適用法律爲準。"],
      ["四、費用與支付",
       "平臺目前不爲跑友自主活動提供任何收款能力：不代收報名費，不支持上傳個人收款碼，不支持代收後轉賬，不支持押金，也不支持住宿、拼車、裝備代購等代收費。活動如涉及費用，只能以文字說明並由參與雙方線下自行確認。任何要求預先向個人賬戶付款的行爲，平臺一律不予支持，參與者應謹慎覈實。"],
      ["五、禁止發佈的內容",
       "以下內容一律不予發佈，已發佈的將被下架或緊急凍結：" +
       BAN_RULES.map(function (r) { return "（" + r.code + "）" + r.t; }).join("；") + "。"],
      ["六、內容與肖像",
       "發佈內容不得含有違法、涉政、色情、賭博、詐騙、傳銷、醫療功效宣稱或其他違反柬埔寨王國法律的信息。發佈人保證所上傳照片已獲得畫面中可辨識人物的同意，未侵犯他人肖像權、著作權或其他合法權益；因內容侵權引發的索賠由發佈人承擔。"],
      ["七、聯繫方式與個人信息",
       "發佈人自願公開其聯繫方式，並知悉該信息可能被其他用戶獲取、保存或轉述。平臺按發佈人所選的可見範圍展示，並對查看行爲做留痕，但無法阻止他人截圖、複製或轉發。"],
      ["八、平臺的處置權",
       "平臺有權在審覈階段或收到舉報後，對內容作不予展示、下架、刪除或緊急凍結處理，並保留必要的操作日誌。平臺的審覈爲形式審覈，不構成對活動真實性、安全性或合法性的擔保。"],
      ["九、記錄與留痕",
       "勾選全部確認項並點擊「發佈」，即視爲發佈人以電子方式簽署本聲明。平臺將記錄本聲明的版本號、語言版本、全文快照與校驗值、發佈人賬號、逐項勾選結果、簽署時間與時區，並一併記錄 IP 地址、設備與 User-Agent 作爲「簽署環境輔助留痕信息」。該類環境信息僅用於輔助還原簽署當時的情形，不能單獨作爲簽署人身份的絕對證明。記錄不隨活動的下架、凍結或刪除而刪除；簽署記錄按照平臺數據保留政策保存，具體期限由正式隱私政策及當地法律要求確定。"],
      ["十、本聲明的界限",
       "本聲明不能代替平臺審覈、安全管理，也不能代替柬埔寨王國法律法規對活動組織者的要求。簽署本聲明不意味着發佈人可以免除法定責任，也不意味着平臺可以不履行合理的審覈與處置義務。"],
      ["十一、適用法律與語言版本",
       "本聲明適用柬埔寨王國法律。本文爲產品原型用示範文本，正式上線前必須由柬埔寨當地執業律師審覈定稿，並形成同一版本號下的中文、英文與高棉語三份文本。正式系統應記錄用戶實際簽署的語言版本與完整文本快照。"]
    ],
    items: [
      { k: "organizer", t: "我是本次活動的組織者，填寫的信息真實有效",
        d: "活動的組織、現場安全與必要許可由我本人負責。" },
      { k: "liability", t: "我知悉這是跑友自主活動，RUN 不是主辦方、不參與現場組織和執行",
        d: "RUN 僅提供信息發佈與報名意向記錄；參與者應自行覈實信息並評估風險，相關糾紛由我與參與者依法自行解決。" },
      { k: "content", t: "我保證內容合法合規，且不通過平臺收取任何費用",
        d: "不含 R01–R08 禁止發佈的內容，已獲照片中人物同意，不要求任何人向平臺或我的個人賬戶預付款。" }
    ]
  };

  function discFullText() {
    var t = "RUN 用戶自發活動免責聲明 " + DISCLAIMER.version + "（" + DISCLAIMER.date + " 生效）\n";
    DISCLAIMER.sections.forEach(function (s) { t += s[0] + "\n" + s[1] + "\n"; });
    DISCLAIMER.items.forEach(function (it) { t += "[確認項:" + it.k + "] " + it.t + " " + it.d + "\n"; });
    return t;
  }

  /* 演示用摘要：正式實現請用 SHA-256(全文)。這裏只要保證「同文同值、改文變值」 */
  function hash16(str) {
    var h1 = 0x811c9dc5, h2 = 0x01000193, i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      h1 = ((h1 ^ c) >>> 0) * 16777619 >>> 0;
      h2 = ((h2 << 5) + h2 + c) >>> 0;
    }
    return (("0000000" + h1.toString(16)).slice(-8) + ("0000000" + h2.toString(16)).slice(-8)).toUpperCase();
  }

  function nowStamp() {
    var d = new Date();
    return d.getFullYear() + "." + pad(d.getMonth() + 1) + "." + pad(d.getDate()) + " " +
      pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
  function deviceStr() {
    var ua = navigator.userAgent || "";
    var os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android"
      : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : "其他";
    var br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome"
      : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "其他";
    return os + " · " + br;
  }
  function fakeIp() {
    var n = S.posts.length;
    return "175.100." + (12 + n * 7 % 200) + "." + (5 + n * 31 % 240);
  }

  /* ---- 數據存取 ---- */

  var LOCALIMG = {};        // 本地選的圖只放內存，不寫 localStorage（會撐爆配額）
  var localSeed = 900;

  var PREVIEW = null;       // 發佈前的預覽稿，不落庫

  function allUgc() {
    return S.posts.slice().reverse().concat(DEMO.ugc);
  }
  function ugcById(id) {
    if (id === "__preview") return PREVIEW;
    var l = allUgc();
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }
  /* 凍結的活動仍然留在列表裏（帶「已凍結」標識）——報過名的人要能找回來看到風險提示，
     直接藏掉反而讓人聯繫不上、也看不到警告。 */
  function ugcPublished() {
    return allUgc().filter(function (p) {
      return p.status === "published";
    });
  }
  /* 狀態機：審覈中 → 已通過 → 已下架 / 緊急凍結
     凍結是平臺側動作，所以單獨存一張表，不去改活動本身的 status——
     解凍之後活動要能回到凍結前的狀態，而不是被覆蓋掉。 */
  function ugcFrozen(p) { return S.frozen.indexOf(p.id) >= 0; }
  function ugcStatus(p) { return ugcFrozen(p) ? "frozen" : p.status; }

  var UGC_ST = {
    reviewing: ["審覈中", "warn"], published: ["已通過", "ok"],
    rejected: ["未通過", "bad"], closed: ["已下架", ""],
    frozen: ["緊急凍結", "bad"], preview: ["預覽", "warn"]
  };

  function ugcJoined(p) {
    return S.joins.indexOf(p.id) >= 0;
  }
  function ugcSeats(p) {
    return Math.max(0, p.cap - p.joined - (ugcJoined(p) ? 1 : 0));
  }

  /* 凍結後聯繫方式一律隱藏，報名過的也一樣——凍結的常見原因就是詐騙和騷擾 */
  function contactUnlocked(p) {
    if (ugcStatus(p) === "frozen") return false;
    if (p.mine) return true;
    if (p.vis === "public") return true;
    return ugcJoined(p);
  }

  /* 聯繫方式查看留痕（演示級）。同一活動 + 同一聯繫方式類型，在「仍處於參加狀態」
     期間只記一條，避免連續點擊刷出一堆重複記錄；退出後再參加會記新的一條。 */
  function logContactView(p, type) {
    var dup = S.views.some(function (v) {
      return v.act === p.id && v.type === type && v.user === DEMO.user.id && v.joined;
    });
    if (dup) return false;
    S.views.push({
      act: p.id, user: DEMO.user.id, at: nowStamp(), type: type,
      joined: p.mine ? true : ugcJoined(p)
    });
    if (S.views.length > 50) S.views = S.views.slice(-50);
    save();
    return true;
  }
  /* 退出活動：把這條活動下的查看記錄標記爲「已退出參加」，不刪除 */
  function closeContactViews(id) {
    var changed = false;
    S.views.forEach(function (v) {
      if (v.act === id && v.joined) { v.joined = false; changed = true; }
    });
    if (changed) save();
  }
  function viewsOf(id) {
    return S.views.filter(function (v) { return v.act === id; });
  }
  function ugcImgTag(seed) {
    if (LOCALIMG[seed]) return '<img src="' + LOCALIMG[seed] + '" alt="活動圖片">';
    return '<canvas data-art="race-' + seed + '"></canvas>';
  }

  var curUgc = "g1";
  var lastPost = null;

  /* 種子帖也補上留痕記錄：演示時不用先自己發一條，才能看到留痕長什麼樣 */
  (function seedConsents() {
    DEMO.ugc.forEach(function (p, i) {
      p.consent = {
        recId: "CONSENT-" + p.at.replace(/[.: ]/g, "") + "-" + pad(i + 1),
        activityId: p.id, userId: p.byId, userName: p.by,
        userPhone: "+855 " + (70 + i) + " *** " + (100 + i * 7),
        version: DISCLAIMER.version, effective: DISCLAIMER.date,
        lang: (i === 0 ? "km-KH" : "en") + "（用戶實際簽署的語言版本）",
        snapshot: "已存全文快照 " + (discFullText().length + i * 37) + " 字",
        hash: hash16(discFullText() + "|" + (i === 0 ? "km-KH" : "en")),
        algo: "原型摘要（正式實現用 SHA-256）",
        items: DISCLAIMER.items.map(function (it) { return it.k + "=accepted"; }),
        acceptedAt: p.at + ":0" + (i + 3), tz: "Asia/Phnom_Penh (UTC+7)",
        ip: "175.100." + (24 + i * 11) + "." + (61 + i * 7),
        device: i === 0 ? "Android · Chrome" : "iOS · Safari",
        ua: "Mozilla/5.0 （演示數據，正式環境存完整 UA）…",
        channel: TG.on ? "telegram-miniapp" : "web",
        retention: "按平臺數據保留政策保存（不隨活動下架 / 凍結 / 刪除而刪除；具體期限由正式隱私政策及當地法律要求確定）"
      };
    });
  })();

  function demoConsentPost() { return DEMO.ugc[0]; }

  /* 把演示種子帖複製成一條「我發佈的」記錄並落庫，保證兩個頁面口徑一致 */
  function seedMyPost() {
    var src = DEMO.ugc[0];
    var post = JSON.parse(JSON.stringify(src));
    post.id = "gm" + (S.posts.length + 1);
    post.by = DEMO.user.name; post.byId = DEMO.user.id; post.av = "ME";
    post.byNote = "演示賬號";
    post.mine = true; post.status = "published";
    post.at = "2026.08.08 09:20";
    post.consent = { recId: "SIGN-DEMO-0001", ver: "v1.0", at: post.at, items: [true, true, true] };
    S.posts.push(post); save();
    return post;
  }

  /* ---- 首頁「跑友活動」卡片 ---- */

  function renderUgcHome() {
    var wrap = $("ugc-home");
    if (!wrap) return;
    wrap.innerHTML = "";
    var list = ugcPublished().slice(0, 6);
    if (!list.length) {
      wrap.innerHTML = '<div class="empty"><b>還沒有跑友活動</b>你可以發第一條。</div>';
      return;
    }
    list.forEach(function (p) { wrap.appendChild(ugcCard(p)); });
  }

  function ugcCard(p) {
    var el = document.createElement("button");
    el.type = "button";
    el.className = "ucard";
    var left = ugcSeats(p);
    var stx = ugcStatus(p);
    el.innerHTML =
      '<div class="ucard-img">' + ugcImgTag(p.imgs[0]) +
        (p.imgs.length > 1 ? '<span class="ucard-n">1 / ' + p.imgs.length + '</span>' : '') +
        orgTag("ugc") +
        (stx === "frozen" ? '<span class="ucard-st st bad">已凍結</span>'
          : p.mine ? '<span class="ucard-st st ok">我發佈的</span>' : '') +
      '</div>' +
      '<div class="ucard-body">' +
        '<h4>' + h(p.t) + '</h4>' +
        '<div class="ucard-meta">' + h(p.d) + '<br>' + h(p.loc) + ' · ' + h(p.dist) + '</div>' +
        '<div class="ucard-foot">' +
          '<span class="avatar">' + h(p.av) + '</span>' +
          '<span>' + h(p.by) + '</span>' +
          '<span class="join">' + (left > 0 ? left + " 個空位" : "已滿") + '</span>' +
        '</div>' +
      '</div>';
    el.addEventListener("click", function () { curUgc = p.id; go("ugc"); });
    return el;
  }

  /* ---- 活動詳情 ---- */

  function renderUgcDetail() {
    var p = ugcById(curUgc);
    if (!p) { go("home"); return; }
    var joined = ugcJoined(p), left = ugcSeats(p), mine = !!p.mine;

    var status = ugcStatus(p);
    var st = $("ugc-state");
    if (status === "frozen") {
      st.innerHTML = '<div class="freeze-bar">' +
        '<b>⚠ 這條活動已被平臺緊急凍結</b><br>' +
        (joined
          ? '你此前報名過這場活動。平臺已收到風險線索並凍結了它，<b>請勿前往、勿付款、勿再與對方聯繫</b>。如果你已經付過錢或提供過個人信息，請立刻聯繫髮卡銀行並向當地警方報案。'
          : '這條活動因涉嫌違規或存在安全風險已被凍結，<b>不再接受報名</b>，組織者聯繫方式已隱藏。') +
        '<br><span style="font-size:.78rem;color:var(--ink-mute)">凍結原因：' + h(p.freezeReason || "平臺收到風險舉報，正在覈實") +
        '　發佈記錄、審覈記錄與免責聲明簽署記錄均已保留。</span></div>';
    } else if (status === "preview") {
      st.innerHTML = '<div class="demo-bar" style="display:flex;gap:.8rem;align-items:center;flex-wrap:wrap">' +
        '<span>這是<b>發佈前預覽</b>，還沒有提交，別人看不到。</span>' +
        '<button class="btn sm" data-go="post" style="margin-left:auto">← 回去繼續改</button></div>';
    } else if (status === "reviewing") {
      st.innerHTML = '<div class="demo-bar">這條活動<b>正在審覈</b>，還沒有對其他人展示。你現在看到的是發佈人預覽。</div>';
    } else if (status === "rejected") {
      st.innerHTML = '<div class="demo-bar" style="border-color:#E9A79B;background:var(--stop-tint);color:var(--stop)">' +
        '審覈未通過' + (p.rejectCode ? '（' + h(p.rejectCode) + '）' : '') + '：' +
        h(p.rejectReason || "內容需要修改") + '。修改後可以重新提交。</div>';
    } else if (status === "closed") {
      st.innerHTML = '<div class="demo-bar">這條活動已被髮布人<b>下架</b>，不再接受報名。</div>';
    } else {
      st.innerHTML = "";
    }

    var gal = $("ugc-gal");
    gal.className = "ugc-gal n" + Math.min(3, p.imgs.length);
    gal.innerHTML = p.imgs.map(function (s) { return ugcImgTag(s); }).join("");

    $("ugc-title").textContent = p.t;
    $("ugc-tags").innerHTML = orgTag("ugc") + ' ' +
      '<span class="utag">' + h(p.tag) + '</span>' +
      '<span class="utag">' + h(p.fee) + '</span>' +
      '<span class="utag">' + h(p.dist) + '</span>';
    $("ugc-author").innerHTML =
      '<span class="avatar">' + h(p.av) + '</span>' +
      '<div><b>' + h(p.by) + (mine ? '　<span class="st ok">我</span>' : '') + '</b>' +
      '<span>' + h(p.byNote) + ' · 發佈於 ' + h(p.at) + '</span></div>';
    $("ugc-body").textContent = p.body;
    $("ugc-by2").textContent = p.by;

    $("ugc-info").innerHTML = [
      ["主辦性質", "跑友自主活動 · 非 RUN 官方主辦"],
      ["時間", h(p.d)], ["地點", h(p.loc)], ["集合方式", h(p.meet)], ["距離 / 強度", h(p.dist)],
      ["費用", h(p.fee) + "　<span style='color:var(--ink-mute);font-size:.82rem'>平臺不代收，線下自行確認</span>"],
      ["人數", (p.joined + (joined ? 1 : 0)) + " / " + p.cap + " 人（報名意向登記）"]
    ].map(function (r) {
      return "<tr><td style='width:7.5rem;color:var(--ink-mute)'>" + r[0] + "</td><td>" + r[1] + "</td></tr>";
    }).join("");

    $("ugc-fee").textContent = p.fee;
    $("ugc-left").textContent = left > 0 ? ("還有 " + left + " 個空位") : "名額已滿";

    var cta = $("ugc-join"), note = $("ugc-note");
    cta.className = "btn wide lg";
    cta.disabled = false;
    if (status === "frozen") {
      cta.textContent = "已凍結 · 不可報名"; cta.disabled = true;
      note.textContent = joined
        ? "你的報名記錄保留着，但這場活動已經不建議參加。"
        : "平臺已凍結這條活動，不再接受新的報名。";
    } else if (status !== "published") {
      cta.textContent = "暫不可報名"; cta.disabled = true;
      note.textContent = "活動通過審覈後才能接受報名。";
    } else if (mine) {
      cta.textContent = "這是你自己發的"; cta.disabled = true;
      note.textContent = "去「我的 → 我發佈的」可以看報名情況、留痕記錄，或者下架這條活動。";
    } else if (joined) {
      cta.textContent = "已報名 · 取消參加";
      cta.className = "btn wide lg ghost";
      note.textContent = "已經告訴組織者你會來了。來不了的話點這裏取消，把位置讓出去。";
    } else if (left <= 0) {
      cta.textContent = "名額已滿"; cta.disabled = true;
      note.textContent = "跑友活動不設候補，直接聯繫組織者問問還能不能加。";
    } else {
      cta.textContent = "我要參加";
      note.textContent = "報名意向登記只是告訴組織者你會來，不收費。RUN 不是本活動主辦方，不參與現場組織和執行，請自行覈實信息並評估風險。";
    }
    cta.onclick = function () {
      if (joined) {
        S.joins = S.joins.filter(function (x) { return x !== p.id; });
        closeContactViews(p.id);          // 退出後聯繫方式重新隱藏，查看記錄標記爲已結束
        save(); toast("已取消參加，聯繫方式已重新隱藏"); renderUgcDetail(); renderUgcHome();
        return;
      }
      withLock("ugcjoin-" + p.id, cta, "提交中…", function () {
        if (ugcJoined(p)) return;
        if (ugcSeats(p) <= 0) { toast("名額剛好滿了"); renderUgcDetail(); return; }
        S.joins.push(p.id); save();
        toast(p.vis === "joined" ? "報名成功，組織者的聯繫方式已經解鎖" : "報名成功");
        renderUgcDetail(); renderUgcHome();
      });
    };

    renderUgcContact(p);

    var rep = $("ugc-report");
    var reported = S.reports.indexOf(p.id) >= 0;
    rep.textContent = reported ? "已舉報" : "舉報";
    rep.disabled = reported || mine;
    rep.onclick = function () { openReport(p); };
  }

  var viewLogOpen = false;

  function renderUgcContact(p) {
    var box = $("ugc-contact");
    var unlocked = contactUnlocked(p);
    var frozen = ugcStatus(p) === "frozen";
    var rows = "";
    function mask(s) {
      if (!s) return "";
      if (s.length <= 4) return s.charAt(0) + "***";
      return s.slice(0, 4) + "*".repeat(Math.max(3, s.length - 6)) + s.slice(-2);
    }
    if (p.contact.tg) {
      rows += '<div class="contact-row"><i>✈️</i><b>' + (unlocked ? p.contact.tg : mask(p.contact.tg)) + '</b></div>';
      if (unlocked && !p.mine) logContactView(p, "tg");
    }
    if (p.contact.ph) {
      rows += '<div class="contact-row"><i>📞</i><b>' + (unlocked ? p.contact.ph : mask(p.contact.ph)) + '</b></div>';
      if (unlocked && !p.mine) logContactView(p, "phone");
    }

    var foot;
    if (frozen) {
      foot = '<p class="contact-lock" style="margin-top:.4rem;color:var(--stop)">🚫 活動已被平臺<b>緊急凍結</b>，聯繫方式已隱藏。</p>';
    } else if (unlocked) {
      foot = '<p class="contact-lock" style="margin-top:.4rem">直接聯繫組織者，RUN 不轉達消息。' +
        '<br>平臺<b>不代收任何費用</b>，對方要求轉賬或提供驗證碼時請立即停止並舉報。</p>';
    } else {
      foot = '<p class="contact-lock" style="margin-top:.4rem">🔒 發佈人設置爲<b>報名後可見</b>，點「我要參加」後自動解鎖，取消參加會重新隱藏。</p>';
    }

    // 查看留痕（演示級）
    var logs = viewsOf(p.id);
    var log = '<div class="viewlog"><button type="button" id="vlog-toggle">' +
      (viewLogOpen ? "▾" : "▸") + ' 聯繫方式查看留痕（' + logs.length + '）</button>';
    if (viewLogOpen) {
      log += logs.length
        ? '<table><tbody>' + logs.slice().reverse().map(function (v) {
            return '<tr><td>' + v.act + '</td><td>' + v.user + '</td><td>' + v.at + '</td><td>' +
              (v.type === "tg" ? "Telegram" : "電話") + '</td><td>' +
              (v.joined ? "參加中" : "已退出") + '</td></tr>';
          }).join("") + '</tbody></table>'
        : '<p class="none">還沒有查看記錄。點「我要參加」解鎖聯繫方式後會生成一條。</p>';
      log += '<p class="none">記錄：活動 ID / 查看用戶 / 查看時間 / 聯繫方式類型 / 是否仍在參加。' +
        '同一活動同一類型在參加期間只記一條，退出後再參加會記新的一條。' +
        '<b>當前僅爲前端演示，正式系統必須由服務端留痕並接入風控。</b></p>';
    }
    log += '</div>';

    box.innerHTML =
      '<div style="font-size:.76rem;color:var(--ink-mute);margin-bottom:.35rem">組織者聯繫方式</div>' +
      rows + foot + log;

    $("vlog-toggle").addEventListener("click", function () {
      viewLogOpen = !viewLogOpen;
      renderUgcContact(p);
    });
  }

  /* ---- 舉報 ---- */

  var REPORT_REASONS = [
    "冒充官方", "涉嫌詐騙或收費異常", "活動信息虛假", "聯繫方式騷擾",
    "活動安全風險", "違法違規內容", "活動已取消", "其他"
  ];
  var repTarget = null, repPick = 0;

  function openReport(p) {
    repTarget = p; repPick = 0;
    var box = $("rep-list");
    box.innerHTML = "";
    REPORT_REASONS.forEach(function (r, i) {
      var lab = document.createElement("label");
      lab.className = "agree";
      lab.innerHTML = '<input type="radio" name="rep" ' + (i === 0 ? "checked" : "") + '><span>' + r + '</span>';
      lab.querySelector("input").addEventListener("change", function () { repPick = i; });
      box.appendChild(lab);
    });
    $("rep-bg").classList.add("on");
    try { history.pushState(null, "", location.hash || "#/"); } catch (e) {}
  }

  $("rep-cancel").addEventListener("click", function () { $("rep-bg").classList.remove("on"); });
  $("rep-bg").addEventListener("click", function (e) { if (e.target === this) this.classList.remove("on"); });
  $("rep-ok").addEventListener("click", function () {
    if (!repTarget) return;
    if (S.reports.indexOf(repTarget.id) < 0) { S.reports.push(repTarget.id); save(); }
    $("rep-bg").classList.remove("on");
    toast("舉報已提交：" + REPORT_REASONS[repPick] + "（演示）");
    renderUgcDetail();
  });

  /* ---- 發佈表單 ---- */

  var pkImgs = [], postTag = "夜跑", postVis = "joined";
  var discOk = { organizer: false, liability: false, content: false };
  var postEventsBound = false, postDirty = false;

  function renderPostForm() {
    buildPostForm();
    renderPicker();
    checkPost();
  }

  var NO_FEE_I18N = {
    en: [
      "RUN does not collect entry fees for community runs",
      "Personal KHQR payment codes cannot be uploaded",
      "Platform does not collect and transfer funds to organizers",
      "Activity deposits of any kind are not supported",
      "No fees collected for accommodation, carpools, or gear"
    ],
    km: [
      "RUN មិនប្រមូលថ្លៃចុះឈ្មោះសម្រាប់សកម្មភាពអ្នករត់ទេ",
      "មិនគាំទ្រការបង្ហោះកូដ KHQR ផ្ទាល់ខ្លួនឡើយ",
      "មិនគាំទ្រការប្រមូលប្រាក់ផ្ទេរទៅអ្នករៀបចំឡើយ",
      "មិនគាំទ្រការតម្កល់ប្រាក់កក់គ្រប់រូបភាពឡើយ",
      "មិនគាំទ្រការប្រមូលថ្លៃស្នាក់នៅ ជិះរថយន្តរួម ឬទិញសម្ភារៈឡើយ"
    ]
  };

  var BAN_RULES_I18N = {
    en: [
      { code: "R01", t: "Gambling, betting, or illegal prize-driven activities" },
      { code: "R02", t: "Impersonating RUN or other official organizations" },
      { code: "R03", t: "Suspected fraud or requesting SMS verification codes" },
      { code: "R04", t: "Directing users to pay unknown personal accounts in advance" },
      { code: "R05", t: "Illegal goods, contraband, or illegal promotions" },
      { code: "R06", t: "High-risk activities without basic safety measures" },
      { code: "R07", t: "Requiring minors to attend alone without a guardian" },
      { code: "R08", t: "Fake activity locations, times, or organizer identities" }
    ],
    km: [
      { code: "R01", t: "ល្បែងស៊ីសង ឬសកម្មភាពរង្វាន់ខុសច្បាប់" },
      { code: "R02", t: "ក្លែងបន្លំជា RUN ឬស្ថាប័នផ្លូវការដទៃទៀត" },
      { code: "R03", t: "ការសង្ស័យក្លែងបន្លំ ឬស្នើសុំលេខកូដ SMS" },
      { code: "R04", t: "ណែនាំឲ្យផ្ទេរប្រាក់ទៅគណនីផ្ទាល់ខ្លួនដែលមិនស្គាល់" },
      { code: "R05", t: "ទំនិញខុសច្បាប់ ឬការផ្សព្វផ្សាយខុសច្បាប់" },
      { code: "R06", t: "សកម្មភាពហានិភ័យខ្ពស់ដោយគ្មានវិធានការសុវត្ថិភាព" },
      { code: "R07", t: "តម្រូវឲ្យអនីតិជនចូលរួមតែម្នាក់ឯងដោយគ្មានអាណាព្យាបាល" },
      { code: "R08", t: "ទីតាំង ពេលវេលា ឬអ្នករៀបចំមិនពិតប្រាកដ" }
    ]
  };

  var UGC_TAGS_I18N = {
    en: ["Night Run", "Easy Run", "Long Run", "Trail Run", "Track", "Social"],
    km: ["រត់ពេលយប់", "រត់ស្រាល", "រត់ចម្ងាយឆ្ងាយ", "រត់ព្រៃ", "រត់តារាង", "រត់មិត្តភាព"]
  };

  var UGC_VIS_I18N = {
    en: [
      ["joined", "Participants Only", "Only runners who have registered for this activity can view your contact info."],
      ["public", "Public to Everyone", "Anyone who opens this page can see your contact info."]
    ],
    km: [
      ["joined", "អ្នកចូលរួមប៉ុណ្ណោះ", "មានតែអ្នកដែលបានចុះឈ្មោះសកម្មភាពនេះ ទើបអាចឃើញព័ត៌មានទំនាក់ទំនងរបស់អ្នក។"],
      ["public", "សាធារណៈទាំងអស់", "មនុស្សគ្រប់គ្នាដែលបើកទំព័រនេះ អាចឃើញព័ត៌មានទំនាក់ទំនងរបស់អ្នក។"]
    ]
  };

    var DISCLAIMER_SECTIONS_I18N = {
    en: [
      ["I. Platform Role",
       "This activity is initiated by community runners, not organized by RUN. RUN (the 'Platform') only provides listing and interest registration tools and is not an organizer, host, or co-host. The listing on the platform does not constitute a warranty of safety, quality, or authenticity."],
      ["II. Organizer Responsibility",
       "The poster is the sole organizer and person responsible. The poster warrants that schedule, location, route, capacity, and contacts are accurate and lawful, and that any required venue or road permits have been obtained."],
      ["III. Assumption of Risk",
       "Running, trail running, and outdoor sports carry inherent risks of injury, heat exhaustion, and traffic hazards. Participants must assess their own physical condition and obtain personal insurance. Disputes shall be resolved between participants and organizers under the law."],
      ["IV. Fees & Payments",
       "The platform does not collect any fees for community runs: no entry fees, no personal QR codes, no transfers, and no deposits. Any shared costs must be clearly explained in text and settled offline. Do not pay unknown personal accounts in advance."],
      ["V. Prohibited Content",
       "The following content is strictly prohibited: gambling, fraud, unauthorized financial solicitation, illegal goods, and high-risk activities without safety measures."],
      ["VI. Content & Likeness Rights",
       "Uploaded content must not violate the laws of the Kingdom of Cambodia. The poster warrants that consent has been obtained from identifiable persons in photos."],
      ["VII. Contact Info & Privacy",
       "The poster voluntarily discloses contact information according to the chosen visibility setting. The platform records audit logs of inquiries but cannot prevent external copying or forwarding."],
      ["VIII. Platform Rights",
       "The platform reserves the right to unpublish, delete, or freeze violating content during review or following user reports."],
      ["IX. Audit & Records",
       "Checking all items and submitting constitutes electronic signature. The platform records version, timestamp, account ID, and IP/device data for audit and legal evidence."],
      ["X. Limitations",
       "This disclaimer does not substitute for applicable laws of the Kingdom of Cambodia. Signing does not waive statutory legal responsibilities."],
      ["XI. Governing Law",
       "This disclaimer is governed by the laws of the Kingdom of Cambodia."]
    ],
    km: [
      ["១. តួនាទីរបស់ប្រព័ន្ធ",
       "សកម្មភាពនេះជារបស់អ្នករត់ខ្លួនឯង មិនមែនជាការរៀបចំផ្លូវការរបស់ RUN ឡើយ។ RUN គ្រាន់តែជាឧបករណ៍ផ្សព្វផ្សាយ និងកត់ត្រាចំណាប់អារម្មណ៍ប៉ុណ្ណោះ មិនមែនជាអ្នករៀបចំឡើយ។ ការបង្ហាញនៅលើទំព័រនេះ មិនមែនជាការធានាសុវត្ថិភាព ឬគុណភាពឡើយ។"],
      ["២. ទំនួលខុសត្រូវរបស់អ្នករៀបចំ",
       "អ្នកបង្ហោះគឺជាអ្នករៀបចំតែម្នាក់គត់ និងទទួលខុសត្រូវទាំងស្រុង។ អ្នកបង្ហោះត្រូវធានាថាពេលវេលា ទីកន្លែង ផ្លូវ និងទំនាក់ទំនងពិតជាត្រឹមត្រូវ និងស្របច្បាប់។"],
      ["៣. ការទទួលខុសត្រូវហានិភ័យ",
       "ការរត់ និងកីឡាក្រៅផ្ទះមានហានិភ័យរបួស ឬគ្រោះថ្នាក់។ អ្នកចូលរួមត្រូវវាយតម្លៃសុខភាពខ្លួនឯង និងមានការធានារ៉ាប់រង។ រាល់វិវាទត្រូវដោះស្រាយរវាងអ្នករៀបចំ និងអ្នកចូលរួមតាមផ្លូវច្បាប់។"],
      ["៤. ថ្លៃចំណាយ និងការទូទាត់",
       "ប្រព័ន្ធមិនប្រមូលប្រាក់សម្រាប់សកម្មភាពអ្នករត់ឡើយ៖ មិនប្រមូលថ្លៃចុះឈ្មោះ មិនបង្ហោះកូដ QR ផ្ទាល់ខ្លួន និងមិនតម្កល់ប្រាក់កក់។ រាល់ការចំណាយត្រូវទូទាត់ក្រៅបណ្តាញ។"],
      ["៥. ខ្លឹមសារដែលហាមឃាត់",
       "ខ្លឹមសារខាងក្រោមត្រូវបានហាមឃាត់ដាច់ខាត៖ ល្បែងស៊ីសង ការក្លែងបន្លំ ទំនិញខុសច្បាប់ និងសកម្មភាពគ្មានវិធានការសុវត្ថិភាព។"],
      ["៦. សិទ្ធិរូបភាព និងខ្លឹមសារ",
       "ខ្លឹមសារមិនត្រូវល្មើសច្បាប់នៃព្រះរាជាណាចក្រកម្ពុជាឡើយ។ អ្នកបង្ហោះត្រូវមានការយល់ព្រមពីបុគ្គលក្នុងរូបថត។"],
      ["៧. ព័ត៌មានទំនាក់ទំនង",
       "អ្នកបង្ហោះយល់ព្រមបង្ហាញព័ត៌មានទំនាក់ទំនងតាមជម្រើសដែលបានកំណត់។"],
      ["៨. សិទ្ធិគ្រប់គ្រងរបស់ប្រព័ន្ធ",
       "ប្រព័ន្ធមានសិទ្ធិដកចេញ ឬបង្កកខ្លឹមសារដែលល្មើសគោលការណ៍គ្រប់ពេលវេលា។"],
      ["៩. កំណត់ត្រាសវនកម្ម",
       "ការគូសធីក និងដាក់ស្នើ ទុកជាការចុះហត្ថលេខាអេឡិចត្រូនិច។ ប្រព័ន្ធនឹងរក្សាទុកកំណត់ត្រាសវនកម្មយ៉ាងពេញលេញ។"],
      ["១០. កម្រិតនៃសេចក្តីថ្លែងការណ៍",
       "សេចក្តីថ្លែងការណ៍នេះមិនជំនួសច្បាប់នៃព្រះរាជាណាចក្រកម្ពុជាឡើយ។"],
      ["១១. ច្បាប់គ្រប់គ្រង",
       "សេចក្តីថ្លែងការណ៍នេះស្ថិតក្រោមច្បាប់នៃព្រះរាជាណាចក្រកម្ពុជា។"]
    ]
  };

  var DISCLAIMER_ITEMS_I18N = {
    en: [
      { k: "organizer", t: "I am the sole organizer of this activity", d: "I confirm the schedule, location, and route are accurate and lawful." },
      { k: "liability", t: "Participants join at their own risk", d: "RUN does not organize this on-site and does not assume event liability." },
      { k: "content",   t: "Content and photos do not infringe rights", d: "I have consent from identifiable people in uploaded photos." }
    ],
    km: [
      { k: "organizer", t: "ខ្ញុំជាអ្នករៀបចំតែម្នាក់គត់នៃសកម្មភាពនេះ", d: "ខ្ញុំបញ្ជាក់ថា ពេលវេលា ទីកន្លែង និងផ្លូវរត់ពិតជាត្រឹមត្រូវ និងស្របច្បាប់។" },
      { k: "liability", t: "អ្នកចូលរួមទទួលខុសត្រូវហានិភ័យដោយខ្លួនឯង", d: "RUN មិនចូលរួមរៀបចំនៅទីកន្លែង និងមិនធានាហានិភ័យឡើយ។" },
      { k: "content",   t: "ខ្លឹមសារ និងរូបថតមិនរំលោភសិទ្ធិអ្នកដទៃ", d: "ខ្ញុំបានទទួលការយល់ព្រមពីបុគ្គលក្នុងរូបថតដែលបានបង្ហោះ។" }
    ]
  };

  function buildPostForm() {
    var feeList = (LANG !== 'zh' && NO_FEE_I18N[LANG]) || NO_FEE;
    var banList = (LANG !== 'zh' && BAN_RULES_I18N[LANG]) || BAN_RULES;
    $("rule-fee").innerHTML = feeList.map(function (t) {
      return '<li><i>✕</i><span>' + t + '</span></li>';
    }).join("");
    $("rule-ban").innerHTML = banList.map(function (r) {
      return '<li><code>' + r.code + '</code><span>' + r.t + '</span></li>';
    }).join("");

    $("disc-ver").textContent = DISCLAIMER.version + " · " + DISCLAIMER.date + (LANG === 'en' ? " Effective" : (LANG === 'km' ? " មានសុពលភាព" : " 生效"));
    var discSections = (LANG !== 'zh' && DISCLAIMER_SECTIONS_I18N[LANG]) || DISCLAIMER.sections;
    $("disc-body").innerHTML = discSections.map(function (s) {
      return "<h5>" + s[0] + "</h5><p>" + s[1] + "</p>";
    }).join("");
    $("disc-more").onclick = function () {
      var open = $("disc-body").classList.toggle("open");
      this.textContent = open ? (LANG === 'en' ? "Collapse ▴" : (LANG === 'km' ? "បង្រួម ▴" : "收起 ▴"))
                              : (LANG === 'en' ? "View Full Text ▾" : (LANG === 'km' ? "ពង្រីកមើលទាំងអស់ ▾" : "展開全文 ▾"));
    };

    // Update Placeholders based on language
    if (LANG === "en") {
      $("i-title").placeholder = "e.g. Wednesday Night Run · Riverside 8K Easy Pace";
      $("i-body").placeholder = "Where to meet, how fast, route, what to bring — write clearly so others can join.";
      $("i-date").placeholder = "2026.08.12 Wed 19:30";
      $("i-dist").placeholder = "8 km steady pace";
      $("i-loc").placeholder = "Phnom Penh · Riverside Boardwalk";
      $("i-meet").placeholder = "19:15 meet under Palace flagpole, will depart on time";
      $("i-fee").innerHTML = '<option value="完全免費">100% Free</option><option value="線下 AA · 自行確認">Split Costs (AA offline)</option><option value="各付各的 · 自行確認">Pay Own Expenses</option>';
    } else if (LANG === "km") {
      $("i-title").placeholder = "ឧ. រត់ពេលយប់ថ្ងៃពុធ · មាត់ទន្លេ ៨ គ.ម";
      $("i-body").placeholder = "ជួបគ្នានៅឯណា រត់ល្បឿនប៉ុន្មាន និងត្រូវយកអ្វីមកខ្លះ...";
      $("i-date").placeholder = "2026.08.12 ពុធ 19:30";
      $("i-dist").placeholder = "៨ គ.ម ល្បឿនថេរ";
      $("i-loc").placeholder = "ភ្នំពេញ · មាត់ទន្លេ";
      $("i-meet").placeholder = "19:15 ជួបគ្នានៅមុខព្រះបរមរាជវាំង";
      $("i-fee").innerHTML = '<option value="完全免費">ឥតគិតថ្លៃ ១០០%</option><option value="線下 AA · 自行確認">ចែករំលែកការចំណាយ</option><option value="各付各的 · 自行確認">បង់រៀងខ្លួន</option>';
    } else {
      $("i-title").placeholder = "例：週三夜跑 · 濱河大道 8 公里勻速";
      $("i-body").placeholder = "從哪兒出發、跑多快、跑完去哪兒喫、需要帶什麼，寫清楚一點，別人纔敢來。";
      $("i-date").placeholder = "2026.08.12 週三 19:30";
      $("i-dist").placeholder = "8 km 勻速";
      $("i-loc").placeholder = "金邊 · 濱河大道";
      $("i-meet").placeholder = "19:15 王宮廣場旗杆下集合，晚到不等";
      $("i-fee").innerHTML = '<option value="完全免費">完全免費</option><option value="線下 AA · 自行確認">線下 AA（自行確認）</option><option value="各付各的 · 自行確認">各付各的（自行確認）</option>';
    }

    // 活動類型
    var tw = $("i-tag");
    tw.innerHTML = "";
    var tagList = (LANG !== 'zh' && UGC_TAGS_I18N[LANG]) || UGC_TAGS;
    tagList.forEach(function (t, idx) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (idx === 0 ? " on" : "");
      b.textContent = t;
      b.addEventListener("click", function () {
        postTag = UGC_TAGS[idx] || t;
        Array.prototype.forEach.call(tw.children, function (x) { x.classList.toggle("on", x === b); });
      });
      tw.appendChild(b);
    });

    // 聯繫方式可見範圍
    var vw = $("i-vis");
    vw.innerHTML = "";
    var visList = (LANG !== 'zh' && UGC_VIS_I18N[LANG]) || UGC_VIS;
    visList.forEach(function (v, idx) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (idx === 0 ? " on" : "");
      b.textContent = v[1];
      b.addEventListener("click", function () {
        postVis = v[0];
        Array.prototype.forEach.call(vw.children, function (x) { x.classList.toggle("on", x === b); });
        $("vis-note").textContent = v[2];
      });
      vw.appendChild(b);
    });
    $("vis-note").textContent = visList[0][2];

    // 免責聲明確認項
    var cw = $("disc-checks");
    cw.innerHTML = "";
    var discItems = (LANG !== 'zh' && DISCLAIMER_ITEMS_I18N[LANG]) || DISCLAIMER.items;
    var reqTag = LANG === 'en' ? 'Required' : (LANG === 'km' ? 'ចាំបាច់' : '必選');
    discItems.forEach(function (it) {
      var lab = document.createElement("label");
      lab.className = "authz-row";
      lab.style.borderTop = "1px solid var(--line)";
      lab.innerHTML = '<input type="checkbox"><span><b>' + it.t +
        '<span class="tagreq">' + reqTag + '</span></b><span>' + it.d + '</span></span>';
      var box = lab.querySelector("input");
      box.addEventListener("change", function () { discOk[it.k] = box.checked; checkPost(); });
      cw.appendChild(lab);
    });

    if (!postEventsBound) {
      postEventsBound = true;
      // 字數統計 + 校驗
      ["i-title", "i-body", "i-date", "i-loc", "i-tg", "i-ph", "i-dist", "i-meet", "i-cap"].forEach(function (id) {
        $(id).addEventListener("input", function () { postDirty = true; checkPost(); });
        $(id).addEventListener("blur", function () { postDirty = true; checkPost(); });
      });

      $("pk-file").addEventListener("change", function () {
        var files = Array.prototype.slice.call(this.files || []);
        files.filter(acceptImage).slice(0, 9 - pkImgs.length).forEach(function (f) {
          var rd = new FileReader();
          rd.onload = function () {
            if (pkImgs.length >= 9) return;
            var seed = ++localSeed;
            LOCALIMG[seed] = rd.result;
            pkImgs.push(seed);
            renderPicker(); checkPost();
          };
          rd.readAsDataURL(f);
        });
        this.value = "";
      });
    }

    $("post-preview").addEventListener("click", previewPost);
    $("post-demo").addEventListener("click", fillDemoPost);
    $("post-submit").addEventListener("click", function () { openDiscConfirm(); });
  }

  function renderPicker() {
    var g = $("pk-grid");
    g.innerHTML = "";
    pkImgs.forEach(function (seed, i) {
      var d = document.createElement("div");
      d.className = "slot";
      d.innerHTML = ugcImgTag(seed) +
        '<button type="button" class="rm" aria-label="刪除">×</button>' +
        (i === 0 ? '<span class="cover">封面</span>' : '');
      d.querySelector(".rm").addEventListener("click", function () {
        pkImgs.splice(i, 1); renderPicker(); checkPost();
      });
      g.appendChild(d);
    });
    if (pkImgs.length < 9) {
      var add = document.createElement("button");
      add.type = "button";
      add.className = "add";
      add.innerHTML = '<span><em>＋</em>從相冊選<br>' + pkImgs.length + ' / 9</span>';
      add.addEventListener("click", function () { $("pk-file").click(); });
      g.appendChild(add);

      var demo = document.createElement("button");
      demo.type = "button";
      demo.className = "add";
      demo.innerHTML = '<span><em>🖼</em>用示例圖</span>';
      demo.addEventListener("click", function () {
        if (pkImgs.length >= 9) return;
        pkImgs.push(120 + pkImgs.length * 13 + (S.posts.length * 3));
        renderPicker(); checkPost();
      });
      g.appendChild(demo);
    }
    requestAnimationFrame(paintAll);
  }

  function postDraft() {
    return {
      title: $("i-title").value.trim(),
      body: $("i-body").value.trim(),
      date: $("i-date").value.trim(),
      loc: $("i-loc").value.trim(),
      meet: $("i-meet").value.trim(),
      dist: $("i-dist").value.trim(),
      cap: Math.max(1, Math.min(500, parseInt($("i-cap").value, 10) || 20)),
      fee: $("i-fee").value,
      tg: $("i-tg").value.trim(),
      ph: $("i-ph").value.trim()
    };
  }

  /* 校驗：把「還差什麼」直接說出來，而不是隻把按鈕置灰 */
  var POST_ERRS = {
    zh: {
      step: "還差一步：",
      no_title: "還沒寫標題",
      body_short: "正文至少 20 個字",
      no_body: "還沒寫正文",
      no_date: "還沒填時間",
      no_loc: "還沒填地點",
      no_contact: "至少留一個聯繫方式",
      no_img: "至少放一張圖",
      no_disc: "免責聲明還有沒勾的確認項"
    },
    en: {
      step: "One step left: ",
      no_title: "Title is missing",
      body_short: "Description needs at least 20 characters",
      no_body: "Description is missing",
      no_date: "Date & time is missing",
      no_loc: "Location is missing",
      no_contact: "At least one contact method is required",
      no_img: "At least one photo is required",
      no_disc: "Please confirm all disclaimer checkboxes"
    },
    km: {
      step: "នៅខ្វះមួយជំហានទៀត៖ ",
      no_title: "មិនទាន់សរសេរចំណងជើង",
      body_short: "ខ្លឹមសារត្រូវមានយ៉ាងហោច ២០ តួអក្សរ",
      no_body: "មិនទាន់សរសេរខ្លឹមសារ",
      no_date: "មិនទាន់បំពេញពេលវេលា",
      no_loc: "មិនទាន់បំពេញទីតាំង",
      no_contact: "សូមទុកទំនាក់ទំនងយ៉ាងហោចណាស់មួយ",
      no_img: "សូមដាក់រូបថតយ៉ាងហោចណាស់មួយសន្លឹក",
      no_disc: "សូមគូសធីកគ្រប់ចំណុចនៃការបដិសេធ"
    }
  };

  function checkPost() {
    var d = postDraft();
    $("c-title").textContent = d.title.length + " / 30";
    $("c-body").textContent = d.body.length + " / 1000";

    var errs = POST_ERRS[LANG] || POST_ERRS.zh;
    var miss = null;
    function bad(id, cond) {
      var el = $(id);
      if (el) el.classList.toggle("bad", postDirty && !!cond);
      return cond;
    }
    if (bad("f-title", !d.title)) miss = miss || errs.no_title;
    if (bad("f-body", d.body.length > 0 && d.body.length < 20)) miss = miss || errs.body_short;
    if (!d.body) miss = miss || errs.no_body;
    if (bad("f-date", !d.date)) miss = miss || errs.no_date;
    if (bad("f-loc", !d.loc)) miss = miss || errs.no_loc;
    if (bad("f-ct", !d.tg && !d.ph)) miss = miss || errs.no_contact;
    if (!pkImgs.length) miss = miss || errs.no_img;

    var allDisc = DISCLAIMER.items.every(function (it) { return discOk[it.k]; });
    if (!allDisc) miss = miss || errs.no_disc;

    $("post-submit").disabled = !!miss;
    $("post-why").textContent = miss ? (errs.step + miss) : "";
    return !miss;
  }

  function fillDemoPost() {
    $("i-title").value = "週日晨跑 · 鑽石島環島 10K 輕鬆跑";
    $("i-body").value = "每週日早上固定的環島跑，從鑽石島 A 門出發，繞島兩圈剛好 10 公里，全程有路燈和廁所。\n\n配速 6:30 左右，能聊天的強度，新手也能跟。跑完一起在島上喫早飯，各付各的。\n\n帶一瓶水，我會多帶兩瓶放在起點。下雨照常，除非打雷。";
    $("i-date").value = "2026.08.16（週日）05:45";
    $("i-loc").value = "金邊 · 鑽石島環島";
    $("i-meet").value = "05:30 鑽石島 A 門集合，05:45 準時出發";
    $("i-dist").value = "10 km · 配速 6:30";
    $("i-cap").value = "15";
    $("i-tg").value = "@dara_runs";
    if (pkImgs.length < 2) { pkImgs = [133, 146, 159]; }
    postDirty = true;
    renderPicker();
    checkPost();
    toast("示例內容已填好，免責聲明還是要自己勾");
  }

  function previewPost() {
    var d = postDraft();
    if (!d.title || !d.body || !pkImgs.length) { toast("先寫個標題、正文，放一張圖，再預覽"); return; }
    var pv = draftToPost(d, "__preview", "preview");
    pv.at = "尚未發佈";
    PREVIEW = pv;
    curUgc = "__preview";
    go("ugc");
  }

  function draftToPost(d, id, status) {
    return {
      id: id, t: d.title, tag: postTag,
      by: DEMO.user.name, byId: DEMO.user.id, av: "SD",
      byNote: "演示賬號 · 第 " + (S.posts.length + 1) + " 次發佈",
      d: d.date, loc: d.loc, meet: d.meet || "—", dist: d.dist || "—",
      cap: d.cap, joined: 0, fee: d.fee,
      imgs: pkImgs.slice(), contact: { tg: d.tg, ph: d.ph }, vis: postVis,
      body: d.body, status: status, at: nowStamp(), mine: true, reports: 0
    };
  }

  /* ---- 發佈：二次確認 → 落庫 → 留痕 ---- */

  function openDiscConfirm() {
    postDirty = true;
    if (!checkPost()) return;
    var d = postDraft();
    $("disc-sum").innerHTML =
      "<b>" + d.title + "</b><br>" + d.date + " · " + d.loc + "<br>" +
      "聯繫方式：" + (d.tg ? d.tg + " " : "") + (d.ph || "") +
      "（" + (postVis === "public" ? "所有人可見" : "報名後可見") + "）<br>" +
      "簽署：" + DISCLAIMER.version + " · 3 / 3 項已確認";
    $("disc-bg").classList.add("on");
    try { history.pushState(null, "", location.hash || "#/"); } catch (e) {}
  }

  $("disc-cancel").addEventListener("click", function () { $("disc-bg").classList.remove("on"); });
  $("disc-bg").addEventListener("click", function (e) { if (e.target === this) this.classList.remove("on"); });
  $("disc-ok").addEventListener("click", function () {
    var btn = this;
    withLock("publish", btn, "提交中…", function () {
      if (!checkPost()) { $("disc-bg").classList.remove("on"); return; }
      var d = postDraft();
      var id = "p" + Date.now();
      var text = discFullText();
      var seq = S.posts.length + 1;

      // 留痕記錄：與活動一一對應，獨立成表，活動刪了它也不刪
      var consent = {
        recId: "CONSENT-" + nowStamp().replace(/[.: ]/g, "") + "-" + pad(seq),
        activityId: id,
        userId: DEMO.user.id, userName: DEMO.user.name, userPhone: DEMO.user.phone,
        version: DISCLAIMER.version, effective: DISCLAIMER.date,
        lang: DISCLAIMER.lang + "（用戶實際簽署的語言版本）",
        snapshot: "已存全文快照 " + text.length + " 字",
        hash: hash16(text), algo: "原型摘要（正式實現用 SHA-256）",
        items: DISCLAIMER.items.map(function (it) { return it.k + "=accepted"; }),
        acceptedAt: nowStamp(), tz: "Asia/Phnom_Penh (UTC+7)",
        ip: fakeIp(), device: deviceStr(),
        ua: (navigator.userAgent || "").slice(0, 52) + "…",
        channel: "web", retention: "按平臺數據保留政策保存（不隨活動下架 / 凍結 / 刪除而刪除；具體期限由正式隱私政策及當地法律要求確定）"
      };

      var post = draftToPost(d, id, "reviewing");
      post.consent = consent;
      S.posts.push(post);
      save();

      lastPost = post;
      PREVIEW = null;
      $("disc-bg").classList.remove("on");

      // 表單清空，避免連續發佈時把上一條內容帶過來
      ["i-title", "i-body", "i-date", "i-loc", "i-meet", "i-dist", "i-tg", "i-ph"].forEach(function (x) { $(x).value = ""; });
      $("i-cap").value = "20";
      pkImgs = [];
      postDirty = false;
      DISCLAIMER.items.forEach(function (it) { discOk[it.k] = false; });
      document.querySelectorAll("#disc-checks input").forEach(function (b) { b.checked = false; });

      renderUgcHome();
      go("postdone");
    });
  });

  /* ---- 發佈結果 + 留痕展示 ---- */

  function renderPostDone() {
    var p = lastPost;
    if (!p) { go("post"); return; }
    // 可能在別處改過狀態（審覈 / 下架），以庫裏的爲準
    var live = ugcById(p.id);
    if (live) { p = live; lastPost = live; }

    if (!$("rej-code").options.length) {
      REJECT_CODES.forEach(function (r) {
        var o = document.createElement("option");
        o.value = r.code; o.textContent = r.code + " · " + r.t;
        $("rej-code").appendChild(o);
      });
    }

    var mark = $("pd-mark");
    if (ugcStatus(p) === "frozen") {
      mark.textContent = "🚫";
      mark.style.background = "var(--stop-tint)"; mark.style.color = "var(--stop)";
      $("pd-title").textContent = "已被平臺緊急凍結";
      $("pd-sub").textContent = "「" + p.t + "」已凍結：不接受新報名，聯繫方式已隱藏，已報名的人會看到風險提示。" +
        "發佈記錄、審覈記錄與下面這條簽署記錄全部保留。";
    } else if (p.status === "published") {
      mark.textContent = "✓";
      mark.style.background = "var(--leaf-tint)"; mark.style.color = "var(--leaf)";
      $("pd-title").textContent = "審覈通過，已發佈";
      $("pd-sub").textContent = "「" + p.t + "」已經出現在首頁「跑友活動」裏，其他人可以報名了。";
    } else if (p.status === "rejected") {
      mark.textContent = "!";
      mark.style.background = "var(--stop-tint)"; mark.style.color = "var(--stop)";
      $("pd-title").textContent = "審覈未通過 " + (p.rejectCode || "");
      $("pd-sub").textContent = (p.rejectCode ? p.rejectCode + " · " : "") +
        (p.rejectReason || "內容需要修改") + "。修改後可以重新提交。";
    } else {
      mark.textContent = "⏳";
      mark.style.background = "var(--warn-tint)"; mark.style.color = "var(--warn)";
      $("pd-title").textContent = "已提交，等待審覈";
      $("pd-sub").textContent = "「" + p.t + "」正在審覈。通過後會出現在首頁「跑友活動」裏，並給你發一條 Telegram 通知（演示模擬）。";
    }

    var c = p.consent || {};
    var rows = [
      ["記錄編號", c.recId], ["活動 ID", c.activityId],
      ["簽署人", c.userName + " / " + c.userId], ["簽署人手機", c.userPhone],
      ["聲明版本", c.version + "（" + c.effective + " 生效）"],
      ["語言版本", c.lang],
      ["全文快照", c.snapshot], ["全文校驗值", c.hash], ["摘要算法", c.algo],
      ["確認項", (c.items || []).join("  ")],
      ["簽署時間", c.acceptedAt + "  " + c.tz],
      ["—— 簽署環境輔助留痕信息 ——", ""],
      ["IP 地址", c.ip], ["設備", c.device], ["User-Agent", c.ua], ["渠道", c.channel],
      ["—— ——", ""],
      ["保留期限", c.retention]
    ];
    $("pd-trace").innerHTML = rows.map(function (r) {
      if (!r[1]) return '<div style="opacity:.55"><span class="k"></span><span class="v">' + r[0] + '</span></div>';
      return '<div><span class="k">' + r[0] + '</span><span class="v">' + r[1] + '</span></div>';
    }).join("");

    // 種子帖只用來展示留痕格式，不給改狀態
    var frozen = ugcFrozen(p);
    $("sim-approve").disabled = (p.status === "published" && !frozen) || !p.mine;
    $("sim-reject").disabled = p.status === "rejected" || !p.mine || frozen;
    $("sim-freeze").disabled = !p.mine;
    $("sim-freeze").textContent = frozen ? "解除緊急凍結" : "模擬平臺緊急凍結";
  }

  $("sim-approve").addEventListener("click", function () {
    if (!lastPost || !lastPost.mine) return;
    S.frozen = S.frozen.filter(function (x) { return x !== lastPost.id; });
    lastPost.status = "published";
    delete lastPost.rejectReason; delete lastPost.rejectCode;
    save(); renderUgcHome(); renderPostDone();
    toast("審覈通過（演示）· 已發到首頁「跑友活動」");
  });
  $("sim-reject").addEventListener("click", function () {
    if (!lastPost || !lastPost.mine) return;
    var code = $("rej-code").value;
    var hit = REJECT_CODES.filter(function (r) { return r.code === code; })[0] || REJECT_CODES[0];
    lastPost.status = "rejected";
    lastPost.rejectCode = hit.code;
    lastPost.rejectReason = hit.t;
    save(); renderUgcHome(); renderPostDone();
    toast("審覈駁回（演示）· " + hit.code + " " + hit.t);
  });
  $("sim-freeze").addEventListener("click", function () {
    if (!lastPost || !lastPost.mine) return;
    if (ugcFrozen(lastPost)) {
      S.frozen = S.frozen.filter(function (x) { return x !== lastPost.id; });
      delete lastPost.freezeReason;
      toast("已解除凍結（演示）");
    } else {
      S.frozen.push(lastPost.id);
      var code = $("rej-code").value;
      var hit = REJECT_CODES.filter(function (r) { return r.code === code; })[0] || REJECT_CODES[0];
      lastPost.freezeReason = hit.code + " " + hit.t;
      toast("已緊急凍結（演示）· 聯繫方式已隱藏，禁止新報名");
    }
    save(); renderUgcHome(); renderPostDone();
  });
  $("pd-view").addEventListener("click", function () {
    if (!lastPost) return;
    curUgc = lastPost.id;
    go("ugc");
  });

  /* ---- 我發佈的 ---- */

  function renderMePosts(body) {
    if (!S.posts.length) {
      body.innerHTML = '<div class="empty"><b>你還沒發過活動</b>發一條試試，圖文都可以寫。</div>' +
        '<div class="btn-row" style="justify-content:center;margin-top:1rem"><button class="btn" data-go="post">＋ 發佈活動</button></div>';
      return;
    }
    S.posts.slice().reverse().forEach(function (p) {
      var status = ugcStatus(p);
      var st = UGC_ST[status] || ["—", ""];
      var d = document.createElement("div");
      d.className = "me-item";
      d.innerHTML =
        '<div class="me-main"><b>' + h(p.t) + '　<span class="st ' + st[1] + '">' + st[0] + '</span>' +
        ' <span class="org-tag ugc">跑友自主活動</span></b>' +
        '<div class="me-meta">' + h(p.d) + " · " + h(p.loc) + " · 發佈於 " + h(p.at) +
        (status === "published" ? "　報名 " + p.joined + " / " + p.cap + " 人" : "") + '</div>' +
        (status === "rejected" ? '<div class="me-meta" style="color:var(--stop)">駁回 ' +
          h(p.rejectCode || "") + '：' + h(p.rejectReason || "—") + '</div>' : '') +
        (status === "frozen" ? '<div class="me-meta" style="color:var(--stop)">平臺緊急凍結：' +
          h(p.freezeReason || "風險覈實中") + '　報名已關閉，聯繫方式已隱藏，留痕記錄保留</div>' : '') +
        '<div class="me-acts"></div></div>';
      var acts = d.querySelector(".me-acts");
      function add(label, fn, ghost) {
        var b = document.createElement("button");
        b.className = "btn sm" + (ghost ? " ghost" : "");
        b.textContent = label;
        b.addEventListener("click", fn);
        acts.appendChild(b);
      }
      add("查看", function () { curUgc = p.id; go("ugc"); });
      add("免責聲明留痕", function () { lastPost = p; go("postdone"); }, true);
      if (status === "published") {
        add("下架", function () {
          var b = this;
          withLock("close-" + p.id, b, "處理中…", function () {
            p.status = "closed"; save(); toast("已下架，留痕記錄仍然保留");
            renderUgcHome(); renderMe("posts");
          });
        }, true);
      }
      body.appendChild(d);
    });
  }

  /* ================================================================
     v3 · 演示場景控制器
     ================================================================ */

  var SCENARIOS = [
    { id: "default", n: "① 正常付費報名", go: "detail",
      note: "從賽事詳情開始，走完選組別 → 填資料 → 確認報名訂單 → KHQR 支付 → 憑證。", set: {} },
    { id: "free", n: "② 免費活動報名", go: "freedetail",
      note: "週六晨跑，名額充足，可以完整報名並拿到免費憑證。", set: { freeEv: "f1" } },
    { id: "full", n: "③ 免費活動名額已滿", go: "freedetail",
      note: "新手訓練營名額爲 0，報名按鈕變成「加入候補」。", set: { freeEv: "f3" } },
    { id: "wait", n: "④ 候補狀態", go: "me",
      note: "在「我的賽事」裏看候補記錄，可以退出候補。", set: { freeEv: "f3" } },
    { id: "paywait", n: "⑤ 支付等待中", go: "pay",
      note: "KHQR 已生成，前端每 3 秒輪詢一次到賬（模擬 Bakong 沒有 webhook 的現實）。", set: { payFast: false } },
    { id: "paytimeout", n: "⑥ 支付超時", go: "pay",
      note: "名額保留時間壓到 20 秒，看超時後頁面怎麼處理。", set: { payFast: true } },
    { id: "regdone", n: "⑦ 付費報名成功", go: "done", note: "電子參賽憑證 + 贊助商優惠券。", set: {} },
    { id: "resok", n: "⑧ 成績已發佈", go: "result", note: "完賽成績、分段、排名與電子完賽證書。", set: { resBib: 3247 } },
    { id: "dns", n: "⑨ DNS 未出發", go: "result", note: "報了名沒到起點，成績記 DNS，沒有證書。", set: { resBib: 4501 } },
    { id: "dnf", n: "⑩ DNF 未完賽", go: "result", note: "中途退賽，有分段但沒有完賽成績。", set: { resBib: 2077 } },
    { id: "aiok", n: "⑪ 號碼布找到照片", go: "photores", note: "號碼布 3247，找到多張已關聯這個號碼的照片。", set: { ai: "ok" } },
    { id: "ailow", n: "⑫ 號碼布拍得不清楚", go: "photores", note: "號碼布被衣服遮擋，工作人員只能標成疑似，需要用戶自己確認。", set: { ai: "low" } },
    { id: "aino", n: "⑬ 一張都沒匹配上", go: "photores", note: "一張都沒匹配上，頁面給出四條補救路徑。", set: { ai: "none" } },
    { id: "buy", n: "⑭ 用戶付費購買照片", go: "photo", note: "沒有贊助商買斷時，照片按原圖 / 精修 / 全套包售賣。", set: { ai: "ok", sponsorFree: false } },
    { id: "freeclaim", n: "⑮ 贊助商免費領取", go: "photo", note: "贊助商買斷本場照片，用戶免費領、帶水印、領券、分享。", set: { ai: "ok", sponsorFree: true } },
    { id: "dash", n: "⑯ 主辦方數據看板", go: "dash", note: "報名 / 賽事 / 照片 / 贊助 / Banner / 跑友活動，藍色指標會跟着你的操作變化。", set: {} },
    { id: "banner", n: "⑰ 首頁廣告 Banner", go: "home",
      note: "四張輪播：已售廣告、自家賽事、拉 UGC、招商空位。左右箭頭可手動切，鼠標移上去會暫停。", set: {} },
    { id: "ugcpost", n: "⑱ 用戶發佈活動", go: "post",
      note: "小紅書式圖文發佈。點「一鍵填入示例內容」可以跳過打字，免責聲明仍需逐條勾選。", set: {} },
    { id: "ugcview", n: "⑲ 跑友活動詳情", go: "ugc",
      note: "用戶發佈的活動長什麼樣：圖文、組織者、聯繫方式（報名後才解鎖）、免責提示與舉報入口。", set: { ugc: "g1" } },
    { id: "ugctrace", n: "⑳ 免責聲明留痕", go: "postdone",
      note: "發佈那一刻落庫的簽署記錄：版本號、語言版本、全文快照與校驗值、逐項勾選、時間，以及簽署環境輔助留痕信息。", set: {} },
    { id: "ugcfreeze", n: "㉑ 緊急凍結", go: "ugc", set: { ugc: "g2" },
      note: "平臺凍結一條高風險活動：禁止新報名、隱藏聯繫方式、已報名用戶看到醒目風險提示，三類記錄全部保留。" }
  ];

  function applyScenario(id, navigate) {
    var sc = null;
    for (var i = 0; i < SCENARIOS.length; i++) if (SCENARIOS[i].id === id) sc = SCENARIOS[i];
    if (!sc) return;
    S.scenario = id; save();
    for (var k in sc.set) SC[k] = sc.set[k];
    $("sc-note").textContent = sc.note;
    if ($("sc-sel").value !== id) $("sc-sel").value = id;

    if (sc.set.freeEv) curFree = sc.set.freeEv;
    if (sc.set.ugc) curUgc = sc.set.ugc;
    // 留痕場景需要一條實際存在的記錄，沒有就先用種子帖的簽署記錄頂上
    if (id === "ugctrace" && !lastPost) {
      /* 演示場景也必須落一條真實的「我發佈的」記錄，否則結果頁說已發佈、
         個人中心卻說沒發過，同一條數據兩處矛盾 */
      lastPost = S.posts.length ? S.posts[S.posts.length - 1] : seedMyPost();
    }
    // 凍結場景：把這條演示活動凍上，並給它報個名，好看到「已報名用戶的風險提示」
    if (id === "ugcfreeze") {
      if (S.joins.indexOf("g2") < 0) {
        var seed2 = ugcById("g2");
        if (seed2 && seed2.joined > 0) seed2.joined--;   // 騰一個位置給「我」，人數仍然是滿的
        S.joins.push("g2");
      }
      if (S.frozen.indexOf("g2") < 0) S.frozen.push("g2");
      var g2 = ugcById("g2");
      if (g2) g2.freezeReason = "R03 涉嫌詐騙，或要求用戶提供短信驗證碼";
      save();
    }
    if (sc.set.resBib) {
      var hit = DEMO.results.filter(function (r) { return r.bib === sc.set.resBib; })[0];
      if (hit) curRes = hit;
    }
    if (id === "aiok" || id === "ailow" || id === "aino") { phCtx.bib = 3247; search__silent(); }
    if (id === "buy" || id === "freeclaim") {
      phCtx.bib = 3247; search__silent();
      curPhoto = phCtx.list.length ? phCtx.list[0].id : DEMO.photos[0].id;
    }
    if (navigate) go(sc.go);
  }

  function search__silent() {
    var all = DEMO.photos.filter(function (p) { return p.ev === phEvent; });
    var hits = all.filter(function (p) { return p.bib === phCtx.bib && !p.unmatched; });
    phCtx.mode = "bib";
    phCtx.list = SC.ai === "none" ? [] : SC.ai === "low" ? hits.filter(function (p) { return p.conf < 70; }) : hits;
  }

  (function buildScenarioUI() {
    var sel = $("sc-sel");
    SCENARIOS.forEach(function (s) {
      var o = document.createElement("option");
      o.value = s.id; o.textContent = s.n;
      sel.appendChild(o);
    });
    sel.value = S.scenario && SCENARIOS.some(function (s) { return s.id === S.scenario; }) ? S.scenario : "default";
    sel.addEventListener("change", function () { applyScenario(this.value, true); });
  })();

  $("new-toggle").addEventListener("click", function () {
    var on = !document.body.classList.contains("show-new");
    document.body.classList.toggle("show-new", on);
    this.textContent = on ? "開" : "關";
    this.classList.toggle("on", on);
    this.setAttribute("aria-pressed", String(on));
  });

  $("reset-demo").addEventListener("click", resetDemo);

  /* ================================================================
     v3 · 讓付費報名也進「我的賽事」
     ================================================================ */

  /* ⚖️ D-098 A1 · 進入 KHQR 那一刻就在共享域建單並<b>真的</b>佔住名額與配額。
     以前是等到 done 頁才第一次建單，於是付款窗口裏那句「名額爲你保留 10:00」
     背後什麼都沒有。現在這句話對應一筆真實的共享預留事實。
     A9 冪等：同一次結賬（同一個 orderNo）重進 / 重渲染只對應同一張單。 */
  function reserveRegOrder() {
    RD.load();
    var already = RD.orderByNo(ORD.orderNo);
    /* ⚖️ D-098 A9 · 冪等的邊界是「<b>這一次</b>結賬」：
       同一張還在付款窗口裏的單，重進 / 重渲染都返回它本身；
       但如果這個訂單號對應的交易<b>已經結束</b>（付過款、或已過期作廢），
       那麼現在進入 KHQR 就是<b>一筆新的結賬</b>，必須鑄新的訂單號重新搶名額，
       否則第二次報名會被錯當成第一次的重放。 */
    /* ⚖️ D-100 A4 · 重進付款頁時，先按<b>業務截止時刻</b>結算掉過期的舊單：
       該 EXPIRED 的當場 EXPIRED、預留恰好一次放回公共池。絕不給它續命。 */
    if (already) RD.settleIfPastDeadline(already, { who: "system", role: "SYSTEM" });
    if (already && already.status !== "PENDING_PAYMENT") {
      /* 這個訂單號對應的交易已經結束（付過款 / 已過期作廢）：
         現在進入 KHQR 就是<b>一筆新的結賬</b>，鑄新單號重新搶名額。
         注意：這裏只是準備好新單號，真正建單在下面 —— 舊單原樣留作歷史。 */
      RD.save();
      ORD.orderNo = newOrderNo();
      already = null;
    }
    if (already) return { ok: true, order: already, idempotent: true };
    var res = RD.createRegistrationOrder({
      /* ⚖️ D-121 R6 · 這裏以前永久寫死 e1，於是從 e3 進來的人也會給 EV-A 建單、
         佔 EV-A 的名額、燒 EV-A 的 quota。訂單歸屬只能是<b>用戶點進來的那場</b>。 */
      orderNo: ORD.orderNo, eventId: RD.adminEventId(selRace()),
      buyer: ORD.parts[0] ? ORD.parts[0].name : DEMO.user.name,
      buyerUserId: "u1", phone: (ORD.parts[0] && ORD.parts[0].phone) || DEMO.user.phone,
      amount: total(), discount: state.discount, discountCode: state.code || null,
      /* 演示場景「⑥ 支付超時」把窗口壓到 20 秒。倒計時現在是 deadline 的視圖，
         所以窗口長度必須寫進訂單本身，不能 UI 一套、訂單另一套。 */
      holdSeconds: SC.payFast ? 20 : 600,
      participants: ORD.parts.map(function (pt) {
        return { name: pt.name, catId: pt.cat, phone: pt.phone, dob: pt.dob,
                 ageOnRaceDay: ageOnRaceDay(pt.dob),
                 gender: pt.gender === "女" ? "F" : "M", nation: pt.aud === "exp" ? "OTHER" : "KH",
                 size: pt.size.split("（")[0], audience: feAudience(pt.aud) };
      }),
      actor: { who: "user:u1", role: "USER" }
    });
    if (res.ok) RD.save();
    return res;
  }

  /* ⚖️ D-098 A3 · 付款窗口超時：名額與配額<b>真的</b>放回公共池，恰好一次。
     重複的超時回調只有第一次生效。 */
  function expireRegOrder() {
    RD.load();
    var o = (payOrderId && RD.findOrder(payOrderId)) || RD.orderByNo(ORD.orderNo);
    if (!o) return null;
    var res = RD.expireRegistrationOrder(o.id, { who: "system", role: "SYSTEM" });
    if (res.ok && !res.already) RD.save();
    return res;
  }

  /* ⚖️ D-098 A2 · 支付成功<b>不新建訂單</b>，只把同一張 PENDING_PAYMENT 推進到
     PAID：名額不再加第二次，配額 RESERVED → CONSUMED。
     成功頁解析的就是這同一張共享訂單。 */
  function recordPaidReg() {
    var main = ORD.parts[0];
    var cName = main ? catById(main.cat) : null;
    var cat = cName ? (cName.n + (cName.d ? " " + cName.d : "")) : "—";
    /* 寫盤前先重讀共享狀態：這一頁可能已經開了很久，期間後臺可能已經分配了
       號碼布 / 處理了退款。拿過期快照寫盤會覆蓋另一端剛做完的事。 */
    RD.load();
    var o = RD.orderByNo(ORD.orderNo);
    if (!o) {
      /* 正常路徑不會走到這裏（進 KHQR 時就該建單了）。刷新後直接跳成功頁
         這類情況，不再憑空補建一張 PAID 單 —— 那正是被判 F-002 的舊語義。 */
      return;
    }
    /* ⚖️ D-125 R6 · <b>成功頁是一個視圖，不是收款入口。</b>
       它以前會調 confirmRegistrationPayment(role: USER) —— 等於「頁面渲染出來了」
       本身就能把錢變出來。收款必須在<b>進入這一頁之前</b>由有資格的一方完成；
       這裏只<b>讀</b>一張已經 PAID 的訂單並把它畫出來。
       沒付成功就什麼都不寫，也不假裝成功。 */
    if (o.status !== "PAID") {
      toast("這張訂單還不是「已支付」（當前 " + o.status + "），成功頁不會替它確認到賬。");
      return;
    }
    var dOrd = o;
    /* ⚖️ D-121 R8 · 這條本地展示殼掛在<b>訂單自己的賽事</b>上，
       不是「用戶此刻在瀏覽哪一場」—— 那兩件事可以完全不同。 */
    var feId = RD.feEventId(dOrd.eventId) || FE_EVENT;
    var ev = evById(feId) || evById(FE_EVENT);
    if (S.regs.some(function (r) { return r.domainId === dOrd.id; })) { save(); return; }
    /* 下面這條本地 S.regs 記錄只是 v5 工作人員端原型的<b>展示殼</b>，
       不持有號碼布 / 持有人 / 狀態這類業務真相（D-096 F-003 / D2）。 */
    S.regs.push({
      id: "r" + Date.now(), ev: feId, kind: "paid", status: "registered",
      domainId: dOrd.id,
      cat: cat + (ORD.parts.length > 1 ? "（本單共 " + ORD.parts.length + " 人）" : ""),
      code: ORD.orderNo, paid: dOrd.amount, at: ev.d,
      parts: dOrd.participants.map(function (op) {
        return { pid: op.id, regId: op.regId, name: op.name, catId: op.cat, aud: op.audience === "LOCAL" ? "cam" : "exp",
          size: op.reg.size, fee: op.paid, status: "registered" };
      })
    });
    if (!S.coupons.some(function (c) { return c.id === "cp-bw"; })) {
      S.coupons.push({ id: "cp-bw", n: "BlueWave Sports Drink 全場 8 折", code: "RUN-BW-8842", exp: "2026.09.30", used: false });
    }
    save();
    renderRaceLists();
  }

  /* 賽事卡片重繪（名額會變） */
  function renderRaceLists() {
    if (!homeWrap) return;
    allWrap.innerHTML = "";
    renderNextRace();
    renderHomeMosaic();
    renderFreeLight();
    publicRaces().forEach(function (r, i) { allWrap.appendChild(raceCard(r, i)); });
    renderUgcHome();
    requestAnimationFrame(paintAll);
  }

  /* ================================================================
     v3 · 推薦演示順序（約 5 分鐘）
     ================================================================ */

  /* 演示主線：先講清楚 RUN 的核心生意（官方賽事 → 成績 → 照片 → 贊助 → 看板），
     跑友活動和廣告 Banner 放最後當增量，不許搶主線。 */
  var TOUR = [
    { t: "首頁 · v6 視覺", d: "Race Day Editorial：照片 Hero + Next Race 卡、1 大 + 2 小賽事馬賽克、三語切換（右上角）", go: "home" },
    { t: "賽事搜索與篩選", d: "按名稱 / 地點搜索，按月份、地點、狀態篩選", go: "races" },
    { t: "賽事詳情 · 硬信息", d: "Cut-off、分批起跑、Race Pack 時間地點、賽包清單、代領規則", go: "detail" },
    { t: "遊客報名", d: "不彈登錄牆，直接進流程；頂部說明「無需註冊即可報名」", go: "reg1", sc: "default" },
    { t: "添加第二參賽者", d: "一筆訂單最多 5 人，每人獨立組別、價格、尺碼與號碼布", go: "reg1" },
    { t: "本地 / 外國人雙軌價格", d: "同一組別 Cambodian 與 Expatriate 價格不同；本地價需現場覈驗證件", go: "reg1" },
    { t: "參賽資料", d: "按參賽者分頁籤填寫，手機號必填——這是付款後認領賬號的憑據", go: "reg2" },
    { t: "確認訂單", d: "多參賽者明細 + 三層肖像授權，一筆訂單統一付款", go: "reg4" },
    { t: "KHQR 模擬支付", d: "倒計時與輪詢都是前端模擬，真實到賬由後端輪詢判斷", go: "pay" },
    { t: "賬號認領", d: "付款成功後創建賬號，一鍵認領本次報名與歷史成績", go: "done" },
    { t: "我的跑步履歷", d: "歷史賽事全部歸入同一檔案——這是三年數據在用戶側的樣子", go: "me-history" },
    { t: "成績庫", d: "按賽事瀏覽，或直接輸號碼布 / 姓名查人", go: "results" },
    { t: "單場成績榜", d: "四種榜單切換、排序、分頁、搜索", go: "resultev" },
    { t: "個人永久成績頁", d: "不登錄可訪問，帶分段與四種排名分母，可分享", go: "presult" },
    { t: "Race Pack 工作臺", d: "工作人員端：掃碼查人、覈驗身份、確認領取", go: "racepack" },
    { t: "離線模式", d: "斷網仍可掃碼與覈銷，恢復後同步去重", go: "racepack" },
    { t: "Bib 換號", d: "1001 → 2001，換號是追加記錄而不是覆蓋號碼", go: "bibmgmt" },
    { t: "換號後的成績", d: "成績頁顯示新號，原號仍在變更記錄裏", go: "presult" },
    { t: "換號後的照片", d: "用新號也能搜到原來掛在舊號上的照片", go: "photos" },
    { t: "贊助商免費照片", d: "贊助商買單，原價 $4 變免費，帶品牌水印", go: "photo", sc: "freeclaim" },
    { t: "跑友活動", d: "用戶自主發佈，非官方主辦；聯繫方式報名後才解鎖", go: "ugc", sc: "ugcview" },
    { t: "主辦方數據看板", d: "報名 / 賽事 / 照片 / 贊助四塊，藍色數字跟着剛纔的操作變了", go: "dash" }
  ];


  (function buildTour() {
    var list = $("tour-list");
    TOUR.forEach(function (item, i) {
      var li = document.createElement("li");
      li.innerHTML = '<i>' + (i + 1) + '</i><button type="button"></button>';
      var b = li.querySelector("button");
      b.innerHTML = item.t + '<span>' + item.d + '</span>';
      b.addEventListener("click", function () {
        if (item.sc) applyScenario(item.sc, false);
        if (item.fill) { $("rs-q").value = String(item.fill); }
        go(item.go);
        if (item.fill) later(renderResultsHome2, 60);
      });
      list.appendChild(li);
    });
    $("tour-toggle").addEventListener("click", function () {
      var open = list.classList.toggle("open");
      this.textContent = (open ? "▾" : "▸") + " 推薦演示順序 · 約 12 分鐘";
      this.setAttribute("aria-expanded", String(open));
    });
  })();

  /* ---------------- boot ---------------- */

  // 沒有構建步驟時佔位符不會被替換，別讓面板裏直接露出 __BUILD_COMMIT__
  $("build-info").innerHTML =
    "RUN Demo " + BUILD.version + "<br>Build " + BUILD.date +
    "<br>Commit " + (/^[0-9a-f]{7,40}$/.test(BUILD.commit) ? BUILD.commit : "未注入（無構建步驟）") +
    "<br>Branch " + BUILD.branch;

  authzRows($("reg-authz"), function () {
    var all = Array.prototype.every.call(document.querySelectorAll(".ag"), function (x) { return x.checked; });
    $("to-pay").disabled = !(all && S.authz.shoot && S.authz.promo);
  });

  // 從上次的上下文恢復，保證刷新後不是空狀態
  curFree = S.ctx.freeEv;
  curPhoto = S.ctx.photo;
  phEvent = S.ctx.phEvent;
  phCtx.bib = S.ctx.phBib;
  phCtx.mode = S.ctx.phMode;
  meTab = S.ctx.meTab;
  curUgc = S.ctx.ugc;
  rsEvent = "e1";
  if (S.ctx.resBib) {
    curRes = DEMO.results.filter(function (r) { return r.bib === S.ctx.resBib; })[0] || null;
  }

  /* D-121 · 恢復上次停留的那一場（只有真的還能公開進入才恢復；
     否則回到本屆演示賽事，絕不把用戶丟在一個已經變成草稿的賽事上） */
  (function restoreSelectedRace(){
    var want = S.ctx.selRace || FE_EVENT;
    if (!evById(want)) want = FE_EVENT;
    if (sharedEventOf(want) && !sharedPublished(want)) want = FE_EVENT;
    selectedRaceId = want;
  })();
  renderRoute(S.ctx.rmGroup || "21k");
  buildBanner();
  renderRaceLists();
  (function restoreLang() {
    var l = "zh";
    try { l = localStorage.getItem("run.lang") || "zh"; } catch (e) {}
    setLang(l, true);
  })();
  applyScenario($("sc-sel").value, false);
  search__silent();


  /* ================================================================
     ================  v5 · 競品缺口補全（純前端演示）  ================
     全部爲前端模擬：無後端、無數據庫、無真實支付 / 短信 / 存儲 / OCR。
     ================================================================ */

  function h(x) {
    return String(x == null ? "" : x).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function todo(msg) { toast(msg || "正式系統將在後端接入後執行此操作，當前爲前端演示。"); }

  /* 「模擬進入賽後」：一場還在報名的比賽不可能已經有正式成績。
     賽前只開放 Race Pack / Bib 運營；切到賽後才發佈成績與照片。
     這樣換號鏈路（Bib 1001 → 2001 → 成績 → 照片）依然完整，但不製造業務上不存在的狀態。 */
  var PHASES = [
    ["open",   "報名中",              "報名開放，尚未比賽：沒有成績、沒有照片、領物尚未開始"],
    ["closed", "報名已截止 · 領物期", "不能再報名；已報名的人查憑證、領 Race Pack；仍然沒有成績"],
    ["post",   "賽後 · 成績已發佈",   "比賽已結束：成績、證書、照片全部開放"]
  ];
  function phase() { return S.phase || "open"; }
  function isPostRace() { return phase() === "post"; }
  function regOpen()    { return phase() === "open"; }
  function packOpen()   { return phase() === "closed" || phase() === "post"; }
  function phaseLabel() {
    for (var i = 0; i < PHASES.length; i++) if (PHASES[i][0] === phase()) return PHASES[i][1];
    return "報名中";
  }
  function setPhase(v) {
    S.phase = v; save(); syncPhase();
    var note = PHASES.filter(function (x) { return x[0] === v; })[0];
    toast("賽事階段 → " + note[1] + "（演示）");
  }
  function nextPhase() {
    var order = ["open", "closed", "post"];
    setPhase(order[(order.indexOf(phase()) + 1) % 3]);
  }
  function syncPhase() {
    var b = $("phase-toggle");
    if (b) {
      b.textContent = phaseLabel();
      b.classList.toggle("on", phase() !== "open");
    }
    var n = $("phase-note");
    if (n) {
      var cur = PHASES.filter(function (x) { return x[0] === phase(); })[0];
      n.textContent = cur ? cur[2] : "";
    }
    if (typeof renderRaceLists === "function") renderRaceLists();
    if (typeof applyRF === "function") applyRF();
  }
  /* ⚖️ D-117 B1 / B2 · <b>「比賽舉行了嗎」和「這一批成績發佈了嗎」是兩個事實。</b>
     ----------------------------------------------------------------
     演示階段（S.phase = post）只回答前一個。後一個的唯一權威是共享域裏的
     ResultBatch —— 那是後臺「發佈成績 / 撤回發佈」真正寫進去的東西。
     以前用戶端只看階段，於是 OPS 把 RB-1 撤回發佈之後，用戶這邊照樣把它
     當正式成績展示、照樣出證書：同一件事，兩邊兩個答案。

     現在兩個都要成立。判定按 <b>(賽事, 組別)</b> 逐個算，撤回一個組別
     不會連累另一個組別自己有效的 PUBLISHED 批次（B3）。
     沒有 PUBLISHED 批次時數據一行不刪，只是不再當成「當前正式成績」呈現（B4 / B13）。
     ⚠️ 共享域裏<b>還沒有</b>成績批次這份事實時（用戶從沒打開過後臺），
     回落到既有演示行爲 —— 絕不把「沒有事實」讀成「未發佈」。
     ⚠️ 不新增 REPUBLISHED：新批次發佈之後自然又有了 PUBLISHED，就又看得見（B10）。 */

  /* 前端的距離標籤 / 組別名 → 共享 Category。用的是共享域自己的 feId / feName，
     不在前端另立一張映射表。 */
  function sharedCatIdOfLabel(feEvId, label) {
    var e = sharedEventOf(feEvId);
    if (!e || !label) return null;
    var s = String(label).toLowerCase(), hit = null;
    e.categories.forEach(function (c) {
      if (hit) return;
      if (c.feId && s.indexOf(String(c.feId).toLowerCase()) === 0) hit = c;        /* "21K" → feId "21k" */
      else if (c.feName && s.indexOf(String(c.feName).toLowerCase()) === 0) hit = c; /* "半程馬拉松 21.1 km" */
    });
    return hit ? hit.id : null;
  }
  /* 本屆某個組別當前的發佈事實："PUBLISHED" / "UNPUBLISHED" / "PENDING" / null */
  function currentResultState(label) {
    var evId = RD.adminEventId(FE_EVENT);
    var catId = evId ? sharedCatIdOfLabel(FE_EVENT, label) : null;
    return catId ? RD.resultBatchStateOf(evId, catId) : null;
  }
  /* 本屆（h0 / e1）某個組別的成績是否可以按<b>當前正式成績</b>呈現。
     不傳組別時是整場的聚合：任意一個組別有 PUBLISHED 批次就算這場有成績可看。 */
  function published(hid, dist) {
    if (hid !== "h0") return true;            /* 往期演示賽事：既有行爲一個字不動 */
    if (!isPostRace()) return false;          /* 比賽還沒有舉行 */
    var hs = histById("h0");
    var dists = dist ? [dist] : ((hs && hs.dists) || []);
    var known = false, any = false;
    for (var i = 0; i < dists.length; i++) {
      var v = currentResultState(dists[i]);
      if (v === null) continue;               /* 這一組沒有共享事實，不參與判定 */
      known = true;
      if (v === "PUBLISHED") any = true;
    }
    return known ? any : true;                /* 一條事實都沒有 → 回落到既有演示行爲 */
  }
  /* 「成績複覈中」<b>只</b>指曾經發布、之後被 OPS 撤回的那一種。
     「從來沒發佈過」（DRAFT / VALIDATED）是另一句話：成績尚未發佈。
     兩者都看不到成績，但原因不同，不能共用一段文案。 */
  /* 成績看不到，只有三種原因。文案在<b>一處</b>定死，成績榜 / 永久成績頁 / 成績詳情
     三個入口共用 —— 不給每個屏各寫一套發佈規則（B5：不許每屏一套規則）。 */
  function resultBlockNote(hid, dist) {
    if (underReview(hid, dist)) {
      return { key: "review", title: "成績複覈中",
        body: "本組成績<b>當前不是已發佈狀態</b>，主辦方正在複覈。複覈期間不顯示名次與淨成績，" +
              "<b>成績複覈中，證書暫不可生成</b>。<b>成績數據沒有被刪除</b>，重新發布之後會自動恢復。" };
    }
    if (isPostRace()) {
      return { key: "pending", title: "成績尚未發佈",
        body: "本組成績還在「導入 → 校驗 → 發佈」這條鏈路上，主辦方<b>尚未發佈</b>。" +
              "未發佈的成績不顯示名次與淨成績，也不生成完賽證書；發佈之後這裏會自動出現。" };
    }
    return { key: "notyet", title: "比賽尚未舉行 · 成績未發佈",
      /* D-111 A6 · 對外聲明的比賽日期以共享事實爲準，別再寫死一個。 */
      body: "本場比賽日 " + h((sharedEventDate(FE_EVENT) || "").replace(/-/g, ".") || histById("h0").d) +
            "。成績由計時公司 CSV 導入、校驗後發佈，" +
            "在那之前不會有任何完賽時間、名次或證書。" };
  }
  function underReview(hid, dist) {
    if (hid !== "h0" || !isPostRace()) return false;
    var hs = histById("h0");
    var dists = dist ? [dist] : ((hs && hs.dists) || []);
    for (var i = 0; i < dists.length; i++) {
      if (currentResultState(dists[i]) === "UNPUBLISHED") return true;
    }
    return false;
  }

  /* ---------- 名額：只有一個前端數據源 ---------- */
  /* 已佔用名額 = 該賽事下所有「有效」參賽者。付費單按人算，免費活動按條算。 */
  function usedSeats(evId) {
    var n = 0;
    /* D-092 · 共享業務域裏的有效報名同樣佔名額；本地 S.regs 裏帶 domainId 的付費記錄
       只是鏡像，不再重複計數，否則同一個人會被算兩次。 */
    var adminEv = RD.adminEventId(evId);
    if (adminEv) {
      RD.state.orders.forEach(function (o) {
        if (o.eventId !== adminEv) return;
        /* ⚖️ D-098 A8 · 付款窗口裏被預留的位子對別人來說<b>就是不可用</b>，
           所以 PENDING 也算佔用 —— 否則「名額爲你保留」對別人不成立。 */
        o.participants.forEach(function (p) {
          if (p.regStatus === "CONFIRMED") n += 1;
          else if (p.regStatus === "PENDING" && o.status === "PENDING_PAYMENT") n += 1;
        });
      });
    }
    S.regs.forEach(function (r) {
      if (r.kind === "paid" && r.domainId) return;
      if (r.ev !== evId || r.status === "cancelled") return;
      if (r.kind === "free") { if (r.status === "registered") n += 1; return; }
      if (r.parts && r.parts.length) {
        r.parts.forEach(function (p) { if (p.status !== "cancelled") n += 1; });
      } else if (r.status === "registered") { n += 1; }
    });
    return n;
  }
  /* 某人是否已通過本地價資格覈驗 */
  /* ⚖️ D-100 B3 · 證件覈驗只有一份共享事實。真實報名一律按 regId 認；
     演示底表那 18 人沒有共享 Registration，用一個穩定的 LEGACY 鍵掛在同一張表上，
     兩邊互不干擾，但都<b>只有這一張表</b>。 */
  function packKey(r) { return r && r.regId ? r.regId : ("LEGACY:" + (r && r.uid)); }
  function now2() {
    var d = new Date(), p2 = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) +
           " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
  }
  function idOK(r) {
    /* ⚖️ D-102 Rule 7 · 退役的 S.idChecked 不再參與任何判定，
       覈驗與否一律現取共享事實。傳字符串是老調用，同樣走共享解析。 */
    return RD.racePackIdVerified(typeof r === "string" ? (RD.resolveLegacyRegId(r) || r) : packKey(r));
  }
  function setIdOK(r) {
    var res = RD.verifyRacePackId(packKey(r), { who: "staff:" + S.device, role: "RACE_STAFF" });
    RD.save();
    return res;
  }

  /* ---------------- 身份類型與價格規則 ---------------- */

  var AUD = {
    cam: { s: "Cambodian", zh: "柬埔寨籍", need: true },
    exp: { s: "Expatriate", zh: "外籍 / International", need: false }
  };
  var PHASE = { early: "Early Bird", normal: "Normal" };
  /* 演示口徑：早鳥至 2026.08.20，之後爲正常價。原型固定停在早鳥階段。 */
  var PHASE_NOW = "early";
  var PHASE_NOTE = { early: "早鳥價 · 至 2026.08.20", normal: "正常價 · 08.21 起" };
  /* ⚖️ D-111 A5 · 比賽日期是<b>業務事實</b>，不是一個可以寫死的展示常量。
     資格判定按「比賽當天年齡」算，所以判定用的日期必須來自共享賽事本身。
     以前這裏寫死 2026-09-20，而共享 EV-A 是 2026-11-15 ——
     用戶看到一個日期，系統卻按另一個日期判他夠不夠年齡。
     沒有映射的演示賽事仍回落到這個裝飾日期。 */
  var RACE_DAY_FALLBACK = "2026-09-20";
  function raceDay() {
    return sharedEventDate(selRace()) || RACE_DAY_FALLBACK;   /* D-121 · 資格按<b>選中那場</b>的比賽日算 */
  }

  /* PriceRule 的前端形態：組別 × 身份 × 階段 × 年齡門檻 × 名額。
     正式系統裏這是一張獨立的表，一期後臺按賽事逐條配置。 */
  /* D-097 · 價格、年齡門檻、名額、配額<b>全部</b>取自共享域那一套 PriceRule / Category。
     用戶端不再持有第二張價格表 —— 同一個賽事不允許有兩套價格真相。
     規則沒變：姓名、成績、照片可以是假數據；價格、費率、年齡門檻、退款與身份規則不能編。 */
  function feAudience(aud) { return aud === "exp" ? "ALL" : "LOCAL"; }

  function catById(id) {
    var live = CATS_LIVE();
    for (var i = 0; i < live.length; i++) if (live[i].id === id) return live[i];
    return live[0];
  }
  function ageOnRaceDay(dob) {
    if (!dob) return null;
    var d = new Date(dob + "T00:00:00"), r = new Date(raceDay() + "T00:00:00");
    if (isNaN(d.getTime())) return null;
    var a = r.getFullYear() - d.getFullYear();
    var m = r.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && r.getDate() < d.getDate())) a--;
    return a;
  }
  /* 命中唯一一條價格檔；命中不到就說清楚爲什麼。判定全部來自共享域。 */
  function priceFor(catId, aud, dob) {
    var cat = catById(catId);
    /* ⚖️ D-121 R4 · 價格檔在<b>選中的那場賽事</b>裏找。e3 卡片上那個裝飾性的
       「$25 起」不是財務事實，共享 PriceRule 纔是。 */
    var evId = RD.adminEventId(selRace());
    if (!cat || !cat.adminId) {
      return { blocked: "暫未開放 · Price TBA（價格與規則尚未確定，原型不編造）" };
    }
    if (RD.capacityLeft(evId, cat.adminId) <= 0) return { blocked: "名額已滿，可加入候補（演示）" };
    var elig = RD.categoryEligibility(evId, cat.adminId, ageOnRaceDay(dob));
    if (!elig.ok) {
      return { blocked: elig.why === "需要出生日期才能按比賽當天年齡判定資格"
        ? "請先填寫出生日期，系統需要按比賽當天的年齡判斷" : elig.why };
    }
    var m = RD.matchPriceRule(evId, cat.adminId, feAudience(aud));
    if (!m.ok) return { blocked: m.why };
    return { amount: m.rule.price, ruleId: m.rule.id, ruleName: m.rule.name,
             window: m.rule.window, phase: PHASE_NOW, phaseName: m.rule.name };
  }
  function ptPrice(pt) {
    if (!pt || !pt.cat) return null;
    var r = priceFor(pt.cat, pt.aud, pt.dob);
    return (r && r.amount != null) ? r : null;
  }

  /* ---------------- 訂單模型：Buyer → Order → Participant ---------------- */

  var ORD = { orderNo: "RUN26PP4821", parts: [] };
  var MAX_PARTS = 5;
  var SIZES = ["S（胸圍 96）", "M（胸圍 102）", "L（胸圍 108）", "XL（胸圍 114）", "XXL（胸圍 120）"];
  var ptSeq = 0;

  function newPart(seed) {
    ptSeq++;
    return {
      id: "pt" + ptSeq,
      name: seed ? DEMO.user.name : "",
      aud: "cam",
      dob: seed ? DEMO.user.dob : "",
      cat: null,
      gender: seed ? DEMO.user.gender : "男",
      phone: seed ? DEMO.user.phone : "",
      idNo: seed ? DEMO.user.idNo : "",
      size: "M（胸圍 102）",
      ec: seed ? DEMO.user.ec : "",
      ecp: seed ? DEMO.user.ecPhone : ""
    };
  }
  function resetOrder() {
    ptSeq = 0;
    /* ⚖️ D-096 F-004 · 每一次新的結賬都是一筆新的訂單，必須有<b>自己的訂單號</b>。
       冪等邊界是這張訂單，不是「這個賽事」——同一個買家完全可以合法地下第二單。 */
    ORD.orderNo = newOrderNo();
    ORD.parts = [newPart(true)];
    pdActive = 0;
    renderParts();
  }

  /* ---------------- reg1 · 參賽者與組別 ---------------- */

  function partValid1(pt) {
    if (!pt.name.trim()) return "請填寫姓名";
    if (!pt.dob) return "請填寫出生日期";
    if (!pt.cat) return "請選擇組別";
    if (!ptPrice(pt)) return "所選組別不可報名";
    return null;
  }

  function renderParts() {
    var wrap = $("pt-list");
    if (!wrap) return;
    wrap.innerHTML = "";

    ORD.parts.forEach(function (pt, idx) {
      var card = document.createElement("div");
      card.className = "pt-card";

      var cats = CATS_LIVE().map(function (c) {
        var r = priceFor(c.id, pt.aud, pt.dob);
        var on = pt.cat === c.id;
        var ok = r && r.amount != null;
        var right = ok ? ("$" + r.amount) : (c.adminId ? "—" : "TBA");
        var sub = ok
          ? (AUD[pt.aud].s + " · " + r.ruleName + "（" + r.window + "）" +
             (c.minAge ? " · " + c.minAge + "+" : " · 不限年齡"))
          : (r && r.blocked ? r.blocked : "不可報名");
        return '<button type="button" class="' + (on ? "on" : "") + '"' + (ok ? "" : " disabled") +
          ' data-pt="' + pt.id + '" data-cat="' + c.id + '">' +
          '<span class="opt-radio"' + (on ? ' style="border-color:var(--brand);background:radial-gradient(circle,var(--brand) 45%,transparent 46%)"' : '') + '></span>' +
          '<span class="cp-main"><b>' + h(c.n) + '　' + h(c.d) + '</b><span>' + h(sub) + '</span></span>' +
          '<span class="cp-p' + (ok ? "" : " off") + '">' + right + '</span></button>';
      }).join("");

      var altAud = pt.aud === "cam" ? "exp" : "cam";
      var altHint = (function () {
        if (!pt.cat) return "";
        var a = priceFor(pt.cat, pt.aud, pt.dob), b = priceFor(pt.cat, altAud, pt.dob);
        if (!a || a.amount == null || !b || b.amount == null) return "";
        return '<p class="mut" style="font-size:.78rem;margin:.45rem 0 0">同組別 ' +
          h(AUD[altAud].s) + ' 價格爲 $' + b.amount + '，身份不同價格不同——這是柬埔寨賽事的標準做法。</p>';
      })();

      card.innerHTML =
        '<div class="pt-head">' +
          '<span class="pt-no">PARTICIPANT ' + (idx + 1) + '</span>' +
          '<b>' + h(pt.name || "未填寫姓名") + '</b>' +
          (ORD.parts.length > 1 ? '<button type="button" data-del="' + pt.id + '">移除</button>' : '') +
        '</div>' +
        '<div class="pt-body">' +
          '<div class="field"><label>姓名（拉丁字母）<span class="hint">與證件一致，將印在號碼布上</span></label>' +
            '<input type="text" data-f="name" data-pt="' + pt.id + '" value="' + h(pt.name) + '" placeholder="SOK DARA"></div>' +

          '<div class="field"><label>Participant Type · 參賽者類型</label>' +
            '<div class="seg">' +
              '<button type="button" data-aud="cam" data-pt="' + pt.id + '" class="' + (pt.aud === "cam" ? "on" : "") + '">Cambodian</button>' +
              '<button type="button" data-aud="exp" data-pt="' + pt.id + '" class="' + (pt.aud === "exp" ? "on" : "") + '">International / Expatriate</button>' +
            '</div>' +
            (pt.aud === "cam" ? '<div class="id-note">領取 Race Pack 時需出示柬埔寨身份證件進行資格覈驗。覈驗不通過需現場補差價。</div>' : '') +
          '</div>' +

          '<div class="field"><label>出生日期<span class="hint">按比賽當天 ' + raceDay().replace(/-/g, ".") + ' 判斷年齡門檻</span></label>' +
            '<input type="date" data-f="dob" data-pt="' + pt.id + '" value="' + h(pt.dob) + '"></div>' +

          '<div class="field" style="margin-bottom:0"><label>選擇組別</label>' +
            '<div class="cat-pick">' + cats + '</div>' + altHint + '</div>' +
        '</div>';

      wrap.appendChild(card);
    });

    /* 小計 */
    var sum = $("pt-sum");
    var okParts = ORD.parts.filter(function (p) { return !partValid1(p); });
    if (!okParts.length) {
      sum.innerHTML = '<p class="sum-head">費用預覽</p><p class="sum-sub">選好組別後這裏會顯示每個人的價格。</p>';
    } else {
      var t = 0;
      sum.innerHTML = '<p class="sum-head">費用預覽</p><p class="sum-sub">一筆訂單統一付款，每人獨立號碼布與電子憑證</p>' +
        okParts.map(function (p) {
          var pr = ptPrice(p); t += pr.amount;
          return '<div class="sum-line"><span>' + h(p.name) + ' · ' + h(catById(p.cat).d) + ' · ' + h(AUD[p.aud].s) +
            '</span><span>' + money(pr.amount) + '</span></div>';
        }).join("") +
        '<div class="sum-line total"><span>報名費小計</span><span>' + money(t) + '</span></div>';
    }

    $("pt-add").disabled = ORD.parts.length >= MAX_PARTS;
    $("pt-add").textContent = ORD.parts.length >= MAX_PARTS
      ? "一筆訂單最多 5 名參賽者（演示上限）"
      : "＋ 添加參賽者（幫朋友、家人或跑團一起報名）";

    var bad = null;
    for (var i = 0; i < ORD.parts.length; i++) {
      var m = partValid1(ORD.parts[i]);
      if (m) { bad = "參賽者 " + (i + 1) + "：" + m; break; }
    }
    $("to-reg2").disabled = !!bad;
    $("pt-why").hidden = !bad;
    $("pt-why").textContent = bad || "";

    var grpBadge = $("group-discount-badge");
    if (grpBadge) {
      grpBadge.style.display = ORD.parts.length >= 3 ? "block" : "none";
    }
  }

  function ptById(id) {
    for (var i = 0; i < ORD.parts.length; i++) if (ORD.parts[i].id === id) return ORD.parts[i];
    return null;
  }

  (function bindReg1() {
    var wrap = $("pt-list");
    wrap.addEventListener("click", function (e) {
      var t = e.target.closest("[data-del]");
      if (t) {
        ORD.parts = ORD.parts.filter(function (p) { return p.id !== t.getAttribute("data-del"); });
        if (pdActive >= ORD.parts.length) pdActive = ORD.parts.length - 1;
        renderParts(); return;
      }
      t = e.target.closest("[data-aud]");
      if (t) {
        var p1 = ptById(t.getAttribute("data-pt"));
        if (p1) { p1.aud = t.getAttribute("data-aud"); renderParts(); }
        return;
      }
      t = e.target.closest("[data-cat]");
      if (t && !t.disabled) {
        var p2 = ptById(t.getAttribute("data-pt"));
        if (p2) { p2.cat = t.getAttribute("data-cat"); renderParts(); }
      }
    });
    wrap.addEventListener("input", function (e) {
      var f = e.target.getAttribute && e.target.getAttribute("data-f");
      if (!f) return;
      var p = ptById(e.target.getAttribute("data-pt"));
      if (!p) return;
      p[f] = e.target.value;
      if (f === "dob") renderParts();
      else {
        var head = e.target.closest(".pt-card").querySelector(".pt-head b");
        if (head) head.textContent = p.name || "未填寫姓名";
        renderParts__soft();
      }
    });
    $("pt-add").addEventListener("click", function () {
      if (ORD.parts.length >= MAX_PARTS) return;
      ORD.parts.push(newPart(false));
      renderParts();
      toast("已添加參賽者 " + ORD.parts.length + "（演示）");
    });
    $("to-reg2").addEventListener("click", function () { go("reg2"); });
  })();

  /* 只刷新小計與按鈕狀態，避免打字時輸入框失焦 */
  function renderParts__soft() {
    var bad = null;
    for (var i = 0; i < ORD.parts.length; i++) {
      var m = partValid1(ORD.parts[i]);
      if (m) { bad = "參賽者 " + (i + 1) + "：" + m; break; }
    }
    $("to-reg2").disabled = !!bad;
    $("pt-why").hidden = !bad;
    $("pt-why").textContent = bad || "";
  }

  /* ---------------- reg2 · 參賽資料 ---------------- */

  var pdActive = 0;

  function renderPartDetails() {
    var tabs = $("pd-tabs"), body = $("pd-body");
    if (!tabs) return;
    if (pdActive >= ORD.parts.length) pdActive = 0;
    tabs.innerHTML = "";
    ORD.parts.forEach(function (pt, i) {
      var b = document.createElement("button");
      b.className = "tab" + (i === pdActive ? " on" : "");
      b.textContent = (i + 1) + " · " + (pt.name || "未填寫");
      b.addEventListener("click", function () { pdActive = i; renderPartDetails(); });
      tabs.appendChild(b);
    });

    var p = ORD.parts[pdActive];
    if (!p) { body.innerHTML = ""; return; }
    var pr = ptPrice(p);
    if (!p.email) p.email = "runner" + (pdActive + 1) + "@run.com.kh";
    if (!p.idNo) p.idNo = "01234567" + (pdActive + 1);
    if (!p.ec) p.ec = "SOK SREY";
    if (!p.ecp) p.ecp = "+855 12 987 654";
    if (!p.nation) p.nation = p.aud === "cam" ? "柬埔寨 (Cambodia)" : "國際 (International)";

    body.innerHTML =
      '<div class="card" style="margin-bottom:1rem">' +
        '<h4>' + h(p.name) + '</h4>' +
        '<p class="mut">' + h(catById(p.cat).n + " " + catById(p.cat).d) + ' · ' + h(AUD[p.aud].s) +
        ' · ' + (pr ? money(pr.amount) : "—") + '</p>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>真實姓名 <b style="color:var(--stop)">*</b></label><input type="text" data-d="name" value="' + h(p.name) + '" placeholder="英文或護照名"></div>' +
        '<div class="field"><label>國籍 / 身份資格 <b style="color:var(--stop)">*</b></label><select data-d="nation">' +
          ['柬埔寨 (Cambodia)', '中國 (China)', '法國 (France)', '美國 (USA)', '日本 (Japan)', '其他國家/地區'].map(function (nat) { return '<option' + (p.nation === nat ? " selected" : "") + '>' + nat + '</option>'; }).join("") +
        '</select></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>性別</label><select data-d="gender">' +
          ['男', '女'].map(function (g) { return '<option' + (p.gender === g ? " selected" : "") + '>' + g + '</option>'; }).join("") +
        '</select></div>' +
        '<div class="field"><label>出生日期 <b style="color:var(--stop)">*</b><span class="hint">用於年齡組判定與保險生效</span></label>' +
          '<input type="date" data-d="dob" value="' + h(p.dob) + '"></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>身份證件 / 護照號 <b style="color:var(--stop)">*</b><span class="hint">合法有效證件，用於現場領物覈對與保險事故理賠</span></label>' +
          '<input type="text" data-d="idNo" value="' + h(p.idNo) + '" placeholder="例如：012345678 / N12345678"></div>' +
        '<div class="field"><label>電子郵箱 <b style="color:var(--stop)">*</b><span class="hint">接收官方電子參賽確認函與重要安全通告</span></label>' +
          '<input type="email" data-d="email" value="' + h(p.email) + '" placeholder="runner@example.com"></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>手機號碼 <b style="color:var(--stop)">*</b><span class="hint">現場短信憑證與賬號認領</span></label>' +
          '<input type="tel" data-d="phone" value="' + h(p.phone) + '" placeholder="+855 12 345 678"></div>' +
        '<div class="field"><label>參賽包 T恤尺碼<span class="hint">亞洲碼標準</span></label>' +
          '<select data-d="size">' + SIZES.map(function (s) {
            return '<option' + (p.size === s ? " selected" : "") + '>' + s + '</option>';
          }).join("") + '</select></div>' +
      '</div>' +
      '<div class="card" style="background:var(--panel2);box-shadow:none;margin-top:.6rem">' +
        '<h4 style="margin:0 0 .4rem">🚨 緊急聯絡人信息（安全與突發醫療保障必填）</h4>' +
        '<div class="field-row">' +
          '<div class="field"><label>緊急聯繫人姓名 <b style="color:var(--stop)">*</b></label><input type="text" data-d="ec" value="' + h(p.ec) + '" placeholder="家人、朋友或跑團領隊姓名"></div>' +
          '<div class="field"><label>緊急聯繫人電話 <b style="color:var(--stop)">*</b></label><input type="tel" data-d="ecp" value="' + h(p.ecp) + '" placeholder="+855 12 987 654"></div>' +
        '</div>' +
      '</div>';

    body.querySelectorAll("[data-d]").forEach(function (el) {
      el.addEventListener("input", function () {
        p[el.getAttribute("data-d")] = el.value;
        checkPd();
      });
      el.addEventListener("change", function () {
        p[el.getAttribute("data-d")] = el.value;
        checkPd();
      });
    });
    checkPd();
  }

  function checkPd() {
    var bad = null;
    for (var i = 0; i < ORD.parts.length; i++) {
      var p = ORD.parts[i];
      if (!String(p.name || "").trim()) { bad = "參賽者 " + (i + 1) + "：真實姓名必填"; break; }
      if (!String(p.phone || "").trim()) { bad = "參賽者 " + (i + 1) + "（" + (p.name || "") + "）：手機號必填（現場覈驗與憑證認領）"; break; }
      if (!String(p.idNo || "").trim()) { bad = "參賽者 " + (i + 1) + "（" + (p.name || "") + "）：身份證件/護照號必填（用於現場領物覈對與保險事故理賠）"; break; }
      if (!String(p.email || "").trim()) { bad = "參賽者 " + (i + 1) + "（" + (p.name || "") + "）：電子郵箱必填（接收官方報名確認函）"; break; }
      if (!String(p.ec || "").trim()) { bad = "參賽者 " + (i + 1) + "（" + (p.name || "") + "）：緊急聯繫人姓名必填"; break; }
      if (!String(p.ecp || "").trim()) { bad = "參賽者 " + (i + 1) + "（" + (p.name || "") + "）：緊急聯繫人電話必填（用於賽事現場醫療救援）"; break; }
    }
    var btn = $("to-reg4");
    if (btn) btn.disabled = !!bad;
    $("pd-why").hidden = !bad;
    $("pd-why").textContent = bad || "";
  }

  $("to-reg4").addEventListener("click", function () { go("reg4"); });

  /* ---------------- reg4 · 訂單裏的參賽者明細 ---------------- */

  function renderOrderParts() {
    var box = $("sum-parts");
    if (!box) return;
    box.innerHTML = '<div class="card" style="margin-bottom:1rem"><h4>本單參賽者（' + ORD.parts.length + ' 人）' +
      '<span class="new-tag">新</span></h4>' +
      ORD.parts.map(function (p, i) {
        var pr = ptPrice(p);
        return '<div class="sum-line" style="border:none;padding:.45rem 0">' +
          '<span><b style="font-weight:600">' + h(p.name) + '</b><br>' +
          '<span class="mut" style="font-size:.8rem">' + h(catById(p.cat).n + " " + catById(p.cat).d) +
          ' · ' + h(AUD[p.aud].s) + ' · T恤 ' + h(p.size.split("（")[0]) + ' · 號碼布待分配</span></span>' +
          '<span class="mono">' + (pr ? money(pr.amount) : "—") + '</span></div>';
      }).join("") +
      '<p class="mut" style="margin-top:.6rem">付款人：' + h(ORD.parts[0] ? ORD.parts[0].name : "—") +
      '（本單聯繫人）。付款人與參賽者是兩種角色，付款人不一定參賽。</p></div>';
  }

  /* ---------------- 報名成功：每人一張憑證 + 號碼布二維碼 ---------------- */

  /* D-096 F-003 · 原 bibForPart() 已刪除：它憑空造了一個只有用戶端知道的號碼布，
     與 BibAssignment 這個權威事實並存 —— 兩個號碼布真相就是兩個錯誤來源。 */

  function renderDonePasses() {
    var box = $("done-passes");
    if (!box) return;

    /* 兩種來源：剛下完的訂單（ORD），或從「我的賽事」點進來的歷史訂單（curCred） */
    var list, orderNo;
    if (curCred) {
      var r = curCred.reg;
      orderNo = r.code;
      list = r.parts.map(function (x) {
        /* 歷史訂單同樣從共享域解析當前持有人 / 當前號碼布 / 當前報名狀態 */
        var f = x.regId ? RD.findOPByReg(x.regId) : null;
        return { name: f ? RD.holderOf(f.p) : x.name, cat: x.catId, aud: x.aud,
                 size: f ? f.p.reg.size : x.size,
                 _bib: x.regId ? RD.currentBib(x.regId) : null, _pid: x.pid,
                 _off: f ? f.p.regStatus !== "CONFIRMED" : x.status === "cancelled" };
      });
      $("done-sub").textContent = "訂單 " + r.code + " · 共 " + list.length + " 名參賽者";
    } else {
      orderNo = ORD.orderNo;
      /* ⚖️ D-096 F-003 · 號碼布只有一個權威事實：BibAssignment。
         這裏絕不再自己造一個「用戶端專用號」——沒分配就如實顯示「待分配」。 */
      var dOrd = RD.orderByNo(ORD.orderNo);
      list = (dOrd ? dOrd.participants : []).map(function (op) {
        return { name: RD.holderOf(op), cat: (RD.categoryById(dOrd.eventId, op.cat) || {}).feId || op.cat,
                 aud: op.audience === "LOCAL" ? "cam" : "exp", size: op.reg.size,
                 _bib: RD.currentBib(op.regId), _off: op.regStatus !== "CONFIRMED" };
      });
      if (!list.length) {
        /* 直接跳到這一頁（例如刷新後走 hash 路由）時，本次會話沒有對應訂單。
           仍然從共享域取<b>這個用戶最近的一張訂單</b>，絕不自己造號碼布。 */
        /* ⚖️ D-098 · 只回落到<b>真的付過款</b>的訂單。付款窗口裏的 PENDING_PAYMENT
           不是參賽憑證 —— 錢還沒到賬就發憑證，正是這一輪要修掉的假語義。 */
        var mine = RD.myOrders("u1").filter(function (x) {
          return x.status === "PAID" || x.status === "PARTIALLY_REFUNDED";
        });
        var last = mine.length ? mine[0] : null;
        if (last) {
          orderNo = last.orderNo || last.id;
          $("done-sub").textContent = "訂單 " + orderNo + " · 共 " + last.participants.length + " 名參賽者";
          list = last.participants.map(function (op) {
            return { name: RD.holderOf(op),
                     cat: (RD.categoryById(last.eventId, op.cat) || {}).feId || op.cat,
                     aud: op.audience === "LOCAL" ? "cam" : "exp", size: op.reg.size,
                     _bib: RD.currentBib(op.regId), _off: op.regStatus !== "CONFIRMED" };
          });
        } else {
          list = ORD.parts.map(function (p) {
            return { name: p.name, cat: p.cat, aud: p.aud, size: p.size, _bib: null, _off: false };
          });
        }
      }
      $("done-sub").textContent = list.length > 1
        ? "本單共 " + list.length + " 名參賽者，每人一張獨立憑證與號碼布"
        : (list[0] ? list[0].name + "，你已成功報名 金邊濱河半程馬拉松 2026" : "你已成功報名");
    }

    box.innerHTML = list.map(function (p, i) {
      var bib = p._bib;                      /* null = 還沒有權威的號碼布綁定 */
      if (p._off) {
        return '<div class="pass" style="opacity:.6">' +
          '<div class="pass-top"><b>RUN</b><span>電子參賽憑證 ' + (i + 1) + " / " + list.length + '</span></div>' +
          '<div class="pass-body"><div class="pass-fields" style="width:100%">' +
          '<div><span>姓名</span><b>' + h(p.name) + '</b></div>' +
          '<div><span>狀態</span><b style="color:var(--stop)">已取消 · 憑證已失效</b></div>' +
          '</div></div>' +
          '<div class="pass-foot" style="background:var(--stop-tint);color:var(--stop)">' +
          '此憑證已失效，不可用於領取參賽包或入場</div></div>';
      }
      return '<div class="pass">' +
        '<div class="pass-top"><b>RUN</b><span>電子參賽憑證 ' + (i + 1) + " / " + list.length + '</span></div>' +
        '<div class="pass-body">' +
          '<div class="pass-qr"><canvas data-art="qr-pass-' + i + '"></canvas></div>' +
          '<div class="pass-fields">' +
            '<div><span>姓名</span><b>' + h(p.name) + '</b></div>' +
            '<div><span>組別</span><b>' + h(catById(p.cat).n + " " + catById(p.cat).d) + '</b></div>' +
            '<div><span>號碼布</span><b class="mono">' +
              (bib ? h(bib) : '<span style="color:var(--ink-mute);font-weight:500">號碼布待分配</span>') + '</b></div>' +
            '<div><span>報名編號</span><b class="mono">' + (p._pid || (orderNo + "-" + (i + 1))) + '</b></div>' +
          '</div>' +
        '</div>' +
        '<div class="bibqr">' +
          '<canvas data-art="qr-bib-' + i + '"></canvas>' +
          '<div><b>比賽後掃碼直接查看成績</b>號碼布上會印同一個二維碼。成績發佈前掃到的是「成績處理中」，' +
          '發佈後自動變成你的永久成績頁。' +
          (bib ? '<button class="btn quiet sm" data-bibqr="' + h(bib) + '">點這裏模擬掃碼</button>'
               : '<span class="mut" style="font-size:.72rem">號碼布尚未分配，賽前由運營統一編排後這裏會顯示你的號碼</span>') + '</div>' +
        '</div>' +
        '<div class="pass-foot">領取裝備包時請出示此二維碼 · 9/18–9/19 · 金邊市中心演示領物點' +
        (p.aud === "cam" ? ' · 需出示柬埔寨身份證件覈驗本地價資格' : '') + '</div>' +
      '</div>';
    }).join("");

    $("claim-card").hidden = !!curCred;
    var rs = $("restart"); if (rs) rs.hidden = !!curCred;
    if (!curCred) renderClaimCard();
    requestAnimationFrame(paintAll);
  }

  document.addEventListener("click", function (e) {
    var pr = e.target.closest("[data-postrace],[data-phase]");
    if (pr) {
      setPhase(pr.getAttribute("data-phase") || "post");
      var cur = (document.querySelector(".screen.on") || {}).id || "";
      go(cur.slice(2) || "home");
      return;
    }
    var t = e.target.closest("[data-bibqr]");
    if (!t) return;
    openBibQr(parseInt(t.getAttribute("data-bibqr"), 10));
  });

  /* 號碼布二維碼：成績已發佈 → 永久成績頁；否則 → 成績處理中 */
  function openBibQr(bib) {
    var row = findBoardRowByBib(bib);
    if (row) { curPerma = row; go("presult"); return; }   // 未發佈時 renderPerma 會顯示「成績處理中」
    curPerma = { pending: true, bib: bib };
    go("presult");
  }

  /* ---------------- 賬號認領 ---------------- */

  function renderClaimCard() {
    var box = $("claim-card");
    if (!box) return;
    var phone = (ORD.parts[0] && ORD.parts[0].phone) || DEMO.user.phone;

    if (S.account.claimed) {
      box.innerHTML =
        '<h4>✓ 已認領本次報名</h4>' +
        '<p style="margin:0 0 .7rem;font-size:.88rem">賬號 <b>' + h(S.account.phone || phone) + '</b> 已創建（演示，未發送真實短信）。</p>' +
        '<div class="empty" style="background:var(--card);text-align:left;margin:0 0 .9rem">' +
        '<b>發現 3 條歷史參賽記錄</b>2025 金邊濱河半馬 21K、2025 湄公河夜跑 10K、2024 吳哥日出跑 10K —— ' +
        '手機號一致，已一併歸入你的檔案。</div>' +
        '<div class="btn-row"><button class="btn sm" data-go="me-history">查看我的跑步履歷 →</button>' +
        '<button class="btn ghost sm" data-go="results">去成績庫看看</button></div>';
      return;
    }

    box.innerHTML =
      '<h4>保存你的 RUN 記錄</h4>' +
      '<p style="margin:0 0 .6rem;font-size:.88rem">你剛纔是以遊客身份完成報名的。創建 RUN 賬號以後，你可以：</p>' +
      '<ul>' +
        '<li>查看所有歷史賽事</li><li>查詢成績</li><li>下載完賽證書</li>' +
        '<li>查找比賽照片</li><li>下次報名自動填寫資料</li>' +
      '</ul>' +
      '<div id="claim-step1">' +
        '<div class="otp-row"><input id="claim-phone" type="tel" value="' + h(phone) + '" placeholder="+855 12 345 678">' +
        '<button class="btn sm" id="claim-send">發送驗證碼</button></div>' +
        '<p class="mut" style="font-size:.78rem;margin:.5rem 0 0">演示模擬，不會發送真實短信。</p>' +
      '</div>' +
      '<div id="claim-step2" hidden>' +
        '<div class="otp-row"><input id="claim-otp" type="text" inputmode="numeric" placeholder="輸入 6 位驗證碼（演示：任意 6 位）">' +
        '<button class="btn sm" id="claim-ok">創建並認領</button></div>' +
        '<p class="mut" style="font-size:.78rem;margin:.5rem 0 0">驗證碼已「發送」到 <b id="claim-to">—</b>（演示）。</p>' +
      '</div>';

    $("claim-send").addEventListener("click", function () {
      var v = $("claim-phone").value.trim();
      if (v.replace(/\D/g, "").length < 8) { toast("請填寫有效手機號（演示）"); return; }
      $("claim-step1").hidden = true;
      $("claim-step2").hidden = false;
      $("claim-to").textContent = v;
      toast("驗證碼已發送（演示，未接真實短信）");
    });
    $("claim-ok").addEventListener("click", function () {
      var code = $("claim-otp").value.trim();
      if (!/^\d{6}$/.test(code)) { toast("請輸入 6 位數字驗證碼（演示）"); return; }
      S.account.claimed = true;
      S.account.phone = $("claim-phone").value.trim();
      save();
      renderClaimCard();
      toast("已認領本次報名，並找到 3 條歷史記錄（演示）");
    });
  }

  /* ---------------- 賽事列表篩選 ---------------- */

  var RF = { q: "", month: "all", loc: "all", state: "all" };

  function evMonth(r) {
    var m = String(r.d).match(/(\d{4})\.(\d{2})/);
    if (!m) return "2026-08";
    return m[1] + "-" + m[2];
  }
  function evStateKey(r) {
    if (r.state === "done") return "done";
    if (r.state === "soon") return "soon";
    if (r.state === "full") return "closed";
    return "open";
  }
  function evLocKey(r) {
    if (!r || !r.loc) return "other";
    var rawLocs = ["金邊", "暹粒", "西哈努克", "馬德望"];
    for (var i = 0; i < rawLocs.length; i++) {
      if (r.loc.indexOf(rawLocs[i]) >= 0) return rawLocs[i];
    }
    return "other";
  }
  function matchRF(r) {
    if (!r) return false;
    var l = (typeof LANG !== "undefined" && LANG) ? LANG : "zh";
    var rLoc = r.loc || "";
    var rTitle = (typeof RACE_L10N !== "undefined" && RACE_L10N[r.id] && (RACE_L10N[r.id].sub[l] || RACE_L10N[r.id].flat)) || r.t || "";
    if (RF.q) {
      var q = RF.q.toLowerCase();
      if (((r.t || "") + " " + rLoc + " " + rTitle).toLowerCase().indexOf(q) < 0) return false;
    }
    if (RF.month !== "all") {
      var m = evMonth(r);
      if (RF.month === "later") { if (m <= "2026-11") return false; }
      else if (m !== RF.month) return false;
    }
    if (RF.loc !== "all" && evLocKey(r) !== RF.loc) return false;
    if (RF.state !== "all" && evStateKey(r) !== RF.state) return false;
    return true;
  }

  function chipRow(id, list, cur, onPick) {
    var row = $(id);
    if (!row) return;
    row.querySelectorAll(".fchip").forEach(function (b) { b.remove(); });
    (list || []).forEach(function (o) {
      var b = document.createElement("button");
      b.className = "fchip" + (o[0] === cur ? " on" : "");
      b.textContent = o[1];
      b.addEventListener("click", function () { onPick(o[0]); });
      row.appendChild(b);
    });
  }

  function renderRaceFilters() {
    if (typeof RF === "undefined" || !RF) RF = { q: "", month: "all", loc: "all", state: "all" };
    var l = (typeof LANG !== "undefined" && LANG) ? LANG : "zh";
    var monthsMap = {
      zh: [["all", "全部"], ["2026-08", "2026年8月"], ["2026-09", "2026年9月"], ["2026-10", "2026年10月"], ["2026-11", "2026年11月"], ["later", "以後"]],
      en: [["all", "All"], ["2026-08", "Aug 2026"], ["2026-09", "Sep 2026"], ["2026-10", "Oct 2026"], ["2026-11", "Nov 2026"], ["later", "Later"]],
      km: [["all", "ទាំងអស់"], ["2026-08", "សីហា ២០២៦"], ["2026-09", "កញ្ញា ២០២៦"], ["2026-10", "តុលា ២០២៦"], ["2026-11", "វិច្ឆិកា ២០២៦"], ["later", "ពេលក្រោយ"]]
    };
    var locsMap = {
      zh: [["all", "全部"], ["金邊", "金邊"], ["暹粒", "暹粒"], ["西哈努克", "西哈努克"], ["馬德望", "馬德望"], ["other", "其他"]],
      en: [["all", "All"], ["金邊", "Phnom Penh"], ["暹粒", "Siem Reap"], ["西哈努克", "Sihanoukville"], ["馬德望", "Battambang"], ["other", "Other"]],
      km: [["all", "ទាំងអស់"], ["金邊", "ភ្នំពេញ"], ["暹粒", "សៀមរាប"], ["西哈努克", "ព្រះសីហនុ"], ["馬德望", "បាត់ដំបង"], ["other", "ផ្សេងៗ"]]
    };
    var statesMap = {
      zh: [["all", "全部"], ["open", "報名中"], ["soon", "即將開始"], ["closed", "報名截止"], ["done", "已結束"]],
      en: [["all", "All"], ["open", "Open"], ["soon", "Coming Soon"], ["closed", "Closed"], ["done", "Finished"]],
      km: [["all", "ទាំងអស់"], ["open", "បើកចុះឈ្មោះ"], ["soon", "ជិតបើក"], ["closed", "បិទចុះឈ្មោះ"], ["done", "បានបញ្ចប់"]]
    };

    var emMonth = l === 'en' ? 'Month' : (l === 'km' ? 'ខែ' : '月份');
    var emLoc = l === 'en' ? 'Location' : (l === 'km' ? 'ទីតាំង' : '地點');
    var emState = l === 'en' ? 'Status' : (l === 'km' ? 'ស្ថានភាព' : '狀態');

    var mEl = $("rf-month"), lEl = $("rf-loc"), sEl = $("rf-state");
    if (mEl) {
      var em = mEl.querySelector("em");
      if (em) em.textContent = emMonth;
      else {
        var newEm = document.createElement("em");
        newEm.textContent = emMonth;
        mEl.prepend(newEm);
      }
    }
    if (lEl) {
      var em = lEl.querySelector("em");
      if (em) em.textContent = emLoc;
      else {
        var newEm = document.createElement("em");
        newEm.textContent = emLoc;
        lEl.prepend(newEm);
      }
    }
    if (sEl) {
      var em = sEl.querySelector("em");
      if (em) em.textContent = emState;
      else {
        var newEm = document.createElement("em");
        newEm.textContent = emState;
        sEl.prepend(newEm);
      }
    }

    if ($("rf-q")) {
      $("rf-q").placeholder = l === 'en' ? "Search race name or city..."
        : (l === 'km' ? "ស្វែងរកឈ្មោះការប្រកួត ឬទីក្រុង..."
        : "搜索賽事名稱或地點，例如「濱河」「暹粒」");
    }

    var mList = monthsMap[l] || monthsMap.zh;
    var lList = locsMap[l] || locsMap.zh;
    var sList = statesMap[l] || statesMap.zh;

    chipRow("rf-month", mList, RF.month, function (v) { RF.month = v; applyRF(); });
    chipRow("rf-loc", lList, RF.loc, function (v) { RF.loc = v; applyRF(); });
    chipRow("rf-state", sList, RF.state, function (v) { RF.state = v; applyRF(); });
  }

  function applyRF() {
    renderRaceFilters();
    var wrap = $("all-races");
    wrap.innerHTML = "";
    /* ⚖️ D-117 A5 · 搜索與篩選同樣是公開發現面：先去掉「已隱藏公開展示」的，
       再套用戶自己的篩選條件。總數也要跟着變，否則「共 N 場（全部 M 場）」
       會把一個用戶根本看不到的賽事算進去。 */
    var pool = publicRaces();
    var hits = pool.filter(matchRF);
    hits.forEach(function (r, i) { wrap.appendChild(raceCard(r, i)); });
    $("rf-empty").hidden = hits.length > 0;
    if (LANG === "en") {
      $("rf-count").innerHTML = "Total <b>" + hits.length + "</b> races" +
        (hits.length < pool.length ? " (out of " + pool.length + ")" : "") +
        " · Past races in 'View All Past Races'";
    } else if (LANG === "km") {
      $("rf-count").innerHTML = "សរុប <b>" + hits.length + "</b> ការប្រកួត" +
        (hits.length < pool.length ? " (ក្នុងចំណោម " + pool.length + ")" : "") +
        " · ការប្រកួតកន្លងមកក្នុង «មើលការប្រកួតកន្លងមកទាំងអស់»";
    } else {
      $("rf-count").innerHTML = "共 <b>" + hits.length + "</b> 場賽事" +
        (hits.length < pool.length ? "（全部 " + pool.length + " 場）" : "") +
        " · 往期比賽在「查看全部歷史賽事」";
    }
    requestAnimationFrame(paintAll);
  }

  $("rf-q").addEventListener("input", function () { RF.q = this.value.trim(); applyRF(); });
  $("rf-clear").addEventListener("click", function () {
    RF = { q: "", month: "all", loc: "all", state: "all" };
    $("rf-q").value = "";
    applyRF();
    toast("篩選已清空");
  });

  /* ================================================================
     v5 · 成績庫（歷史賽事 → 榜單 → 個人永久成績頁）
     數據源仍是「計時公司 CSV 導入」的形態，全部爲前端生成的演示數據。
     ================================================================ */

  var HIST = [
    { id: "h0", y: 2026, t: "金邊濱河半程馬拉松 2026", d: "2026.09.20", loc: "金邊 · 洞裏薩河濱公園",
      dists: ["21K", "10K", "5K"], ev: "e1", photos: true, published: true },
    { id: "h1", y: 2026, t: "湄公河夜跑 2026", d: "2026.08.30", loc: "金邊 · 濱河大道",
      dists: ["10K", "5K"], ev: "e5", photos: true, published: true },
    { id: "h2", y: 2026, t: "金邊女子 10K 2026", d: "2026.03.08", loc: "金邊 · 萬谷湖公園",
      dists: ["10K", "5K"], photos: true, published: true },
    { id: "h3", y: 2026, t: "西哈努克海濱跑 2026", d: "2026.01.18", loc: "西哈努克 · 奧切迪海灘",
      dists: ["10K", "5K"], photos: false, published: true },
    { id: "h4", y: 2025, t: "吳哥日出跑 2025", d: "2025.12.07", loc: "暹粒 · 吳哥窟",
      dists: ["21K", "10K"], photos: true, published: true },
    { id: "h5", y: 2025, t: "磅湛鄉村越野 2025", d: "2025.12.14", loc: "磅湛 · 湄公河東岸",
      dists: ["25K", "12K"], ev: "e6", photos: false, published: true },
    { id: "h6", y: 2025, t: "金邊濱河半程馬拉松 2025", d: "2025.09.21", loc: "金邊 · 洞裏薩河濱公園",
      dists: ["21K", "10K", "5K"], photos: true, published: true },
    { id: "h7", y: 2025, t: "馬德望古城跑 2025", d: "2025.05.11", loc: "馬德望 · 老城區",
      dists: ["10K", "5K"], photos: false, published: true },
    { id: "h8", y: 2024, t: "吳哥日出跑 2024", d: "2024.12.08", loc: "暹粒 · 吳哥窟",
      dists: ["21K", "10K"], photos: true, published: true },
    { id: "h9", y: 2024, t: "金邊濱河半程馬拉松 2024", d: "2024.09.22", loc: "金邊 · 洞裏薩河濱公園",
      dists: ["21K", "10K", "5K"], photos: false, published: true },
    { id: "h10", y: 2024, t: "西哈努克海濱跑 2024", d: "2024.02.25", loc: "西哈努克 · 奧切迪海灘",
      dists: ["10K", "5K"], photos: false, published: true }
  ];
  function histById(id) {
    for (var i = 0; i < HIST.length; i++) if (HIST[i].id === id) return HIST[i];
    return HIST[0];
  }

  var FIRST = ["SOK", "CHEA", "LY", "KEO", "NOU", "VANN", "HONG", "PHAL", "SAM", "TEP", "MAO", "RITH",
    "SREY", "DARA", "PISETH", "MONY", "CHANDA", "SOPHEA", "VUTHY", "SOKHA"];
  var LAST = ["DARA", "SREY", "PISETH", "MONY", "CHANDA", "SOPHEA", "VUTHY", "SOKHA", "RATHA", "VICHEA",
    "KIMLENG", "PANHA", "BUNTHENG", "MOROKOT", "SAMBATH", "THIDA"];
  var INTL = ["TAKIZAKI KUNIAKI", "OTA YUGO", "REEVE JOLLIFFE", "MARIA DIJKHORST", "CRAIG PIKE",
    "EMIKO MATSUMURA", "LIU HAIPING", "THOMAS JANSSENS", "KRISTEN JAREMBACK", "MING TINGGUANG"];
  var AGEG = ["U20", "20-29", "30-39", "40-49", "50+"];

  /* 號碼布號段：組別決定前綴，與 Bib 運營工作臺共用同一份定義 */
  var BIB_BASE = { "21K": 2100, "10K": 1000, "5K": 5000, "25K": 2500, "12K": 1200 };
  var DIST_MIN = { "21K": 78, "10K": 55, "5K": 32, "25K": 105, "12K": 62 };

  var boardCache = {};
  function board(histId, dist) {
    var key = histId + "|" + dist;
    if (boardCache[key]) return boardCache[key];
    var hs = histById(histId);
    var n = 40 + ((hs.id.charCodeAt(1) * 13 + dist.charCodeAt(0) * 7) % 90);
    if (dist === "21K") n += 40;
    var rnd = rng(hs.y * 31 + dist.charCodeAt(0) * 7 + (hs.id.length * 11));
    var base = DIST_MIN[dist] || 60;
    var rows = [], i;
    for (i = 0; i < n; i++) {
      var intl = rnd() < 0.22;
      var nm = intl ? INTL[Math.floor(rnd() * INTL.length)]
        : (FIRST[Math.floor(rnd() * FIRST.length)] + " " + LAST[Math.floor(rnd() * LAST.length)]);
      var g = rnd() < 0.63 ? "M" : "F";
      var secs = Math.floor(base * 60 + i * (base * 1.15) + rnd() * 90);
      /* 真實賽事一定有非完賽：每場按固定比例摻入 DNF / DNS / PENDING，
         不給它們編造正式成績時間。 */
      var st = "FIN";
      if (i % 17 === 5) st = "DNF";
      else if (i % 23 === 7) st = "DNS";
      else if (i % 29 === 11) st = "PENDING";
      rows.push({
        hid: histId, dist: dist,
        bib: (BIB_BASE[dist] || 1000) + 11 + i * 3,
        name: nm, gender: g, aud: intl ? "exp" : "cam",
        ageGroup: AGEG[Math.floor(rnd() * AGEG.length)],
        status: st,
        netS: st === "FIN" ? secs : 0, gunS: st === "FIN" ? secs + 30 + Math.floor(rnd() * 90) : 0
      });
    }
    /* 演示主角：Sven Chea，固定 Bib 1001，用來演示換號後的鏈路 */
    if (histId === "h0" && dist === "10K") {
      rows.push({ hid: histId, dist: dist, bib: 1001, name: "SVEN CHEA", gender: "M", aud: "cam",
        ageGroup: "30-39", status: "FIN", netS: 62 * 60 + 31, gunS: 63 * 60 + 3, star: true });
      rows.push({ hid: histId, dist: dist, bib: 1077, name: "LIM PISETH", gender: "M", aud: "cam",
        ageGroup: "40-49", status: "DNF", netS: 0, gunS: 0,
        note: "在 8 km 補給點因中暑退賽，醫療組已處理，狀況良好。" });
      rows.push({ hid: histId, dist: dist, bib: 1088, name: "NOU CHANDA", gender: "F", aud: "cam",
        ageGroup: "20-29", status: "PENDING", netS: 0, gunS: 0,
        note: "計時芯片讀數異常，成績處理中，出成績後會通知你。" });
    }
    if (histId === "h0" && dist === "21K") {
      rows.push({ hid: histId, dist: dist, bib: 3247, name: "SOK DARA", gender: "M", aud: "cam",
        ageGroup: "20-29", status: "FIN", netS: 2 * 3600 + 6 * 60 + 12, gunS: 2 * 3600 + 7 * 60 + 44, star: true });
      rows.push({ hid: histId, dist: dist, bib: 3301, name: "KEO MONY", gender: "M", aud: "cam",
        ageGroup: "30-39", status: "DNS", netS: 0, gunS: 0,
        note: "已報名但未到起點檢錄，成績記爲 DNS。" });
    }
    /* 完賽的按淨成績排，非完賽的一律排在最後，且不佔名次 */
    rows.sort(function (a, b) {
      var af = a.status === "FIN", bf = b.status === "FIN";
      if (af !== bf) return af ? -1 : 1;
      if (!af) return a.bib - b.bib;
      return a.netS - b.netS;
    });

    var gc = { M: 0, F: 0 }, cc = {}, ac = {}, fin = 0;
    rows.forEach(function (r) {
      r.uid = "demo-" + hs.y + "-" + dist.toLowerCase() + "-" + pad5(r.bib);
      if (r.status !== "FIN") {
        r.rank = 0; r.gRank = 0; r.aRank = 0; r.cRank = 0;
        r.net = "—"; r.gun = "—";
        return;
      }
      fin++;
      r.rank = fin;
      gc[r.gender]++; r.gRank = gc[r.gender];
      cc[r.ageGroup] = (cc[r.ageGroup] || 0) + 1; r.aRank = cc[r.ageGroup];
      ac[r.aud] = (ac[r.aud] || 0) + 1; r.cRank = ac[r.aud];
      r.net = hms(r.netS); r.gun = hms(r.gunS);
    });
    rows.forEach(function (r) {
      r.total = fin;
      r.gTotal = gc[r.gender] || 0; r.aTotal = cc[r.ageGroup] || 0; r.cTotal = ac[r.aud] || 0;
    });
    boardCache[key] = rows;
    return rows;
  }
  function pad5(n) { var s = String(n); while (s.length < 5) s = "0" + s; return s; }
  function hms(s) {
    var hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return (hh > 0 ? hh + ":" : "") + (hh > 0 && mm < 10 ? "0" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss;
  }

  /* ---------------- 號碼布運營：換號後所有鏈路必須跟着走 ---------------- */

  /* 當前號 = 原始號經過全部換號操作之後的結果 */
  function effBib(orig) {
    var cur = orig;
    S.bibOps.forEach(function (o) { if (o.op === "change" && o.from === cur) cur = o.to; });
    return cur;
  }
  /* 反查：用戶輸入的當前號對應的原始號（成績、照片都掛在原始號上） */
  function origBib(cur) {
    var out = cur, guard = 0;
    var found = true;
    while (found && guard++ < 20) {
      found = false;
      for (var i = S.bibOps.length - 1; i >= 0; i--) {
        var o = S.bibOps[i];
        if (o.op === "change" && o.to === out) { out = o.from; found = true; break; }
      }
    }
    return out;
  }
  function bibHistory(orig) {
    return S.bibOps.filter(function (o) { return o.op === "change" && (o.from === orig || o.to === effBib(orig)); });
  }
  function findBoardRowByBib(bib) {
    var o = origBib(bib), hit = null;
    HIST.forEach(function (hs) {
      hs.dists.forEach(function (d) {
        if (hit) return;
        board(hs.id, d).forEach(function (r) { if (!hit && r.bib === o) hit = r; });
      });
    });
    return hit;
  }
  function rowByUid(uid) {
    var hit = null;
    HIST.forEach(function (hs) {
      hs.dists.forEach(function (d) {
        if (hit) return;
        board(hs.id, d).forEach(function (r) { if (!hit && r.uid === uid) hit = r; });
      });
    });
    return hit;
  }

  /* ---------------- 歷史賽事頁 ---------------- */

  var HS = { q: "", y: "all", dist: "all" };

  function renderHistory() {
    if (typeof HS === "undefined" || !HS) HS = { q: "", y: "all", dist: "all" };
    if (typeof HIST === "undefined" || !HIST) return;
    var years = [["all", "全部"]].concat([2026, 2025, 2024].map(function (y) { return [String(y), String(y) + " 年"]; }));
    var dists = [["all", "全部"], ["21K", "21K"], ["10K", "10K"], ["5K", "5K"], ["其他", "其他距離"]];
    chipRow("hs-year", years, HS.y, function (v) { HS.y = v; renderHistory(); });
    chipRow("hs-dist", dists, HS.dist, function (v) { HS.dist = v; renderHistory(); });

    var hits = HIST.filter(function (hs) {
      if (HS.q && (hs.t + " " + hs.loc).toLowerCase().indexOf(HS.q.toLowerCase()) < 0) return false;
      if (HS.y !== "all" && String(hs.y) !== HS.y) return false;
      if (HS.dist !== "all") {
        if (HS.dist === "其他") { if (hs.dists.some(function (d) { return ["21K", "10K", "5K"].indexOf(d) >= 0; })) return false; }
        else if (hs.dists.indexOf(HS.dist) < 0) return false;
      }
      return true;
    });

    $("hs-count").innerHTML = "共 <b>" + hits.length + "</b> 場 · 全部 " + HIST.length + " 場歷史賽事";
    var box = $("hs-list");
    if (!hits.length) {
      box.innerHTML = '<div class="empty"><b>沒有匹配的歷史賽事</b>換個年份或距離試試。</div>';
      return;
    }
    var byYear = {};
    hits.forEach(function (hs) { (byYear[hs.y] = byYear[hs.y] || []).push(hs); });
    box.innerHTML = Object.keys(byYear).sort().reverse().map(function (y) {
      return '<div class="yr-group"><h4>' + y + '</h4>' + byYear[y].map(function (hs) {
        var pub = published(hs.id);
        /* ⚖️ D-117 B3 · 逐組別數：撤回發佈的那一組不該繼續被算進「完賽 N 人」。 */
        var n = hs.dists.reduce(function (a, d) {
          return a + (published(hs.id, d) ? board(hs.id, d).length : 0); }, 0);
        return '<div class="me-item"><div class="me-main">' +
          '<b>' + h(hs.t) + '</b>' +
          '<div class="me-meta">' + h(hs.d) + ' · ' + h(hs.loc) + ' · ' + hs.dists.join(" / ") +
          (pub ? ' · 完賽 ' + n + ' 人' : ' · ' + resultBlockNote(hs.id).title) + '</div>' +
          '<div class="me-acts">' +
            '<button class="btn sm" data-hs="' + hs.id + '">查看成績榜</button>' +
            (hs.photos ? '<button class="btn ghost sm" data-hsp="' + hs.id + '">賽事照片</button>' : '') +
            (hs.ev ? '<button class="btn ghost sm" data-hse="' + hs.ev + '">賽事詳情</button>' : '') +
          '</div></div></div>';
      }).join("") + '</div>';
    }).join("");
  }

  $("hs-q").addEventListener("input", function () { HS.q = this.value.trim(); renderHistory(); });
  $("hs-clear").addEventListener("click", function () {
    HS = { q: "", y: "all", dist: "all" }; $("hs-q").value = ""; renderHistory(); toast("篩選已清空");
  });
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-hs]");
    if (t) { reCtx.hid = t.getAttribute("data-hs"); reCtx.dist = null; reCtx.page = 1; go("resultev"); return; }
    t = e.target.closest("[data-hsp]");
    if (t) {
      var hs = histById(t.getAttribute("data-hsp"));
      if (hs.ev) { phEvent = hs.ev; }
      go("photos");
      toast("演示：照片庫按賽事切換，這場是「" + hs.t + "」");
      return;
    }
    t = e.target.closest("[data-hse]");
    if (t) { setSelectedRace(t.getAttribute("data-hse")); go("detail"); }
  });

  /* ---------------- 單場榜單 ---------------- */

  var RES_ST = { FIN: ["完賽", "ok"], DNF: ["DNF 未完賽", "bad"], DNS: ["DNS 未出發", "bad"],
                 PENDING: ["成績處理中", "warn"] };
  var reCtx = { hid: "h0", dist: null, board: "all", page: 1, q: "", sort: "rank", asc: true };
  var PER = 25;
  var BOARDS = [["all", "All Results"], ["gender", "Gender"], ["cat", "Category"], ["age", "Age Group"]];

  function renderResultEvent() {
    var hs = histById(reCtx.hid);
    if (!reCtx.dist || hs.dists.indexOf(reCtx.dist) < 0) reCtx.dist = hs.dists[0];
    $("re-title").textContent = hs.t;
    $("re-sub").textContent = hs.d + " · " + hs.loc + " · 成績由計時公司 CSV 導入後發佈（演示）";

    chipRowTabs("re-dist", hs.dists.map(function (d) { return [d, d]; }), reCtx.dist, function (v) {
      reCtx.dist = v; reCtx.page = 1; renderResultEvent();
    });
    chipRowTabs("re-board", BOARDS, reCtx.board, function (v) {
      reCtx.board = v; reCtx.page = 1; renderResultEvent();
    });

    /* ⚖️ D-117 B3 / B4 · 判定按<b>當前這個組別</b>算：撤回發佈的是 21K，
       10K 自己那份有效的 PUBLISHED 批次不該跟着消失。組別頁籤仍然可切，
       用戶切到別的組別就能看到那一組的成績。 */
    if (!published(hs.id, reCtx.dist)) {
      var note = resultBlockNote(hs.id, reCtx.dist);
      $("re-count").innerHTML = h(note.title);
      $("re-table").innerHTML = "";
      $("re-pager").innerHTML = "";
      $("re-empty").hidden = false;
      $("re-empty").innerHTML = "<b>" + h(note.title) + "（" + h(reCtx.dist) + "）</b>" + note.body +
        '<div class="btn-row" style="margin-top:.8rem;justify-content:center">' +
        (note.key === "notyet" ? '<button class="btn sm" data-postrace="1">模擬進入賽後</button>' : '') +
        '<button class="btn ghost sm" data-go="history">看往期賽事成績</button></div>';
      return;
    }

    var rows = board(hs.id, reCtx.dist).slice();
    if (reCtx.board !== "all") rows = rows.filter(function (r) { return r.status === "FIN"; });
    if (reCtx.q) {
      var q = reCtx.q.toLowerCase();
      rows = rows.filter(function (r) {
        return String(effBib(r.bib)).indexOf(q) >= 0 || r.name.toLowerCase().indexOf(q) >= 0;
      });
    }
    var sortKey = reCtx.sort;
    rows.sort(function (a, b) {
      var x, y;
      if (sortKey === "bib") { x = effBib(a.bib); y = effBib(b.bib); }
      else if (sortKey === "name") { return (reCtx.asc ? 1 : -1) * a.name.localeCompare(b.name); }
      else if (sortKey === "net") { x = a.netS; y = b.netS; }
      else if (sortKey === "gun") { x = a.gunS; y = b.gunS; }
      else { x = a.rank; y = b.rank; }
      return (reCtx.asc ? 1 : -1) * (x - y);
    });

    var totalPages = Math.max(1, Math.ceil(rows.length / PER));
    if (reCtx.page > totalPages) reCtx.page = 1;
    var slice = rows.slice((reCtx.page - 1) * PER, reCtx.page * PER);

    $("re-count").innerHTML = "共 <b>" + rows.length + "</b> 條成績 · 當前榜：" +
      BOARDS.filter(function (b) { return b[0] === reCtx.board; })[0][1] +
      (reCtx.board !== "all" ? "（只列完賽）" : "") +
      (reCtx.q ? " · 只在 " + reCtx.dist + " 裏搜索" : "");
    $("re-empty").hidden = rows.length > 0;

    /* 當前距離沒搜到時，別讓用戶以爲查無此人——去別的距離裏看看 */
    if (!rows.length && reCtx.q) {
      var elsewhere = [];
      hs.dists.forEach(function (d) {
        if (d === reCtx.dist) return;
        var n = board(hs.id, d).filter(function (r) {
          return String(effBib(r.bib)).indexOf(reCtx.q.toLowerCase()) >= 0 ||
            r.name.toLowerCase().indexOf(reCtx.q.toLowerCase()) >= 0;
        }).length;
        if (n) elsewhere.push([d, n]);
      });
      $("re-empty").innerHTML = elsewhere.length
        ? "<b>這個距離裏沒有</b>但在 " + elsewhere.map(function (x) { return x[0] + " 裏有 " + x[1] + " 條"; }).join("、") +
          '。<div class="btn-row" style="margin-top:.7rem;justify-content:center">' +
          elsewhere.map(function (x) { return '<button class="btn sm" data-jump="' + x[0] + '">去 ' + x[0] + ' 看看</button>'; }).join("") +
          "</div>"
        : "<b>沒有匹配的成績</b>換個號碼布或姓名試試。";
    }

    var cols = reCtx.board === "gender"
      ? [["rank", "總名次"], ["bib", "Bib"], ["name", "姓名"], ["", "性別"], ["", "性別名次"], ["gun", "槍聲"], ["net", "淨成績"]]
      : reCtx.board === "cat"
      ? [["rank", "總名次"], ["bib", "Bib"], ["name", "姓名"], ["", "身份"], ["", "身份名次"], ["gun", "槍聲"], ["net", "淨成績"]]
      : reCtx.board === "age"
      ? [["rank", "總名次"], ["bib", "Bib"], ["name", "姓名"], ["", "年齡組"], ["", "組內名次"], ["gun", "槍聲"], ["net", "淨成績"]]
      : [["rank", "名次"], ["bib", "Bib"], ["name", "姓名"], ["", "性別"], ["", "年齡組"], ["gun", "槍聲成績"], ["net", "淨成績"], ["", "狀態"]];

    var head = "<thead><tr>" + cols.map(function (c) {
      if (!c[0]) return "<th>" + c[1] + "</th>";
      var on = reCtx.sort === c[0];
      return '<th><button data-sort="' + c[0] + '" class="' + (on ? "srt" + (reCtx.asc ? " asc" : "") : "") + '">' + c[1] + "</button></th>";
    }).join("") + "</tr></thead>";

    var body = "<tbody>" + slice.map(function (r) {
      var cur = effBib(r.bib), moved = cur !== r.bib;
      var c4, c5;
      if (reCtx.board === "gender") { c4 = r.gender === "M" ? "男" : "女"; c5 = r.gRank + " / " + r.gTotal; }
      else if (reCtx.board === "cat") { c4 = AUD[r.aud].s; c5 = r.cRank + " / " + r.cTotal; }
      else if (reCtx.board === "age") { c4 = r.ageGroup; c5 = r.aRank + " / " + r.aTotal; }
      else { c4 = r.gender === "M" ? "男" : "女"; c5 = r.ageGroup; }
      var fin = r.status === "FIN";
      var stCell = fin ? '' : '<td>' + RES_ST[r.status][0] + '</td>';
      return '<tr data-uid="' + r.uid + '" class="' + (r.star ? "me" : "") + (fin ? "" : " nofin") + '">' +
        '<td class="n">' + (fin ? r.rank : "—") + '</td>' +
        '<td class="n">' + cur + (moved ? ' <span class="st warn" style="font-size:.65rem">換號</span>' : '') + '</td>' +
        '<td class="nm">' + h(r.name) + '</td>' +
        '<td>' + h(c4) + '</td><td class="n">' + (fin ? h(c5) : "—") + '</td>' +
        '<td class="n">' + r.gun + '</td><td class="n">' + r.net + '</td>' +
        (reCtx.board === "all" ? '<td><span class="st ' + RES_ST[r.status][1] + '">' + RES_ST[r.status][0] + '</span></td>' : '') +
        '</tr>';
    }).join("") + "</tbody>";

    $("re-table").innerHTML = head + body;

    var pg = $("re-pager");
    var btns = "";
    var show = [];
    for (var i = 1; i <= totalPages; i++) {
      if (i <= 2 || i > totalPages - 2 || Math.abs(i - reCtx.page) <= 1) show.push(i);
    }
    var last = 0;
    show.forEach(function (i) {
      if (i - last > 1) btns += '<span style="color:var(--ink-mute);font-size:.8rem">…</span>';
      btns += '<button data-page="' + i + '" class="' + (i === reCtx.page ? "on" : "") + '">' + i + "</button>";
      last = i;
    });
    pg.innerHTML =
      '<button data-page="' + Math.max(1, reCtx.page - 1) + '"' + (reCtx.page === 1 ? " disabled" : "") + '>‹</button>' +
      btns +
      '<button data-page="' + Math.min(totalPages, reCtx.page + 1) + '"' + (reCtx.page === totalPages ? " disabled" : "") + '>›</button>' +
      '<span class="pg-info">第 ' + reCtx.page + ' / ' + totalPages + ' 頁</span>';
  }

  function chipRowTabs(id, list, cur, onPick) {
    var row = $(id);
    row.innerHTML = "";
    list.forEach(function (o) {
      var b = document.createElement("button");
      b.className = "tab" + (o[0] === cur ? " on" : "");
      b.textContent = o[1];
      b.addEventListener("click", function () { onPick(o[0]); });
      row.appendChild(b);
    });
  }

  $("re-table").addEventListener("click", function (e) {
    var st = e.target.closest("[data-sort]");
    if (st) {
      var k = st.getAttribute("data-sort");
      if (reCtx.sort === k) reCtx.asc = !reCtx.asc; else { reCtx.sort = k; reCtx.asc = true; }
      renderResultEvent(); return;
    }
    var tr = e.target.closest("tr[data-uid]");
    if (tr) { curPerma = rowByUid(tr.getAttribute("data-uid")); go("presult"); }
  });
  $("re-empty").addEventListener("click", function (e) {
    var b = e.target.closest("[data-jump]");
    if (!b) return;
    reCtx.dist = b.getAttribute("data-jump");
    reCtx.page = 1;
    renderResultEvent();
  });
  $("re-pager").addEventListener("click", function (e) {
    var b = e.target.closest("[data-page]");
    if (!b || b.disabled) return;
    reCtx.page = parseInt(b.getAttribute("data-page"), 10);
    renderResultEvent();
    $("re-table").scrollIntoView({ block: "start" });
  });
  $("re-q").addEventListener("input", function () { reCtx.q = this.value.trim(); reCtx.page = 1; renderResultEvent(); });
  $("re-clear").addEventListener("click", function () {
    reCtx.q = ""; $("re-q").value = ""; reCtx.page = 1; renderResultEvent();
  });

  /* ---------------- 個人永久成績頁 ---------------- */

  var curPerma = null;

  function renderPerma() {
    var box = $("pr-body");
    if (!curPerma) { go("results"); return; }

    if (curPerma.pending) {
      box.innerHTML = '<div class="card"><h4>成績處理中</h4>' +
        '<p class="mut">號碼布 <b>' + curPerma.bib + '</b> 的成績還沒有發佈。計時數據導入並校驗完成後，' +
        '掃這個二維碼就會自動變成成績頁——鏈接地址不變。</p>' +
        '<p class="perma" style="margin-top:.7rem">/result/pending-' + curPerma.bib + '</p>' +
        '<div class="btn-row" style="margin-top:.9rem"><button class="btn ghost sm" data-go="results">去成績庫看看別的比賽</button></div></div>';
      return;
    }

    /* ⚖️ D-117 B5 / B6 · 永久成績頁是<b>同一個</b>發佈事實的另一個入口。
       不能讓用戶繞這條路進來，還把一份已經撤回發佈的成績當正式成績看。
       這裏不另立一套發佈規則，讀的就是上面那一個 published()。 */
    if (!published(curPerma.hid, curPerma.dist)) {
      var prNote = resultBlockNote(curPerma.hid, curPerma.dist);
      box.innerHTML = '<div class="card"><h4>' + h(prNote.title) + '</h4>' +
        '<p class="mut">號碼布 <b>' + effBib(curPerma.bib) + '</b> 所在組別（' + h(curPerma.dist) + '）：' +
        prNote.body + '掃同一個二維碼<b>地址不變</b>，恢復發佈後會自動變回成績頁。</p>' +
        '<p class="perma" style="margin-top:.7rem">/result/' + curPerma.uid + '</p>' +
        '<div class="btn-row" style="margin-top:.9rem">' +
        '<button class="btn ghost" disabled>' +
        (prNote.key === "review" ? "成績複覈中，證書暫不可生成" : "完賽證書暫不可生成") + '</button>' +
        (prNote.key === "notyet" ? '<button class="btn sm" data-postrace="1">模擬進入賽後</button>' : '') +
        '<button class="btn ghost sm" data-go="results">去成績庫看往期比賽</button></div></div>';
      return;
    }

    var r = curPerma, hs = histById(r.hid);
    var cur = effBib(r.bib), moved = cur !== r.bib;
    var hist = bibHistory(r.bib);

    if (r.status && r.status !== "FIN") {
      box.innerHTML =
        '<div class="card">' +
          '<p class="perma">/result/' + r.uid + '</p>' +
          '<h2 class="pg" style="margin:.6rem 0 .2rem">' + h(r.name) + '</h2>' +
          '<p class="pg-sub">' + h(hs.t) + ' · ' + h(hs.d) + ' · ' + r.dist + ' · 號碼布 <b>' + cur + '</b></p>' +
          '<div class="res-hero" style="margin-top:1rem">' +
            '<span class="res-state ' + (r.status === "PENDING" ? "wait" : "no") + '">' +
            RES_ST[r.status][0] + '</span>' +
            '<p style="margin:.7rem 0 0;color:var(--ink-mid);font-size:.9rem">' +
            h(r.note || (r.status === "DNS" ? "已報名但未出發，成績記爲 DNS。"
              : r.status === "DNF" ? "未在關門時間內完賽，不計成績與名次。"
              : "計時數據仍在覈對，出成績後會通知你。")) + '</p>' +
          '</div>' +
          '<p class="mut" style="margin-top:.9rem">' +
          (r.status === "PENDING" ? "成績發佈後這個鏈接會自動變成正式成績頁，地址不變。"
            : "未完賽不產生名次、淨成績與完賽證書。") + '</p>' +
        '</div>' +
        '<div class="btn-row" style="margin-top:1.2rem">' +
          '<button class="btn ghost" disabled>完賽證書不可生成</button>' +
          (hs.photos && isPostRace() ? '<button class="btn ghost" id="pr-photos">仍然可以找照片</button>' : '') +
        '</div>';
      if ($("pr-photos")) $("pr-photos").onclick = function () {
        phEvent = hs.ev || "e1"; phCtx.bib = cur;
        if ($("ph-bib")) $("ph-bib").value = String(cur);
        go("photos");
      };
      return;
    }

    box.innerHTML =
      '<div class="card">' +
        '<p class="perma">/result/' + r.uid + '</p>' +
        '<h2 class="pg" style="margin:.6rem 0 .2rem">' + h(r.name) + '</h2>' +
        '<p class="pg-sub">' + h(hs.t) + ' · ' + h(hs.d) + ' · ' + r.dist + ' · 號碼布 <b>' + cur + '</b>' +
        (moved ? '（原 ' + r.bib + '，現場換號）' : '') + '</p>' +

        '<div class="res-hero" style="margin-top:1rem">' +
          '<span class="res-state ok">完賽 FINISHED</span>' +
          '<div class="res-time" style="margin-top:.6rem">' + r.net +
          '<small>淨成績 · 槍聲成績 ' + r.gun + '</small></div>' +
          '<div class="rank-big">' +
            '<div><b>' + r.rank + ' / ' + r.total + '</b><span>Overall 總排名</span></div>' +
            '<div><b>' + r.gRank + ' / ' + r.gTotal + '</b><span>Gender ' + (r.gender === "M" ? "男子" : "女子") + '</span></div>' +
            '<div><b>' + r.aRank + ' / ' + r.aTotal + '</b><span>Age Group ' + r.ageGroup + '</span></div>' +
            '<div><b>' + r.cRank + ' / ' + r.cTotal + '</b><span>Category ' + AUD[r.aud].s + '</span></div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="card"><h4>Splits · 分段</h4><div class="scroll-x"><table class="tbl">' +
        '<thead><tr><th>計時點</th><th class="n">Clock Time</th><th class="n">Split</th><th class="n">Cumulative</th></tr></thead><tbody>' +
        splitsFor(r).map(function (s) {
          return "<tr><td>" + s[0] + "</td><td class='n'>" + s[1] + "</td><td class='n'>" + s[2] + "</td><td class='n'>" + s[3] + "</td></tr>";
        }).join("") +
      '</tbody></table></div></div>' +

      (moved || hist.length
        ? '<div class="card"><h4>號碼布變更記錄<span class="new-tag">新</span></h4>' +
          '<p class="mut">換號之後成績掛在同一個人身上，歷史綁定不被覆蓋。</p>' +
          hist.map(function (o) {
            return '<div class="hist-line"><span class="hl-t">' + h(o.at) + '</span>' +
              '<span class="hl-b"><b>' + o.from + ' → ' + o.to + '</b> · ' + h(o.reason) + ' · ' + h(o.by) + '</span></div>';
          }).join("") + '</div>'
        : '') +

      '<div class="btn-row" style="margin-top:1.2rem">' +
        '<button class="btn" id="pr-cert">查看完賽證書</button>' +
        '<button class="btn ghost" id="pr-photos">查找本場比賽照片</button>' +
        '<button class="btn ghost" id="pr-share">分享成績</button>' +
      '</div>' +
      '<p class="mut" style="margin-top:.8rem;font-size:.8rem">這個鏈接不需要登錄就能打開，' +
      '也是號碼布二維碼的落地頁。任何人拿到鏈接都能看到這一頁。</p>';

    $("pr-cert").onclick = function () {
      var fake = {
        ev: hs.ev || "e1", bib: cur, name: r.name, cat: r.dist, status: "FIN",
        gun: r.gun, net: r.net, rank: r.rank, total: r.total, gRank: r.gRank, gTotal: r.gTotal,
        aRank: r.aRank, aTotal: r.aTotal, ageGroup: r.ageGroup, start: "05:30:00",
        splits: splitsFor(r).map(function (s) { return [s[0], s[3], "—"]; })
      };
      curRes = fake;
      go("result");
    };
    $("pr-photos").onclick = function () {
      phEvent = hs.ev || "e1";
      phCtx.bib = cur;
      if ($("ph-bib")) $("ph-bib").value = String(cur);
      go("photos");
      toast("已帶入號碼布 " + cur + "，可以直接查找（演示）");
    };
    $("pr-share").onclick = function () {
      openShare("分享成績", "我在 " + hs.t + " " + r.dist + " 跑出 " + r.net +
        "，總排名 " + r.rank + "/" + r.total + "。永久成績頁：/result/" + r.uid + "（演示文案）");
    };
  }

  function splitsFor(r) {
    var pts = r.dist === "21K" ? [["START", 0], ["CP1 · 5K", .235], ["CP2 · 10.5K", .49], ["CP3 · 15K", .71], ["FINISH", 1]]
      : r.dist === "10K" ? [["START", 0], ["CP1 · 3K", .29], ["CP2 · 6K", .59], ["FINISH", 1]]
      : [["START", 0], ["CP1 · 2.5K", .49], ["FINISH", 1]];
    var startClock = 5 * 3600 + 30 * 60;
    var out = [], prev = 0;
    pts.forEach(function (p) {
      var cum = Math.round(r.netS * p[1]);
      out.push([p[0], clock(startClock + cum + 2), p[1] === 0 ? "—" : hms(cum - prev), hms(cum)]);
      prev = cum;
    });
    return out;
  }
  function clock(s) {
    var hh = Math.floor(s / 3600) % 24, mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return pad(hh) + ":" + pad(mm) + ":" + pad(ss);
  }

  /* ================================================================
     v5 · 賽事硬信息（Cut-off / Race Pack / Race Kit / Rules）
     正式系統裏這些都是後臺按賽事逐項配置的字段，不是一段富文本。
     ================================================================ */

  var EV_INFO = {
    e1: {
      schedule: [
        { d: "21K", meet: "04:30", start: "05:00", cut: "08:30", age: "16 歲以上", cutNote: "3.5 小時關門" },
        { d: "10K", meet: "05:00", start: "05:30", cut: "07:30", age: "13 歲以上", cutNote: "2 小時關門" },
        { d: "5K",  meet: "05:20", start: "05:50", cut: "07:00", age: "不限年齡", cutNote: "70 分鐘關門" }
      ],
      pack: {
        place: "金邊市中心演示領物點 · 1 層中庭",
        addr: "Preah Monivong Blvd, Phnom Penh（演示地址）",
        map: "https://maps.google.com/?q=Phnom+Penh",
        days: [["9 月 18 日（週五）", "09:00 – 18:00"], ["9 月 19 日（週六）", "09:00 – 20:00"]],
        raceDay: false,
        proxy: true,
        proxyNeed: ["參賽者的電子憑證二維碼", "參賽者證件複印件", "代領人本人證件",
          "參賽者手寫授權書（寫明代領人姓名）", "未滿 16 歲需監護人簽字"]
      },
      kit: {
        "21K": [["Race Bib 號碼布", 1], ["Timing Tag 計時芯片", 1], ["Race Shirt 參賽衫", 1],
          ["Finisher Shirt 完賽衫", 1], ["Finisher Medal 完賽獎牌", 1], ["E-Certificate 電子證書", 1],
          ["E-Results 電子成績", 1], ["Refreshment 賽後補給", 1], ["Sponsor Gift 贊助商贈品", 1]],
        "10K": [["Race Bib 號碼布", 1], ["Timing Tag 計時芯片", 1], ["Race Shirt 參賽衫", 1],
          ["Finisher Shirt 完賽衫", 0], ["Finisher Medal 完賽獎牌", 1], ["E-Certificate 電子證書", 1],
          ["E-Results 電子成績", 1], ["Refreshment 賽後補給", 1], ["Sponsor Gift 贊助商贈品", 1]],
        "5K": [["Race Bib 號碼布", 1], ["Timing Tag 計時芯片", 0], ["Race Shirt 參賽衫", 1],
          ["Finisher Shirt 完賽衫", 0], ["Finisher Medal 完賽獎牌", 1], ["E-Certificate 電子證書", 1],
          ["E-Results 電子成績", 0], ["Refreshment 賽後補給", 1], ["Sponsor Gift 贊助商贈品", 0]]
      },
      org: {
        host: "RUN 賽事運營（演示）", co: "金邊市體育局（演示佔位）",
        sanction: "柬埔寨田徑協會（演示佔位）",
        tel: ["+855 12 345 678", "+855 96 555 0142"], tg: "@run_kh_demo", mail: "hello@run-demo.kh"
      }
    }
  };

  /* ⚖️ D-121 R2 · <b>詳情頁代表的是用戶點進來的那一場</b>。
     ----------------------------------------------------------------
     以前它永久取 e1：從 e3 點進來，看到的是 EV-A 的名字、日期、組別和名額 ——
     那不是「信息不全」，那是<b>把另一場比賽的業務事實安在這一場頭上</b>。
     現在標題 / 日期 / 城市 / 組別 / 剩餘名額 / 價格 / 報名入口一律來自選中賽事；
     只屬於本屆演示賽事的裝飾段落（介紹文案、賽道圖）在別的賽事上整段隱藏。 */
  function renderSelectedEventHead() {
    var r = evById(selRace()); if (!r) return;
    var se = selSharedEvent();
    var name = (se && se.name) || r.t;                 /* 共享賽事的名字優先 */
    var iso = sharedEventDate(selRace()) || r.iso || null;
    var dt = iso ? new Date(iso + "T00:00:00") : null;
    var WD = ["週日","週一","週二","週三","週四","週五","週六"];
    var md = dt ? ((dt.getMonth() + 1) + " 月 " + dt.getDate() + " 日") : r.d;
    var full = dt ? (dt.getFullYear() + " 年 " + md + "（" + WD[dt.getDay()] + "）") : r.d;
    var set = function (id, txt) { var el = $(id); if (el) el.textContent = txt; };
    set("ev-title", r.t);                              /* 標題用前端展示名（同一場賽事的外殼） */
    set("ev-date-hero", full);
    /* 前端的 loc 串通常已經帶了城市（「金邊 · 洞裏薩河濱公園」），別再拼一遍 */
    var city = (se && se.city) || "";
    set("ev-city", (city && r.loc.indexOf(city) < 0) ? (city + " · " + r.loc) : r.loc);
    /* ⚖️ D-121 R2 · 共享 Event 裏<b>沒有</b>「報名截止時刻」這個事實 —— 那就不要編一個，
       更不能拿比賽日冒充它。這裏只說一件真的知道的事：報名開關當前是開還是停。 */
    set("ev-close", regSwitchOpen(selRace()) ? "報名開放中" : "報名已暫停");
    set("ev-date-reg", md);
    set("ev-date-pay", md);
    set("reg-ev-name", r.t);
    set("pay-ev-name", r.t);
    set("pay-ev-city", r.loc);
    /* 本屆專屬的裝飾段落：換賽事就整段收起來，不拿它冒充別人的信息 */
    var only = $("ev-shell-only");
    if (only) only.hidden = (selRace() !== FE_EVENT);
    /* 組別表：組別 / 距離 / 報名費 / 關門 / 剩餘，全部來自選中的共享賽事 */
    /* 側欄那個「$N 起」以前是寫死的 $15。它是<b>這場賽事</b>當前可報名組別裏的最低價，
       同樣來自共享 PriceRule —— 不是 e3 卡片上那個裝飾性的「$25 起」。 */
    var lowest = null;
    CATS_LIVE().forEach(function (c) {
      var pr = priceFor(c.id, "cam", DEMO.user.dob);
      if (pr && pr.amount != null && (lowest === null || pr.amount < lowest)) lowest = pr.amount;
    });
    var sp = $("side-price");
    if (sp) sp.innerHTML = (lowest === null ? "—" : "$" + lowest) + "<small>起</small>";
    var tb = $("ev-cats");
    if (tb) {
      var evId = RD.adminEventId(selRace());
      var rows = CATS_LIVE().map(function (c) {
        var pr = priceFor(c.id, "cam", DEMO.user.dob);
        var cut = "—";
        if (evId && c.adminId) {
          var sc = RD.categoryById(evId, c.adminId);
          if (sc && sc.cutoff) cut = String(sc.cutoff).slice(11) || sc.cutoff;
        }
        return "<tr><td>" + h(c.n) + "</td><td class='n'>" + h(c.d || "—") + "</td><td class='n'>" +
          (pr && pr.amount != null ? "$" + pr.amount : "—") + "</td><td>" + h(cut) + "</td><td class='n'>" +
          (c.adminId ? c.left : "—") + "</td></tr>";
      }).join("");
      tb.innerHTML = rows || "<tr><td colspan='5'>這場賽事還沒有配置組別</td></tr>";
    }
  }

  /* 沒有演示文案的映射賽事：賽程直接由共享 Category 的 Start / Cut-off / 年齡門檻給出 */
  function sharedScheduleBlock() {
    var evId = RD.adminEventId(selRace());
    var se = selSharedEvent();
    if (!evId || !se) return '<div class="info-block"><h4>賽事信息</h4><div>' +
      '<p class="mut">這場賽事的詳細信息尚未在演示裏配置。</p></div></div>';
    var rows = se.categories.map(function (c) {
      return "<tr><td><b>" + h(c.name) + "</b></td><td class='n'>" + h(c.start || "—") +
        "</td><td class='n'>" + h(c.cutoff || "—") + "</td><td>" +
        (c.minAge ? h(c.minAge + " 歲以上") : "不限年齡") + "</td></tr>";
    }).join("");
    return '<div class="info-block"><h4>Race Schedule · 賽程與關門時間</h4><div>' +
      '<div class="scroll-x"><table class="tbl"><thead><tr>' +
      '<th>組別</th><th class="n">起跑</th><th class="n">關門</th><th>年齡限制</th></tr></thead><tbody>' +
      (rows || "<tr><td colspan='4'>這場賽事還沒有配置組別</td></tr>") + '</tbody></table></div>' +
      '<p class="mut" style="margin-top:.6rem">以上起跑與關門時間來自後臺<b>這場賽事自己的</b>組別配置。</p>' +
      '</div></div>' +
      '<div class="info-block"><h4>領物 / 賽包 / 主辦聯繫方式</h4><div>' +
      '<p class="mut">這幾項演示文案目前只爲「' + h(evById(FE_EVENT).t) +
      '」配置過，<b>不套用到本場</b> —— 那會把另一場比賽的信息安在這裏。' +
      '正式系統裏它們是後臺按賽事逐項配置的結構化字段。</p></div></div>';
  }

  /* 賽事詳情側欄：名額與列表同源，CTA 隨階段變化 */
  function renderDetailSide() {
    var ev = evById(selRace());
    if (!ev || !$("side-seats")) return;
    renderSelectedEventHead();
    var left = seatsLeft(ev);
    var cats = CATS_LIVE();
    $("side-seats").textContent = "共 " + cats.length + " 個組別 · 剩餘 " + left + " 個名額";
    var cta = $("side-cta");
    if (isPostRace()) {
      cta.textContent = "賽事已結束"; cta.disabled = true; cta.removeAttribute("data-go");
      $("side-note1").textContent = "成績與照片已發佈，可在成績庫查詢";
      $("side-note2").hidden = true;
    } else if (packOpen()) {
      cta.textContent = "報名已截止"; cta.disabled = true; cta.removeAttribute("data-go");
      $("side-note1").textContent = "報名已於 2026 年 9 月 12 日 23:59 截止";
      $("side-note2").hidden = false;
      $("side-note2").textContent = "已報名的跑者請在 9/18–9/19 領取參賽包";
      $("side-note2").style.color = "var(--ink-mute)";
    } else if (!regSwitchOpen(selRace())) {
      /* ⚖️ D-117 A2 · 運營點了「停止報名」：不能再開新報名，但這<b>不是</b>取消。
         賽事詳情照常可見（只要公開展示還開着），已付款 / 待付款的單一律不動。 */
      cta.textContent = "報名已暫停"; cta.disabled = true; cta.removeAttribute("data-go");
      $("side-note1").textContent = "主辦方已暫停接受新報名";
      $("side-note2").hidden = false;
      $("side-note2").textContent = "已報名的跑者不受影響：訂單、報名、參賽憑證、號碼布與參賽包全部照常";
      $("side-note2").style.color = "var(--ink-mute)";
    } else if (left <= 0) {
      cta.textContent = "名額已滿"; cta.disabled = true; cta.removeAttribute("data-go");
      $("side-note1").textContent = "報名截止：2026 年 9 月 12 日 23:59";
      $("side-note2").hidden = false;
      $("side-note2").textContent = "名額已滿（演示）";
    } else {
      cta.textContent = "立即報名"; cta.disabled = false; cta.setAttribute("data-go", "reg1");
      /* 同上：不編報名截止日。說得出口的是比賽日與當前開關狀態。 */
      $("side-note1").textContent = "比賽日 " + ((sharedEventDate(selRace()) || ev.iso || ev.d).replace(/-/g, ".")) +
        " · 報名開放中";
      $("side-note2").hidden = false;
      /* ⚖️ D-111 A4 · 這個數字不能寫死：它是 C-21K 此刻的真實剩餘（含付款窗口裏的預留）。
         文案可以是前端的，數字必須來自共享域。 */
      /* ⚖️ D-121 R2 · 這句以前寫死 EV-A 的 C-21K。換成選中賽事裏<b>當前最緊張</b>
         的那個組別，說的是哪一組也一併說出來 —— 不再假定每場都有半程。 */
      var tight = null;
      CATS_LIVE().forEach(function (c) {
        if (!c.adminId) return;
        if (tight === null || c.left < tight.left) tight = c;
      });
      $("side-note2").textContent = tight
        ? (tight.n + (tight.d ? " " + tight.d : "") + "僅剩 " + tight.left + " 個名額")
        : "名額有限";
      $("side-note2").style.color = "var(--warn)";
    }
  }

  function renderEventInfo() {
    renderDetailSide();
    var box = $("ev-info");
    if (!box) return;
    /* ⚖️ D-121 R2 · 領物點 / 賽包清單 / 主辦聯繫方式這些<b>演示外殼文案</b>
       只爲本屆演示賽事配過。換成別的映射賽事時，不套用本屆那一套 ——
       那會把另一場比賽的集合時間、關門時間、年齡限制安在這一場頭上。
       這時改爲按<b>共享 Category 事實</b>給出賽程，並如實說明其餘項尚未配置。 */
    if (typeof EV_INFO === "undefined" || !EV_INFO) { if (typeof sharedScheduleBlock === "function") box.innerHTML = sharedScheduleBlock(); return; }
    var info = EV_INFO[selRace()];
    if (!info) { box.innerHTML = sharedScheduleBlock(); return; }

    var sched = '<div class="info-block"><h4>Race Schedule · 賽程與關門時間</h4><div>' +
      '<div class="scroll-x"><table class="tbl"><thead><tr>' +
      '<th>組別</th><th class="n">集合</th><th class="n">起跑</th><th class="n">關門</th><th>年齡限制</th></tr></thead><tbody>' +
      info.schedule.map(function (s) {
        return "<tr><td><b>" + s.d + "</b></td><td class='n'>" + s.meet + "</td><td class='n'>" + s.start +
          "</td><td class='n'>" + s.cut + "<br><span class='mut' style='font-size:.72rem'>" + s.cutNote +
          "</span></td><td>" + s.age + "</td></tr>";
      }).join("") + '</tbody></table></div>' +
      '<p class="mut" style="margin-top:.6rem">分批起跑，請按自己組別的集合時間到場。關門時間之後計時毯撤收，成績不再記錄。</p>' +
      '</div></div>';

    var p = info.pack;
    var pack = '<div class="info-block"><h4>Race Pack Collection · 領物</h4><div>' +
      '<div class="kv" style="margin-top:0">' +
        '<div><span>地點</span><b>' + h(p.place) + '</b></div>' +
        '<div><span>地址</span><b style="font-size:.85rem">' + h(p.addr) + '</b></div>' +
      '</div>' +
      '<div class="scroll-x"><table class="tbl"><thead><tr><th>日期</th><th>時間</th></tr></thead><tbody>' +
      p.days.map(function (d) { return "<tr><td>" + d[0] + "</td><td class='n'>" + d[1] + "</td></tr>"; }).join("") +
      '</tbody></table></div>' +
      '<div class="btn-row" style="margin:.7rem 0"><button class="btn ghost sm" id="ev-map">在地圖中打開</button></div>' +
      '<p style="font-size:.88rem;margin:.3rem 0"><b>比賽當天不設領物點</b>——' +
      (p.raceDay ? "" : "務必在上述兩天內領取，逾期視爲放棄。") + '</p>' +
      '<p style="font-size:.88rem;margin:.6rem 0 .3rem"><b>可以代領。</b>代領人需攜帶：</p>' +
      '<ul class="kit-list">' + p.proxyNeed.map(function (x) {
        return '<li class="yes"><i>·</i>' + h(x) + '</li>';
      }).join("") + '</ul></div></div>';

    var kitTabs = Object.keys(info.kit);
    var kit = '<div class="info-block"><h4>Race Kit Includes · 參賽包內容</h4><div>' +
      '<div class="tabs" id="kit-tabs" style="margin-bottom:.8rem"></div>' +
      '<div id="kit-body"></div>' +
      '<p class="mut" style="margin-top:.7rem">不同組別的參賽包內容不同——完賽衫只有 21K 有，計時芯片 5K 不發。' +
      '這一項在後臺是逐項勾選的。</p></div></div>';

    var rules = '<div class="info-block"><h4>Rules · 規則與條款</h4><div>' +
      '<p class="mut" style="margin:0 0 .7rem">完整條款單獨成頁，賽事頁只放入口。</p>' +
      '<div class="btn-row">' +
        '<button class="btn ghost sm" data-go="refund">Refund Policy 退款政策</button>' +
        '<button class="btn ghost sm" id="rule-cat">Category Change 組別變更</button>' +
        '<button class="btn ghost sm" id="rule-bib">Bib Transfer 轉讓</button>' +
        '<button class="btn ghost sm" id="rule-fm">Force Majeure 不可抗力</button>' +
        '<button class="btn ghost sm" data-go="terms">Race Rules 參賽規則</button>' +
      '</div></div></div>';

    var bi = '<div class="info-block"><h4>ភាសាខ្មែរ / English<span class="new-tag">新</span></h4><div>' +
      '<p class="mut" style="margin:0 0 .7rem">高棉語與英語並排展示的演示塊。柬埔寨賽事的關鍵信息' +
      '通常要同時給本地跑者、政府和國際選手看，所以不是「切語言」，是「並排」。' +
      '本輪只做這一塊驗證表達方式，不做全站三語。</p>' +
      biRow("Race Pack Collection", "ការទទួលយកសម្ភារៈរត់",
            "18–19 Sep, Phnom Penh city centre. No collection on race day.",
            "១៨–១៩ កញ្ញា នៅទីក្រុងភ្នំពេញ។ គ្មានការទទួលយកនៅថ្ងៃប្រកួតទេ។") +
      biRow("Cut-off Time", "ពេលវេលាកំណត់",
            "21K 3.5 hrs · 10K 2 hrs · 5K 70 mins",
            "២១គ.ម ៣.៥ម៉ោង · ១០គ.ម ២ម៉ោង · ៥គ.ម ៧០នាទី") +
      biRow("Start Time", "ពេលចាប់ផ្ដើម",
            "21K 05:00 · 10K 05:30 · 5K 05:50",
            "២១គ.ម ០៥:០០ · ១០គ.ម ០៥:៣០ · ៥គ.ម ០៥:៥០") +
      '</div></div>';

    var org = info.org;
    var orgBlock = '<div class="info-block"><h4>Organizer · 組織與聯繫方式</h4><div>' +
      '<div class="kv" style="margin-top:0">' +
        '<div><span>主辦</span><b>' + h(org.host) + '</b></div>' +
        '<div><span>協辦</span><b>' + h(org.co) + '</b></div>' +
        '<div><span>認證</span><b>' + h(org.sanction) + '</b></div>' +
      '</div>' +
      '<p style="font-size:.88rem;margin:.5rem 0 0">電話 ' + org.tel.map(h).join(" / ") +
      '　Telegram ' + h(org.tg) + '　郵箱 ' + h(org.mail) + '</p>' +
      '<p class="mut" style="margin-top:.5rem">以上均爲演示佔位，不對應任何真實機構。</p></div></div>';

    var stateBar = isPostRace()
      ? '<div class="info-block" style="border-color:var(--leaf)"><h4 style="background:var(--leaf-tint)">' +
        '本場比賽已結束 · 成績與照片已發佈</h4><div>' +
        '<p style="margin:0 0 .7rem">報名與領物均已關閉。下面的賽事信息保留爲賽後存檔。</p>' +
        '<div class="btn-row"><button class="btn sm" data-go="resultev">查看本場成績榜</button>' +
        '<button class="btn ghost sm" data-go="photos">查找本場照片</button></div></div></div>'
      : packOpen()
      ? '<div class="info-block" style="border-color:var(--warn)"><h4 style="background:var(--warn-tint)">' +
        '報名已截止 · 領物期</h4><div>' +
        '<p style="margin:0 0 .7rem">不能再報名。已報名的跑者請在 <b>9/18–9/19</b> 到領物點領取參賽包，' +
        '出示電子參賽憑證的二維碼。<b>成績與照片要等比賽結束後纔有。</b></p>' +
        '<div class="btn-row"><button class="btn ghost sm" data-go="me">查看我的電子憑證</button>' +
        '<button class="btn ghost sm" data-phase="post">模擬進入賽後</button></div></div></div>'
      : '<div class="info-block" style="border-color:var(--brand)"><h4 style="background:var(--brand-tint)">' +
        '本場比賽尚未舉行 · 報名中</h4><div>' +
        '<p style="margin:0 0 .7rem">比賽日 2026.09.20。<b>賽前不會有成績，也不會有照片</b>——' +
        '這兩樣要等賽後纔有。領物在報名截止之後開始。</p>' +
        '<div class="btn-row"><button class="btn ghost sm" data-phase="closed">模擬報名截止 · 進入領物期</button>' +
        '<button class="btn ghost sm" data-phase="post">直接進入賽後</button></div></div></div>';

    box.innerHTML = stateBar + sched + pack + kit + rules + bi + orgBlock;

    var kt = "21K";
    function drawKit() {
      chipRowTabs("kit-tabs", kitTabs.map(function (k) { return [k, k]; }), kt, function (v) { kt = v; drawKit(); });
      $("kit-body").innerHTML = '<ul class="kit-list">' + info.kit[kt].map(function (x) {
        return '<li class="' + (x[1] ? "yes" : "no") + '"><i>' + (x[1] ? "✓" : "×") + '</i>' + h(x[0]) + '</li>';
      }).join("") + '</ul>';
    }
    drawKit();

    $("ev-map").onclick = function () { todo("正式系統會打開 Google Maps 定位。當前爲前端演示，不跳轉外部站點。"); };
    $("rule-cat").onclick = function () {
      todo("組別變更：升組補差價、降組不退，賽前 14 天截止，收 $5 手續費（演示規則）。正式流程由後端與客服後臺實現。");
    };
    $("rule-bib").onclick = function () {
      todo("號碼布轉讓：是否開放由每場賽事單獨配置，本場演示爲「允許，賽前 14 天截止」。正式流程由後端實現。");
    };
    $("rule-fm").onclick = function () {
      todo("不可抗力：極端天氣、公共衛生事件或政府管制導致取消時，全額退款或順延，由參賽者選擇（演示規則）。");
    };
  }

  function biRow(en, km, enV, kmV) {
    return '<div class="bilingual" style="margin-bottom:.6rem">' +
      '<div><span class="lg-tag">ENGLISH</span><b>' + h(en) + '</b><span>' + h(enV) + '</span></div>' +
      '<div><span class="lg-tag">ភាសាខ្មែរ · KHMER</span><b>' + h(km) + '</b><span>' + h(kmV) + '</span></div>' +
      '</div>';
  }

  /* ================================================================
     v5 · Race Pack 工作臺（工作人員端）
     ================================================================ */

  var RP_EVENTS = [["e1", "金邊濱河半程馬拉松 2026"]];
  var rpSel = null;
  var rpSize = {};        // uid -> 現場改過的尺碼（演示級，不落庫）

  /* 領物名單直接從成績榜的同一批人派生：換號在兩邊同時生效，不會各寫一套 */
  /* 領物名單的唯一來源是報名記錄。演示底表 18 人代表「歷史已導入的報名」，
     用戶在原型裏新報的名也必須出現在這裏，取消的人保留但不可發包。 */
  function roster() {
    /* ⚖️ D-096 D2 · 領物名單的當前真相全部來自<b>共享域</b>：
       當前持有人、當前號碼布、當前報名狀態、是否有進行中的退款。
       本地 S.regs 不再是第二套 Registration 真相。 */
    /* ⚖️ D-098 根 B · 與運營後臺用<b>同一個</b>派生函數，不各寫一遍。 */
    var out = [];
    var evId = RD.adminEventId("e1");
    var DIST = { "C-21K": "21K", "C-10K": "10K", "C-5K": "5K" };
    RD.racePackRoster(evId).forEach(function (d) {
      var f = RD.findOPByReg(d.regId);
      out.push({
        uid: "reg:" + d.opId, row: null,
        bib: d.bib, orig: d.bib,
        name: d.name, dist: DIST[d.cat] || "10K",
        aud: d.localPrice ? "cam" : "exp",
        size: rpSize["reg:" + d.opId] || (f ? f.p.reg.size : "M"), paid: true,
        idChecked: RD.racePackIdVerified(d.regId),
        cancelled: d.cancelled,
        refundHold: !!d.openRefund, refundId: d.openRefund ? d.openRefund.id : null,
        regId: d.regId, fromReg: true
      });
    });
    var base = [];
    ["21K", "10K", "5K"].forEach(function (d) {
      board("h0", d).slice(0, d === "10K" ? 8 : 5).forEach(function (r) { base.push(r); });
    });
    var star = board("h0", "10K").filter(function (r) { return r.bib === 1001; })[0];
    if (star && base.indexOf(star) < 0) base.unshift(star);
    var seen = {};
    return base.filter(function (r) {
      if (seen[r.uid]) return false; seen[r.uid] = 1; return true;
    }).map(function (r) {
      var seed = r.bib % 5;
      return {
        uid: r.uid, row: r, bib: effBib(r.bib), orig: r.bib, name: r.name, dist: r.dist,
        aud: r.aud, size: rpSize[r.uid] || ["S", "M", "L", "XL"][seed % 4],
        paid: seed !== 3, idChecked: RD.racePackIdVerified("LEGACY:" + r.uid), cancelled: false, fromReg: false
      };
    }).concat(out);
  }
  function rosterByUid(uid) {
    var all = roster();
    for (var i = 0; i < all.length; i++) if (all[i].uid === uid) return all[i];
    return null;
  }
  /* ⚖️ D-100 B2 / B6 · 「領沒領」的<b>唯一</b>權威是共享領物事實。
     離線隊列只是<b>待同步的運輸記錄</b>，會在界面上明確標成「待同步」，
     但它不是第二本已完成的領物賬 —— 也因此不能拿它去擋後臺。 */
  function isCollected(r) { return RD.racePackPicked(packKey(r)); }
  function queuedOf(r) {
    var k = packKey(r);
    return S.packQueue.filter(function (x) { return x.regId === k; })[0] || null;
  }
  function packRec(r) {
    var f = RD.racePackFact(packKey(r));
    if (f && f.picked) {
      return { at: f.pickedAt, by: f.pickedBy, dev: f.device, off: !!f.offlineSynced, synced: true };
    }
    return null;
  }

  /* ⚖️ D-102 Rule 9 · 同步被當前事實拒絕的離線覈銷：包已經交出去了，
     但共享域不接受這筆領物。它必須一直顯示成需人工處理，而不是悄悄消失。 */
  function blockedQueueHtml() {
    var bad = S.packQueue.filter(function (q) { return q.blocked; });
    if (!bad.length) return "";
    return '<div class="sync-bar" style="background:var(--stop)">✖ <b>' + bad.length +
      ' 條離線覈銷無法入賬，需人工處理</b>（現場包已發出，但共享業務事實拒絕寫入）</div>' +
      '<div class="id-note" style="background:var(--stop-tint);border-color:var(--stop);color:#8B2F20">' +
      bad.map(function (q) {
        return '<div><b>' + h(q.regId) + '</b> · ' + h(q.at) + ' · Device ' + h(q.device) +
               '<br><span class="mut">' + h(q.why || "同步被當前事實拒絕") + '</span></div>';
      }).join("") + '</div>';
  }

  function renderRacePack() {
    var sel = $("rp-ev");
    if (!sel.options.length) {
      RP_EVENTS.forEach(function (e) {
        var o = document.createElement("option"); o.value = e[0]; o.textContent = e[1]; sel.appendChild(o);
      });
    }
    $("rp-dev").value = S.device;
    var net = $("rp-net");
    net.className = "staff-pill " + (S.net === "online" ? "on" : "off");
    net.textContent = S.net === "online" ? "● ONLINE" : "● OFFLINE";

    var all = roster();
    var done = all.filter(function (r) { return isCollected(r); }).length;
    $("rp-progress").textContent = "演示名單 " + all.length + " 人 · 已領 " + done + " · 未領 " + (all.length - done) +
      " · 當前設備 Device " + S.device;

    var sync = $("rp-sync");
    if (!packOpen()) {
      sync.innerHTML = '<div class="sync-bar" style="background:#22557F">⚑ <b>領物尚未開始</b> · ' +
        '當前階段「' + phaseLabel() + '」，報名還在進行，參賽包不發放。' +
        '<button class="btn sm" data-phase="closed" style="margin-left:auto">切到「報名已截止 · 領物期」</button></div>';
      renderRpResults(all);
      renderRpDetail();
      return;
    }
    if (S.net === "offline") {
      sync.innerHTML = '<div class="sync-bar">⚠︎ <b>離線模式</b> · ' + S.packQueue.length +
        ' 條<b>待同步</b>（尚未寫入業務事實）· 仍可掃碼、查本地名單、確認領取' +
        '<button class="btn sm" id="rp-go-online" style="margin-left:auto">切回 Online 並同步</button></div>' +
        blockedQueueHtml();
      $("rp-go-online").onclick = function () { setNet("online"); };
    } else if (S.syncReport && (S.syncReport.already.length || S.syncReport.conflict.length)) {
      var rep = S.syncReport;
      sync.innerHTML = '<div class="sync-bar" style="background:#8B5A16">↻ 上次同步 ' + rep.at +
        '：成功 <b>' + rep.okN + '</b> 條' +
        (rep.already.length ? ' · <b>' + rep.already.length + '</b> 條他人已處理（不重複發放）' : '') +
        (rep.conflict.length ? ' · <b>' + rep.conflict.length + '</b> 條按當前事實被拒' : '') +
        '<button class="btn sm" id="rp-clear-rep" style="margin-left:auto">知道了</button></div>' +
        (rep.conflict.length
          ? '<div class="id-note" style="margin-top:.4rem">' +
            rep.conflict.map(function (c) { return '<div><b>' + h(c.regId) + '</b>：' +
              h(String(c.why).replace(/<[^>]+>/g, "")) + '</div>'; }).join("") + '</div>'
          : "");
      var cb = $("rp-clear-rep");
      if (cb) cb.onclick = function () { S.syncReport = null; save(); renderRacePack(); };
    } else {
      sync.innerHTML = blockedQueueHtml();
    }

    renderRpResults(all);
    renderRpDetail();
  }

  function setNet(v) {
    S.net = v;
    if (v === "online" && S.packQueue.length) {
      var n = S.packQueue.length;
      /* ⚖️ D-100 B4 / B5 · 同步不是把本地隊列抄進另一本本地賬，
         而是拿每一條<b>重跑共享域那個唯一發包入口</b>，用<b>當前</b>事實判定：
         後臺已經先發過 → 已處理，不產生第二筆；
         期間出現進行中退款 / 報名被取消 → 失敗關閉，不寫領物事實。 */
      RD.load();
      var out = RD.syncRacePackQueue(S.packQueue, { who: "staff:" + S.device, role: "RACE_STAFF" });
      RD.save();
      var okN = out.filter(function (x) { return x.outcome === "SYNCED"; }).length;
      var already = out.filter(function (x) { return x.outcome === "ALREADY"; });
      var conflict = out.filter(function (x) { return x.outcome === "CONFLICT"; });
      /* ⚖️ D-102 Rule 9 · 已同步 / 已被他人處理的從隊列移除；
         <b>被當前事實拒絕的那幾條留在隊列裏</b>，並帶上原因 ——
         包在現場是真的交出去了，這條證據不能因爲一次同步失敗就人間蒸發。
         它會一直顯示成「需人工處理」，刷新也還在。 */
      var blockedIds = {};
      conflict.forEach(function (c) { blockedIds[c.regId] = c.why; });
      S.packQueue = S.packQueue.filter(function (q) { return blockedIds[q.regId] != null; })
        .map(function (q) {
          q.blocked = true;
          q.why = String(blockedIds[q.regId] || "").replace(/<[^>]+>/g, "");
          return q;
        });
      S.syncReport = { at: now2(), okN: okN, already: already, conflict: conflict };
      save();
      renderRacePack();
      var msg = "同步完成 · " + n + " 條離線覈銷已回傳：成功 " + okN;
      if (already.length) msg += " · 已被他人處理 " + already.length;
      if (conflict.length) msg += " · 當前事實不允許 " + conflict.length;
      toast(msg + "（演示）");
      return;
    }
    save();
    renderRacePack();
    toast(v === "offline" ? "已切到離線模式（演示）" : "已切回在線（演示）");
  }

  function renderRpResults(all) {
    var q = ($("rp-q").value || "").trim().toLowerCase();
    var list = !q ? all.slice(0, 6) : all.filter(function (r) {
      return String(r.bib).indexOf(q) >= 0 || String(r.orig).indexOf(q) >= 0 ||
        r.name.toLowerCase().indexOf(q) >= 0;
    });
    $("rp-results").innerHTML = list.length
      ? list.map(function (r) {
          return '<button class="staff-row" data-rp="' + r.uid + '">' +
            '<span class="sr-bib">' + r.bib + '</span>' +
            '<span class="sr-nm">' + h(r.name) + ' · ' + r.dist + '</span>' +
            '<span class="sr-st ' + (r.cancelled ? "bad" : isCollected(r) ? "done" : queuedOf(r) ? "todo" : "todo") + '">' +
            (r.cancelled ? "CANCELLED" : isCollected(r) ? "已領取" : queuedOf(r) ? "待同步" : "未領取") + '</span></button>';
        }).join("")
      : '<p style="color:var(--ink-mute);font-size:.85rem;margin:.3rem 0">沒有找到。演示名單裏可以試：1001、SVEN、SOK</p>';
    if (!q) {
      $("rp-results").insertAdjacentHTML("afterbegin",
        '<p style="color:var(--ink-mute);font-size:.78rem;margin:0 0 .2rem">最近 / 常用（演示）</p>');
    }
  }

  function renderRpDetail() {
    var box = $("rp-detail");
    if (!rpSel) { box.innerHTML = ""; return; }
    var r = rosterByUid(rpSel);
    if (!r) { rpSel = null; box.innerHTML = ""; return; }
    var col = packRec(r);
    var queued = queuedOf(r);

    box.innerHTML =
      '<div class="staff-card big-bib">' +
        '<div class="bib-big"><small>BIB</small>' + r.bib +
        (r.bib !== r.orig ? ' <span class="st warn" style="font-size:.6rem;vertical-align:middle">原 ' + r.orig + '</span>' : '') + '</div>' +
        '<div class="runner-nm">' + h(r.name) + '</div>' +
        '<div class="kv">' +
          '<div><span>Distance</span><b>' + r.dist + '</b></div>' +
          '<div><span>Participant Type</span><b class="' + (r.aud === "cam" ? "warn" : "") + '">' + AUD[r.aud].s + '</b></div>' +
          '<div><span>Payment</span><b class="' + (r.paid ? "good" : "bad") + '">' + (r.paid ? "PAID" : "UNPAID") + '</b></div>' +
          '<div><span>Identity Check</span><b class="' + (r.aud !== "cam" ? "" : r.idChecked ? "good" : "bad") + '">' +
            (r.aud !== "cam" ? "NOT REQUIRED" : r.idChecked ? "VERIFIED 已覈驗" : "REQUIRED 需覈驗") + '</b></div>' +
          '<div><span>Shirt</span><b>' + r.size + '</b></div>' +
          '<div><span>Race Pack</span><b class="' + (col ? "good" : queued ? "warn" : "bad") + '">' +
            (col ? "COLLECTED" : queued ? "PENDING SYNC 待同步" : "NOT COLLECTED") + '</b></div>' +
        '</div>' +
        (r.cancelled
          ? '<div class="id-note" style="background:var(--stop-tint);border-color:var(--stop);color:#8B2F20">' +
            '<b>此報名已取消，不可發放參賽包。</b>記錄保留是爲了讓你在現場能查到「這個人報過名但已取消」，而不是查無此人。</div>'
          : '') +
        (!r.cancelled && r.aud === "cam" && !r.idChecked
          ? '<div class="id-note"><b>本地價資格未覈驗。</b>需出示柬埔寨身份證件，覈驗通過後才能發放參賽包。' +
            '（本場外籍價爲 ' + (function () {
              var fe = r.dist === "21K" ? "21k" : r.dist === "10K" ? "10k" : "5k";
              var c = catById(fe);
              var m = c && c.adminId ? RD.matchPriceRule(RD.adminEventId(FE_EVENT), c.adminId, "ALL") : null;
              return (m && m.ok) ? ("$" + m.rule.price) : "—";
            })() + '）</div>'
          : '') +
        (!r.paid && !r.cancelled ? '<div class="id-note" style="background:var(--stop-tint);border-color:var(--stop);color:#8B2F20">未支付：不得發放參賽包，請引導至現場收款臺。</div>' : '') +

        (r.cancelled
          ? '<div class="staff-acts" style="margin-top:.9rem">' +
            '<button class="btn ghost" disabled>已取消 · 不可發包</button></div>'
          : queued && !col
          ? '<div class="id-note"><b>已離線覈銷，等待同步。</b>這條記錄<b>還不是</b>業務事實 ——' +
            '聯網後會拿當前的報名 / 退款 / 是否已被他人發放重新校驗一次，通過了才真正寫入。' +
            '<span class="mut"> 排隊時間 ' + h(queued.at) + ' · Device ' + h(queued.device) + '</span></div>' +
            '<div class="staff-acts" style="margin-top:.8rem">' +
            '<button class="btn ghost" id="rp-undo">撤銷這條待同步</button></div>'
          : col
          ? '<div class="collected-mark" style="margin-top:.9rem"><b>COLLECTED</b>' +
            '<span>操作人 ' + h(col.by || ("Staff " + col.dev)) + ' · ' + h(col.at) +
            (col.dev ? ' · Device ' + h(col.dev) : '') +
            (col.off ? ' · 離線補同步' : '') + '</span></div>' +
            /* 發完包才發現號碼布損壞是現場常態：已領取仍然要能換號，且不清掉領取狀態 */
            '<div class="staff-acts" style="margin-top:.8rem">' +
            '<button class="btn ghost" id="rp-bib">更換 Bib</button>' +
            '<button class="btn ghost" id="rp-size">修改尺碼</button>' +
            '<button class="btn ghost" id="rp-undo">撤銷誤操作</button></div>'
          : '<div class="staff-acts" style="margin-top:.9rem">' +
            '<button class="btn ghost" id="rp-id"' + (r.aud === "cam" && !r.idChecked ? '' : ' disabled') + '>覈驗身份</button>' +
            '<button class="btn ghost" id="rp-edit">修改資料</button>' +
            '<button class="btn ghost" id="rp-size">修改尺碼</button>' +
            '<button class="btn ghost" id="rp-bib">更換 Bib</button>' +
            '<button class="btn big-ok" id="rp-ok" style="grid-column:1/-1"' +
            ((r.aud === "cam" && !r.idChecked) || !r.paid ? ' disabled' : '') + '>確認領取 Race Pack</button>' +
            ((r.aud === "cam" && !r.idChecked)
              ? '<p class="why-blocked" style="grid-column:1/-1;margin:0">請先完成本地價格資格覈驗</p>' : '') +
            '</div>') +
      '</div>';

    var el;
    if ((el = $("rp-id"))) el.onclick = function () {
      setIdOK(r);
      toast("本地價資格覈驗通過 · VERIFIED · 運營後臺立即可見（演示）");
      renderRacePack();
    };
    if ((el = $("rp-edit"))) el.onclick = function () {
      todo("現場改資料：正式系統裏改完立即回傳並留操作日誌。當前爲前端演示。");
    };
    if ((el = $("rp-size"))) el.onclick = function () {
      var i = ["S", "M", "L", "XL"].indexOf(r.size);
      rpSize[r.uid] = ["S", "M", "L", "XL"][(i + 1) % 4];
      toast("尺碼已改爲 " + rpSize[r.uid] + "（演示，未落庫）");
      renderRpDetail();
    };
    if ((el = $("rp-bib"))) el.onclick = function () {
      bmSel = r.uid;
      go("bibmgmt");
      toast("已跳到 Bib 運營工作臺，換號在那裏操作並留痕");
    };
    if ((el = $("rp-ok"))) el.onclick = function () {
      if (!packOpen()) { toast("報名尚未截止，領物還沒開始（演示攔截）"); return; }
      if (r.cancelled) { toast("該報名已取消，不能發放參賽包（演示攔截）"); return; }
      if (!r.paid) { toast("未支付，不能發放參賽包（演示攔截）"); return; }
      if (r.aud === "cam" && !r.idChecked) { toast("請先完成本地價格資格覈驗（演示攔截）"); return; }
      var key = packKey(r);
      if (S.net === "offline") {
        /* ⚖️ D-100 B4 · 離線時<b>不產生已完成的領物事實</b>，只排一條待同步記錄。
           真正寫不寫得進去，等聯網後拿<b>當時</b>的共享事實重新判定。 */
        if (queuedOf(r)) { toast("這條已經在待同步隊列裏了（演示）"); return; }
        S.packQueue.push({ regId: key, at: now2(), device: S.device, by: "Staff " + S.device });
        save();
        toast("已離線覈銷 · " + S.packQueue.length + " 條待同步（尚未寫入業務事實）");
      } else {
        /* 在線：走<b>與後臺完全相同</b>的共享寫入口 */
        var res = RD.issueRacePack(key, { who: "staff:" + S.device, role: "RACE_STAFF" },
                                   { device: S.device });
        if (!res.ok) {
          toast(String(res.why || "發包被拒").replace(/<[^>]+>/g, ""));
          renderRacePack();
          return;
        }
        RD.save();
        toast("Race Pack 已發放 · 運營後臺立即可見（演示）");
      }
      renderRacePack();
    };
    if ((el = $("rp-undo"))) el.onclick = function () {
      var key = packKey(r);
      RD.undoRacePack(key, { who: "staff:" + S.device, role: "RACE_STAFF" }, "現場撤銷誤操作");
      RD.save();
      S.packQueue = S.packQueue.filter(function (x) { return x.regId !== key; });
      save(); renderRacePack();
      toast("已撤銷領取記錄 · 運營後臺同步可見（演示，正式系統會留撤銷日誌）");
    };
  }

  $("rp-q").addEventListener("input", function () { renderRpResults(roster()); });
  $("rp-scan").addEventListener("click", function () {
    var all = roster();
    var pick = all.filter(function (r) { return !isCollected(r); })[0] || all[0];
    if (!pick) return;
    rpSel = pick.uid;
    $("rp-q").value = String(pick.bib);
    renderRpResults(all);
    renderRpDetail();
    toast("模擬掃碼：讀到號碼布 " + pick.bib + "（演示，未調用相機）");
  });
  $("rp-results").addEventListener("click", function (e) {
    var t = e.target.closest("[data-rp]");
    if (!t) return;
    rpSel = t.getAttribute("data-rp");
    renderRpDetail();
  });
  $("rp-dev").addEventListener("change", function () {
    S.device = this.value; save();
    toast("已切換到 Device " + S.device + "：多臺設備同時作業，同步後按票據 ID 去重");
    renderRacePack();
  });
  $("rp-net").addEventListener("click", function () { setNet(S.net === "online" ? "offline" : "online"); });
  $("rp-exit").addEventListener("click", function () { go("staff"); });

  /* ================================================================
     v5 · Bib 運營工作臺
     ================================================================ */

  var BIB_RANGES = [
    { d: "5K",  from: 5001, to: 5999, reserved: [5001, 5010] },
    { d: "10K", from: 1001, to: 1999, reserved: [1001, 1005] },
    { d: "21K", from: 2101, to: 2999, reserved: [2101, 2110] }
  ];
  var bmSel = null;

  function bibState(n) {
    if (S.bibOps.some(function (o) { return o.op === "void" && o.from === n; })) return "void";
    var used = roster().some(function (r) { return r.bib === n; });
    if (used) return "assigned";
    var rng2 = BIB_RANGES.filter(function (r) { return n >= r.reserved[0] && n <= r.reserved[1]; })[0];
    if (rng2) return "reserved";
    return "available";
  }

  function renderBibMgmt() {
    var sel = $("bm-ev");
    if (!sel.options.length) {
      RP_EVENTS.forEach(function (e) {
        var o = document.createElement("option"); o.value = e[0]; o.textContent = e[1]; sel.appendChild(o);
      });
    }

    var all = roster();
    $("bm-ranges").innerHTML = BIB_RANGES.map(function (r) {
      var assigned = all.filter(function (x) { return x.bib >= r.from && x.bib <= r.to; }).length;
      var voided = S.bibOps.filter(function (o) { return o.op === "void" && o.from >= r.from && o.from <= r.to; }).length;
      var reserved = r.reserved[1] - r.reserved[0] + 1;
      var total = r.to - r.from + 1;
      return '<div><b>' + r.d + '　' + r.from + '–' + r.to + '</b>' +
        '<span>共 ' + total + ' 個號 · 預留 ' + r.reserved[0] + '–' + r.reserved[1] + '</span>' +
        '<div class="bib-stat">' +
          '<i class="bs-as">Assigned ' + assigned + '</i>' +
          '<i class="bs-rs">Reserved ' + reserved + '</i>' +
          '<i class="bs-vd">Void ' + voided + '</i>' +
          '<i class="bs-av">Available ' + (total - assigned - reserved - voided) + '</i>' +
        '</div></div>';
    }).join("");

    renderBmResults();
    renderBmDetail();

    var ops = S.bibOps.filter(function (o) { return o.op === "change"; });
    $("bm-log").innerHTML = ops.length
      ? ops.slice().reverse().map(function (o) {
          return '<div class="hist-line"><span class="hl-t">' + h(o.at) + '</span>' +
            '<span class="hl-b"><b>' + o.from + ' → ' + o.to + '</b> · ' + h(o.reason) +
            ' · 操作人 ' + h(o.by) + '</span></div>';
        }).join("")
      : '<p class="mut" style="margin:0">還沒有換號記錄。到上面查一個人（試試 1001），換個號看看鏈路。</p>';
  }

  function renderBmResults() {
    var q = ($("bm-q").value || "").trim().toLowerCase();
    var all = roster();
    var list = !q ? all.slice(0, 5) : all.filter(function (r) {
      return String(r.bib).indexOf(q) >= 0 || String(r.orig).indexOf(q) >= 0 || r.name.toLowerCase().indexOf(q) >= 0;
    });
    $("bm-results").innerHTML = list.length
      ? list.map(function (r) {
          return '<button class="staff-row" data-bm="' + r.uid + '">' +
            '<span class="sr-bib">' + r.bib + '</span>' +
            '<span class="sr-nm">' + h(r.name) + ' · ' + r.dist + '</span>' +
            '<span class="sr-st ' + (r.bib !== r.orig ? "done" : "todo") + '">' +
            (r.bib !== r.orig ? "已換號" : bibState(r.bib) === "assigned" ? "Assigned" : "—") + '</span></button>';
        }).join("")
      : '<p style="color:var(--ink-mute);font-size:.85rem;margin:.3rem 0">沒有找到。試試 1001 或 SVEN。</p>';
  }

  function renderBmDetail() {
    var box = $("bm-detail");
    if (!bmSel) { box.innerHTML = ""; return; }
    var r = rosterByUid(bmSel);
    if (!r) { bmSel = null; box.innerHTML = ""; return; }
    var hist = bibHistory(r.orig);
    var suggest = r.dist === "21K" ? 2901 : r.dist === "10K" ? 2001 : 5901;

    box.innerHTML =
      '<div class="staff-card">' +
        '<div class="runner-nm">' + h(r.name) + '</div>' +
        '<div class="kv">' +
          '<div><span>Current Bib</span><b class="mono">' + r.bib + '</b></div>' +
          '<div><span>Original Bib</span><b class="mono">' + r.orig + '</b></div>' +
          '<div><span>Distance</span><b>' + r.dist + '</b></div>' +
          '<div><span>State</span><b>' + bibState(r.bib).toUpperCase() + '</b></div>' +
        '</div>' +

        '<div class="field-row" style="margin-top:.4rem">' +
          '<div class="field"><label>Change to · 換成</label>' +
            '<input id="bm-new" type="text" inputmode="numeric" value="' + suggest + '"></div>' +
          '<div class="field"><label>Reason · 原因</label>' +
            '<select id="bm-reason">' +
              '<option>Damaged Bib 號碼布損壞</option>' +
              '<option>Printing Error 印刷錯誤</option>' +
              '<option>Category Change 組別變更</option>' +
              '<option>Bib Transfer 轉讓</option>' +
              '<option>Lost 遺失補發</option>' +
            '</select></div>' +
        '</div>' +
        '<div class="staff-acts">' +
          '<button class="btn" id="bm-change">Confirm 確認換號</button>' +
          '<button class="btn ghost" id="bm-reserve">Reserve 預留</button>' +
          '<button class="btn ghost" id="bm-assign">Assign 分配</button>' +
          '<button class="btn danger" id="bm-void">Void 作廢</button>' +
        '</div>' +

        '<h4 style="margin:1.2rem 0 .3rem;font-size:.95rem">Bib History · 歷史綁定</h4>' +
        '<p class="mut" style="margin:0 0 .5rem">換號是追加一條記錄，不是覆蓋號碼。原號在這裏永遠查得到。</p>' +
        '<div class="hist-line"><span class="hl-t">初始分配</span><span class="hl-b"><b>' + r.orig +
          '</b> · Assigned · ' + h(r.name) + '</span></div>' +
        hist.map(function (o) {
          return '<div class="hist-line"><span class="hl-t">' + h(o.at) + '</span>' +
            '<span class="hl-b"><b>' + o.from + ' → ' + o.to + '</b> · ' + h(o.reason) + ' · ' + h(o.by) + '</span></div>';
        }).join("") +

        (r.bib !== r.orig
          ? '<div class="id-note" style="background:var(--brand-tint);border-color:var(--brand);color:var(--brand-deep)">' +
            '換號已生效，去看鏈路是否跟着走：' +
            '<div class="btn-row" style="margin-top:.5rem">' +
            '<button class="btn sm" data-chain="reg">報名記錄</button>' +
            '<button class="btn sm" data-chain="result">成績</button>' +
            '<button class="btn sm" data-chain="photo">照片</button></div></div>'
          : '') +
      '</div>';

    $("bm-change").onclick = function () {
      var v = parseInt(($("bm-new").value || "").trim(), 10);
      if (!v || v < 100 || v > 99999) { toast("請輸入有效號碼布號（演示）"); return; }
      if (v === r.bib) { toast("新號和當前號一樣"); return; }
      if (roster().some(function (x) { return x.bib === v; })) { toast("號碼布 " + v + " 已被佔用（演示攔截）"); return; }
      S.bibOps.push({
        op: "change", ev: "e1", rid: r.uid, from: r.bib, to: v,
        reason: $("bm-reason").value, by: "Staff " + S.device,
        at: "2026.09.18 " + clock(10 * 3600 + S.bibOps.length * 421 % 25200)
      });
      save();
      renderBibMgmt();
      toast("已換號 " + r.bib + " → " + v + "，成績與照片鏈路同步跟着走（演示）");
    };
    $("bm-reserve").onclick = function () { todo("預留號段：正式系統裏會把號段標記爲 Reserved 並排除自動分配。當前爲前端演示。"); };
    $("bm-assign").onclick = function () { todo("手工分配：正式系統裏會從可用號段取號並寫入報名記錄。當前爲前端演示。"); };
    $("bm-void").onclick = function () {
      S.bibOps.push({ op: "void", ev: "e1", rid: r.uid, from: r.bib, to: 0,
        reason: "Void 作廢", by: "Staff " + S.device, at: "2026.09.18 11:20" });
      save(); renderBibMgmt();
      toast("號碼布 " + r.bib + " 已作廢，原號不可再用（演示）");
    };
  }

  $("bm-q").addEventListener("input", function () { renderBmResults(); });
  $("bm-find").addEventListener("click", function () { renderBmResults(); });
  $("bm-results").addEventListener("click", function (e) {
    var t = e.target.closest("[data-bm]");
    if (!t) return;
    bmSel = t.getAttribute("data-bm");
    renderBmDetail();
  });
  $("bm-exit").addEventListener("click", function () { go("staff"); });
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-chain]");
    if (!t) return;
    var r = rosterByUid(bmSel);
    if (!r) return;
    var k = t.getAttribute("data-chain");
    if (k === "reg") { go("me-races"); toast("報名記錄裏顯示的是當前號 " + r.bib + "（演示）"); }
    else if (k === "result") {
      curPerma = findBoardRowByBib(r.bib);
      go("presult");
      toast("成績頁號碼布已變成 " + r.bib + "，原號仍在變更記錄裏");
    } else {
      phEvent = "e1"; phCtx.bib = r.bib;
      if ($("ph-bib")) $("ph-bib").value = String(r.bib);
      go("photos");
      toast("用新號 " + r.bib + " 就能搜到原來掛在 " + r.orig + " 上的照片");
    }
  });

  /* ================================================================
     v5 · 成績庫首頁（賽事瀏覽 + 直接查人）
     ================================================================ */

  function renderResultsHome2() {
    if (typeof HIST === "undefined" || !HIST) return;
    var l = (typeof LANG !== "undefined" && LANG) ? LANG : "zh";
    var histTitles = {
      en: {
        "金邊濱河半程馬拉松 2026": "Riverside Half Marathon 2026",
        "湄公河夜跑 2026": "Mekong Night Run 2026",
        "金邊女子 10K 2026": "Phnom Penh Women's 10K 2026",
        "西哈努克海濱跑 2026": "Sihanoukville Beach Run 2026",
        "吳哥日出跑 2025": "Angkor Sunrise Run 2025",
        "磅湛鄉村越野 2025": "Kampong Cham Trail 2025",
        "金邊濱河半程馬拉松 2025": "Riverside Half Marathon 2025",
        "馬德望古城跑 2025": "Battambang Heritage Run 2025",
        "吳哥日出跑 2024": "Angkor Sunrise Run 2024",
        "金邊濱河半程馬拉松 2024": "Riverside Half Marathon 2024"
      },
      km: {
        "金邊濱河半程馬拉松 2026": "ការរត់ពាក់កណ្តាលម៉ារ៉ាតុង មាត់ទន្លេភ្នំពេញ ២០២៦",
        "湄公河夜跑 2026": "ការរត់ពេលយប់ មេគង្គ ២០២៦",
        "金邊女子 10K 2026": "ការរត់នារីភ្នំពេញ 10K ២០២៦",
        "西哈努克海濱跑 2026": "ការរត់តាមឆ្នេរ ក្រុងព្រះសីហនុ ២០២៦",
        "吳哥日出跑 2025": "ការរត់ព្រះអាទិត្យរះ អង្គរ ២០២៥",
        "磅湛鄉村越野 2025": "ការរត់តាមទីជនបទ កំពង់ចាម ២០២៥",
        "金邊濱河半程馬拉松 2025": "ការរត់ពាក់កណ្តាលម៉ារ៉ាតុង មាត់ទន្លេភ្នំពេញ ២០២៥",
        "馬德望古城跑 2025": "ការរត់បាត់ដំបង ២០២៥",
        "吳哥日出跑 2024": "ការរត់ព្រះអាទិត្យរះ អង្គរ ២០២៤",
        "金邊濱河半程馬拉松 2024": "ការរត់ពាក់កណ្តាលម៉ារ៉ាតុង មាត់ទន្លេភ្នំពេញ ២០២៤"
      }
    };
    if ($("rs-q")) {
      $("rs-q").placeholder = l === 'en' ? "Search race / name / Bib, e.g. 'Riverside', 'SVEN', '1001'"
        : (l === 'km' ? "ស្វែងរកការប្រកួត / ឈ្មោះ / លេខ Bib ឧ. «មាត់ទន្លេ», «SVEN», «1001»"
        : "搜索賽事 / 姓名 / 號碼布，例如「濱河」「SVEN」「1001」");
    }
    var q = ($("rs-q").value || "").trim();
    var ql = q.toLowerCase();

    /* 直接命中的人：號碼布或姓名 */
    var direct = [];
    if (ql.length >= 2) {
      HIST.forEach(function (hs) {
        hs.dists.forEach(function (d) {
          if (!published(hs.id, d)) return;
          board(hs.id, d).forEach(function (r) {
            if (direct.length >= 12) return;
            var cur = String(effBib(r.bib));
            if (cur.indexOf(ql) >= 0 || r.name.toLowerCase().indexOf(ql) >= 0) direct.push(r);
          });
        });
      });
    }
    var directTitle = l === 'en' ? 'Found ' + direct.length + ' results'
      : (l === 'km' ? 'រកឃើញ ' + direct.length + ' លទ្ធផល'
      : '找到 ' + direct.length + ' 條成績');
    var resPageBtn = l === 'en' ? 'Result Page →' : (l === 'km' ? 'ទំព័រលទ្ធផល →' : '成績頁 →');

    $("rs-direct").innerHTML = direct.length
      ? '<h4 style="margin:1.2rem 0 .6rem;font-size:1rem">' + directTitle + '</h4>' +
        direct.map(function (r) {
          var hs = histById(r.hid);
          var hName = (histTitles[l] && histTitles[l][hs.t]) || hs.t;
          return '<button class="staff-row" style="border:1px solid var(--line);margin-bottom:.4rem" data-uid="' + r.uid + '">' +
            '<span class="sr-bib">' + effBib(r.bib) + '</span>' +
            '<span class="sr-nm"><b>' + h(r.name) + '</b><br><span class="mut" style="font-size:.78rem">' +
            h(hName) + ' · ' + r.dist + ' · ' + (LANG === 'en' ? 'Net: ' : (LANG === 'km' ? 'សុទ្ធ៖ ' : '淨成績 ')) + r.net + '</span></span>' +
            '<span class="sr-st done">' + resPageBtn + '</span></button>';
        }).join("")
      : "";

    var hits = HIST.filter(function (hs) {
      var hName = (histTitles[l] && histTitles[l][hs.t]) || hs.t;
      return !q || (hs.t + " " + hs.loc + " " + hName).toLowerCase().indexOf(ql) >= 0;
    });

    if (LANG === "en") {
      $("rs-count").innerHTML = "Past Races <b>" + hits.length + "</b>" +
        (direct.length ? " · Direct hits: " + direct.length + " results" : "");
    } else if (LANG === "km") {
      $("rs-count").innerHTML = "ការប្រកួតកន្លងមក <b>" + hits.length + "</b>" +
        (direct.length ? " · ត្រូវចំផ្ទាល់៖ " + direct.length + " លទ្ធផល" : "");
    } else {
      $("rs-count").innerHTML = "歷史賽事 <b>" + hits.length + "</b> 場" +
        (direct.length ? " · 直接命中 " + direct.length + " 條成績" : "");
    }

    var box = $("rs-list");
    if (!hits.length && !direct.length) {
      box.innerHTML = LANG === 'en'
        ? '<div class="empty"><b>No results found</b>Try searching for "Riverside", "Angkor", or enter Bib 1001 / 3247.</div>'
        : (LANG === 'km'
          ? '<div class="empty"><b>រកមិនឃើញទេ</b>សូមសាកល្បងស្វែងរក «មាត់ទន្លេ», «អង្គរ» ឬបញ្ចូលលេខ Bib 1001 / 3247។</div>'
          : '<div class="empty"><b>沒有找到</b>試試搜索「濱河」「吳哥」，或直接輸號碼布 1001 / 3247。</div>');
      return;
    }
    var byYear = {};
    hits.forEach(function (hs) { (byYear[hs.y] = byYear[hs.y] || []).push(hs); });
    var browseTitle = LANG === 'en' ? 'Browse by Race' : (LANG === 'km' ? 'មើលតាមការប្រកួត' : '按賽事瀏覽');
    var boardBtn = LANG === 'en' ? 'Leaderboard →' : (LANG === 'km' ? 'តារាងលទ្ធផល →' : '榜單 →');

    box.innerHTML = '<h4 style="margin:1.4rem 0 .6rem;font-size:1rem">' + browseTitle + '</h4>' +
      Object.keys(byYear).sort().reverse().map(function (y) {
        return '<div class="yr-group"><h4>' + y + '</h4>' + byYear[y].map(function (hs) {
          var pub = published(hs.id);
          var n = hs.dists.reduce(function (a, d) {
            return a + (published(hs.id, d) ? board(hs.id, d).length : 0); }, 0);
          var hName = (histTitles[l] && histTitles[l][hs.t]) || hs.t;
          var unpubNote = LANG === 'en' ? 'Race not held yet · Results unpublished'
            : (LANG === 'km' ? 'ការប្រកួតមិនទាន់ប្រព្រឹត្តទៅទេ · មិនទាន់ចេញលទ្ធផល'
            : resultBlockNote(hs.id).title);
          var countNote = LANG === 'en' ? ' · ' + n + ' results' : (LANG === 'km' ? ' · ' + n + ' លទ្ធផល' : ' · ' + n + ' 條成績');
          
          return '<button class="staff-row" style="border:1px solid var(--line);margin-bottom:.4rem" data-hs="' + hs.id + '">' +
            '<span class="sr-nm"><b>' + h(hName) + '</b><br><span class="mut" style="font-size:.78rem">' +
            h(hs.d) + ' · ' + h(hs.loc) + ' · ' + hs.dists.join(" / ") +
            (pub ? countNote : ' · ' + unpubNote) + '</span></span>' +
            '<span class="sr-st ' + (pub ? "done" : "todo") + '">' +
            (pub ? boardBtn : unpubNote) + '</span></button>';
        }).join("") + '</div>';
      }).join("");
  }

  $("rs-q").addEventListener("input", renderResultsHome2);
  $("rs-clear").addEventListener("click", function () {
    $("rs-q").value = ""; renderResultsHome2(); toast("已清空");
  });
  $("rs-direct").addEventListener("click", function (e) {
    var t = e.target.closest("[data-uid]");
    if (!t) return;
    curPerma = rowByUid(t.getAttribute("data-uid"));
    go("presult");
  });

  /* ================================================================
     v5 · 我的跑步履歷
     ================================================================ */

  function renderMeHistory(body) {
    if (!S.account.claimed) {
      body.innerHTML = '<div class="empty"><b>還沒有認領賬號</b>' +
        '走一遍「遊客報名 → 付款 → 創建賬號」，歷史成績會按手機號自動歸入這裏。' +
        '<div class="btn-row" style="margin-top:.8rem;justify-content:center">' +
        '<button class="btn sm" data-go="detail" data-race="' + h(FE_EVENT) + '">去報名</button>' +
        '<button class="btn ghost sm" data-go="results">先逛成績庫</button></div></div>';
      return;
    }
    /* ⚖️ D-117 B7 · 履歷裏「本屆」那一條同樣受成績發佈事實管：批次被撤回
       發佈期間，它不再作爲一條<b>已發佈成績</b>出現在這裏。
       這只是<b>呈現</b>：底層成績數據一行沒刪，重新發布就又回來。
       往期賽事（h6 / h1 / h8）不受影響。 */
    var mine = [
      published("h0", "10K") ? board("h0", "10K").filter(function (r) { return r.bib === 1001; })[0] : null,
      board("h6", "21K")[7],
      board("h1", "10K")[3],
      board("h8", "10K")[5]
    ].filter(Boolean);

    var dist = {};
    mine.forEach(function (r) { dist[r.dist] = (dist[r.dist] || 0) + 1; });

    body.innerHTML =
      '<div class="card"><h4>跑步履歷<span class="demo-tag">演示數據</span></h4>' +
      '<div class="rank-big" style="margin-top:.6rem">' +
        '<div><b>' + mine.length + '</b><span>總參賽次數</span></div>' +
        '<div><b>' + mine.length + '</b><span>總完賽次數</span></div>' +
        '<div><b>' + (dist["5K"] || 0) + '</b><span>5K</span></div>' +
        '<div><b>' + (dist["10K"] || 0) + '</b><span>10K</span></div>' +
        '<div><b>' + (dist["21K"] || 0) + '</b><span>21K</span></div>' +
      '</div>' +
      '<p class="mut" style="margin-top:.8rem">這就是「三年 50 場、2 萬人次」在用戶這一側的樣子：' +
      '一個人註冊一次，之前所有比賽自動歸到同一個檔案下。</p></div>' +

      mine.map(function (r) {
        var hs = histById(r.hid);
        return '<div class="me-item"><div class="me-main">' +
          '<b>' + hs.y + ' ' + h(hs.t) + ' · ' + r.dist + '　<span class="st free">已完賽</span></b>' +
          '<div class="me-meta">淨成績 ' + r.net + ' · 號碼布 ' + effBib(r.bib) +
          ' · 總排名 ' + r.rank + '/' + r.total + '</div>' +
          '<div class="me-acts">' +
            '<button class="btn sm" data-uid="' + r.uid + '">查看成績</button>' +
            '<button class="btn ghost sm" data-cert-uid="' + r.uid + '">查看證書</button>' +
            '<button class="btn ghost sm" data-photo-uid="' + r.uid + '">查看照片</button>' +
          '</div></div></div>';
      }).join("");

    body.querySelectorAll("[data-uid]").forEach(function (b) {
      b.addEventListener("click", function () { curPerma = rowByUid(b.getAttribute("data-uid")); go("presult"); });
    });
    body.querySelectorAll("[data-cert-uid]").forEach(function (b) {
      b.addEventListener("click", function () {
        curPerma = rowByUid(b.getAttribute("data-cert-uid"));
        go("presult");
        later(function () { if ($("pr-cert")) $("pr-cert").click(); }, 60);
      });
    });
    body.querySelectorAll("[data-photo-uid]").forEach(function (b) {
      b.addEventListener("click", function () {
        var r = rowByUid(b.getAttribute("data-photo-uid"));
        var hs = histById(r.hid);
        phEvent = hs.ev || "e1"; phCtx.bib = effBib(r.bib);
        if ($("ph-bib")) $("ph-bib").value = String(effBib(r.bib));
        go("photos");
      });
    });
  }

  /* ================================================================
     v5 · FAQ / 聯繫我們 / 條款與政策
     文案取自 docs/03-網站文案.md；文檔沒有正式法律文本的部分明確標註待替換。
     ================================================================ */

  var FAQ = [
    ["報名相關", [
      ["怎麼報名？", "在賽事頁面點「立即報名」，選組別、填信息、完成支付即可。全程大約 3 分鐘。<b>不需要先註冊</b>，付款後再創建賬號也可以。"],
      ["可以幫別人報名嗎？", "可以。在第 1 步點「添加參賽者」，一筆訂單最多 5 個人，統一付款，每人一張獨立憑證和號碼布。注意緊急聯繫人不要填參賽者本人。"],
      ["報名後可以修改信息嗎？", "報名截止前可以在「我的」裏自助修改。號碼布號一旦分配後不可自助更改，需要現場找工作人員換號，換號會留記錄。"],
      ["可以轉讓給別人嗎？", "由每場賽事單獨設置是否開放。開放時需聯繫客服並提供雙方信息，賽前 14 天截止。"],
      ["柬埔寨人和外國人價格爲什麼不一樣？", "這是本地賽事的通行做法。選擇 Cambodian 價格的參賽者，需要在領取 Race Pack 時出示柬埔寨身份證件覈驗；覈驗不通過需現場補差價。"]
    ]],
    ["支付相關", [
      ["支持哪些支付方式？", "第一期只支持 <b>KHQR</b>——任何支持 KHQR 的銀行 App 都能掃。也可以聯繫我們安排銀行轉賬或現場付款。"],
      ["支付失敗了怎麼辦？", "名額會爲你保留 10 分鐘，可以重新掃碼。超時後名額釋放，需要重新報名。"],
      ["可以退款嗎？", "賽前 30 天以上全額退款（扣除支付手續費），7–30 天退 50%，7 天內不退款但可轉讓。賽事因不可抗力取消的全額退款。"],
      ["可以拿到付款收據嗎？", "可以。把賽事名稱、姓名、證件號和報名編號發給我們，我們會把收據發給你。"]
    ]],
    ["周邊商品", [
      ["周邊要在報名的時候一起買嗎？", "不用，也不能。<b>周邊商品是單獨下單、單獨付款的</b>——它和報名是兩筆獨立的訂單，報名流程裏不會出現周邊選購。買不買周邊，完全不影響報名。"],
      ["參賽包裏的 T恤和周邊商品是一回事嗎？", "不是。<b>參賽包 T恤屬於報名本身</b>，尺碼在報名第 2 步「參賽資料」裏填，隨 Race Pack 一起領。<b>周邊商品是另外買的</b>，走它自己的訂單。"],
      ["周邊尺碼怎麼選？", "採用亞洲碼，拿不準建議選大一碼。"],
      ["周邊可以單獨退嗎？", "周邊訂單和報名訂單各自獨立，<b>各自按各自的規則處理</b>，不存在「隨報名整單退」這回事。具體規則以周邊訂單頁公佈的爲準。"]
    ]],
    ["比賽當天", [
      ["怎麼領裝備包？", "在指定時間到指定地點，出示電子參賽憑證的二維碼和身份證件即可。<b>比賽當天不設領物點。</b>"],
      ["可以代領嗎？", "可以。代領人需出示參賽者的電子憑證、參賽者證件複印件、本人證件和參賽者手寫授權書。未滿 16 歲需監護人簽字。"],
      ["忘帶手機 / 二維碼打不開怎麼辦？", "到現場服務檯，報姓名和手機號，我們可以人工覈對。"],
      ["下雨會取消嗎？", "小雨照常進行。遇極端天氣我們會提前通過 Telegram 通知，並安排延期或退款。"]
    ]],
    ["成績與照片", [
      ["成績多久出來？", "計時數據由計時公司導入，一般在賽後當天發佈。號碼布上印有二維碼，掃碼就能直接打開你的成績頁。"],
      ["成績頁可以分享嗎？", "可以。每個人有一個固定的成績鏈接，不需要登錄就能打開，可以直接發給朋友。"],
      ["查不到我的成績怎麼辦？", "可能是計時芯片沒讀到，或者現場換過號碼布。把姓名和號碼布發給我們，我們可以人工覈對補錄。"],
      ["照片怎麼找？", "在「找我的照片」裏輸號碼布即可。如果現場換過號碼布，用新號也能搜到原來的照片。"]
    ]]
  ];

  function renderFaq() {
    $("faq-body").innerHTML = FAQ.map(function (g) {
      return '<h4 style="margin:1.4rem 0 .3rem">' + h(g[0]) + '</h4>' +
        g[1].map(function (qa) {
          return '<div class="qa"><button type="button">' + h(qa[0]) + '</button><div>' + qa[1] + '</div></div>';
        }).join("");
    }).join("");
  }
  $("faq-body").addEventListener("click", function (e) {
    var b = e.target.closest(".qa > button");
    if (!b) return;
    b.parentNode.classList.toggle("open");
  });

  function renderContact() {
    $("contact-body").innerHTML =
      '<h4>找我們最快的方式</h4>' +
      '<div class="kv" style="margin-top:.6rem">' +
        '<div><span>Telegram</span><b>@run_kh_demo</b></div>' +
        '<div><span>電話</span><b>+855 12 345 678</b></div>' +
        '<div><span>郵箱</span><b>hello@run-demo.kh</b></div>' +
        '<div><span>辦公時間</span><b>週一至週五 09:00–18:00</b></div>' +
      '</div>' +
      '<p class="mut" style="margin-top:.8rem">以上均爲演示佔位，不是真實聯繫方式。</p>' +
      '<h4 style="margin-top:1.4rem">常見問題先看這裏</h4>' +
      '<p class="mut">報名、退款、領物、成績、照片的常見問題都在 FAQ 裏，通常比等回覆快。</p>' +
      '<div class="btn-row" style="margin-top:.7rem">' +
        '<button class="btn sm" data-go="faq">查看常見問題</button>' +
        '<button class="btn ghost sm" id="ct-msg">給我們發消息</button>' +
      '</div>' +
      '<h4 style="margin-top:1.4rem">賽事當天</h4>' +
      '<p class="mut">現場服務檯在起終點拱門左側，全天有人。領物問題請直接到 Race Pack 服務檯。</p>';
    $("ct-msg").onclick = function () {
      todo("發送消息需要後端與客服工單系統，本輪不做。正式系統會寫入工單隊列並回執。");
    };
  }

  var POL = {
    terms: {
      t: "使用條款 · Terms of Use",
      s: "本頁爲條款要點清單，不是可直接使用的法律文本。",
      body: [
        ["參賽協議應覆蓋", ["參賽者健康狀況自我聲明與責任承擔", "未成年人蔘賽的監護人同意條款",
          "參賽者需遵守賽事規則、服從工作人員指揮", "違規行爲（替跑、抄近道、使用交通工具）的取消資格條款",
          "參賽資格不得私自轉讓的規定與官方轉讓流程"]],
        ["免責聲明應覆蓋", ["運動風險的明確告知（含心血管意外、中暑、跌倒等）", "主辦方責任範圍與免責邊界",
          "建議參賽者自行購買意外保險，說明主辦方是否提供基礎保險及保額", "個人財物遺失的責任劃分",
          "不可抗力（極端天氣、公共衛生事件、政府管制）的處理方式"]]
      ]
    },
    privacy: {
      t: "個人數據政策 · Personal Data Policy",
      s: "本頁爲政策要點清單，不是可直接使用的法律文本。",
      body: [
        ["隱私政策應覆蓋", ["收集哪些個人信息、用途、保存期限",
          "與第三方（支付渠道、計時公司、攝影團隊）共享的範圍",
          "肖像權授權：賽事照片的拍攝、存儲、展示、商業使用範圍",
          "用戶的查詢、更正、刪除權利與行使方式", "數據安全措施"]],
        ["肖像權條款要寫清楚的範圍", ["賽事記錄", "官網與社媒宣傳", "贊助商聯合宣傳",
          "向參賽者本人銷售其個人照片"]],
        ["本原型已實現的用戶側控制", ["影像授權可分別開關（現場拍攝 / 宣傳使用）",
          "照片刪除申請與處理狀態", "號碼布標記有誤的回報", "聯繫方式查看留痕"]]
      ]
    },
    security: {
      t: "安全政策 · Security Policy",
      s: "本頁爲要點說明，正式版本需與技術與法務共同確認。",
      body: [
        ["支付安全", ["不自行存儲銀行卡信息", "支付確認以服務端主動查詢爲準，不依賴跳轉結果",
          "訂單與支付一一對應，確認冪等", "每日與銀行流水逐日對賬"]],
        ["數據安全", ["身份信息與緊急聯繫人屬敏感數據，加密存儲、權限最小化",
          "所有涉及金額與名額的操作留日誌", "每日備份，備份異地存放"]],
        ["賬號安全", ["手機號 OTP 登錄", "認領歷史記錄需手機號完全一致，且每條記錄只能被認領一次",
          "認領操作留痕，不可刪除"]]
      ]
    },
    refund: {
      t: "退款政策 · Refund Policy",
      s: "DEMO POLICY / 演示規則 —— 僅供演示，不代表真實賽事最終退款政策。",
      body: [
        ["退款分檔 · DEMO POLICY / 演示規則（僅供演示，不代表真實賽事最終退款政策；真實比例、時間窗、手續費與不可抗力條款由主辦方 / 運營 / 法務確定，尚未定稿）",
          ["報名截止前 30 天以上：全額退款，扣除支付通道手續費",
          "報名截止前 7–30 天：退 50%，或免費轉讓給他人",
          "報名截止前 7 天內：不退款，可轉讓",
          "賽事因不可抗力取消：全額退款，或順延至下一場（由參賽者選擇）"]],
        ["退款政策還應覆蓋", ["支付通道手續費的承擔方", "退款到賬時間與退款方式",
          "周邊商品的退款規則（<b>周邊訂單與報名訂單相互獨立，各自處理，不隨報名整單退</b>）"]],
        ["組別變更（演示）", ["升組需補差價", "降組不退差價", "賽前 14 天截止", "每次變更收取手續費"]]
      ]
    }
  };
  var POL_TABS = [["terms", "使用條款"], ["privacy", "個人數據政策"], ["security", "安全政策"], ["refund", "退款政策"]];

  /* 四份政策各自獨立成頁、獨立路由。報名流程、FAQ、Footer、客服都要能單獨鏈接其中一份，
     後端保存協議版本時也需要一個明確對象。頁籤只是互相跳轉，不是同頁切 Tab。 */
  function renderPolicy(key) {
    var p = POL[key];
    if (!p) return;
    var sc = $("s-" + key);
    sc.querySelector("[data-pt]").textContent = p.t;
    sc.querySelector("[data-ps]").textContent = p.s;

    var tabs = sc.querySelector("[data-ptabs]");
    tabs.innerHTML = "";
    POL_TABS.forEach(function (t) {
      var b = document.createElement("button");
      b.className = "tab" + (t[0] === key ? " on" : "");
      b.textContent = t[1];
      b.setAttribute("data-go", t[0]);
      tabs.appendChild(b);
    });

    sc.querySelector("[data-pbody]").innerHTML =
      '<div class="todo-legal">⚠️ <b>待正式法務版本替換。</b>' +
      '以下內容取自 <code>docs/03-網站文案.md</code> 的「條款要點清單」，' +
      '是條款<b>應當覆蓋的範圍</b>，不是可直接使用的法律文本。' +
      '正式條款必須由柬埔寨本地律師起草或審覈，並同時提供高棉語與英語版本；' +
      '發生爭議時以高棉語版本爲準。原型不編造法律文本。</div>' +
      p.body.map(function (sec) {
        return '<h3>' + h(sec[0]) + '</h3><ul>' + sec[1].map(function (li) {
          return "<li>" + h(li) + "</li>";
        }).join("") + '</ul>';
      }).join("");
  }

  /* ================================================================
     v5 · 演示照片：給換號演示的主角補幾張照片（掛在原始號 1001 上）
     ================================================================ */

  (function seedV5Photos() {
    var spots = [["起點", "start", 0.2, "05:31"], ["3 號補給點", "aid", 3, "05:52"],
      ["獨立紀念碑機位", "course", 5.5, "06:07"], ["終點衝線", "finish", 10, "06:26"]];
    spots.forEach(function (s, i) {
      DEMO.photos.push({
        id: "pv" + (i + 1), ev: "e1", seed: 300 + i * 13, bib: 1001,
        spot: s[0], zone: s[1], km: s[2], time: s[3],
        by: ["Sopheak", "Ratha", "Dara", "Vichea"][i % 4],
        conf: [97, 93, 88, 96][i], blocked: false, unmatched: false
      });
    });
  })();

  /* ---------------- v5.1 · 移動端底部導航 ---------------- */

  var MNAV_MAP = { races: "races", detail: "races", reg1: "races", reg2: "races",
    shop: "me", shopitem: "me", moconfirm: "me", mopay: "me", modone: "me",
    moorders: "me", moorder: "me", regdetail: "me",
    reg4: "races", pay: "races", done: "races", history: "races",
    results: "results", resultev: "results", presult: "results", result: "results",
    photos: "photos", photores: "photos", photo: "photos",
    acts: "acts", freedetail: "acts", freereg: "acts", freedone: "acts",
    ugc: "acts", post: "acts", postdone: "acts",
    me: "me" };
  function syncMnav(name) {
    var cur = MNAV_MAP[name] || "";
    document.querySelectorAll("#mnav button").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-go") === cur);
    });
  }

  /* ---------------- v5.1 · 活動聚合頁 ---------------- */

  function renderActs() {
    var fw = $("acts-free");
    fw.innerHTML = "";
    publicRaces().filter(function (r) { return r.free; }).forEach(function (r, i) { fw.appendChild(raceCard(r, i)); });
    var uw = $("acts-ugc");
    uw.innerHTML = "";
    var list = ugcPublished();
    if (!list.length) {
      uw.innerHTML = '<div class="empty"><b>還沒有跑友活動</b>你可以發第一條。</div>';
    } else {
      var grid = document.createElement("div");
      grid.className = "ugc-grid";
      list.forEach(function (pp) { grid.appendChild(ugcCard(pp)); });
      uw.appendChild(grid);
    }
    requestAnimationFrame(paintAll);
  }

  /* ---------------- v5.1 · 工作人員門戶 ---------------- */

  function renderStaffPortal() {
    var sel = $("staff-ev");
    if (!sel.options.length) {
      RP_EVENTS.forEach(function (e) {
        var o = document.createElement("option"); o.value = e[0]; o.textContent = e[1]; sel.appendChild(o);
      });
    }
    $("staff-who").textContent = "Staff " + S.device + " · Device " + S.device;
    var all = roster();
    var done = all.filter(function (r) { return isCollected(r); }).length;
    var cancelled = all.filter(function (r) { return r.cancelled; }).length;
    $("staff-sub").textContent = "領物名單 " + all.length + " 人 · 已領 " + done +
      " · 未領 " + (all.length - done - cancelled) + " · 已取消 " + cancelled;
    $("staff-phase").textContent = "當前賽事階段：" + phaseLabel() +
      (packOpen() ? " · 領物工作臺可用" : " · 領物尚未開始（報名仍在進行）");
  }

  /* ================================================================
     v5 · 初始化
     ================================================================ */

  /* ================================================================
     D-092 · Backend-Compatible Business Semantics（用戶端）
     ----------------------------------------------------------------
     這一段做三件事：

       1. 付費報名的「我的賽事」改爲渲染<b>共享 Mock 業務域</b>裏的訂單 ——
          用戶看到的 Order / Participant / Registration / Refund / Bib
          與運營後臺是<b>同一個對象</b>；
       2. 移除付費報名的「取消報名 → 直接取消並釋放名額」這個 Magic UI，
          換成<b>退款信息 + 聯繫客服 / 申請退款協助</b>。
          ⚠️ 用戶<b>不能</b>自助創建 Refund —— 一期仍是人工退款：
          Refund 只能由 SUPPORT / FINANCE 在後臺創建；
       3. 獨立的周邊商品用戶端（列表 → 詳情 → 下單 → 獨立 KHQR →
          我的周邊訂單），<b>絕不回到報名流程裏做混合結賬</b>。

     ⚠️ 全部爲 Demo：沒有後端、沒有數據庫、沒有真實支付。
     ================================================================ */

  /* RD / MY_UID 在文件頂部就綁好（見「共享 Mock 業務域」一節）——
     名額計算在模塊頂層就會跑，晚於那裏賦值會拿到 undefined。 */

  var curRegOp = null;      /* 報名詳情：當前 OrderParticipant id */
  var curProd  = null;      /* 周邊商品詳情：當前 Product id */
  var curMO    = null;      /* 當前周邊訂單 id */
  var moSel    = { skuId: null, qty: 1 };

  function rdActor() { return { who: "user:" + MY_UID, role: "USER" }; }

  /* ⚖️ D-111 根 C · 周邊訂單在待付款期間是<b>真的佔着庫存</b>的。
     ----------------------------------------------------------------
     用戶重開「我的周邊訂單」時，不能看到一張早該過期的單還顯示成待付款、
     庫存還被它佔着，只因爲沒人點過「模擬付款超時」。
     所以在切屏 / 跨端同步 / 截止時刻到點這三處都對一次賬 ——
     釋放邏輯一行沒抄，全部由共享域的 expireMerchOrder() 負責 exactly-once。
     ⚠️ 定時器只是觸發器：過沒過期永遠看當前時間與訂單自己的截止時刻，
     回調遲到只會讓結算晚發生，絕不把付款窗口往後順延。 */
  var merchDeadlineTimer = null;
  function reconcileMerchDeadlines() {
    var settled = RD.reconcileExpiredMerchOrders(rdActor());
    if (settled.length) RD.save();
    return settled;
  }
  function scheduleMerchDeadlineSweep() {
    if (merchDeadlineTimer) { clearTimeout(merchDeadlineTimer); merchDeadlineTimer = null; }
    var next = RD.nextMerchDeadlineAt();
    if (next === null) return;
    merchDeadlineTimer = setTimeout(onMerchDeadlineDue, Math.max(0, next - Date.now() + 250));
  }
  function onMerchDeadlineDue() {
    merchDeadlineTimer = null;
    var settled = reconcileMerchDeadlines();
    if (settled.length) {
      var cur = (document.querySelector(".screen.on") || {}).id || "";
      cur = cur.slice(2) || "home";
      toast("周邊訂單付款窗口已到期：預留庫存已釋放（演示）");
      go(cur);
    }
    scheduleMerchDeadlineSweep();
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) onMerchDeadlineDue();
  });
  window.addEventListener("focus", function () { onMerchDeadlineDue(); });

  /* 後臺改了同一份狀態時，用戶端要能看見 —— 否則又是兩個 Mock 宇宙。 */
  RD.watch(function () {
    reconcileMerchDeadlines();
    scheduleMerchDeadlineSweep();
    var cur = (document.querySelector(".screen.on") || {}).id || "";
    cur = cur.slice(2) || "home";
    toast("業務狀態已更新（運營後臺剛剛處理了你的一條記錄）");
    go(cur);
  });

  /* ---------------- 報名側：用戶可見狀態 ---------------- */

  /* 用戶看到的是中文結果，不是內部枚舉；但兩邊說的必須是同一件事。 */
  function regUserState(o, p) {
    var open = RD.openRefundOf(p.id);
    if (open && open.status === "REQUESTED") {
      return { label: "退款審覈中", cls: "warn",
        note: "退款申請已登記，<b>錢一分沒動</b>；報名仍然有效、名額仍然佔用、號碼布不變，但<b>參賽包暫停發放</b>。" };
    }
    if (open && open.status === "APPROVED") {
      return { label: "退款已批准，等待退款", cls: "warn",
        note: "已批准退款金額，<b>錢還沒有打出去</b>。報名此刻仍然有效、名額仍然佔用；" +
              "打款完成之後纔會取消報名並釋放名額。" };
    }
    var settled = RD.settledRefundsOf(p.id);
    if (settled.length && p.regStatus === "CANCELLED" && p.cancelReason === "REFUND_SETTLED") {
      return { label: "退款完成", cls: "bad",
        note: "退款已實際打出。<b>參賽資格已取消</b>，參賽憑證失效，名額已釋放一次。" };
    }
    if (p.regStatus === "CANCELLED") {
      return { label: "已取消", cls: "bad",
        note: "該報名已取消（原因：" + h(p.cancelReason || "—") + "）。" };
    }
    if (p.regStatus === "PENDING") {
      return { label: "待付款", cls: "warn", note: "訂單尚未付款，報名還沒有生效。" };
    }
    var closed = RD.refundsOf(p.id).filter(function (r) {
      return r.status === "REJECTED" || r.status === "WITHDRAWN";
    });
    if (closed.length) {
      var last = closed[closed.length - 1];
      return { label: "已確認", cls: "ok",
        note: "最近一次退款申請" + (last.status === "WITHDRAWN" ? "已撤回" : "未通過") +
              "（" + h(last.rejectReason || last.reason || "—") + "）。" +
              "<b>參賽資格從頭到尾沒有被取消過</b>；參賽包需要重新走一次領物資格校驗後才放行。" };
    }
    return { label: "已確認", cls: "ok", note: "" };
  }

  function domainEventTitle(adminEvId) {
    var fe = RD.feEventId(adminEvId);
    var ev = fe ? evById(fe) : null;
    return ev ? ev.t : adminEvId;
  }

  /* ---------------- 我的賽事：共享域訂單卡 ---------------- */

  function domainOrderCard(o) {
    var d = document.createElement("div");
    d.className = "me-item";
    var alive = o.participants.filter(function (p) { return p.regStatus === "CONFIRMED"; }).length;
    d.innerHTML =
      '<div class="me-main">' +
        '<b>' + h(domainEventTitle(o.eventId)) + '　<span class="st ' + (alive ? "ok" : "bad") + '">' +
          (alive ? "報名有效" : "已全部取消") + '</span> <span class="st free">與後臺同一份數據</span></b>' +
        '<div class="me-meta">訂單 ' + h(o.id) + ' · ' + o.participants.length + ' 名參賽者（有效 ' + alive + '）· ' +
          money(o.amount) + ' · 下單 ' + h(o.paidAt || o.createdAt || "—") + '</div>' +
        '<div class="ord-parts"></div>' +
        '<div class="me-acts"></div>' +
      '</div>';
    var box = d.querySelector(".ord-parts");
    o.participants.forEach(function (p) { box.appendChild(domainPartRow(o, p)); });
    var acts = d.querySelector(".me-acts");
    var note = document.createElement("span");
    note.className = "mut";
    note.style.fontSize = ".78rem";
    note.innerHTML = "付費報名<b>沒有「一鍵取消」</b>：一期是人工退款，退款申請只能由客服或財務在後臺創建。" +
      "需要退款請在「報名詳情」裏聯繫客服。";
    acts.appendChild(note);
    return d;
  }

  function domainPartRow(o, p) {
    var st = regUserState(o, p);
    var bib = RD.currentBib(p.regId) || p.bib;
    var row = document.createElement("div");
    row.className = "ord-part" + (st.cls === "bad" ? " off" : "");
    row.innerHTML =
      '<div class="op-main">' +
        '<b>' + h(RD.holderOf(p)) + (RD.transferred(p) ? ' <span class="st warn">已轉讓</span>' : '') + '</b>' +
        '<span>' + h(p.catName || p.cat) + ' · Bib ' + (bib ? '<code>' + h(bib) + '</code>' : '未分配') +
        ' · 尺碼 ' + h(p.reg.size) + ' · ' + money(p.paid) + '</span>' +
      '</div>' +
      '<span class="op-st ' + (st.cls === "ok" ? "ok" : "bad") + '">' + h(st.label) + '</span>' +
      '<div class="op-acts"></div>';
    var acts = row.querySelector(".op-acts");
    acts.appendChild(mkBtn(LANG === "en" ? "Registration Details" : (LANG === "km" ? "ព័ត៌មានលម្អិត" : "報名詳情"), function () { curRegOp = p.id; go("regdetail"); }));
    return row;
  }

  /* ---------------- 報名詳情 ---------------- */

  function renderRegDetail() {
    var f = RD.findOP(curRegOp);
    var body = $("rgd-body");
    if (!f) { body.innerHTML = '<div class="empty"><b>找不到這條報名</b>請返回「我的賽事」。</div>'; return; }
    var o = f.o, p = f.p, r = p.reg;
    var st = regUserState(o, p);
    var bib = RD.currentBib(p.regId) || p.bib;
    var open = RD.openRefundOf(p.id);
    var sr = RD.openSupportRequest(p.id);
    $("rgd-sub").innerHTML = h(domainEventTitle(o.eventId)) + " · 訂單 " + h(o.id) + " · " + h(p.regId);

    var html = "";

    /* 當前狀態 */
    html += '<div class="card"><h4>當前狀態 <span class="st ' + (st.cls === "ok" ? "ok" : "warn") + '">' +
      h(st.label) + '</span></h4>' + (st.note ? '<p class="mut">' + st.note + '</p>' : '') + '</div>';

    /* 參賽憑證 */
    if (p.regStatus === "CONFIRMED") {
      html += '<div class="card"><h4>參賽憑證</h4>' +
        '<div class="pass-qr" style="max-width:8rem"><canvas data-art="qr-bib-' + (parseInt(bib, 10) || 0) + '"></canvas></div>' +
        '<p style="margin:.6rem 0 0"><b>' + h(RD.holderOf(p)) + '</b> · Bib <code>' + h(bib || "未分配") + '</code> · ' +
        h(p.catName || p.cat) + '</p>' +
        (open ? '<p class="mut" style="color:var(--stop)">存在進行中的退款，<b>參賽包暫停發放</b>。</p>' : '') +
        '</div>';
    }

    /* 財務快照（只讀） */
    html += '<div class="card"><h4>報名時財務快照 <span class="st warn">不可編輯</span></h4>' +
      '<p class="mut">對賬、退款、票據認的是這一份。它在下單那一刻就凍結了，之後不會因爲改資料而變。</p>' +
      '<table class="tbl">' +
      '<tr><td>報名時姓名</td><td><b>' + h(p.name) + '</b></td></tr>' +
      '<tr><td>報名組別</td><td>' + h(p.catName || p.cat) + '</td></tr>' +
      '<tr><td>身份 / 價格檔</td><td>' + h(p.audience || "ALL") + '</td></tr>' +
      '<tr><td>已付金額</td><td>' + money(p.paid) + ' ' + h(o.currency) + '</td></tr>' +
      '<tr><td>訂單付款時間</td><td>' + h(o.paidAt || "未付款") + '</td></tr>' +
      '</table></div>';

    /* 當前參賽資料 */
    html += '<div class="card"><h4>當前參賽資料</h4>' +
      '<p class="mut">這是<b>這一場比賽</b>的資料，不是你的個人檔案。需要更正請聯繫客服，' +
      '客服在後臺修改後會留下改動前後的記錄。</p>' +
      '<table class="tbl">' +
      '<tr><td>當前持有人</td><td><b>' + h(r.holder) + '</b>' +
        (RD.transferred(p) ? ' <span class="st warn">已轉讓</span>' : '') + '</td></tr>' +
      '<tr><td>聯繫電話</td><td>' + h(r.phone) + '</td></tr>' +
      '<tr><td>出生日期</td><td>' + h(r.dob) + '</td></tr>' +
      '<tr><td>性別</td><td>' + h(r.gender) + '</td></tr>' +
      '<tr><td>國籍</td><td>' + h(r.nation) + '</td></tr>' +
      '<tr><td>參賽包 T 恤尺碼</td><td>' + h(r.size) + '</td></tr>' +
      '<tr><td>當前號碼布</td><td>' + (bib ? '<code>' + h(bib) + '</code>' : '未分配') + '</td></tr>' +
      '</table>';
    if (r.transfers.length) {
      html += '<p class="mut" style="margin-top:.8rem"><b>轉讓記錄</b>（原持有人會被永久保留）</p><table class="tbl">';
      r.transfers.forEach(function (t) {
        html += '<tr><td>' + h(t.at) + '</td><td>' + h(t.from) + ' → <b>' + h(t.to) + '</b>' +
          '<br><span class="mut">轉讓時號碼布 ' + h(t.bibAt || "—") + ' · ' + h(t.reason) + '</span></td></tr>';
      });
      html += '</table>';
    }
    if (r.edits.length) {
      html += '<p class="mut" style="margin-top:.8rem"><b>資料變更記錄</b></p><table class="tbl">';
      r.edits.slice().reverse().slice(0, 8).forEach(function (e) {
        html += '<tr><td>' + h(e.at) + '</td><td>' + h(e.field) + '：' + h(e.before) + ' → <b>' + h(e.after) + '</b>' +
          '<br><span class="mut">' + h(e.reason) + '</span></td></tr>';
      });
      html += '</table>';
    }
    html += '</div>';

    /* 退款信息 */
    var rfs = RD.refundsOf(p.id);
    html += '<div class="card"><h4>退款信息</h4>';
    if (!rfs.length) html += '<p class="mut">這條報名目前沒有任何退款記錄。</p>';
    else {
      html += '<table class="tbl">';
      rfs.forEach(function (x) {
        var lbl = { REQUESTED: "退款審覈中", APPROVED: "退款已批准，等待退款", SETTLED: "退款完成",
                    REJECTED: "退款申請未通過", WITHDRAWN: "退款申請已撤回" }[x.status] || x.status;
        html += '<tr><td>' + h(x.id) + '</td><td><b>' + h(lbl) + '</b> · ' + money(x.amount) +
          '<br><span class="mut">' + h(x.reason || "") +
          (x.rejectReason ? ' · ' + h(x.rejectReason) : '') + '</span></td></tr>';
      });
      html += '</table>';
    }
    html += '<div class="empty" style="text-align:left;margin:.9rem 0 0">' +
      '<b>DEMO POLICY / 演示規則</b>' +
      '僅供演示，不代表真實賽事最終退款政策。<br>' +
      '真實的退款比例、時間窗、手續費承擔方與不可抗力條款，由主辦方 / 運營 / 法務確定，目前<b>尚未定稿</b>；' +
      '本原型不編造這些商業規則。<br>' +
      '一期<b>不做用戶自助退款</b>：退款申請由客服或財務在後臺登記，之後由財務審批、線下打款、結算。' +
      '</div></div>';

    /* 聯繫客服 / 申請退款協助 */
    html += '<div class="card"><h4>需要退款或修改資料？</h4>';
    if (p.regStatus !== "CONFIRMED") {
      html += '<p class="mut">這條報名已經不是有效參賽資格，不需要再申請退款。</p>';
    } else if (open) {
      html += '<p class="mut">你已經有一條<b>進行中的退款</b>（' + h(open.id) + '），請等待財務處理，不需要重複提交。</p>';
    } else if (sr) {
      html += '<div class="empty" style="text-align:left"><b>協助請求已提交（' + h(sr.id) + '）</b>' +
        '提交時間 ' + h(sr.at) + '<br>訴求：' + h(sr.reason) + '<br>' +
        '客服會在後臺受理。<b>這不是退款單</b>：你的報名狀態、名額、號碼布、領物資格現在<b>一個都沒有變</b>。</div>';
    } else {
      html += '<p class="mut">一期是<b>人工退款</b>：你在這裏提交的是<b>退款協助請求</b>，' +
        '它<b>不是</b>退款單，也不會自動取消你的報名。客服受理後由財務決定是否退款。</p>' +
        '<div class="fld"><label>訴求說明（必填）</label>' +
        '<textarea id="rd-reason" style="min-height:4.5rem" placeholder="例：受傷無法參賽，希望申請退款"></textarea></div>' +
        '<div class="fld"><label>聯繫方式</label>' +
        '<input type="text" id="rd-contact" value="' + h(r.phone) + '"></div>' +
        '<div class="btn-row" style="margin-top:.8rem">' +
        '<button class="btn" id="rd-submit">提交退款協助請求</button>' +
        '<button class="btn ghost" data-go="contact">聯繫客服</button></div>';
    }
    html += '</div>';

    body.innerHTML = html;
    var sub = $("rd-submit");
    if (sub) {
      sub.addEventListener("click", function () {
        var why = ($("rd-reason") && $("rd-reason").value.trim()) || "";
        if (!why) { toast("請填寫訴求說明"); return; }
        var res = RD.supportRequestCreate(curRegOp, rdActor(), why,
          ($("rd-contact") && $("rd-contact").value.trim()) || r.phone);
        if (!res.ok) { toast(res.msg); return; }
        RD.save();
        toast("已提交退款協助請求，客服會在後臺受理");
        renderRegDetail();
      });
    }
    requestAnimationFrame(paintAll);
  }

  /* ================================================================
     周邊商品（獨立訂單域 · D-048）
     ================================================================ */

  function moUserState(o) {
    var rf = RD.merchRefundOf(o.id);
    if (rf && rf.status === "REQUESTED") return { label: "退款審覈中", cls: "warn" };
    if (rf && rf.status === "APPROVED")  return { label: "退款已批准，等待退款", cls: "warn" };
    if (rf && rf.status === "SETTLED")   return { label: "退款完成", cls: "bad" };
    if (o.status === "PENDING_PAYMENT")  return { label: "待付款", cls: "warn" };
    if (o.status === "CANCELLED")        return { label: "已取消", cls: "bad" };
    if (o.status === "EXPIRED")          return { label: "訂單已過期", cls: "bad" };
    if (o.status === "PAID" && o.fulfillment === "PENDING_HANDOFF") return { label: "支付成功 · 待領取", cls: "warn" };
    if (o.status === "PAID" && o.fulfillment === "FULFILLED") return { label: "已領取", cls: "ok" };
    return { label: o.status, cls: "" };
  }

  function renderShop() {
    if (typeof RD === "undefined" || !RD || typeof RD.products !== "function") return;
    var l = (typeof LANG !== "undefined" && LANG) ? LANG : "zh";
    var prodNames = {
      en: {
        "RUN 2026 賽事紀念 T 恤": "RUN 2026 Commemorative T-Shirt",
        "RUN 輕量運動腰包": "RUN Lightweight Running Belt",
        "RUN 限量獎牌掛架": "RUN Limited Edition Medal Hanger"
      },
      km: {
        "RUN 2026 賽事紀念 T 恤": "អាវយឺតអនុស្សាវរីយ៍ RUN 2026",
        "RUN 輕量運動腰包": "កាបូបចង្កេះរត់ RUN",
        "RUN 限量獎牌掛架": "កន្លែងព្យួរមេដាយ RUN"
      }
    };
    var body = $("shop-body");
    var list = RD.products().filter(function (p) { return p.status !== "DRAFT"; });
    var noticeTitle = l === 'en' ? 'Merchandise and race registration are separate orders'
      : (l === 'km' ? 'ទំនិញ និងការចុះឈ្មោះជាការបញ្ជាទិញដាច់ដោយឡែក'
      : '周邊和報名是兩筆獨立的訂單');
    var noticeDesc = l === 'en' ? 'Merchandise is not part of registration and gives no entry quota. Separate orders, payments, and refunds.'
      : (l === 'km' ? 'ការទិញទំនិញមិនស្ថិតក្នុងដំណើរការចុះឈ្មោះទេ និងមិនផ្តល់កន្លែងប្រកួតឡើយ។ បញ្ជាទិញ បង់ប្រាក់ និងសងប្រាក់ដោយឡែកពីគ្នា។'
      : '報名流程裏不會出現周邊選購，周邊訂單也不會給你任何參賽資格。兩邊各自下單、各自付款、各自退款。');
    var myOrdersBtn = l === 'en' ? 'My Merchandise Orders →'
      : (l === 'km' ? 'ការបញ្ជាទិញទំនិញរបស់ខ្ញុំ →'
      : '我的周邊訂單 →');

    var html = '<div class="empty" style="text-align:left;margin-bottom:1.1rem">' +
      '<b>' + noticeTitle + '</b>' + noticeDesc + '</div>';
    html += '<div class="btn-row" style="margin-bottom:1rem"><button class="btn ghost sm" data-go="moorders">' + myOrdersBtn + '</button></div>';
    html += '<div class="pgrid">';
    list.forEach(function (p) {
      var soldOut = RD.productSoldOut(p);
      var off = p.status !== "ON_SALE";
      var prices = p.skus.map(function (s) { return s.price; });
      var from = Math.min.apply(null, prices);
      var pName = (prodNames[l] && prodNames[l][p.name]) || p.name;
      
      var offTag = LANG === 'en' ? 'Discontinued' : (LANG === 'km' ? 'ឈប់លក់' : '已下架');
      var soldTag = LANG === 'en' ? 'Sold Out' : (LANG === 'km' ? 'អស់ពីស្តុក' : '售罄');
      var offMeta = LANG === 'en' ? 'Unavailable' : (LANG === 'km' ? 'មិនអាចទិញបាន' : '暫不可購買');
      var soldMeta = LANG === 'en' ? 'Sold Out · Unavailable' : (LANG === 'km' ? 'អស់ពីស្តុក · មិនអាចទិញបាន' : '售罄 · 暫不可購買');
      var priceMeta = LANG === 'en' ? 'From $' + from + ' · ' + p.skus.length + ' Variants'
        : (LANG === 'km' ? 'ចាប់ពី $' + from + ' · ' + p.skus.length + ' ជម្រើស'
        : '$' + from + ' 起 · ' + p.skus.length + ' 個規格');

      html += '<button class="pcard" data-prod="' + p.id + '">' +
        '<div class="pcard-img"><canvas data-art="prod-' + p.seed + '"></canvas>' +
        (off ? '<span class="pflag">' + offTag + '</span>' : (soldOut ? '<span class="pflag">' + soldTag + '</span>' : '')) + '</div>' +
        '<div class="pcard-body"><b style="font-size:.9rem">' + h(pName) + '</b>' +
        '<span class="meta">' + (off ? offMeta : (soldOut ? soldMeta : priceMeta)) + '</span>' +
        '</div></button>';
    });
    html += '</div>';
    body.innerHTML = html;
    body.querySelectorAll("[data-prod]").forEach(function (b) {
      b.addEventListener("click", function () { curProd = b.getAttribute("data-prod"); go("shopitem"); });
    });
    requestAnimationFrame(paintAll);
  }

  function renderShopItem() {
    var body = $("shopitem-body");
    var p = RD.productById(curProd);
    if (!p) { body.innerHTML = '<div class="empty"><b>商品不存在</b></div>'; return; }
    var off = p.status !== "ON_SALE";
    if (!moSel.skuId || !p.skus.some(function (s) { return s.id === moSel.skuId; })) {
      var first = p.skus.filter(function (s) { return RD.skuSaleable(p, s).ok; })[0] || p.skus[0];
      moSel = { skuId: first.id, qty: 1 };
    }
    var html = '<h2 class="pg">' + h(p.name) + '</h2>' +
      '<p class="pg-sub">' + h(p.desc) + '</p>' +
      '<div class="card"><div class="merch-thumb" style="width:11rem;height:11rem;border-radius:var(--r)"><canvas data-art="prod-' + p.seed + '"></canvas></div>';
    if (off) {
      html += '<div class="empty" style="text-align:left;margin-top:1rem"><b>該商品當前已下架</b>' +
        '下架只阻斷新訂單；如果你已經有一張未付款的訂單，它<b>仍然可以正常付款完成</b>。</div>';
    }
    html += '<h4 style="margin-top:1.1rem">選擇規格</h4>';
    p.skus.forEach(function (s) {
      var sale = RD.skuSaleable(p, s);
      var av = RD.available(s);
      html += '<button type="button" class="opt' + (moSel.skuId === s.id ? " sel" : "") + '"' +
        (sale.ok ? "" : " disabled") + ' data-sku="' + s.id + '">' +
        '<span class="opt-radio"></span>' +
        '<span class="opt-main"><b>' + h(s.variant) + ' / ' + h(s.size) + '</b>' +
        '<span>' + (sale.ok ? ('可購 ' + av + ' 件（available = on_hand − reserved）') : ('不可購買 · ' + h(sale.why))) + '</span></span>' +
        '<span class="opt-price">$' + s.price + '</span></button>';
    });
    var cur = RD.skuById(moSel.skuId);
    var curOk = cur ? RD.skuSaleable(p, cur.sku).ok : false;
    var maxQty = cur ? RD.available(cur.sku) : 0;
    html += '<div class="fld" style="margin-top:1.1rem"><label>數量</label>' +
      '<input type="number" id="mo-qty" style="max-width:8rem" min="1" max="' + Math.max(1, maxQty) + '" value="' + moSel.qty + '"></div>' +
      '<div class="btn-row" style="margin-top:1.1rem">' +
      '<button class="btn' + (curOk ? "" : " ghost") + '" id="mo-buy"' + (curOk ? "" : " disabled") + '>立即下單</button>' +
      '<button class="btn ghost" data-go="shop">再看看</button></div>' +
      '<p class="mut" style="margin-top:.8rem;font-size:.8rem">下單會<b>立即爲你佔用庫存</b>（reserved），但<b>不會</b>扣減實際庫存；' +
      '付款成功才真正出庫。超時未付款會自動釋放，且<b>只釋放一次</b>。</p>' +
      '</div>';
    body.innerHTML = html;

    body.querySelectorAll("[data-sku]").forEach(function (el) {
      el.addEventListener("click", function () {
        moSel = { skuId: el.getAttribute("data-sku"), qty: 1 };
        renderShopItem();
      });
    });
    var q = $("mo-qty");
    if (q) q.addEventListener("change", function () { moSel.qty = Math.max(1, parseInt(this.value, 10) || 1); });
    var buy = $("mo-buy");
    if (buy) buy.addEventListener("click", function () {
      var btn = this;
      withLock("mo-buy", btn, "下單中…", function () {
        var res = RD.createMerchOrder({
          eventId: p.eventId, buyer: DEMO.user.name, buyerUserId: MY_UID, phone: DEMO.user.phone,
          items: [{ skuId: moSel.skuId, qty: moSel.qty }], actor: rdActor(), source: "USER"
        });
        if (!res.ok) { toast(res.msg); renderShopItem(); return; }
        RD.save();
        curMO = res.order.id;
        go("moconfirm");
      });
    });
    requestAnimationFrame(paintAll);
  }

  function moLines(o) {
    return o.items.map(function (it) {
      return '<tr><td>' + h(it.productName) + '<br><span class="mut">' + h(it.variant) + ' / ' + h(it.size) +
        ' · 下單時價格 $' + it.unitPrice + '</span></td><td style="text-align:right">×' + it.qty +
        '<br><b>' + money(it.amount) + '</b></td></tr>';
    }).join("");
  }

  function renderMoConfirm() {
    var o = RD.merchOrderById(curMO);
    var body = $("moc-body");
    if (!o) { body.innerHTML = '<div class="empty"><b>訂單不存在</b></div>'; return; }
    $("moc-sub").innerHTML = "訂單 " + h(o.id) + " · 這張單與你的報名訂單<b>完全獨立</b>";
    var html = '<div class="card"><h4>訂單內容（下單即凍結）</h4><table class="tbl">' + moLines(o) +
      '<tr><td><b>合計</b></td><td style="text-align:right"><b>' + money(o.amount) + '</b></td></tr></table>' +
      '<p class="mut" style="margin-top:.7rem">上面這些價格和規格在<b>下單那一刻</b>就凍結了。' +
      '之後運營改價、改名、換圖、下架，<b>都不會改動這張單</b>。</p>' +
      '<p class="mut">付款截止：<b>' + h(o.deadline) + '</b>。超時會自動取消並釋放庫存佔用。</p></div>';
    html += '<div class="btn-row"><button class="btn" data-go="mopay">去支付</button>' +
      '<button class="btn ghost" id="moc-cancel">取消訂單</button></div>';
    body.innerHTML = html;
    $("moc-cancel").addEventListener("click", function () {
      var btn = this;
      withLock("moc-cancel", btn, "取消中…", function () {
        var res = RD.cancelMerchOrder(o.id, rdActor(), null, "USER");
        if (!res.ok) {
          /* ⚖️ D-115 · 取消沒做成，但域可能已經如實把這張單結算成過期了。
             那是<b>真的業務變更</b>，必須落盤——否則刷新一下它又變回待付款，
             庫存也重新被佔着，用戶和後臺看到兩份事實。 */
          if (res.mutated) RD.save();
          toast(res.expired
            ? "訂單已經過期，庫存佔用已釋放（不是被取消：這一單是過期了，也不產生退款）"
            : res.msg);
          if (res.expired) go("moorder"); else renderMoConfirm();
          return;
        }
        RD.save();
        toast("訂單已取消，庫存佔用已釋放（不產生退款：錢從來沒到過）");
        go("moorders");
      });
    });
  }

  var moPayTimer = null;
  function renderMoPay() {
    var o = RD.merchOrderById(curMO);
    if (!o) { go("shop"); return; }
    $("mop-amt").textContent = money(o.amount);
    $("mop-sub").innerHTML = "周邊訂單 <b>" + h(o.id) + "</b> · 與報名訂單相互獨立";
    $("mop-deadline").textContent = "付款截止 " + o.deadline;
    if (o.status !== "PENDING_PAYMENT") { toast("這張訂單當前是「" + moUserState(o).label + "」，不能再支付"); go("moorder"); }
  }

  function renderMoDone() {
    var o = RD.merchOrderById(curMO);
    var body = $("mod-body");
    if (!o) { body.innerHTML = ""; return; }
    var st = moUserState(o);
    $("mod-title").textContent = st.label;
    $("mod-sub").innerHTML = "訂單 <b>" + h(o.id) + "</b> · " + money(o.amount);
    body.innerHTML = '<div class="card" style="text-align:left"><table class="tbl">' + moLines(o) + '</table>' +
      '<p class="mut" style="margin-top:.7rem"><b>「待領取」不是「已完成」。</b>' +
      '錢收到了、庫存也扣了，但貨還沒有交到你手上。到現場領取後，工作人員會在後臺確認交付，' +
      '這裏纔會變成「已領取」。</p>' +
      '<p class="mut"><b>周邊領取和參賽包領物是兩件事</b>：領了參賽包不代表領了周邊，反過來也一樣。</p></div>';
  }

  function moCard(o) {
    var st = moUserState(o);
    var d = document.createElement("div");
    d.className = "me-item";
    d.innerHTML = '<div class="me-main"><b>' + h(o.items[0].productName) +
      (o.items.length > 1 ? " 等 " + o.items.length + " 項" : "") +
      '　<span class="st ' + (st.cls === "ok" ? "ok" : (st.cls === "bad" ? "bad" : "warn")) + '">' + h(st.label) + '</span></b>' +
      '<div class="me-meta">訂單 ' + h(o.id) + ' · ' + money(o.amount) + ' · ' + h(o.createdAt) + '</div>' +
      '<div class="me-acts"></div></div>';
    var acts = d.querySelector(".me-acts");
    acts.appendChild(mkBtn("訂單詳情", function () { curMO = o.id; go("moorder"); }));
    if (o.status === "PENDING_PAYMENT") {
      acts.appendChild(mkBtn("去支付", function () { curMO = o.id; go("mopay"); }));
    }
    return d;
  }

  function renderMoOrders() {
    var body = $("moorders-body");
    var list = RD.myMerchOrders(MY_UID);
    if (!list.length) {
      body.innerHTML = '<div class="empty"><b>還沒有周邊訂單</b>去 RUN 周邊看看。' +
        '<div style="margin-top:.9rem"><button class="btn sm" data-go="shop">去看周邊</button></div></div>';
      return;
    }
    body.innerHTML = "";
    list.forEach(function (o) { body.appendChild(moCard(o)); });
  }

  function renderMoOrder() {
    var o = RD.merchOrderById(curMO);
    var body = $("moo-body");
    if (!o) { body.innerHTML = '<div class="empty"><b>訂單不存在</b></div>'; return; }
    var st = moUserState(o);
    var rf = RD.merchRefundOf(o.id);
    $("moo-sub").innerHTML = "訂單 " + h(o.id) + " · 與運營後臺看到的是<b>同一張單</b>";
    var html = '<div class="card"><h4>當前狀態 <span class="st ' +
      (st.cls === "ok" ? "ok" : (st.cls === "bad" ? "bad" : "warn")) + '">' + h(st.label) + '</span></h4>' +
      '<table class="tbl">' + moLines(o) +
      '<tr><td><b>合計</b></td><td style="text-align:right"><b>' + money(o.amount) + '</b></td></tr></table>';
    if (o.paidAt) html += '<p class="mut">付款時間 ' + h(o.paidAt) + '</p>';
    if (o.status === "PENDING_PAYMENT") html += '<p class="mut">付款截止 <b>' + h(o.deadline) + '</b></p>';
    if (o.status === "EXPIRED") {
      html += '<div class="empty" style="text-align:left;margin-top:.9rem"><b>訂單已過期</b>' +
        '庫存佔用已經釋放。<b>過期訂單不會因爲事後到賬而自動恢復</b>——那件貨可能已經賣給別人了。' +
        '如果你確實已經付了款，請聯繫客服，錢會通過周邊訂單自己的財務流程退回。</div>';
    }
    html += '</div>';

    html += '<div class="card"><h4>領取狀態</h4>';
    if (o.status !== "PAID") html += '<p class="mut">尚未支付成功，沒有領取安排。</p>';
    else if (o.fulfillment === "PENDING_HANDOFF") {
      html += '<p class="mut"><b>待領取。</b>到現場周邊發放臺出示本訂單，工作人員覈對後會在後臺確認交付。</p>';
    } else if (o.handoff) {
      html += '<p class="mut"><b>已領取。</b>' + h(o.handoff.at) + ' · ' + h(o.handoff.location) +
        '<br>收貨確認：' + h(o.handoff.recipient) + '</p>';
    }
    html += '<p class="mut" style="font-size:.8rem"><b>周邊領取與參賽包領物互不影響</b>：一邊完成不會讓另一邊自動完成。</p></div>';

    if (rf) {
      var lbl = { REQUESTED: "退款審覈中", APPROVED: "退款已批准，等待退款", SETTLED: "退款完成",
                  REJECTED: "退款申請未通過", WITHDRAWN: "退款申請已撤回" }[rf.status] || rf.status;
      html += '<div class="card"><h4>退款 <span class="st warn">' + h(lbl) + '</span></h4>' +
        '<p class="mut">' + h(rf.reason || "") + (rf.rejectReason ? ' · ' + h(rf.rejectReason) : '') + '</p>' +
        (rf.status === "SETTLED"
          ? '<p class="mut">退款金額 ' + money(rf.settledAmount != null ? rf.settledAmount : rf.amount) +
            ' 已打回。<b>退錢和退貨是兩件事</b>：' +
            '實物要不要退、怎麼退，由客服另行安排。</p>' : '') +
        '</div>';
    }

    html += '<div class="card"><h4>需要取消或退款？</h4>';
    if (o.status === "PENDING_PAYMENT") {
      html += '<p class="mut">這張單還沒付款，你可以<b>直接取消</b>：庫存佔用會釋放一次，' +
        '<b>不產生退款單</b>——錢從來沒有到過。</p>' +
        '<div class="btn-row"><button class="btn ghost" id="moo-cancel">取消訂單</button>' +
        '<button class="btn" id="moo-pay">去支付</button></div>';
    } else if (o.status === "PAID" && !rf) {
      html += '<p class="mut">已付款的周邊訂單<b>一期只支持整單退款</b>，不做分項退款、部分退貨、換尺碼。' +
        '需要退款請聯繫客服，由客服或財務在後臺登記退款申請。</p>' +
        '<div class="btn-row"><button class="btn ghost" data-go="contact">聯繫客服</button></div>';
    } else {
      html += '<p class="mut">當前狀態沒有可執行的操作。</p>';
    }
    html += '</div>';

    body.innerHTML = html;
    var c = $("moo-cancel");
    if (c) c.addEventListener("click", function () {
      var btn = this;
      withLock("moo-cancel", btn, "取消中…", function () {
        var res = RD.cancelMerchOrder(o.id, rdActor(), null, "USER");
        if (!res.ok) {
          /* ⚖️ D-115 · 同上：ok:false 裏可能藏着一次真實的過期結算，先落盤再說話。 */
          if (res.mutated) RD.save();
          toast(res.expired
            ? "訂單已經過期，庫存佔用已釋放（不是被取消：這一單是過期了，也不產生退款）"
            : res.msg);
          renderMoOrder();
          return;
        }
        RD.save();
        toast("訂單已取消，庫存佔用已釋放一次（on_hand 未變，不產生退款）");
        renderMoOrder();
      });
    });
    var pb = $("moo-pay");
    if (pb) pb.addEventListener("click", function () { curMO = o.id; go("mopay"); });
  }

  /* ---------------- 周邊支付（獨立於報名支付） ---------------- */
  document.addEventListener("click", function (e) {
    if (e.target && e.target.id === "mop-paid") {
      var o = RD.merchOrderById(curMO);
      if (!o) return;
      var res = RD.payMerchOrder(o.id, rdActor(), null);
      if (!res.ok) {
        /* 付款期限已過：這筆錢是真的到了，但訂單不會被恢復（周邊側沒有逆向路徑）。
           共享域已經如實超時並把錢登記成周邊支付異常，這裏只負責如實告訴用戶。 */
        RD.save();
        toast(res.lateArrival
          ? "付款期限已過，訂單已過期。這筆錢已如實入賬，會由財務通過周邊退款流程退回——不會恢復訂單，也不會發貨。"
          : res.msg);
        go("moorder");
        return;
      }
      RD.save();
      go("modone");
    }
    if (e.target && e.target.id === "mop-timeout") {
      var o2 = RD.merchOrderById(curMO);
      if (!o2) return;
      var r2 = RD.expireMerchOrder(o2.id, rdActor());
      RD.save();
      toast(r2.ok ? "訂單已超時，庫存佔用釋放一次" : r2.msg);
      go("moorder");
    }
  });

  function v5Init() {
    renderRaceFilters();
    applyRF();
    resetOrder();
    renderEventInfo();
    renderFaq();
    reCtx.hid = S.ctx.reEvent || "h0";
    reCtx.board = S.ctx.reBoard || "all";
    if (S.ctx.prUid) curPerma = rowByUid(S.ctx.prUid);
  }

  v5Init();
  syncPhase();

  // 優先按 URL hash 落地；沒有 hash 時回到上次停留的頁面；都沒有就首頁
  (function bootRoute() {
    var target = screenFromHash();
    /* Telegram 深鏈：t.me/<bot>/<app>?startapp=race-e1 | photos-e1 | results ；普通鏈接用 ?start=... */
    var qs = new URLSearchParams(location.search);
    var sp = TG.startParam || qs.get("startapp") || qs.get("start") || qs.get("tgWebAppStartParam");
    if (sp) {
      var m = /^(race|detail|photos|results|result|races|me)(?:[-_](.+))?$/.exec(String(sp).trim());
      if (m) {
        if (m[2] && evById(m[2])) setSelectedRace(m[2]);
        target = { race: "detail", detail: "detail", photos: "photos", results: "results", result: "results", races: "races", me: "me" }[m[1]];
      }
    }
    if (!target) target = SCREENS.indexOf(S.ctx.screen) >= 0 ? S.ctx.screen : "home";
    // 報名流程中途刷新沒有意義，直接回賽事詳情
    if (["reg1", "reg2", "reg4", "pay"].indexOf(target) >= 0 && !screenFromHash()) target = "detail";
    go(target);
  })();

  window.addEventListener("pagehide", clearAllTimers);

  // 後臺標籤頁裏 requestAnimationFrame 不會觸發，插畫和證書可能沒畫上。
  // 頁面重新可見時補一次，避免用戶切回來看到空白畫布。
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") requestAnimationFrame(function () { paintAll(); });
  });
  window.addEventListener("focus", function () { requestAnimationFrame(function () { paintAll(); }); });

  $("phase-toggle").addEventListener("click", function () {
    nextPhase();
    var cur = (document.querySelector(".screen.on") || {}).id || "";
    go(cur.slice(2) || "home");
  });

  $("phnote-toggle").addEventListener("click", function () {
    var off = document.body.classList.toggle("hide-phnote");
    this.textContent = (off ? "▸ 顯示" : "▾ 隱藏") + "「AI 生成佔位」角標";
    this.setAttribute("aria-pressed", String(off));
  });

  $("later-toggle").addEventListener("click", function () {
    var on = document.body.classList.toggle("show-later");
    this.textContent = (on ? "▾ 隱藏" : "▸ 顯示") + " AI 找照片入口（自拍 / 人臉）";
    this.setAttribute("aria-pressed", String(on));
  });

  $("ad-toggle").addEventListener("click", function () {
    adTagsOn = !adTagsOn;
    this.textContent = adTagsOn ? "開" : "關";
    this.classList.toggle("on", adTagsOn);
    this.setAttribute("aria-pressed", String(adTagsOn));
    syncAdTags();
  });

  /* 審覈修復 · 「保存二維碼」以前是死控件：現在把畫布導出爲圖片下載；Telegram WebView 不支持下載時提示截圖 */
  var qrSave = $("qr-save");
  if (qrSave) qrSave.addEventListener("click", function () {
    var cv = document.querySelector('#s-pay canvas[data-art="qr-pay"]');
    if (!cv) return;
    try {
      var url = cv.toDataURL("image/png");
      if (TG.on) { toast("Telegram 內請直接截圖保存二維碼"); return; }
      var a = document.createElement("a"); a.href = url; a.download = "werun-khqr.png";
      document.body.appendChild(a); a.click(); a.remove();
      toast("二維碼已保存");
    } catch (e) { toast("無法導出二維碼，請截圖保存"); }
  });
  /* 審覈修復 · 沒有包 .scroll-x 的表格在 360px 會被 overflow-x:hidden 截斷 */
  document.querySelectorAll("table.tbl").forEach(function (tb) {
    if (tb.closest(".scroll-x")) return;
    var w = document.createElement("div"); w.className = "scroll-x";
    tb.parentNode.insertBefore(w, tb); w.appendChild(tb);
  });

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { requestAnimationFrame(function () { paintAll(); }); }, 150);
  });
  paintAll();
  setTimeout(function () { paintAll(); }, 60);

  /* PWA：只在 https 下注冊 Service Worker（本地開發不緩存） */
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
