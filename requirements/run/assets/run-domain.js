/* ================================================================
   RUN Demo · Shared Mock Business Domain（D-092）
   ================================================================

   这个文件是 **用户端（index.html）与运营后台（admin.html）共用的同一份
   业务对象**。它存在的唯一理由，是让下面这句话在 Demo 里成立：

     「RUN Demo 不要求真实后端，但要求 Backend-Compatible Business Semantics。」

   Mock 数据可以是假的；**业务语义不能是假的**。
   因此每一个重要动作都必须答得出：

     操作的是哪个业务对象 / 之前是什么状态 / 之后是什么状态 / 谁做的 /
     留下了什么历史 / 有什么连带效果 / 明确不变的是什么 /
     后台在哪看得到 / 用户在哪看得到结果。

   ⚠️ 这不是生产架构，也不是数据库设计：
     · 没有后端、没有 API、没有表结构冻结
     · localStorage 只是 Demo 的"同一份状态"载体，不代表持久化方案
     · 并发、幂等键、事务边界属于 Backend Technical Design（docs/14 §十四）

   本文件只做一件事：**把两边的 Mock 宇宙合成一个**，
   并把最贵的那几条不变量（exactly-once 释放、退钱≠退货、跨域禁写）
   写成两边都必须走的函数，而不是各写一遍的注释。
   ================================================================ */
(function (global) {
  "use strict";

  var KEY = "run-demo-domain-v1";
  var SCHEMA = 1;

  /* 用户端赛事 id ⇄ 后台赛事 id：两边原本各有一套 id，这里只做映射，
     不改任何一边既有的赛事数据（§15 不重设计既有模块）。 */
  var EVENT_MAP = { "e1": "EV-A", "e3": "EV-B" };
  var EVENT_MAP_R = { "EV-A": "e1", "EV-B": "e3" };

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function now() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
           " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function stampOf(epochMs) {
    var d = new Date(epochMs);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
           " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function plusMinutes(mins) {
    var d = new Date(Date.now() + mins * 60000);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
           " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function ts(str) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(str || ""));
    if (!m) return 0;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
  }
  /* ⚖️ D-100 NF-REG-01 · 付款窗口的业务权威是<b>截止时刻</b>本身。
     可读字符串只精确到分钟，10 分钟窗口够用，但演示场景会把窗口压到 20 秒，
     所以另存一个精确到毫秒的 deadlineAt 作为判定载体；
     o.deadline 由它派生，两者永远一致，只是给人看的那一份没有秒。 */
  function deadlineOf(o) {
    if (!o) return 0;
    if (typeof o.deadlineAt === "number" && o.deadlineAt > 0) return o.deadlineAt;
    return ts(o.deadline);
  }
  function pastDeadline(o) {
    var d = deadlineOf(o);
    return !!d && d <= Date.now();
  }
  /* 还剩多少业务时间（秒）。前端倒计时只是它的一个<b>视图</b>，
     不是另一个事实来源 —— 离开页面再回来不会因此多出十分钟。 */
  function secondsLeft(o) {
    var d = deadlineOf(o);
    if (!d) return null;
    return Math.max(0, Math.ceil((d - Date.now()) / 1000));
  }

  /* ================================================================
     1) 种子数据
     ================================================================
     报名侧的 orders / refunds / bibs 三张表，形状与 admin.html 原本的
     DB.orders / DB.refunds / DB.bibs **完全一致**（冻结行为优先于实现方便），
     只是每个 Participant 多挂一个 `reg` 块：

       p.name / p.cat / p.paid   = OrderParticipant 财务快照（不可编辑）
       p.reg.*                   = Registration 当前参赛资料（可编辑）

     这两组数据从此不是同一份 —— docs/12 §8.2「OrderParticipant 是不可变
     财务凭据」在 Demo 里第一次真的有了对照物。
     ================================================================ */

  /* holderId = 身份（谁在参赛）；holder = 这个身份当前的显示拼写。
     ⚖️ 两者分开，才能让「修改资料」只改拼写、「参赛人转让」才改身份（D-096 F-006）。 */
  var HOLDER_SEQ = 0;
  function newHolderId() { HOLDER_SEQ += 1; return "H-" + Date.now().toString(36) + "-" + HOLDER_SEQ; }
  function R(holder, phone, dob, gender, nation, size, holderId, idNo, email, ec, ecp) {
    return {
      holderId: holderId || newHolderId(),
      holder: holder,
      phone: phone,
      dob: dob,
      gender: gender,
      nation: nation || "KH",
      size: size,
      idNo: idNo || "012345678",
      email: email || (holder ? holder.toLowerCase().replace(/\s+/g, ".") + "@run.com.kh" : "runner@run.com.kh"),
      ec: ec || "Emergency Contact",
      ecp: ecp || "+855 12 987 654",
      edits: [],
      transfers: []
    };
  }

  function seed() {
    return {
      schemaVersion: SCHEMA,
      seq: { RF: 11, RC: 2, MO: 1003, MRF: 0, ADJ: 1, MEX: 1, SR: 0, ORD: 3000, OP: 20, REG: 20 },

      /* ---------------- 赛事 / 组别 / 价格档（D-097 · 唯一一套事实）----------------
         ⚠️ Demo 数据，不是生产价格政策。
         `minAge` 是这份 Demo 原本就有的组别硬性资格事实（原先只存在于用户端），
         上移到这里只是为了消灭「同一个赛事两套业务真相」，<b>不代表冻结任何真实年龄门槛</b>——
         真实值属于 Event / Category 配置。 */
      events: [
        /* D-033 · 报名开关与公开展示开关是两个独立字段，都不等于 Event.status。
           Event.status 只有 DRAFT / PUBLISHED 两个值；D-032 之后不存在任何把
           PUBLISHED 改回 DRAFT 的路径。 */
        { id:"EV-A", name:"Phnom Penh Half Marathon 2026", date:"2026-11-15", city:"金边", status:"PUBLISHED",
          registrationOpen:true, publicVisible:true,
          racePackConfigured:true,
          /* docs/12 §9「发布赛事」前置：每组都要有 Start / Cut-off / 名额 / PriceRule。
             priceRuleIds 表示「这一组适用哪几档价格」，不改动 PriceRule 本身的模型。 */
          categories:[
            {id:"C-21K", name:"半程 21K", cap:800,  used:612,  start:"2026-11-15 06:00", cutoff:"2026-11-15 09:30", priceRuleIds:["P-EB","P-STD","P-LOC"], minAge:16, feId:"21k", feName:"半程马拉松", feDist:"21.1 km"},
            {id:"C-10K", name:"欢乐 10K", cap:1200, used:1043, start:"2026-11-15 06:30", cutoff:"2026-11-15 09:00", priceRuleIds:["P-EB","P-STD","P-LOC"], minAge:13, feId:"10k", feName:"健康跑",   feDist:"10 km"},
            {id:"C-5K",  name:"亲子 5K",  cap:400,  used:187,  start:"2026-11-15 07:30", cutoff:"2026-11-15 09:00", priceRuleIds:["P-STD","P-LOC"], minAge:0,  feId:"5k",  feName:"欢乐跑",   feDist:"5 km"}
          ],
          priceRules:[
            {id:"P-EB",  name:"早鸟价",   audience:"ALL",   price:15, quota:300, used:300, window:"09/01–09/30"},
            {id:"P-STD", name:"标准价",   audience:"ALL",   price:22, quota:1500,used:842, window:"10/01–11/08"},
            {id:"P-LOC", name:"本地居民价",audience:"LOCAL",price:12, quota:600, used:418, window:"全程"}
          ],
          sponsors:[{name:"ABC Water", watermark:true, freeClaim:true},{name:"KH Sports", watermark:true, freeClaim:false}]
        },
        /* EV-B 是 DRAFT，且 Race Pack 配置尚未完成 —— 用来演示「发布前置校验没过时，
           按钮为什么是灰的、灰在哪一条」（D-034 §6）。 */
        { id:"EV-B", name:"Siem Reap Sunrise Run", date:"2026-12-06", city:"暹粒", status:"DRAFT",
          registrationOpen:true, publicVisible:true,
          racePackConfigured:false,
          /* 两个组别，其中「亲子 5K」故意留不全（缺 Cut-off、缺 PriceRule）——
             用来演示：只要<b>有一个组别</b>不完整，发布就必须被挡住，
             而且要说得出是哪一组、缺哪一项（P1-3）。 */
          categories:[
            {id:"C-10K2", name:"10K",     cap:600, used:0, start:"2026-12-06 06:00", cutoff:"2026-12-06 09:00", priceRuleIds:["P-STD2"]},
            {id:"C-5K2",  name:"亲子 5K", cap:200, used:0, start:"2026-12-06 07:30", cutoff:null,               priceRuleIds:[]}
          ],
          priceRules:[{id:"P-STD2", name:"标准价", audience:"ALL", price:18, quota:600, used:0, window:"待定"}],
          sponsors:[]
        }
      ],

      coupons: [
        { id: "CP-VIP100", code: "VIP100", type: "WAIVER", value: 100, quota: 999, used: 0, desc: "100% VIP 特邀优免直通码（0元免单）", validUntil: "2026-12-31" },
        { id: "CP-RUN2026", code: "RUN2026", type: "PERCENT", value: 10, quota: 999, used: 12, desc: "全场 9 折特惠码", validUntil: "2026-12-31" },
        { id: "CP-GROUP15", code: "GROUP15", type: "PERCENT", value: 15, quota: 500, used: 5, minRunners: 3, desc: "3人及以上跑团团购 85 折特惠", validUntil: "2026-12-31" },
        { id: "CP-EARLY5", code: "EARLY5", type: "AMOUNT", value: 5, quota: 300, used: 28, desc: "早鸟立减 $5 优惠码", validUntil: "2026-10-31" }
      ],

      /* ---------------- 报名侧 ---------------- */
      orders: [
        /* 场景 1：一单 3 人，1 人已退款，另外 2 人仍可继续处理（SR-001 F-002）
           buyerUserId=u1 → 这一单同时是用户端演示账号「SOK DARA」自己的订单，
           所以 Scenario A 能在两边看到同一个对象。 */
        { id: "ORD-1001", eventId: "EV-A", buyer: "Sok Dara", buyerUserId: "u1",
          phone: "+855 12 345 678", amount: 45, currency: "USD",
          status: "PARTIALLY_REFUNDED", paidAt: "2026-10-02 09:14", archived: false,
          participants: [
            { id: "OP-1", name: "Sok Dara", bib: "1024", regId: "REG-1", cat: "C-21K", catName: "半程 21K",
              paid: 15, audience: "ALL", opStatus: "REFUNDED", regStatus: "CANCELLED",
              cancelReason: "REFUND_SETTLED", purpose: "INITIAL",
              reg: R("Sok Dara", "+855 12 345 678", "1996-04-18", "M", "KH", "M") },
            { id: "OP-2", name: "Chan Sophea", bib: "1025", regId: "REG-2", cat: "C-21K", catName: "半程 21K",
              paid: 15, audience: "ALL", opStatus: "ACTIVE", regStatus: "CONFIRMED", purpose: "INITIAL",
              reg: R("Chan Sophea", "+855 12 700 118", "1994-02-09", "F", "KH", "S") },
            { id: "OP-3", name: "Lim Vuthy", bib: "1026", regId: "REG-3", cat: "C-10K", catName: "欢乐 10K",
              paid: 15, audience: "ALL", opStatus: "ACTIVE", regStatus: "CONFIRMED", purpose: "INITIAL",
              reg: R("Lim Vuthy", "+855 92 330 471", "1990-07-22", "M", "KH", "L") }
          ] },
        /* 场景 2：正常 Registration + 多付异常（SR-001 F-003） */
        { id: "ORD-1002", eventId: "EV-A", buyer: "Nary Pich", buyerUserId: null,
          phone: "+855 96 222 118", amount: 22, currency: "USD",
          status: "PAID", paidAt: "2026-10-05 20:41", archived: false,
          participants: [
            { id: "OP-4", name: "Nary Pich", bib: "2031", regId: "REG-4", cat: "C-10K", catName: "欢乐 10K",
              paid: 22, audience: "ALL", opStatus: "ACTIVE", regStatus: "CONFIRMED", purpose: "INITIAL",
              reg: R("Nary Pich", "+855 96 222 118", "1998-11-30", "F", "KH", "M") }
          ] },
        /* 场景 3：open Refund → Race Pack BLOCK */
        { id: "ORD-1003", eventId: "EV-A", buyer: "Ratana Kim", buyerUserId: null,
          phone: "+855 77 900 431", amount: 22, currency: "USD",
          status: "PAID", paidAt: "2026-10-07 11:02", archived: false,
          participants: [
            { id: "OP-5", name: "Ratana Kim", bib: "2044", regId: "REG-5", cat: "C-10K", catName: "欢乐 10K",
              paid: 22, audience: "ALL", opStatus: "REFUND_PENDING", regStatus: "CONFIRMED", purpose: "INITIAL",
              reg: R("Ratana Kim", "+855 77 900 431", "1992-05-14", "F", "KH", "M") }
          ] },
        /* 场景 4a：未付款订单，但存在 open 支付异常 → D-022 禁止取消 */
        { id: "ORD-1004", eventId: "EV-A", buyer: "Vibol Ouk", buyerUserId: null,
          phone: "+855 10 556 200", amount: 22, currency: "USD",
          status: "PENDING_PAYMENT", paidAt: null, archived: false,
          participants: [
            { id: "OP-6", name: "Vibol Ouk", bib: null, regId: "REG-6", cat: "C-10K", catName: "欢乐 10K",
              paid: 22, audience: "ALL", opStatus: "ACTIVE", regStatus: "PENDING", purpose: "INITIAL",
              reg: R("Vibol Ouk", "+855 10 556 200", "1989-01-03", "M", "KH", "XL") }
          ] },
        /* 场景 4b：干净的未付款订单 → D-022 允许取消 */
        { id: "ORD-1005", eventId: "EV-A", buyer: "Sreymom Chea", buyerUserId: null,
          phone: "+855 88 401 776", amount: 22, currency: "USD",
          status: "PENDING_PAYMENT", paidAt: null, archived: false,
          participants: [
            { id: "OP-7", name: "Sreymom Chea", bib: null, regId: "REG-7", cat: "C-10K", catName: "欢乐 10K",
              paid: 22, audience: "ALL", opStatus: "ACTIVE", regStatus: "PENDING", purpose: "INITIAL",
              reg: R("Sreymom Chea", "+855 88 401 776", "2000-09-19", "F", "KH", "S") }
          ] },
        /* AR-F-002 场景 A：应退 30，实际只退了 25 → 少退 5，要补退 */
        { id: "ORD-2001", eventId: "EV-A", buyer: "Kanha Sok", buyerUserId: null,
          phone: "+855 15 771 402", amount: 30, currency: "USD",
          status: "PARTIALLY_REFUNDED", paidAt: "2026-10-03 14:20", archived: false,
          participants: [
            { id: "OP-9", name: "Kanha Sok", bib: "3010", regId: "REG-9", cat: "C-21K", catName: "半程 21K",
              paid: 30, audience: "ALL", opStatus: "REFUNDED", regStatus: "CANCELLED",
              cancelReason: "REFUND_SETTLED", purpose: "INITIAL",
              reg: R("Kanha Sok", "+855 15 771 402", "1987-03-08", "F", "KH", "M") }
          ] },
        /* AR-F-002 场景 B：应退 20，实际退了 25 → 多退 5，要纠错 */
        { id: "ORD-2002", eventId: "EV-A", buyer: "Bopha Ly", buyerUserId: null,
          phone: "+855 17 336 918", amount: 30, currency: "USD",
          status: "PARTIALLY_REFUNDED", paidAt: "2026-10-04 09:05", archived: false,
          participants: [
            { id: "OP-10", name: "Bopha Ly", bib: "3011", regId: "REG-10", cat: "C-10K", catName: "欢乐 10K",
              paid: 30, audience: "ALL", opStatus: "REFUNDED", regStatus: "CANCELLED",
              cancelReason: "REFUND_SETTLED", purpose: "INITIAL",
              reg: R("Bopha Ly", "+855 17 336 918", "1995-12-01", "F", "KH", "L") }
          ] },
        /* 场景 4c：已过期订单 —— LATE_ARRIVAL 的真实起点（EXPIRED + ORDER_EXPIRED） */
        { id: "ORD-1006", eventId: "EV-A", buyer: "Dara Meas", buyerUserId: null,
          phone: "+855 92 118 003", amount: 22, currency: "USD",
          status: "EXPIRED", paidAt: null, expiredAt: "2026-10-08 12:30", archived: false,
          participants: [
            { id: "OP-8", name: "Dara Meas", bib: null, regId: "REG-8", cat: "C-10K", catName: "欢乐 10K",
              paid: 22, audience: "ALL", opStatus: "ACTIVE", regStatus: "CANCELLED",
              cancelReason: "ORDER_EXPIRED", purpose: "INITIAL",
              reg: R("Dara Meas", "+855 92 118 003", "1991-06-25", "M", "KH", "M") }
          ] },
        /* D-092 J-4 · 已确认报名但<b>还没有号码布</b>的参赛人 —— AUTO 与 CSV 批量的合法目标。
           没有这几条，「自动取号」与「批量导入」在 Demo 里就无从验证。 */
        { id: "ORD-1007", eventId: "EV-A", buyer: "Sopheak Tan", buyerUserId: null,
          phone: "+855 78 220 145", amount: 22, currency: "USD",
          status: "PAID", paidAt: "2026-10-30 10:12", archived: false,
          participants: [
            { id: "OP-11", name: "Sopheak Tan", bib: null, regId: "REG-11", cat: "C-10K", catName: "欢乐 10K",
              paid: 22, audience: "ALL", opStatus: "ACTIVE", regStatus: "CONFIRMED", purpose: "INITIAL",
              reg: R("Sopheak Tan", "+855 78 220 145", "1993-08-11", "M", "KH", "L") }
          ] },
        { id: "ORD-1008", eventId: "EV-A", buyer: "Chhorn Vichea", buyerUserId: null,
          phone: "+855 66 310 927", amount: 44, currency: "USD",
          status: "PAID", paidAt: "2026-10-31 14:48", archived: false,
          participants: [
            { id: "OP-12", name: "Chhorn Vichea", bib: null, regId: "REG-12", cat: "C-10K", catName: "欢乐 10K",
              paid: 22, audience: "ALL", opStatus: "ACTIVE", regStatus: "CONFIRMED", purpose: "INITIAL",
              reg: R("Chhorn Vichea", "+855 66 310 927", "1997-04-02", "M", "KH", "M") },
            { id: "OP-13", name: "Sina Ouk", bib: null, regId: "REG-13", cat: "C-21K", catName: "半程 21K",
              paid: 22, audience: "ALL", opStatus: "ACTIVE", regStatus: "CONFIRMED", purpose: "INITIAL",
              reg: R("Sina Ouk", "+855 69 118 302", "1999-10-27", "F", "KH", "S") }
          ] },
        /* D-092 J-5 · 一个「干净可转让」的参赛人：已确认、已有号码布、无进行中退款、
           未领参赛包、该号未产生成绩事实。Scenario C 的默认起点。 */
        { id: "ORD-1009", eventId: "EV-A", buyer: "Rithy Chan", buyerUserId: null,
          phone: "+855 71 640 288", amount: 22, currency: "USD",
          status: "PAID", paidAt: "2026-11-01 09:30", archived: false,
          participants: [
            { id: "OP-14", name: "Rithy Chan", bib: "2050", regId: "REG-14", cat: "C-10K", catName: "欢乐 10K",
              paid: 22, audience: "ALL", opStatus: "ACTIVE", regStatus: "CONFIRMED", purpose: "INITIAL",
              reg: R("Rithy Chan", "+855 71 640 288", "1988-02-17", "M", "KH", "M") }
          ] },
        /* 一条属于另一场赛事（EV-B）的报名 —— 用来验证「CSV 里混进了别场赛事的 Registration」
           这一类冲突真的会被挡住。 */
        { id: "ORD-2100", eventId: "EV-B", buyer: "Vanna Sok", buyerUserId: null,
          phone: "+855 93 505 771", amount: 18, currency: "USD",
          status: "PAID", paidAt: "2026-11-12 08:00", archived: false,
          participants: [
            { id: "OP-15", name: "Vanna Sok", bib: null, regId: "REG-15", cat: "C-10K2", catName: "10K",
              paid: 18, audience: "ALL", opStatus: "ACTIVE", regStatus: "CONFIRMED", purpose: "INITIAL",
              reg: R("Vanna Sok", "+855 93 505 771", "1994-09-05", "M", "KH", "M") }
          ] }
      ],

      refunds: [
        { id: "RF-1", orderId: "ORD-1001", opId: "OP-1", kind: "PARTICIPANT_CANCEL", amount: 15, status: "SETTLED",
          by: "finance.mao", initiatedBy: "FINANCE", at: "2026-10-09 15:20", reason: "跑者受伤退赛" },
        { id: "RF-2", orderId: "ORD-1003", opId: "OP-5", kind: "PARTICIPANT_CANCEL", amount: 22, status: "REQUESTED",
          by: "support.lyn", initiatedBy: "SUPPORT", at: "2026-10-28 10:05",
          reason: "用户来电称行程冲突（客服代客登记）" },
        /* AR-F-002 的两条已结算首次退款 —— Registration 已在这一步取消、名额已释放一次 */
        { id: "RF-10", orderId: "ORD-2001", opId: "OP-9", kind: "PARTICIPANT_CANCEL", type: "STANDARD",
          amount: 25, status: "SETTLED", by: "finance.mao", initiatedBy: "FINANCE", at: "2026-11-16 16:40",
          reason: "退赛退款（应退 $30，打款时误填 $25）", proof: "TXN-90112" },
        { id: "RF-11", orderId: "ORD-2002", opId: "OP-10", kind: "PARTICIPANT_CANCEL", type: "STANDARD",
          amount: 25, status: "SETTLED", by: "finance.mao", initiatedBy: "FINANCE", at: "2026-11-16 16:52",
          reason: "退赛退款（应退 $20，打款时误填 $25）", proof: "TXN-90118" }
      ],

      /* 用户端发起的「退款协助请求」——它**不是** Refund。
         D-092 明确：本轮不授权用户自助创建 Refund。
         用户只能提出诉求；Refund 只能由 SUPPORT / FINANCE 在后台创建。 */
      supportRequests: [],

      /* ⚖️ D-100 根 B · 领物<b>运营事实</b>的唯一权威表，按 regId 挂靠。
         它<b>不</b>决定谁在名单里（那是共享 Registration 的事），
         只回答「领没领 / 谁发的 / 什么时候 / 证件核验过没有」。
         后台与现场工作人员端写的是<b>同一份</b>，不再各存一套。
         种子里的历史领物事实原样保留（B8）。 */
      /* ⚖️ D-111 根 B · 报名侧支付异常上移共享域。
         以前它只存在于 Admin 内存里的 adminSeed()，用户端根本够不着 ——
         于是用户在浏览器里跑出来的迟到到账，无处可落。
         现在两端同一份：用户端登记的真实到账，后台立刻看得见。 */
      regExceptions: [
        { id:"EXC-1", type:"OVERPAID",     orderId:"ORD-1002", amount:5,  status:"OPEN",   note:"银行入账 $27，订单应收 $22，多收 $5", txn:"TXN-88213" },
        { id:"EXC-2", type:"DUPLICATE",    orderId:"ORD-1002", amount:22, status:"OPEN",   note:"同一订单收到第二笔 $22 真实入账", txn:"TXN-88240" },
        { id:"EXC-3", type:"UNDERPAID",    orderId:"ORD-1004", amount:12, status:"OPEN",   note:"订单 $22，仅收到 $12，订单尚未过期", txn:"TXN-88301" },
        { id:"EXC-4", type:"OLD_QR",       orderId:"ORD-1002", amount:22, status:"CLOSED", note:"扫了已刷新的旧二维码，金额与订单可对上，已正常确认", txn:"TXN-88190" },
        { id:"EXC-5", type:"LATE_ARRIVAL", orderId:"ORD-1006", amount:22, status:"OPEN",
          note:"订单已于 10-08 12:30 过期、报名已 CANCELLED(ORDER_EXPIRED)，10-08 12:41 才到账 $22", txn:"TXN-88355" }
      ],

      /* ⚖️ D-104 · 兼容迁移检查点。它<b>必须和被迁移的事实存在于同一份持久化状态里</b>：
         要么两者都在磁盘上，要么都不在。只靠页面本地的一个标记是不够的 ——
         那个标记没落盘，旧存档就会被反复重放。 */
      compat: { legacyWorkerRacePack: false },

      racePackFacts: [
        { regId: "REG-2", picked: false, idVerified: false },
        { regId: "REG-3", picked: true,  idVerified: true,
          pickedAt: "2026-11-14 08:32", pickedBy: "staff.pisey" },
        { regId: "REG-4", picked: false, idVerified: false },
        { regId: "REG-5", picked: false, idVerified: false }
      ],

      bibs: [
        { bib: "1024", eventId: "EV-A", regId: "REG-1", name: "Sok Dara", status: "ASSIGNED", at: "2026-10-20 10:00", by: "ops.chan" },
        { bib: "1025", eventId: "EV-A", regId: "REG-2", name: "Chan Sophea", status: "ASSIGNED", at: "2026-10-20 10:00", by: "ops.chan" },
        { bib: "1026", eventId: "EV-A", regId: "REG-3", name: "Lim Vuthy", status: "ASSIGNED", at: "2026-10-20 10:00", by: "ops.chan" },
        { bib: "2031", eventId: "EV-A", regId: "REG-4", name: "Nary Pich", status: "ASSIGNED", at: "2026-10-21 09:12", by: "ops.chan" },
        { bib: "2044", eventId: "EV-A", regId: "REG-5", name: "Ratana Kim", status: "ASSIGNED", at: "2026-10-21 09:12", by: "ops.chan" },
        /* 场景 5：一次换号历史 */
        { bib: "2010", eventId: "EV-A", regId: "REG-4", name: "Nary Pich", status: "SUPERSEDED", at: "2026-10-21 09:10", by: "ops.chan", note: "号码布印刷污损，现场换号" },
        { bib: "2099", eventId: "EV-A", regId: null, name: null, status: "RESERVED", at: "2026-10-18 16:00", by: "ops.chan", note: "预留号段（嘉宾 / 配速员）" },
        { bib: "2098", eventId: "EV-A", regId: null, name: null, status: "VOIDED", at: "2026-10-19 11:30", by: "ops.chan", note: "印刷错误，整批作废，永不再用" },
        { bib: "3010", eventId: "EV-A", regId: "REG-9", name: "Kanha Sok", status: "ASSIGNED", at: "2026-10-22 10:00", by: "ops.chan" },
        { bib: "3011", eventId: "EV-A", regId: "REG-10", name: "Bopha Ly", status: "ASSIGNED", at: "2026-10-22 10:00", by: "ops.chan" },
        { bib: "2050", eventId: "EV-A", regId: "REG-14", name: "Rithy Chan", status: "ASSIGNED", at: "2026-11-01 10:05", by: "ops.chan" }
      ],

      /* Bib 号段配置：Event → Category → 号段 + 预留段 + 分配方式。
         ⚖️ 年龄 / 性别**不参与**号码编排；它们只影响资格、成绩分组与排名。 */
      bibConfig: [
        { eventId: "EV-A", catId: "C-21K", from: 1000, to: 1999, reservedFrom: 1990, reservedTo: 1999, mode: "AUTO" },
        { eventId: "EV-A", catId: "C-10K", from: 2000, to: 2999, reservedFrom: 2090, reservedTo: 2099, mode: "AUTO" },
        { eventId: "EV-A", catId: "C-5K",  from: 3000, to: 3999, reservedFrom: 3990, reservedTo: 3999, mode: "BATCH" },
        { eventId: "EV-B", catId: "C-10K2", from: 6000, to: 6999, reservedFrom: 6990, reservedTo: 6999, mode: "AUTO" },
        { eventId: "EV-B", catId: "C-5K2",  from: 7000, to: 7999, reservedFrom: 7990, reservedTo: 7999, mode: "AUTO" }
      ],

      /* ---------------- 周边商品侧（docs/14） ----------------
         ⚖️ 价格挂 SKU，不挂 Product（docs/14 §3.1）。
         ⚖️ available = on_hand - reserved 是派生值，永不单独写入（§5.1）。 */
      merch: {
        products: [
          { id: "MP-1", name: "RUN 2026 赛事纪念 T 恤", nameEn: "RUN 2026 Race Tee",
            eventId: "EV-A", status: "ON_SALE", seed: 301,
            desc: "赛事官方纪念款，速干面料，正面为 2026 赛季主视觉。与参赛包里的 T 恤不是同一件。",
            createdBy: "ops.chan", createdAt: "2026-10-01 09:00", lastBy: "ops.chan", lastAt: "2026-10-01 09:00",
            skus: [
              { id: "SKU-1", variant: "黑色", size: "S", price: 12, currency: "USD", onHand: 24, reserved: 0, saleable: true },
              { id: "SKU-2", variant: "黑色", size: "M", price: 12, currency: "USD", onHand: 18, reserved: 1, saleable: true },
              { id: "SKU-3", variant: "黑色", size: "L", price: 12, currency: "USD", onHand: 9,  reserved: 0, saleable: true },
              { id: "SKU-4", variant: "黑色", size: "XL", price: 13, currency: "USD", onHand: 1,  reserved: 0, saleable: true },
              { id: "SKU-5", variant: "白色", size: "M", price: 12, currency: "USD", onHand: 2,  reserved: 2, saleable: true },
              { id: "SKU-6", variant: "白色", size: "L", price: 12, currency: "USD", onHand: 6,  reserved: 0, saleable: true }
            ] },
          { id: "MP-2", name: "RUN 轻量运动腰包", nameEn: "RUN Light Running Belt",
            eventId: "EV-A", status: "ON_SALE", seed: 317,
            desc: "单一规格，可放手机与能量胶，反光条设计。",
            createdBy: "ops.chan", createdAt: "2026-10-01 09:10", lastBy: "ops.chan", lastAt: "2026-10-01 09:10",
            skus: [
              { id: "SKU-7", variant: "标准", size: "均码", price: 9, currency: "USD", onHand: 30, reserved: 0, saleable: true }
            ] },
          { id: "MP-3", name: "RUN 限量奖牌挂架", nameEn: "RUN Medal Hanger",
            eventId: "EV-A", status: "OFF_SALE", seed: 331,
            desc: "金属奖牌挂架。**当前已下架**：供应商更换，等待新一批到货与重新定价。",
            offSaleReason: "供应商更换，等待重新定价",
            createdBy: "ops.chan", createdAt: "2026-09-20 10:00", lastBy: "ops.chan", lastAt: "2026-11-02 15:30",
            skus: [
              { id: "SKU-8", variant: "标准", size: "均码", price: 25, currency: "USD", onHand: 5, reserved: 0, saleable: true }
            ] },
          { id: "MP-4", name: "RUN 2026 官方跑帽（草稿）", nameEn: "RUN 2026 Cap (draft)",
            eventId: "EV-A", status: "DRAFT", seed: 349,
            desc: "尚未定稿：颜色与定价待定，仅后台可见。",
            createdBy: "ops.chan", createdAt: "2026-11-10 11:00", lastBy: "ops.chan", lastAt: "2026-11-10 11:00",
            skus: [
              { id: "SKU-9", variant: "黑色", size: "均码", price: 11, currency: "USD", onHand: 0, reserved: 0, saleable: true }
            ] }
        ],

        orders: [
          /* 已付款、待领取 —— Scenario H（整单退款 + 退货入库）的起点。
             buyerUserId=u1：用户端「我的周边订单」里能看到同一张单。 */
          { id: "MO-1001", eventId: "EV-A", buyer: "Sok Dara", buyerUserId: "u1", phone: "+855 12 345 678",
            status: "PAID", fulfillment: "PENDING_HANDOFF", amount: 24, currency: "USD",
            createdAt: "2026-11-02 19:20", deadline: "2026-11-02 19:50", paidAt: "2026-11-02 19:26",
            source: "USER", txn: "TXN-M-70011",
            items: [
              { skuId: "SKU-2", productId: "MP-1", productName: "RUN 2026 赛事纪念 T 恤", variant: "黑色", size: "M",
                unitPrice: 12, qty: 2, currency: "USD", amount: 24, seed: 301 }
            ],
            reservation: { qty: 2, released: true, releasedAt: "2026-11-02 19:26", releaseKind: "PAID" },
            stockDeducted: true, refundId: null, handoff: null, history: [
              { at: "2026-11-02 19:20", by: "user:u1", role: "USER", what: "创建周边订单", detail: "MO-1001 · PENDING_PAYMENT · reserved +2" },
              { at: "2026-11-02 19:26", by: "user:u1", role: "USER", what: "周边支付成功", detail: "reserved -2 且 on_hand -2 · fulfillment → PENDING_HANDOFF" }
            ] },
          /* 未付款、预留占用中 —— 用来演示 reserved 真的把可购数量压下去 */
          { id: "MO-1002", eventId: "EV-A", buyer: "Ratana Kim", buyerUserId: null, phone: "+855 77 900 431",
            status: "PENDING_PAYMENT", fulfillment: "NONE", amount: 24, currency: "USD",
            createdAt: "2026-11-14 08:10", deadline: "2099-01-01 00:00", paidAt: null,
            source: "USER", txn: null,
            items: [
              { skuId: "SKU-5", productId: "MP-1", productName: "RUN 2026 赛事纪念 T 恤", variant: "白色", size: "M",
                unitPrice: 12, qty: 2, currency: "USD", amount: 24, seed: 301 }
            ],
            reservation: { qty: 2, released: false, releasedAt: null, releaseKind: null },
            stockDeducted: false, refundId: null, handoff: null, history: [
              { at: "2026-11-14 08:10", by: "user:anon", role: "USER", what: "创建周边订单", detail: "MO-1002 · PENDING_PAYMENT · reserved +2" }
            ] },
          /* 已过期 + 过期之后才到账 —— 周边侧 LATE_ARRIVAL（docs/14 §7.2 六个"不"） */
          { id: "MO-1003", eventId: "EV-A", buyer: "Dara Meas", buyerUserId: null, phone: "+855 92 118 003",
            status: "EXPIRED", fulfillment: "NONE", amount: 9, currency: "USD",
            createdAt: "2026-11-10 16:00", deadline: "2026-11-10 16:30", paidAt: null,
            expiredAt: "2026-11-10 16:30", source: "USER", txn: null,
            items: [
              { skuId: "SKU-7", productId: "MP-2", productName: "RUN 轻量运动腰包", variant: "标准", size: "均码",
                unitPrice: 9, qty: 1, currency: "USD", amount: 9, seed: 317 }
            ],
            reservation: { qty: 1, released: true, releasedAt: "2026-11-10 16:30", releaseKind: "EXPIRED" },
            stockDeducted: false, refundId: null, handoff: null, history: [
              { at: "2026-11-10 16:00", by: "user:anon", role: "USER", what: "创建周边订单", detail: "MO-1003 · PENDING_PAYMENT · reserved +1" },
              { at: "2026-11-10 16:30", by: "system", role: "SYSTEM", what: "周边订单超时", detail: "PENDING_PAYMENT → EXPIRED · reserved -1（恰好一次）· on_hand 不变" }
            ] }
        ],

        refunds: [],

        exceptions: [
          { id: "MEX-1", type: "LATE_ARRIVAL", orderId: "MO-1003", amount: 9, status: "OPEN",
            note: "订单已于 11-10 16:30 过期并释放预留，11-10 16:41 才到账 $9（周边侧无 EXPIRED → PAID 逆向路径）",
            txn: "TXN-M-70044", at: "2026-11-10 16:41", resolution: null }
        ],

        adjustments: [
          { id: "ADJ-1", skuId: "SKU-3", delta: 9, reason: "INITIAL_STOCK", note: "首批到货入库",
            by: "ops.chan", at: "2026-10-01 09:20", before: 0, after: 9, sourceOrderId: null }
        ]
      },

      /* 共享 Audit —— 两端写同一条流水。用户端动作写 role:"USER"。 */
      audit: [
        { at: "2026-11-18 10:35", who: "finance.mao", role: "FINANCE", what: "创建多退纠错单", fin: true,
          detail: "RC-2 · ORD-2002 / OP-10 Bopha Ly · OVERPAID · 应退 $20 实退 $25 · 偏差 $5 · source_refund RF-11 · 对账时发现打款金额高于批准金额" },
        { at: "2026-11-18 10:20", who: "finance.mao", role: "FINANCE", what: "创建多退纠错单", fin: true,
          detail: "RC-1 · ORD-2001 / OP-9 Kanha Sok · UNDERPAID · 应退 $30 实退 $25 · 偏差 $5 · source_refund RF-10 · 用户来电反映退款金额不足" },
        { at: "2026-11-02 19:26", who: "user:u1", role: "USER", what: "周边支付成功", fin: true,
          detail: "MO-1001 · $24 · reserved -2 且 on_hand -2 同时生效 · fulfillment → PENDING_HANDOFF · 报名域零写入" },
        { at: "2026-10-09 15:20", who: "finance.mao", role: "FINANCE", what: "退款结算", fin: true,
          detail: "ORD-1001 / OP-1 Sok Dara · $15 · 跑者受伤退赛 · Registration 取消并释放名额" },
        { at: "2026-10-21 09:12", who: "ops.chan", role: "OPS", what: "Bib 换号",
          detail: "REG-4 Nary Pich · 2010 → 2031 · 号码布印刷污损" },
        { at: "2026-11-15 14:20", who: "ops.chan", role: "OPS", what: "成绩发布",
          detail: "RB-1 半程 21K · 612 行 · 0 异常行" }
      ]
    };
  }

  /* ================================================================
     2) 载入 / 落盘 / 重置
     ================================================================ */

  var state = null;
  var watchers = [];
  var writing = false;

  function ensureShape(o) {
    /* 脏数据一律回落到种子：Demo 不允许因为旧数据白屏。 */
    if (!o || typeof o !== "object" || Array.isArray(o)) return seed();
    if (o.schemaVersion !== SCHEMA) return seed();
    var base = seed();
    ["events", "orders", "refunds", "bibs", "bibConfig", "audit", "supportRequests",
     "racePackFacts", "regExceptions"].forEach(function (k) {
      if (!Array.isArray(o[k])) o[k] = base[k];
    });
    if (!o.compat || typeof o.compat !== "object" || Array.isArray(o.compat)) o.compat = { legacyWorkerRacePack: false };
    if (typeof o.compat.legacyWorkerRacePack !== "boolean") o.compat.legacyWorkerRacePack = false;
    migrateRacePackFacts(o);
    if (!o.merch || typeof o.merch !== "object") o.merch = base.merch;
    ["products", "orders", "refunds", "exceptions", "adjustments"].forEach(function (k) {
      if (!Array.isArray(o.merch[k])) o.merch[k] = base.merch[k];
    });
    if (!o.seq || typeof o.seq !== "object") o.seq = base.seq;
    /* Registration 当前资料块缺失时补齐（老数据兼容） */
    o.orders.forEach(function (ord) {
      (ord.participants || []).forEach(function (p) {
        if (!p.reg || typeof p.reg !== "object") p.reg = R(p.name, ord.phone, "1990-01-01", "M", "KH", "M");
        if (!Array.isArray(p.reg.edits)) p.reg.edits = [];
        if (!Array.isArray(p.reg.transfers)) p.reg.transfers = [];
        /* 老数据没有身份键：按当前持有人补一个稳定值，不改写任何历史 */
        if (!p.reg.holderId) p.reg.holderId = "H-" + p.id;
      });
    });
    backfillPriceFacts(o);
    return o;
  }

  /* ⚖️ D-097 F-002 补扫 · OrderParticipant 必须留得住「当初命中的是哪一档价格」。
     种子里的历史报名早于共享价格档，没有这个字段；缺了它，任何需要按
     <b>这个人实际买的那一档</b>做判定的入口（例如超时到账恢复报名要
     consume 回哪一档 quota）就只能瞎猜一档，那等于凭空消耗别人的名额。
     回填口径是确定性的：先按挂牌价与已付快照对得上的那一档，对不上再
     退回该组别 / 身份的常规匹配。<b>只补审计事实，不改任何金额。</b> */
  function backfillPriceFacts(o) {
    (o.orders || []).forEach(function (ord) {
      var ev = (o.events || []).filter(function (e) { return e.id === ord.eventId; })[0];
      if (!ev) return;
      (ord.participants || []).forEach(function (p) {
        if (!p.audience) p.audience = "ALL";
        if (p.priceRuleId) return;
        var cat = ev.categories.filter(function (c) { return c.id === p.cat; })[0];
        if (!cat) return;
        var scopes = p.audience === "LOCAL" ? ["LOCAL", "ALL"] : ["ALL"];
        var usable = (cat.priceRuleIds || []).map(function (id) {
          return ev.priceRules.filter(function (r) { return r.id === id; })[0];
        }).filter(function (r) { return r && scopes.indexOf(r.audience) >= 0; });
        if (!usable.length) return;
        var byPrice = usable.filter(function (r) { return cents(r.price) === cents(p.paid); })[0];
        if (!byPrice) {
          usable.slice().sort(function (a, b) { return (a.price - b.price) || (a.id < b.id ? -1 : 1); });
          byPrice = usable[0];
        }
        p.priceRuleId = byPrice.id;
        p.priceRuleName = byPrice.name;
        if (p.listPrice == null) p.listPrice = byPrice.price;
      });
    });
    backfillReservations(o);
  }

  /* ⚖️ D-098 A1 补齐 · 种子里本来就有处在付款窗口内的订单（PENDING_PAYMENT +
     Registration PENDING）。新模型下这些订单<b>必须</b>真的占着名额与配额，
     否则「付款窗口里的位子算不算占用」在 Demo 里又会两套答案。
     已 PAID / 已结束的订单的占用早已计在 used 里，这里不重复计。 */
  /* ⚖️ D-100 B8 · 确定性 Demo 兼容步骤：把旧位置（admin 私有的 racepack）里的
     领物事实并进共享表。<b>按 regId 去重</b>，已存在就不再造第二条；
     合法的历史领物记录一条都不丢。这是 Demo 数据兼容，不是生产迁移架构。 */
  function migrateRacePackFacts(o) {
    var legacy = (o.admin && Array.isArray(o.admin.racepack)) ? o.admin.racepack : [];
    if (!legacy.length) return;
    legacy.forEach(function (r) {
      if (!r || !r.regId) return;
      var hit = o.racePackFacts.filter(function (f) { return f.regId === r.regId; })[0];
      if (!hit) {
        hit = { regId: r.regId, picked: false, idVerified: false };
        o.racePackFacts.push(hit);
      }
      /* 只做「补齐」，不覆盖已有的更新事实：领过就是领过 */
      if (r.picked && !hit.picked) {
        hit.picked = true;
        hit.pickedAt = r.pickedAt || hit.pickedAt || null;
        hit.pickedBy = r.pickedBy || hit.pickedBy || null;
      }
      if (r.idVerified && !hit.idVerified) hit.idVerified = true;
    });
    if (o.admin) delete o.admin.racepack;      /* 旧位置退役，避免再有人往那儿写 */
  }

  function backfillReservations(o) {
    (o.events || []).forEach(function (e) {
      e.categories.forEach(function (c) { if (c.reserved == null) c.reserved = 0; });
      e.priceRules.forEach(function (r) { if (r.reserved == null) r.reserved = 0; });
    });
    (o.orders || []).forEach(function (ord) {
      if (ord.reservation) return;
      if (ord.status === "PENDING_PAYMENT") {
        var caps = {}, quotas = {};
        (ord.participants || []).forEach(function (p) {
          caps[p.cat] = (caps[p.cat] || 0) + 1;
          if (p.priceRuleId) quotas[p.priceRuleId] = (quotas[p.priceRuleId] || 0) + 1;
        });
        var ev = (o.events || []).filter(function (e) { return e.id === ord.eventId; })[0];
        if (ev) {
          Object.keys(caps).forEach(function (k) {
            var c = ev.categories.filter(function (x) { return x.id === k; })[0];
            if (c) c.reserved = (c.reserved || 0) + caps[k];
          });
          Object.keys(quotas).forEach(function (k) {
            var r = ev.priceRules.filter(function (x) { return x.id === k; })[0];
            if (r) r.reserved = (r.reserved || 0) + quotas[k];
          });
        }
        ord.reservation = { state: "RESERVED", at: ord.createdAt || null, caps: caps, quotas: quotas };
      } else if (ord.status === "EXPIRED") {
        ord.reservation = { state: "RELEASED", releaseKind: "ORDER_EXPIRED", caps: {}, quotas: {} };
      } else {
        /* 已付款 / 已退款等：占用早已计在 used 上，标成 CONSUMED，别再动数 */
        ord.reservation = { state: "CONSUMED", caps: {}, quotas: {} };
      }
    });
  }

  function load() {
    var raw = null;
    try { raw = global.localStorage.getItem(KEY); } catch (e) { raw = null; }
    if (!raw) { state = seed(); backfillPriceFacts(state); return state; }
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    try { state = ensureShape(parsed); }
    catch (e) { state = seed(); }
    return state;
  }

  function save() {
    writing = true;
    try { global.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    writing = false;
  }
  /* ⚖️ D-104 Rule 4 · 有些写入必须答得出「到底落盘没有」。
     落盘失败时调用方要能把检查点撤回来，绝不能留下一个「已迁移」的假象 ——
     那会让一批合法的历史领物记录<b>永远</b>找不回来。 */
  function saveDurable() {
    writing = true;
    var ok = false;
    try { global.localStorage.setItem(KEY, JSON.stringify(state)); ok = true; }
    catch (e) { ok = false; }
    writing = false;
    return ok;
  }

  function reset() {
    try { global.localStorage.removeItem(KEY); } catch (e) {}
    state = seed();
    backfillPriceFacts(state);
    save();
  }

  /* 跨页面 / 跨标签页观察：另一端改了共享状态，这一端要能看见。
     这是 D-092「User → Admin → User 是同一份状态」在 Demo 里的可验证形式。 */
  function watch(cb) {
    watchers.push(cb);
    if (watchers.length === 1) {
      global.addEventListener("storage", function (e) {
        if (e.key !== KEY || writing) return;
        load();
        watchers.forEach(function (f) { try { f(); } catch (err) {} });
      });
    }
  }

  function nextId(prefix, key) {
    state.seq[key] = (state.seq[key] || 0) + 1;
    return prefix + state.seq[key];
  }

  /* ================================================================
     2.5) D-096 / D-097 · 报名侧的财务 / 名额 / 价格档不变量
     ================================================================
     这一段存在的理由：同一条业务规则<b>只能有一处实现</b>。
     用户端结账、后台操作、退款结算全部走这里，
     不允许「前台一套算法、后台另一套算法」。
     ⚠️ 全部是 Demo 语义，不冻结任何生产价格 / 年龄门槛 / 促销分摊引擎。
     ================================================================ */

  function eventById(evId) {
    return (state.events || []).filter(function (e) { return e.id === evId; })[0] || null;
  }
  function categoryById(evId, catId) {
    var e = eventById(evId);
    if (!e) return null;
    return e.categories.filter(function (c) { return c.id === catId; })[0] || null;
  }
  function categoryByFeId(evId, feId) {
    var e = eventById(evId);
    if (!e) return null;
    return e.categories.filter(function (c) { return c.feId === feId; })[0] || null;
  }

  /* ⚖️ D-117 B2 · 成绩「发布了没有」只有<b>一份</b>事实。
     ----------------------------------------------------------------
     后台的 ResultBatch 早就随共享状态一起落盘了（state.admin.resultBatches），
     只是用户端够不着，于是用户端拿「演示阶段 = 赛后」当发布判据。
     那两个是不同的问题：阶段回答「比赛举行了吗」，批次回答「这一批成绩
     发布了吗」。后台把 RB-1 撤回发布之后，用户端照样按正式成绩展示 ——
     同一件事两个答案。
     这里只提供<b>读路径</b>：不新建第二个发布标志，不改 ResultBatch 模型，
     不动它的生命周期（DRAFT → VALIDATED → PUBLISHED → UNPUBLISHED），
     也没有 REPUBLISHED 这种东西。 */
  function resultBatchesOf(evId, catId) {
    var a = state.admin;
    var list = (a && Array.isArray(a.resultBatches)) ? a.resultBatches : [];
    return list.filter(function (b) {
      return b && b.eventId === evId && (catId == null || b.catId === catId);
    });
  }
  /* 当前 (赛事, 组别) 那一个 PUBLISHED 批次；撤回发布之后就没有了。 */
  function publishedResultBatch(evId, catId) {
    return resultBatchesOf(evId, catId).filter(function (b) { return b.status === "PUBLISHED"; })[0] || null;
  }
  /* true / false / <b>null</b>。
     null 的意思是「共享域里根本还没有成绩批次这份事实」——用户从没打开过后台。
     调用方此时必须回落到既有演示行为，<b>不能</b>把「没有事实」读成「未发布」，
     那会凭空把一场正常的演示成绩判成复核中。 */
  function resultPublicationOf(evId, catId) {
    var a = state.admin;
    if (!a || !Array.isArray(a.resultBatches)) return null;
    return !!publishedResultBatch(evId, catId);
  }
  /* 这个 (赛事, 组别) 当前处于哪一种发布事实，给用户端<b>选对文案</b>用：
       "PUBLISHED"    有生效中的已发布批次
       "UNPUBLISHED"  曾经发布、<b>已被撤回</b> → 用户侧是「成绩复核中」
       "PENDING"      只有 DRAFT / VALIDATED，<b>从来没发布过</b> → 「成绩尚未发布」
       null           共享域里根本没有这个组别的批次事实 → 调用方回落到既有演示行为
     ⚠️ 「撤回」与「还没发过」是两句不同的话，不能共用一段文案。
     ⚠️ 不引入 REPUBLISHED：重新发布＝新建批次，那时这里自然又是 PUBLISHED（B10）。 */
  function resultBatchStateOf(evId, catId) {
    var a = state.admin;
    if (!a || !Array.isArray(a.resultBatches)) return null;
    var list = resultBatchesOf(evId, catId);
    if (!list.length) return null;
    if (list.some(function (b) { return b.status === "PUBLISHED"; })) return "PUBLISHED";
    if (list.some(function (b) { return b.status === "UNPUBLISHED"; })) return "UNPUBLISHED";
    return "PENDING";
  }
  function priceRuleById(evId, ruleId) {
    var e = eventById(evId);
    if (!e) return null;
    return e.priceRules.filter(function (r) { return r.id === ruleId; })[0] || null;
  }
  /* 身份 → 够得着哪些价格档。本地居民同时够得着「全部人」的档。 */
  function audienceScopes(audience) {
    return audience === "LOCAL" ? ["LOCAL", "ALL"] : ["ALL"];
  }
  /* ⚖️ 唯一命中一条价格档：组别允许的档 ∩ 身份够得着 ∩ 配额还有剩 → 取最低价。
     这是 <b>Demo 的确定性匹配口径</b>，不是新的定价 / 促销政策。 */
  function matchPriceRule(evId, catId, audience) {
    var cat = categoryById(evId, catId);
    if (!cat) return { ok: false, why: "组别不存在" };
    var scopes = audienceScopes(audience);
    var usable = (cat.priceRuleIds || []).map(function (id) { return priceRuleById(evId, id); })
      .filter(function (r) { return r && scopes.indexOf(r.audience) >= 0; });
    if (!usable.length) return { ok: false, why: "该身份在这个组别没有可用的价格档" };
    var open = usable.filter(function (r) { return quotaLeft(r) > 0; });
    if (!open.length) return { ok: false, why: "该组别可用价格档的名额已售罄" };
    open.sort(function (a, b) { return (a.price - b.price) || (a.id < b.id ? -1 : 1); });
    return { ok: true, rule: open[0] };
  }
  /* 组别硬性资格：目前只有「比赛当天年龄」。值取自 Category 配置，不是写死的政策。 */
  function categoryEligibility(evId, catId, ageOnRaceDay) {
    var cat = categoryById(evId, catId);
    if (!cat) return { ok: false, why: "组别不存在" };
    if (cat.minAge > 0) {
      if (ageOnRaceDay == null) return { ok: false, why: "需要出生日期才能按比赛当天年龄判定资格" };
      if (ageOnRaceDay < cat.minAge) {
        return { ok: false, why: "该组别要求比赛当天年满 " + cat.minAge + " 岁（当前 " + ageOnRaceDay + " 岁）" };
      }
    }
    return { ok: true, cat: cat };
  }
  /* ⚖️ D-098 F-002 / NF-REG-01 · 名额与配额都有<b>两笔</b>占用：
       used     = 已确认（CONFIRMED / CONSUMED）
       reserved = 付款窗口内被这张 PENDING_PAYMENT 订单占住的（RESERVED）
     「还剩多少」必须把两笔都算进去 —— 否则付款窗口里的位子等于没占，
     「名额为你保留 10:00」就是一句假话。 */
  function capOccupied(c) { return (c.used || 0) + (c.reserved || 0); }
  function capacityLeft(evId, catId) {
    var c = categoryById(evId, catId);
    return c ? Math.max(0, c.cap - capOccupied(c)) : 0;
  }
  function quotaOccupied(r) { return (r.used || 0) + (r.reserved || 0); }
  function quotaLeft(r) {
    if (!r) return 0;
    if (r.quota == null) return Infinity;
    return Math.max(0, r.quota - quotaOccupied(r));
  }

  /* ⚖️ D-096 F-001 · 整单折扣必须按分分摊到每个参赛人行，
     让 Σ(参赛人 paid 快照) 恰好等于订单实付额。
     少了这一条，退款的默认义务会大于用户真正付过的钱。
     余数落在第一行 —— Demo 的确定性口径，<b>不是</b>通用促销分摊引擎。 */
  function allocateAmounts(lineAmounts, orderTotalAmount) {
    var listCents = lineAmounts.map(function (v) { return cents(v); });
    var listSum = listCents.reduce(function (a, b) { return a + b; }, 0);
    var target = cents(orderTotalAmount);
    if (listSum <= 0) return lineAmounts.map(function () { return 0; });
    var out = [], acc = 0;
    for (var i = 0; i < listCents.length; i++) {
      var share = (i === listCents.length - 1) ? (target - acc)
                                               : Math.round(target * listCents[i] / listSum);
      acc += share;
      out.push(share);
    }
    var diff = target - out.reduce(function (a, b) { return a + b; }, 0);
    if (diff !== 0) out[0] += diff;
    return out.map(function (c) { return c / 100; });
  }

  /* 名额与配额：各自<b>恰好一次</b>，且能报出前后值。
     ⚖️ D-098 A6 · 这里是<b>写入边界</b>，不是页面预检。任何一个过期标签页 /
     另一个写入方都不允许把 used + reserved 写过 cap / quota —— 所以这两个
     函数自己就要失败关闭，而不是指望调用方先查一遍。 */
  function occupyCapacity(evId, catId, n) {
    var c = categoryById(evId, catId);
    if (!c) return { ok: false, why: "组别不存在：" + catId };
    var k = n == null ? 1 : n;
    if (capOccupied(c) + k > c.cap) {
      return { ok: false, why: "组别 " + c.name + " 名额不足（cap " + c.cap +
               "，已占用 " + capOccupied(c) + "，还需 " + k + "）" };
    }
    var before = c.used;
    c.used = c.used + k;
    return { ok: true, catId: catId, before: before, after: c.used };
  }
  function releaseCapacity(evId, catId, n) {
    var c = categoryById(evId, catId);
    if (!c) return { ok: false, why: "组别不存在：" + catId };
    var k = n == null ? 1 : n;
    var before = c.used;
    c.used = Math.max(0, c.used - k);
    return { ok: true, catId: catId, before: before, after: c.used };
  }
  function consumeQuota(evId, ruleId, n) {
    var r = priceRuleById(evId, ruleId);
    if (!r) return { ok: false, why: "价格档不存在：" + ruleId };
    var k = n == null ? 1 : n;
    if (r.quota != null && quotaOccupied(r) + k > r.quota) {
      return { ok: false, why: "价格档 " + r.name + " 配额不足（quota " + r.quota +
               "，已占用 " + quotaOccupied(r) + "，还需 " + k + "）" };
    }
    var before = r.used;
    r.used = r.used + k;
    return { ok: true, ruleId: ruleId, before: before, after: r.used };
  }

  /* ================================================================
     D-098 根 A · 报名付款预留生命周期（F-002 / NF-REG-01）
     ----------------------------------------------------------------
     「名额为你保留 10:00」必须对应一笔<b>真实存在</b>的共享预留：

       进入 KHQR      Order=PENDING_PAYMENT · Reg=PENDING
                      Category 名额 RESERVED · PriceRule 配额 RESERVED
       支付成功       同一张单 → PAID · Reg → CONFIRMED
                      RESERVED → CONSUMED（名额<b>不再加一次</b>）
       付款窗口超时   → EXPIRED · Reg → CANCELLED(ORDER_EXPIRED)
                      RESERVED → RELEASED（恰好一次）
       成功付款后退款 名额释放一次；<b>CONSUMED 配额不恢复</b>

     预留事实挂在订单上（o.reservation），所以「放过没有 / 放过几次」
     永远答得出来，重复回调也只有第一次生效。
     ================================================================ */

  /* 整单累计需求：同组别 / 同价格档的多个参赛人必须<b>合并</b>算，
     否则两个人各自看见「还剩 1 个」，一起下单就超卖了。 */
  function planReservation(evId, lines) {
    var caps = {}, quotas = {};
    lines.forEach(function (l) {
      caps[l.catId] = (caps[l.catId] || 0) + 1;
      quotas[l.ruleId] = (quotas[l.ruleId] || 0) + 1;
    });
    var errs = [];
    Object.keys(caps).forEach(function (catId) {
      var c = categoryById(evId, catId);
      if (!c) { errs.push("组别不存在：" + catId); return; }
      if (capOccupied(c) + caps[catId] > c.cap) {
        errs.push("组别 " + c.name + " 名额不足：本单需要 " + caps[catId] +
                  " 个，当前只剩 " + Math.max(0, c.cap - capOccupied(c)) + " 个");
      }
    });
    Object.keys(quotas).forEach(function (ruleId) {
      var r = priceRuleById(evId, ruleId);
      if (!r) { errs.push("价格档不存在：" + ruleId); return; }
      if (r.quota != null && quotaOccupied(r) + quotas[ruleId] > r.quota) {
        errs.push("价格档 " + r.name + " 配额不足：本单需要 " + quotas[ruleId] +
                  " 个，当前只剩 " + quotaLeft(r) + " 个");
      }
    });
    return { ok: !errs.length, caps: caps, quotas: quotas, errs: errs, why: errs.join("；") };
  }

  /* 占预留：<b>全有或全无</b>。任一桶不够，整单失败，且不留下任何半截改动。 */
  function reserveOrder(o) {
    if (o.reservation && o.reservation.state === "RESERVED") {
      return { ok: true, already: true, reservation: o.reservation };   /* 幂等：重进同一屏不重复占 */
    }
    if (o.reservation && o.reservation.state === "CONSUMED") {
      return { ok: true, already: true, reservation: o.reservation };
    }
    var lines = o.participants.map(function (p) { return { catId: p.cat, ruleId: p.priceRuleId }; });
    var plan = planReservation(o.eventId, lines);
    if (!plan.ok) return { ok: false, why: plan.why, errs: plan.errs };
    Object.keys(plan.caps).forEach(function (catId) {
      var c = categoryById(o.eventId, catId);
      c.reserved = (c.reserved || 0) + plan.caps[catId];
    });
    Object.keys(plan.quotas).forEach(function (ruleId) {
      var r = priceRuleById(o.eventId, ruleId);
      r.reserved = (r.reserved || 0) + plan.quotas[ruleId];
    });
    o.reservation = { state: "RESERVED", at: now(), caps: plan.caps, quotas: plan.quotas };
    return { ok: true, reservation: o.reservation, plan: plan };
  }

  /* RESERVED → CONSUMED：名额<b>不再加一次</b>，只是从预留挪进已确认。 */
  function consumeOrderReservation(o) {
    var rv = o.reservation;
    if (!rv) return { ok: false, why: "这张订单没有预留事实，无法确认" };
    if (rv.state === "CONSUMED") return { ok: true, already: true, moves: rv.moves || [] };
    if (rv.state !== "RESERVED") return { ok: false, why: "预留当前是 " + rv.state + "，不能确认" };
    var moves = [];
    Object.keys(rv.caps).forEach(function (catId) {
      var c = categoryById(o.eventId, catId);
      var rb = c.reserved || 0, ub = c.used;
      c.reserved = Math.max(0, rb - rv.caps[catId]);
      c.used = ub + rv.caps[catId];
      moves.push(catId + " 名额 RESERVED " + rb + "→" + c.reserved + " · 已确认 " + ub + "→" + c.used);
    });
    Object.keys(rv.quotas).forEach(function (ruleId) {
      var r = priceRuleById(o.eventId, ruleId);
      var rb = r.reserved || 0, ub = r.used;
      r.reserved = Math.max(0, rb - rv.quotas[ruleId]);
      r.used = ub + rv.quotas[ruleId];
      moves.push(ruleId + " 配额 RESERVED " + rb + "→" + r.reserved + " · CONSUMED " + ub + "→" + r.used);
    });
    rv.state = "CONSUMED"; rv.consumedAt = now(); rv.moves = moves;
    return { ok: true, moves: moves };
  }

  /* RESERVED → RELEASED：<b>恰好一次</b>。重复超时回调 / 重渲染都不再放第二次。 */
  function releaseOrderReservation(o, kind) {
    var rv = o.reservation;
    if (!rv) return { ok: false, why: "这张订单没有预留事实，无可释放" };
    if (rv.state === "RELEASED") return { ok: true, already: true, moves: rv.moves || [] };
    if (rv.state === "CONSUMED") {
      return { ok: false, why: "该订单的名额与配额已经是<b>已确认</b>状态，不能当作未付款预留释放；" +
               "已 CONSUMED 的配额永不恢复" };
    }
    var moves = [];
    Object.keys(rv.caps).forEach(function (catId) {
      var c = categoryById(o.eventId, catId);
      var rb = c.reserved || 0;
      c.reserved = Math.max(0, rb - rv.caps[catId]);
      moves.push(catId + " 名额 RESERVED " + rb + "→" + c.reserved + "（放回公共池）");
    });
    Object.keys(rv.quotas).forEach(function (ruleId) {
      var r = priceRuleById(o.eventId, ruleId);
      var rb = r.reserved || 0;
      r.reserved = Math.max(0, rb - rv.quotas[ruleId]);
      moves.push(ruleId + " 配额 RESERVED " + rb + "→" + r.reserved + "（RELEASED，未 CONSUMED）");
    });
    rv.state = "RELEASED"; rv.releasedAt = now(); rv.releaseKind = kind || "ORDER_EXPIRED"; rv.moves = moves;
    return { ok: true, moves: moves };
  }

  /* ================================================================
     3) 共享查询
     ================================================================ */

  function findOrder(id) { return state.orders.filter(function (o) { return o.id === id; })[0] || null; }
  function findOP(opId) {
    for (var i = 0; i < state.orders.length; i++) {
      var ps = state.orders[i].participants;
      for (var j = 0; j < ps.length; j++) if (ps[j].id === opId) return { o: state.orders[i], p: ps[j] };
    }
    return null;
  }
  function findOPByReg(regId) {
    for (var i = 0; i < state.orders.length; i++) {
      var ps = state.orders[i].participants;
      for (var j = 0; j < ps.length; j++) if (ps[j].regId === regId) return { o: state.orders[i], p: ps[j] };
    }
    return null;
  }
  function refundsOf(opId) { return state.refunds.filter(function (r) { return r.opId === opId; }); }
  function openRefundOf(opId) {
    return refundsOf(opId).filter(function (r) { return r.status === "REQUESTED" || r.status === "APPROVED"; })[0] || null;
  }
  function settledRefundsOf(opId) {
    return refundsOf(opId).filter(function (r) { return r.status === "SETTLED"; });
  }
  function currentBib(regId) {
    var hit = state.bibs.filter(function (b) { return b.regId === regId && b.status === "ASSIGNED"; })[0];
    return hit ? hit.bib : null;
  }
  function bibHistoryOf(regId) {
    return state.bibs.filter(function (b) { return b.regId === regId; });
  }
  function holderOf(p) { return (p.reg && p.reg.holder) || p.name; }
  function transferred(p) { return holderOf(p) !== p.name; }
  function myOrders(userId) {
    return state.orders.filter(function (o) { return o.buyerUserId === userId; });
  }
  function openSupportRequest(opId) {
    return state.supportRequests.filter(function (s) { return s.opId === opId && s.status === "OPEN"; })[0] || null;
  }

  /* ---- 周边查询 ---- */
  function products() { return state.merch.products; }
  function productById(id) { return state.merch.products.filter(function (p) { return p.id === id; })[0] || null; }
  function skuById(id) {
    var out = null;
    state.merch.products.forEach(function (p) {
      p.skus.forEach(function (s) { if (s.id === id) out = { product: p, sku: s }; });
    });
    return out;
  }
  function available(sku) { return sku.onHand - sku.reserved; }
  /* ⚖️ docs/14 §3.3 · D-061：可售是三个条件同时成立，不是只看库存。 */
  function skuSaleable(productOrNull, sku) {
    var p = productOrNull || (skuById(sku.id) || {}).product;
    if (!p) return { ok: false, why: "SKU 不存在" };
    if (p.status !== "ON_SALE") return { ok: false, why: "商品当前为 " + p.status + "，仅阻断新单" };
    if (!sku.saleable) return { ok: false, why: "该 SKU 已停售" };
    if (available(sku) <= 0) return { ok: false, why: "售罄（available = 0，派生结论）" };
    return { ok: true, why: "" };
  }
  function productSoldOut(p) {
    var live = p.skus.filter(function (s) { return s.saleable; });
    if (!live.length) return true;
    return live.every(function (s) { return available(s) <= 0; });
  }
  function merchOrderById(id) { return state.merch.orders.filter(function (o) { return o.id === id; })[0] || null; }
  function myMerchOrders(userId) {
    return state.merch.orders.filter(function (o) { return o.buyerUserId === userId; });
  }
  function merchRefundById(id) { return state.merch.refunds.filter(function (r) { return r.id === id; })[0] || null; }
  /* ⚖️ D-094 R4 · 「这张单历史上出现过退款行」不等于「这张单现在有一笔生效中或已退成功的退款」。
     把三类分开，操作闸门只看前两类；第三类是历史，永远不该把一条本该继续的资金流程堵死。

       ACTIVE  = REQUESTED / APPROVED     进行中，不允许再开第二笔
       SUCCESS = SETTLED                  钱已经退回去了，不允许再退一次
       FAILED  = REJECTED / WITHDRAWN     历史终态，<b>不构成任何阻塞</b> */
  function merchRefundsOf(orderId) {
    return state.merch.refunds.filter(function (r) { return r.orderId === orderId; });
  }
  function activeMerchRefund(orderId) {
    return merchRefundsOf(orderId).filter(function (r) {
      return r.status === "REQUESTED" || r.status === "APPROVED";
    })[0] || null;
  }
  function settledMerchRefund(orderId) {
    return merchRefundsOf(orderId).filter(function (r) { return r.status === "SETTLED"; })[0] || null;
  }
  /* 展示用：当前最该被看到的那一条 —— 生效中 > 已结算 > 最近一条历史。
     ⚠️ 这个函数<b>不能</b>用来做「能不能再发起退款」的闸门（那正是 D-094 要修的毛病）。 */
  function merchRefundOf(orderId) {
    return activeMerchRefund(orderId) || settledMerchRefund(orderId) ||
           merchRefundsOf(orderId)[0] || null;
  }
  /* 一笔退款是不是「超时后到账的退回」——两种标记都算，兼容既有数据 */
  function isLateArrivalRefund(r) {
    return !!r && (r.origin === "LATE_ARRIVAL" || !!r.sourceExceptionId);
  }
  function openMerchException(orderId) {
    return state.merch.exceptions.filter(function (x) {
      return x.orderId === orderId && x.status === "OPEN";
    })[0] || null;
  }

  /* ================================================================
     4) 共享写入 —— 留痕
     ================================================================ */

  var FIN_WORDS = ["退款", "支付", "对账", "补退", "纠错", "返还", "结算", "付款", "异常"];
  function isFin(what) {
    return FIN_WORDS.some(function (w) { return String(what).indexOf(w) >= 0; });
  }
  function audit(actor, what, detail) {
    state.audit.unshift({
      at: now(), who: (actor && actor.who) || "system", role: (actor && actor.role) || "SYSTEM",
      what: what, detail: detail, fin: isFin(what), domain: (actor && actor.domain) || null
    });
  }
  function moHistory(o, actor, what, detail) {
    o.history = o.history || [];
    o.history.push({ at: now(), by: (actor && actor.who) || "system", role: (actor && actor.role) || "SYSTEM",
                     what: what, detail: detail });
  }

  /* ================================================================
     5) 周边：库存三个动作，只有三个（docs/14 §5.3）
     ================================================================ */

  function adjustInventory(skuId, delta, reason, actor, opts) {
    var hit = skuById(skuId);
    if (!hit) return { ok: false, msg: "SKU 不存在" };
    opts = opts || {};
    var before = hit.sku.onHand;
    var after = before + delta;
    if (after < 0) return { ok: false, msg: "on_hand 不允许为负（docs/14 §5.2）" };
    if (after - hit.sku.reserved < 0) {
      return { ok: false, msg: "调整后 available 会为负（reserved=" + hit.sku.reserved + "），拒绝：不超卖是硬不变量（§5.2）" };
    }
    hit.sku.onHand = after;
    var adj = {
      id: nextId("ADJ-", "ADJ"), skuId: skuId, delta: delta, reason: reason,
      note: opts.note || "", by: (actor && actor.who) || "system", at: now(),
      before: before, after: after, sourceOrderId: opts.sourceOrderId || null
    };
    state.merch.adjustments.unshift(adj);
    audit(actor, "周边库存调整",
      skuId + " · " + hit.product.name + " " + hit.sku.variant + "/" + hit.sku.size +
      " · delta " + (delta > 0 ? "+" : "") + delta + " · reason " + reason +
      " · on_hand " + before + " → " + after +
      (opts.sourceOrderId ? " · 来源 " + opts.sourceOrderId : "") +
      (opts.note ? " · " + opts.note : ""));
    return { ok: true, adj: adj };
  }

  /* exactly-once 释放：所有释放路径都必须走这一个函数（docs/14 §5.4）。
     少释放 → 幽灵占用；多释放 → 超卖。两者都不能出现。 */
  function releaseReservation(o, kind, actor) {
    if (!o.reservation || o.reservation.released) {
      return { released: false, msg: "该订单的预留此前已释放（" + (o.reservation && o.reservation.releaseKind) + "），本次不再释放 —— exactly-once" };
    }
    var changed = [];
    o.items.forEach(function (it) {
      var hit = skuById(it.skuId);
      if (!hit) return;
      var before = hit.sku.reserved;
      hit.sku.reserved = Math.max(0, hit.sku.reserved - it.qty);
      changed.push(it.skuId + " reserved " + before + " → " + hit.sku.reserved);
    });
    o.reservation.released = true;
    o.reservation.releasedAt = now();
    o.reservation.releaseKind = kind;
    o.reservation.releasedBy = (actor && actor.who) || "system";
    return { released: true, msg: changed.join(" · ") };
  }

  function createMerchOrder(input) {
    /* input: {eventId, buyer, phone, buyerUserId, items:[{skuId, qty}], actor, source} */
    var actor = input.actor || { who: "user:u1", role: "USER" };
    if (!input.items || !input.items.length) return { ok: false, msg: "订单必须至少有一个 SKU" };
    var lines = [];
    for (var i = 0; i < input.items.length; i++) {
      var req = input.items[i];
      var hit = skuById(req.skuId);
      if (!hit) return { ok: false, msg: "SKU " + req.skuId + " 不存在" };
      var qty = Math.floor(Number(req.qty) || 0);
      if (qty <= 0) return { ok: false, msg: "数量必须是正整数" };
      var sale = skuSaleable(hit.product, hit.sku);
      if (!sale.ok) return { ok: false, msg: hit.product.name + " " + hit.sku.variant + "/" + hit.sku.size + "：" + sale.why };
      if (available(hit.sku) < qty) {
        return { ok: false, msg: "库存不足：" + hit.product.name + " " + hit.sku.variant + "/" + hit.sku.size +
                 " 当前可购 " + available(hit.sku) + " 件（available = on_hand - reserved）" };
      }
      /* ⚖️ 下单即冻结快照（docs/14 §四）：之后改主数据不影响这张单。 */
      lines.push({
        skuId: hit.sku.id, productId: hit.product.id, productName: hit.product.name,
        variant: hit.sku.variant, size: hit.sku.size, unitPrice: hit.sku.price,
        qty: qty, currency: hit.sku.currency, amount: hit.sku.price * qty, seed: hit.product.seed
      });
    }
    var amount = lines.reduce(function (a, b) { return a + b.amount; }, 0);
    var totalQty = lines.reduce(function (a, b) { return a + b.qty; }, 0);
    var id = nextId("MO-", "MO");
    var o = {
      id: id, eventId: input.eventId || "EV-A", buyer: input.buyer || "—",
      buyerUserId: input.buyerUserId || null, phone: input.phone || "—",
      status: "PENDING_PAYMENT", fulfillment: "NONE", amount: amount, currency: "USD",
      createdAt: now(), paidAt: null,
      /* ⚖️ D-111 C1 · 与报名侧同一个口径：可读字符串只到分钟，
         判定用的是精确到毫秒的 deadlineAt（演示可以把窗口压到几十秒）。 */
      deadlineAt: null, deadline: null,
      source: input.source || "USER", txn: null, items: lines,
      reservation: { qty: totalQty, released: false, releasedAt: null, releaseKind: null },
      stockDeducted: false, refundId: null, handoff: null, history: []
    };
    var moved = [];
    lines.forEach(function (it) {
      var hit = skuById(it.skuId);
      var before = hit.sku.reserved;
      hit.sku.reserved += it.qty;                        /* on_hand 不变（§5.3） */
      moved.push(it.skuId + " reserved " + before + " → " + hit.sku.reserved);
    });
    var holdSec = (input.holdSeconds != null) ? input.holdSeconds
                : (input.holdMinutes == null ? 30 : input.holdMinutes) * 60;
    o.deadlineAt = input.deadlineAt || (Date.now() + holdSec * 1000);
    o.deadline = stampOf(o.deadlineAt);
    state.merch.orders.unshift(o);
    moHistory(o, actor, "创建周边订单", "PENDING_PAYMENT · " + moved.join(" · "));
    audit(actor, "创建周边订单",
      id + " · " + o.buyer + " · " + lines.map(function (l) {
        return l.productName + " " + l.variant + "/" + l.size + " ×" + l.qty;
      }).join("，") + " · $" + amount + " · reserved += " + totalQty + "，on_hand 不变 · 报名域零写入");
    return { ok: true, order: o };
  }

  function cancelMerchOrder(id, actor, reason, source) {
    var o = merchOrderById(id);
    if (!o) return { ok: false, msg: "订单不存在" };
    if (o.status !== "PENDING_PAYMENT") {
      return { ok: false, msg: "只有 PENDING_PAYMENT 的周边订单可以取消，当前是 " + o.status };
    }
    /* ⚖️ D-112 B4 / B5 · <b>时间先说话，人工取消才轮得到。</b>
       以前这里读的是 o.deadline 这个只到分钟的<b>显示串</b>，与调度器 / 对账
       用的 deadlineAt 是两个时钟：一个把 40 秒后到期的单当成早就过期，
       另一个说还没到。同一张单两种答案。现在统一走 deadlineOf()。
       而且过了截止不能只是"拒绝取消"——那会让这张单原地不动、库存继续被占着。
       它的归宿是 EXPIRED，所以直接交给既有的过期原语结算（释放恰好一次）。 */
    /* ⚖️ D-115 R1 · <b>「这个动作没做成」不等于「什么都没发生」。</b>
       下面这一步真的把业务状态改了：PENDING_PAYMENT → EXPIRED，预留释放恰好一次。
       ok:false 说的只是「你要的那个人工取消没有发生」。调用方若把它一律当成
       零变更、直接 return 掉，这次真实的过期结算就只活在内存里，
       刷新之后订单会"复活"成待付款、库存重新被占——那是假状态。
       所以显式给出 mutated：<b>业务状态到底变没变</b>，由域来回答，不靠调用方猜。 */
    if (pastDeadline(o)) {
      var lateRel = expireMerchOrder(id, actor || { who: "system", role: "SYSTEM" });
      return { ok: false, expired: true, mutated: !!(lateRel && lateRel.ok),
        order: o, release: lateRel && lateRel.release,
        msg: "付款截止时间（" + o.deadline + "）已过：这一单<b>不是被取消的，是过期了</b> —— " +
             "已按既有语义结算：<code>PENDING_PAYMENT → EXPIRED</code>，" +
             "预留库存<b>恰好一次</b>释放，on_hand 不变。" };
    }
    if (o.txn || o.paidAt) return { ok: false, msg: "已存在确认到账证据，取消必须由 FINANCE 在周边财务域裁决" };
    var exc = openMerchException(id);
    if (exc) return { ok: false, msg: "存在待裁的周边支付异常（" + exc.id + " · " + exc.type + "），必须先由 FINANCE 裁决" };
    var rel = releaseReservation(o, "CANCELLED", actor);
    o.status = "CANCELLED";
    o.cancelledAt = now();
    o.cancelSource = source || "USER";
    o.cancelReason = reason || null;
    moHistory(o, actor, "取消周边订单", "PENDING_PAYMENT → CANCELLED · " + rel.msg + " · on_hand 不变 · 不产生 Refund");
    audit(actor, "取消周边订单",
      id + " · PENDING_PAYMENT → CANCELLED · 来源 " + (source || "USER") +
      (reason ? " · 原因：" + reason : "（用户取消不要求填写原因）") +
      " · " + rel.msg + " · on_hand 不变 · <b>不产生 Refund</b>（钱从来没到过）· 报名域零写入");
    return { ok: true, order: o, release: rel };
  }

  function expireMerchOrder(id, actor) {
    var o = merchOrderById(id);
    if (!o) return { ok: false, msg: "订单不存在" };
    if (o.status !== "PENDING_PAYMENT") {
      /* 重复触发超时扫描：不再释放第二次。 */
      var again = releaseReservation(o, "EXPIRED", actor);
      return { ok: false, msg: "订单当前是 " + o.status + "，不再进入 EXPIRED。" + (again.released ? "" : again.msg) };
    }
    var rel = releaseReservation(o, "EXPIRED", actor);
    o.status = "EXPIRED";
    o.expiredAt = now();
    moHistory(o, actor, "周边订单超时", "PENDING_PAYMENT → EXPIRED · " + rel.msg + " · on_hand 不变");
    audit(actor, "周边订单超时",
      id + " · PENDING_PAYMENT → EXPIRED · " + rel.msg + " · on_hand 不变 · 预留释放恰好一次");
    return { ok: true, order: o, release: rel };
  }

  /* 支付成功：reserved -= qty 与 on_hand -= qty 是**一个业务结果**（§5.3）

     ⚖️ 三条前置<b>同时</b>成立才允许正常付款完成（docs/14 §六 · D-050）：
       ① 订单仍是 PENDING_PAYMENT
       ② <b>付款期限未过</b>
       ③ 预留仍然有效
     其中第 ② 条不能只靠"超时扫描还没跑到"来兜底 —— 扫描是<b>实现细节</b>，
     期限本身是<b>业务事实</b>。少了它，一张早已过期、只是还没被扫到的订单
     就能被直接付成功，等于凭空造出一条 EXPIRED → PAID 的逆向路径（D-051 禁止）。

     期限已过时，这笔钱是<b>真实到账</b>，因此按 docs/14 §7.2 处理：
     先把订单如实置为 EXPIRED（释放预留恰好一次），再把钱如实登记为
     周边 LATE_ARRIVAL 异常。<b>不恢复订单、不重新预留、不扣库存、
     不产生履约、不发货</b>，钱走周边财务域退回。 */
  /* ⚖️ D-051 · 周边「超时后到账」的<b>唯一</b>实现。
     两个入口共用它：订单还停在 PENDING_PAYMENT 时才发现过期，
     以及订单<b>早已</b>被对账 / 调度器结算成 EXPIRED 之后钱才到。
     两种情况下钱都是真的到了，处理必须一致 —— 所以不复制一份逻辑。 */
  function merchLateArrival(o, actor, txn, why) {
    var id = o.id;
    /* 先如实超时（可能早就过期了，这一步是幂等的），再如实入账，绝不履约。 */
    var rel = expireMerchOrder(id, { who: "system", role: "SYSTEM" });
    var amt = o.amount;
    var late = merchExceptionCreate(id, "LATE_ARRIVAL", amt,
      "订单付款截止时间为 " + o.deadline + "，该笔 $" + amt + " 在截止之后才到账；" +
      "周边侧没有 EXPIRED → PAID 的逆向路径，订单保持 EXPIRED，钱走周边财务域退回",
      txn || ("TXN-M-" + Math.floor(70000 + Math.random() * 9999)), actor);
    moHistory(o, actor, "周边超时后到账（LATE_ARRIVAL）",
      (why || "付款期限已过") + " · 钱如实入账 " + late.exc.id +
      " · <b>不恢复订单、不重新预留、不扣库存、不产生履约、不发货</b>");
    audit(actor, "周边超时后到账",
      id + " · $" + amt + " · 流水 " + late.exc.txn + " · " + (why || "付款期限已过") +
      (rel.ok ? " · " + rel.release.msg : " · 预留此前已释放，不再释放") +
      " · 订单<b>保持 EXPIRED</b>：不恢复订单 / 不重新预留 / 不扣库存 / 不产生履约 / 不发货（docs/14 §7.2）" +
      " · 钱通过周边财务域退回");
    return { ok: false, lateArrival: true, order: o, exc: late.exc,
             msg: (why || "付款期限已过") + "，这笔钱按<b>超时后到账</b>处理：" +
                  "订单保持已过期，钱已如实入账并登记为周边支付异常 " + late.exc.id +
                  "，由财务通过周边退款流程退回。<b>不会</b>恢复订单、不会扣库存、不会发货。" };
  }

  function payMerchOrder(id, actor, txn) {
    var o = merchOrderById(id);
    if (!o) return { ok: false, msg: "订单不存在" };
    /* ⚖️ D-112 B3 · 钱到了，就得有地方落。
       订单可能<b>已经</b>被对账 / 调度器结算成 EXPIRED 了——对账越勤快，
       这种情况越常见。若在这里以「不是 PENDING_PAYMENT」为由直接回绝，
       那笔<b>真实到账</b>就无处可去，等于对账把 D-051 的入口堵死了。
       所以：已经 EXPIRED 的单，照样走既有的迟到到账分支（不复活、不扣库存、
       不履约）；其余非待付款状态才是真的不能支付。 */
    if (o.status === "EXPIRED") {
      return merchLateArrival(o, actor, txn, "订单已过期（付款截止 " + o.deadline + "）");
    }
    if (o.status !== "PENDING_PAYMENT") return { ok: false, msg: "只有 PENDING_PAYMENT 的订单可以支付，当前是 " + o.status };
    if (!o.reservation || o.reservation.released) {
      return { ok: false, msg: "该订单已无有效预留（" + (o.reservation && o.reservation.releaseKind) + "），不能直接转为已支付" };
    }
    /* ⚖️ D-112 B3 · 与取消 / 调度器 / 对账用<b>同一个</b>截止权威：
       优先 deadlineAt（精确到毫秒），没有才回落到历史订单的显示串。
       以前这里单独解析显示串，于是分钟截断会把还没到期的单误判成迟到到账。 */
    if (pastDeadline(o)) {
      return merchLateArrival(o, actor, txn, "付款期限已过（" + o.deadline + "）");
    }
    var moved = [];
    o.items.forEach(function (it) {
      var hit = skuById(it.skuId);
      if (!hit) return;
      var rb = hit.sku.reserved, ob = hit.sku.onHand;
      hit.sku.reserved = Math.max(0, hit.sku.reserved - it.qty);
      hit.sku.onHand = Math.max(0, hit.sku.onHand - it.qty);
      moved.push(it.skuId + " reserved " + rb + " → " + hit.sku.reserved + " 且 on_hand " + ob + " → " + hit.sku.onHand);
    });
    o.reservation.released = true;
    o.reservation.releasedAt = now();
    o.reservation.releaseKind = "PAID";
    o.stockDeducted = true;
    o.status = "PAID";
    o.paidAt = now();
    o.txn = txn || ("TXN-M-" + Math.floor(70000 + Math.random() * 9999));
    o.fulfillment = "PENDING_HANDOFF";           /* ⚖️ 待领取是一笔负债，不是"已完成"（§10.3） */
    moHistory(o, actor, "周边支付成功", moved.join(" · ") + " · fulfillment → PENDING_HANDOFF");
    audit(actor, "周边支付成功",
      id + " · $" + o.amount + " · 流水 " + o.txn + " · " + moved.join(" · ") +
      " · fulfillment → PENDING_HANDOFF（不是「已完成」）· " +
      "<b>不动</b> OrderParticipant / Registration / capacity / quota / Bib / Race Pack");
    return { ok: true, order: o };
  }

  function handoffMerchOrder(id, actor, info) {
    var o = merchOrderById(id);
    if (!o) return { ok: false, msg: "订单不存在" };
    /* ⚖️ D-096 F-010 · 交付资格由完整当前事实推导（含整单退款是否已结算），
       而且必须在<b>执行那一刻</b>再判一次：过期的交付弹窗不能把已退款的货发出去。 */
    var el = handoffEligibility(o);
    if (!el.ok) return { ok: false, refunded: el.refunded, msg: el.why };
    o.fulfillment = "FULFILLED";
    o.handoff = { at: now(), location: info.location, by: (actor && actor.who) || "system",
                  recipient: info.recipient };
    moHistory(o, actor, "周边实物交付", "PENDING_HANDOFF → FULFILLED · " + info.location + " · 收货人确认：" + info.recipient);
    audit(actor, "周边实物交付",
      id + " · PENDING_HANDOFF → FULFILLED · 地点 " + info.location + " · 收货人确认 " + info.recipient +
      " · <b>不产生</b>任何 Race Pack 领物记录（两条链路互不触发）");
    return { ok: true, order: o };
  }

  /* ---- 周边退款：整单退款（§9.3），与报名侧退款是两个业务对象 ---- */
  /* 一笔真实到账、但订单已过期的钱（周边 LATE_ARRIVAL）。
     它是「已经收到、必须退回」的资金事实，不是「已支付订单」。 */
  function lateArrivalMoney(orderId) {
    return state.merch.exceptions.filter(function (x) {
      return x.orderId === orderId && x.type === "LATE_ARRIVAL" && x.txn;
    })[0] || null;
  }

  /* ⚖️ 可以退款的两种情形（都只做<b>整单</b>退款 · D-055）：
       ① 订单已支付 —— 正常的整单退款；
       ② 订单已过期，但确实收到过一笔钱（周边 LATE_ARRIVAL）——
          docs/14 §7.2 要求「钱通过周边财务域退回」。
          如果这条路不通，那句话就只能写在自由文本里，
          资金对象不会发生任何业务状态变化 —— 那正是 D-092 禁止的假语义。
     ⚠️ 情形 ② <b>不改订单状态</b>：订单从头到尾停在 EXPIRED，
        不恢复、不重新预留、不扣库存、不产生履约、不发货（D-051）。 */
  function merchRefundCreate(orderId, actor, reason, initiatedBy) {
    var o = merchOrderById(orderId);
    if (!o) return { ok: false, msg: "订单不存在" };
    var late = (o.status === "EXPIRED") ? lateArrivalMoney(orderId) : null;
    if (o.status !== "PAID" && !late) {
      return { ok: false, msg: "只有<b>已支付</b>的周边订单、或<b>已过期但确实收到过钱</b>（周边 LATE_ARRIVAL）的订单可以退款，当前是 " + o.status };
    }
    /* ⚖️ D-094 R3 / R5 · 闸门只看「生效中」与「已退成功」。
       历史上被拒绝 / 撤回的退款是<b>历史</b>，不构成阻塞 ——
       否则一次误拒就会把这笔真实收到的钱永远堵死在系统里。 */
    var act = activeMerchRefund(orderId);
    if (act) {
      return { ok: false, existing: act, active: true,
        msg: "该订单已有一笔<b>进行中</b>的退款 " + act.id + "（" + act.status + "）。" +
             "请继续处理这一笔，<b>不要再开第二笔</b>。" };
    }
    var done = settledMerchRefund(orderId);
    if (done) {
      return { ok: false, existing: done, settled: true,
        msg: "该订单的退款 " + done.id + " <b>已经结算</b>（$" + done.amount + " · 凭证 " + done.proof +
             "），这笔钱已经退回去了，不再重复退款。" };
    }
    var amount = late ? late.amount : o.amount;
    var r = {
      id: nextId("MRF-", "MRF"), orderId: orderId, amount: amount, currency: o.currency,
      scope: "WHOLE_ORDER", status: "REQUESTED", reason: reason,
      origin: late ? "LATE_ARRIVAL" : "PAID_ORDER",
      sourceExceptionId: late ? late.id : null,
      initiatedBy: initiatedBy || (actor && actor.role) || "SUPPORT",
      by: (actor && actor.who) || "system", at: now(),
      approvedBy: null, approvedAt: null, settledBy: null, settledAt: null, proof: null,
      rejectReason: null, returnReceived: null
    };
    state.merch.refunds.unshift(r);
    o.refundId = r.id;
    moHistory(o, actor, "创建周边退款申请",
      r.id + " · 整单 $" + amount + " · " + reason +
      (late ? " · 来源：超时后到账 " + late.id + "，订单<b>保持 EXPIRED</b>" : ""));
    audit(actor, "创建周边退款申请",
      r.id + " · " + orderId + " · 整单 $" + amount + " · initiated_by=" + r.initiatedBy +
      (late ? " · <b>来源：周边 LATE_ARRIVAL " + late.id + "</b>（订单保持 EXPIRED，不恢复、不重新预留、不扣库存、不产生履约）" : "") +
      " · 原因：" + reason + " · 钱未动、库存未动、履约未动 · <b>报名域零写入</b>");
    return { ok: true, refund: r };
  }

  function merchRefundApprove(id, actor) {
    var r = merchRefundById(id);
    if (!r) return { ok: false, msg: "退款不存在" };
    if (r.status !== "REQUESTED") return { ok: false, msg: "只有 REQUESTED 可以批准，当前是 " + r.status };
    r.status = "APPROVED"; r.approvedBy = (actor && actor.who); r.approvedAt = now();
    audit(actor, "周边退款审批", id + " · REQUESTED → APPROVED · $" + r.amount +
      " · <b>钱仍未出账</b>，库存零变化，履约零变化");
    var o = merchOrderById(r.orderId);
    if (o) moHistory(o, actor, "周边退款审批", "REQUESTED → APPROVED · 钱仍未出账");
    return { ok: true, refund: r };
  }

  /* ⚖️ D-094 R1 · 来源为 LATE_ARRIVAL 的退款<b>不允许</b>拒绝 / 撤回。
     普通 PAID_ORDER 退款可以被拒——那是在讨论「这笔钱该不该退」。
     但超时后到账不是「该不该退」的问题：钱<b>已经真的收到了</b>，
     而订单必须停在 EXPIRED、货永远不会发出去。拒绝它等于系统收了钱、
     不发货、也不退钱 —— 那是一条走不出去的资金死路。
     因此这里在<b>改动任何状态、写任何成功 Audit 之前</b>先失败关闭。 */
  function merchRefundReject(id, actor, kind, reason, userConfirm) {
    var r = merchRefundById(id);
    if (!r) return { ok: false, msg: "退款不存在" };
    if (isLateArrivalRefund(r)) {
      return { ok: false, lateArrivalLocked: true,
        msg: "这笔退款来自<b>超时后到账</b>（" + (r.sourceExceptionId || "LATE_ARRIVAL") + "）：" +
             "钱<b>已经真的收到了</b>，订单又必须停在 EXPIRED、货不会发出去。" +
             "因此它<b>不允许拒绝或撤回</b>，只能走 REQUESTED → APPROVED → SETTLED 把钱退回去。" +
             "<br><span class='mut'>本次没有改动任何状态，也没有写任何成功 Audit。</span>" };
    }
    if (["REQUESTED", "APPROVED"].indexOf(r.status) < 0) {
      return { ok: false, msg: "只有 REQUESTED / APPROVED 可以拒绝或撤回，当前是 " + r.status };
    }
    if (kind === "WITHDRAWN" && !userConfirm) return { ok: false, msg: "撤回必须记录用户确认" };
    var before = r.status;
    r.status = kind; r.rejectReason = reason; r.rejectedBy = (actor && actor.who); r.rejectedAt = now();
    if (kind === "WITHDRAWN") r.userConfirmation = userConfirm;
    var o = merchOrderById(r.orderId);
    if (o) {
      o.refundId = null;
      moHistory(o, actor, "周边退款" + (kind === "WITHDRAWN" ? "撤回" : "拒绝"), before + " → " + kind + " · " + reason);
    }
    audit(actor, "周边退款" + (kind === "WITHDRAWN" ? "撤回" : "拒绝"),
      id + " · " + before + " → " + kind + " · 原因：" + reason +
      (userConfirm ? " · 用户确认：" + userConfirm : "") + " · 从头到尾没有一分钱出账");
    return { ok: true, refund: r };
  }

  /* 金额按「分」比较：0.1 + 0.2 !== 0.3 这种浮点毛病不该决定钱退没退干净。 */
  function cents(v) { return Math.round(Number(v) * 100); }
  function fmt(v) { return (Math.round(Number(v) * 100) / 100).toFixed(2); }

  /* ⚖️ D-095 R1 · 超时后到账退款的<b>应退金额</b>只有一个权威来源：
     那笔真实到账的 LATE_ARRIVAL 异常金额。
     不从可编辑的界面取、不从当前商品 / 订单价取、不从库存取、
     也不从「后来被覆盖过的退款金额」取 —— 收到多少就必须退回多少。 */
  function lateArrivalObligation(r) {
    if (!isLateArrivalRefund(r)) return { late: false };
    if (!r.sourceExceptionId) {
      return { late: true, ok: false,
        msg: "这笔退款标记为<b>超时后到账</b>，却没有指向任何来源异常。" +
             "应退金额<b>必须</b>来自那笔真实到账的事实，系统<b>不猜金额</b>。" };
    }
    var e = state.merch.exceptions.filter(function (x) { return x.id === r.sourceExceptionId; })[0];
    if (!e) {
      return { late: true, ok: false,
        msg: "找不到来源异常 <b>" + r.sourceExceptionId + "</b>：应退金额无法确定。" +
             "系统<b>不猜金额</b>，也不拿退款单上的数字顶替真实到账事实。" };
    }
    if (e.type !== "LATE_ARRIVAL") {
      return { late: true, ok: false,
        msg: "来源异常 <b>" + e.id + "</b> 的类型是 <code>" + e.type + "</code>，不是 LATE_ARRIVAL：" +
             "不能用它的金额当作超时后到账的应退额。" };
    }
    return { late: true, ok: true, exc: e, amount: e.amount };
  }

  /* ⚖️ SETTLED = 钱真的退回去了。**不代表货回来了**，因此绝不加库存（§9.1） */
  function merchRefundSettle(id, actor, amount, proof) {
    var r = merchRefundById(id);
    if (!r) return { ok: false, msg: "退款不存在" };
    if (r.status !== "APPROVED") return { ok: false, msg: "只有 APPROVED 可以结算，当前是 " + r.status };
    if (!(amount > 0)) return { ok: false, msg: "实际退款金额必须是有效正数" };
    if (!proof) return { ok: false, msg: "打款凭证号必填" };

    /* ---- 以下全部是「改动任何状态之前」的守卫（D-095 R2 / R3）---- */
    var ob = lateArrivalObligation(r);
    if (ob.late && !ob.ok) return { ok: false, amountLocked: true, msg: ob.msg };

    /* ⚖️ D-106 FQA-002 · <b>普通整单退款也必须逐分退清</b>。
       一期周边只有整单退款这一种：要么把这单的钱<b>原额</b>退回去、SETTLED；
       要么就还没退完、停在 APPROVED。以前这里只校验「金额 > 0」，
       于是 $30 的单填 $1 也能变成 SETTLED、订单标 REFUNDED ——
       系统说「已全额退款」，用户手里少了 $29。
       应退额取<b>退款单冻结的整单金额</b>（来自下单时的 MerchandiseOrder.amount），
       不拿当前商品主数据重算 —— 那会让改价追溯改写历史义务。
       ⚠️ 这里<b>不</b>引入部分退款 / 补退 / 纠错模型，那些不在一期范围。 */
    if (!ob.late && r.scope === "WHOLE_ORDER" && cents(amount) !== cents(r.amount)) {
      return { ok: false, amountMismatch: true, required: r.amount, attempted: amount,
        msg: "<b>金额不符，拒绝结算。</b>一期周边退款只有<b>整单</b>一种：" +
             "这一单的应退额是 <b>$" + fmt(r.amount) + "</b>（下单时冻结），本次填的是 $" + fmt(amount) + "。" +
             "<br>少退 → 系统说「已全额退款」而用户手里少了钱；" +
             "多退 → 拿别人的钱补这一笔。两种都不允许。" +
             "<br>一期<b>没有</b>部分退款 / 补退 / 退款纠错这些动作，所以差额也无处可补。" +
             "<br><span class='mut'>此刻退款仍是 APPROVED、订单退款状态未变，没有改动任何业务状态，" +
             "也没有写任何成功 Audit。</span>" };
    }

    if (ob.late && cents(amount) !== cents(ob.amount)) {
      return { ok: false, amountMismatch: true, required: ob.amount, attempted: amount,
        msg: "<b>金额不符，拒绝结算。</b>这笔钱是<b>真实到账</b>的 $" + fmt(ob.amount) +
             "（来源异常 " + ob.exc.id + " · 流水 " + ob.exc.txn + "），" +
             "<b>收到多少就必须退回多少</b>：本次填的是 $" + fmt(amount) + "。" +
             "<br>少退 → 系统说「已全额退回」而用户手里少了钱；" +
             "多退 → 拿别人的钱补这一笔。两种都不允许。" +
             "<br><span class='mut'>此刻退款仍是 APPROVED、来源异常仍是 OPEN，没有改动任何业务状态，也没有写任何成功 Audit。</span>" };
    }

    /* ⚖️ D-095 R4 · 结算<b>不覆盖</b>应退金额。
       「应退多少」与「实际退了多少」必须始终是两个能分别答出来的数字。 */
    r.status = "SETTLED";
    r.requiredAmount = ob.late ? ob.amount : r.amount;   /* 应退（义务） */
    r.settledAmount = amount;                            /* 实退（事实） */
    r.proof = proof;
    r.settledBy = (actor && actor.who); r.settledAt = now();
    var o = merchOrderById(r.orderId);
    if (o) {
      o.refundState = "REFUNDED";
      moHistory(o, actor, "周边退款结算",
        "APPROVED → SETTLED · 应退 $" + fmt(r.requiredAmount) + " · 实退 $" + fmt(amount) +
        " · <b>on_hand 一个数字都没变</b>");
    }
    /* ⚖️ D-094 R2 + D-095 R5 · 超时后到账的异常，只有在
       「已结算 + 金额与真实到账完全一致 + 有打款凭证」三条同时成立时才关闭。
       上面的守卫已经把不满足的情况全部挡在改状态之前，所以走到这里即为三条皆成立。 */
    var closedExc = null;
    if (ob.late && ob.ok) {
      var e = ob.exc;
      if (e.status === "OPEN") {
        e.status = "CLOSED";
        e.resolution = "超时后到账已全额退回（退款 " + r.id + " · 应退 $" + fmt(e.amount) +
                       " · 实退 $" + fmt(amount) + " · 凭证 " + proof + "）";
        e.settledRefundId = r.id;
        e.settlementProof = proof;
        e.settledAmount = amount;
        e.requiredAmount = e.amount;
        e.resolvedBy = (actor && actor.who); e.resolvedAt = now();
        e.note2 = "订单全程停在 EXPIRED：未恢复、未重新预留、未扣库存、未产生履约、未发货";
        closedExc = e;
      }
    }
    audit(actor, "周边退款结算",
      id + " · " + r.orderId + " · 应退 $" + fmt(r.requiredAmount) + " · 实退 $" + fmt(amount) +
      " · 凭证 " + proof +
      (ob.late ? " · <b>与真实到账金额逐分核对一致</b>（来源异常 " + ob.exc.id + "）" : "") +
      " · <b>退钱 ≠ 退货：on_hand 零变化</b>（docs/14 §9.1）· 履约状态不变 · " +
      "<b>不动</b> Registration / capacity / quota / Bib" +
      (closedExc ? " · <b>钱已全额退回，来源异常 " + closedExc.id + " 此刻才 OPEN → CLOSED</b>（留痕：来源异常 / 应退 / 实退 / 打款凭证 / 处置结论）" : ""));
    return { ok: true, refund: r, closedException: closedExc };
  }

  /* 退货入库：唯一能把 on_hand 加回去的路径，且同一笔只能入库一次（§9.2 · M-14）

     ⚖️ <b>整单退货，按下单数量入库，没有"实收数量"这个可填字段</b>（D-055）。
     一期不做分项退款、不做部分退货、不做换货换尺码 —— 一旦允许逐行填数量，
     就等于把"部分退货"这套能力做出来了，只是没起那个名字。
     实物回来时短少 / 损坏，走<b>独立的库存调整事实</b>（STOCKTAKE / DAMAGE），
     那是另一条有操作人、有前后值的记录，不能混进退货入库里当成"少收一点"。 */
  function merchReturnReceived(id, actor, note) {
    var r = merchRefundById(id);
    if (!r) return { ok: false, msg: "退款不存在" };
    if (r.status !== "SETTLED") return { ok: false, msg: "只有已结算的退款可以登记退货入库，当前是 " + r.status };
    if (r.returnReceived) {
      return { ok: false, msg: "该笔退货已于 " + r.returnReceived.at + " 由 " + r.returnReceived.by +
               " 登记入库，重复提交不产生第二次入库（docs/14 M-14）" };
    }
    var o = merchOrderById(r.orderId);
    if (!o) return { ok: false, msg: "订单不存在" };
    /* ⚖️ 没出过库的货不可能"退回来"：LATE_ARRIVAL 的订单从未扣过库存，
       给它回库就是凭空造出幽灵库存（docs/14 §9.1 反例）。 */
    if (!o.stockDeducted) {
      return { ok: false, msg: "该订单从未扣减过库存（" + o.status +
               "，货从来没有出过库），因此不存在可入库的退货。这笔钱只退钱，不回库。" };
    }
    var lines = o.items.map(function (it) { return { skuId: it.skuId, qty: it.qty }; });
    var done = [];
    lines.forEach(function (l) {
      var res = adjustInventory(l.skuId, l.qty, "RETURN_RECEIVED", actor,
        { sourceOrderId: o.id, note: note || "整单退货实物回收" });
      if (res.ok) done.push(l.skuId + " +" + l.qty + "（" + res.adj.before + " → " + res.adj.after + "）");
    });
    r.returnReceived = { at: now(), by: (actor && actor.who) || "system", lines: lines, note: note || "" };
    moHistory(o, actor, "周边退货入库", "RETURN_RECEIVED · 整单按下单数量入库 · " + done.join(" · "));
    audit(actor, "周边退货入库",
      "RETURN_RECEIVED · " + r.id + " · " + o.id + " · <b>整单按下单数量入库</b>（一期不做部分退货）· " +
      done.join(" · ") + " · 只有这一步才会 on_hand += qty，且同一笔只入库一次");
    return { ok: true, refund: r, done: done };
  }

  /* ⚖️ D-111 根 C · 周边的截止时刻同样必须是业务权威。
     ----------------------------------------------------------------
     周边订单在 PENDING_PAYMENT 期间是<b>真的占着库存</b>（reserved）。
     过期本身 expireMerchOrder() 早就写对了，问题和报名侧一模一样：
     它得<b>有人调用</b>。以前要等用户点「模拟付款超时」或下次碰到这张单，
     于是一张没人管的过期订单会把库存<b>无限期</b>占着 —— 幽灵预留。

     这里补上唯一的对账入口，逻辑一行不抄：过期释放仍然全部由
     expireMerchOrder() / 预留事实负责 exactly-once。 */
  function reconcileExpiredMerchOrders(actor) {
    var settled = [];
    (state.merch.orders || []).forEach(function (o) {
      if (o.status !== "PENDING_PAYMENT") return;
      var d = deadlineOf(o);
      if (!d || d > Date.now()) return;
      var res = expireMerchOrder(o.id, actor || { who: "system", role: "SYSTEM" });
      if (res && res.ok) settled.push(o.id);
    });
    return settled;
  }
  /* 当前所有待付款周边订单里最近的那个截止时刻（供调度器用） */
  function nextMerchDeadlineAt() {
    var next = null;
    (state.merch.orders || []).forEach(function (o) {
      if (o.status !== "PENDING_PAYMENT") return;
      var d = deadlineOf(o);
      if (!d) return;
      if (next === null || d < next) next = d;
    });
    return next;
  }

  /* ---- 周边支付异常 ---- */
  function merchExceptionResolve(id, actor, resolution, note) {
    var e = state.merch.exceptions.filter(function (x) { return x.id === id; })[0];
    if (!e) return { ok: false, msg: "异常不存在" };
    if (e.status !== "OPEN") return { ok: false, msg: "该异常已处置：" + e.status };
    /* ⚖️ D-094 R2 · 超时后到账的异常不能靠「写一段处置结论」关掉。
       钱是真的收到了，只有<b>退款结算完成</b>才代表它被处理完。 */
    if (e.type === "LATE_ARRIVAL") {
      return { ok: false, msg: "超时后到账的异常<b>不能手工关闭</b>：它只有在对应的周边退款" +
               "<b>结算完成（SETTLED）</b>之后才会关闭。请走「退回超时到账」→ 审批 → 结算打款。" };
    }
    e.status = "CLOSED"; e.resolution = resolution; e.note2 = note || "";
    e.resolvedBy = (actor && actor.who); e.resolvedAt = now();
    audit(actor, "周边支付异常处置",
      id + " · " + e.type + " · " + e.orderId + " · 处置：" + resolution +
      (note ? " · " + note : "") +
      " · 全程在<b>周边财务域</b>内完成：OrderParticipant / Registration / capacity / quota / Bib 零变化");
    return { ok: true, exc: e };
  }

  function merchExceptionCreate(orderId, type, amount, note, txn, actor) {
    var e = { id: nextId("MEX-", "MEX"), type: type, orderId: orderId, amount: amount,
              status: "OPEN", note: note, txn: txn, at: now(), resolution: null };
    state.merch.exceptions.unshift(e);
    audit(actor, "登记周边支付异常", e.id + " · " + type + " · " + orderId + " · $" + amount + " · " + note);
    return { ok: true, exc: e };
  }

  /* ================================================================
     5.5) 报名侧：用户端走完 4 步流程后落进共享域
     ================================================================
     用户在前台完成的报名，必须落到<b>后台管得到的那一份对象</b>上，
     否则「前台发生的事，后台没有落点」这条毛病就还在。
     ⚠️ 这里只造 Demo 数据，不代表任何下单 / 支付的后端实现。 */
  var CAT_MAP = { "21k":"C-21K", "10k":"C-10K", "5k":"C-5K", "2k":"C-5K" };

  /* ⚖️ D-096 F-004 · 幂等边界是<b>这一笔支付 / 订单本身</b>，不是「这个赛事」。
     同一个买家完全可以合法地下第二单；但同一张订单成功页刷两次不能生出两张单。 */
  function orderByNo(orderNo) {
    if (!orderNo) return null;
    return state.orders.filter(function (o) { return o.orderNo === orderNo; })[0] || null;
  }

  /* ⚖️ D-098 A1 · 用户真正进入 KHQR 付款环节时，共享域里就必须<b>已经有</b>
     这张订单：PENDING_PAYMENT + Registration PENDING + 名额与配额 RESERVED。
     以前是等到 done 页才第一次建单，于是「名额为你保留 10:00」这句话背后
     什么都没有 —— 那是一句假话。建单不再等到付款成功。 */
  function createRegistrationOrder(input) {
    var actor = input.actor || { who: "user:u1", role: "USER" };
    var evId = input.eventId || "EV-A";
    /* A9 幂等：同一次结账（同一个 orderNo）重进 / 重渲染只对应同一张单 */
    var dup = orderByNo(input.orderNo);
    if (dup) return { ok: true, order: dup, idempotent: true };

    /* ⚖️ D-117 A3 · <b>报名开关是写入边界，不是一个前端提示。</b>
       ----------------------------------------------------------------
       用户可能在 OPS 点「停止报名」<b>之前</b>就已经走到第 1–4 步了。
       如果只把详情页的按钮改成「报名已暂停」，那条已经打开的结账仍然能
       创建一张新订单、占住名额 —— 开关就成了摆设。
       所以在<b>真正建单的这一刻</b>重新解析当前共享赛事，关着就拒绝。
       ⚠️ 拒绝发生在幂等判定<b>之后</b>：开关关上之前就已经存在的那张单
       原样有效（D-033：停止报名不取消任何既有订单、不动任何既有报名）。
       这一步不改预留、不建订单、不建报名，什么都不留下。 */
    var evForOpen = eventById(evId);
    if (!evForOpen) return { ok: false, msg: "赛事不存在：" + evId };
    if (evForOpen.registrationOpen !== true) {
      return { ok: false, registrationClosed: true,
        msg: "报名已暂停，请返回赛事详情。<b>本次没有创建任何订单 / 报名，也没有占用任何名额。</b>" };
    }

    var raw = input.participants || [];
    if (!raw.length) return { ok: false, msg: "订单必须至少有一个参赛人" };

    /* 1) 逐个参赛人命中<b>唯一一条</b>价格档（用的是共享域里那一套价格档事实） */
    var lines = [];
    for (var i = 0; i < raw.length; i++) {
      var pt = raw[i];
      var catId = CAT_MAP[pt.catId] || pt.catId;
      var cat = categoryById(evId, catId);
      if (!cat) return { ok: false, msg: "组别不存在：" + pt.catId };
      var elig = categoryEligibility(evId, catId, pt.ageOnRaceDay);
      if (!elig.ok) return { ok: false, msg: (pt.name || "参赛人") + "：" + elig.why };
      var m = matchPriceRule(evId, catId, pt.audience || "ALL");
      if (!m.ok) return { ok: false, msg: (pt.name || "参赛人") + "：" + m.why };
      lines.push({ pt: pt, catId: catId, cat: cat, rule: m.rule });
    }

    /* 2) ⚖️ A5 · 先按<b>整单</b>累计需求校验名额与配额，再决定建不建单。
       同组别 / 同价格档的多个参赛人必须合并算；任何一个桶不够 →
       <b>整单失败</b>，不半截预留、不留下任何改动。 */
    var plan = planReservation(evId, lines.map(function (l) {
      return { catId: l.catId, ruleId: l.rule.id };
    }));
    if (!plan.ok) {
      return { ok: false, msg: plan.why, capacity: true,
               detail: "这一单里同组别 / 同价格档的人是<b>合并</b>计算的，" +
                       "所以不会出现「两个人各自看见还剩 1 个」这种超卖。" };
    }

    /* 3) ⚖️ F-001 · 把订单<b>应付额</b>按分分摊到每一行：
       Σ(参赛人 paid 快照) 必须恰好等于 Order.amount。快照在建单那一刻冻结。 */
    var listPrices = lines.map(function (l) { return l.rule.price; });
    var orderAmount = (input.amount != null) ? input.amount
                    : listPrices.reduce(function (a, b) { return a + b; }, 0);
    var allocated = allocateAmounts(listPrices, orderAmount);

    var parts = lines.map(function (l, idx) {
      var opId = nextId("OP-", "OP");
      return {
        id: opId, name: l.pt.name, bib: null, regId: nextId("REG-", "REG"),
        cat: l.catId, catName: l.cat.name,
        /* 不可变财务快照：这个人<b>实际分摊到的应付 / 已付金额</b> */
        paid: allocated[idx],
        listPrice: l.rule.price,                     /* 折前挂牌价（留痕用，不是义务额） */
        audience: l.pt.audience || "ALL",
        priceRuleId: l.rule.id, priceRuleName: l.rule.name,
        opStatus: "ACTIVE", regStatus: "PENDING", purpose: "INITIAL",
        reg: R(l.pt.name, l.pt.phone, l.pt.dob, l.pt.gender, l.pt.nation, l.pt.size)
      };
    });

    var o = {
      id: nextId("ORD-", "ORD"), orderNo: input.orderNo || null,
      eventId: evId, buyer: input.buyer,
      buyerUserId: input.buyerUserId || null, phone: input.phone,
      amount: orderAmount, currency: "USD",
      status: "PENDING_PAYMENT", paidAt: null, archived: false,
      deadlineAt: null, deadline: null,      /* 下面按 holdSeconds 统一算出来 */
      discount: input.discount || 0, discountCode: input.discountCode || null,
      participants: parts, reservation: null
    };

    /* ⚖️ D-100 A1 · 付款窗口的业务截止时刻在建单这一刻定死，之后<b>只有</b>
       「重新生成 KHQR = 一笔新订单」能拿到新的窗口。页面重进 / 重渲染都不会延长它。 */
    var holdSec = (input.holdSeconds != null) ? input.holdSeconds
                : (input.holdMinutes == null ? 10 : input.holdMinutes) * 60;
    o.deadlineAt = input.deadlineAt || (Date.now() + holdSec * 1000);
    o.deadline = stampOf(o.deadlineAt);

    /* 4) 真的把名额与配额占住。占不住就<b>不建单</b>（上面已先校验，这里是写入边界兜底）。 */
    var rv = reserveOrder(o);
    if (!rv.ok) return { ok: false, msg: rv.why, capacity: true };
    state.orders.unshift(o);

    audit(actor, "用户进入报名付款（名额已预留）",
      o.id + (o.orderNo ? "（" + o.orderNo + "）" : "") + " · " + o.buyer + " · " + parts.length +
      " 名参赛人 · 应付 $" + fmt(o.amount) +
      (o.discount ? "（含优惠 " + (o.discountCode || "") + " −$" + fmt(o.discount) + "，已按分分摊到各参赛人快照）" : "") +
      " · Order=<b>PENDING_PAYMENT</b> · Registration=<b>PENDING</b> · 付款截止 " + o.deadline +
      " · " + parts.map(function (p) {
        return p.regId + " " + p.name + "（" + p.catName + " · " + p.priceRuleName + " · 快照 $" + fmt(p.paid) + "）";
      }).join("，") +
      " · <b>名额与价格档配额已 RESERVED（整单累计校验通过）</b>：" +
      Object.keys(rv.reservation.caps).map(function (k) { return k + "×" + rv.reservation.caps[k]; }).join("，") +
      " / " + Object.keys(rv.reservation.quotas).map(function (k) { return k + "×" + rv.reservation.quotas[k]; }).join("，") +
      " · 钱<b>尚未</b>到账 · 报名与周边是两笔独立订单，这一单不含任何周边行项");
    return { ok: true, order: o, reserved: true };
  }

  /* ⚖️ D-098 A2 · 支付成功<b>不新建订单</b>，只推进同一张 PENDING_PAYMENT。
     名额不再加第二次：RESERVED → CONSUMED 是一次搬运，不是一次新增。 */
  /* ⚖️ D-100 A2 / A5 · 「这张单现在还能不能正常付款」<b>只由业务截止时刻决定</b>，
     与倒计时是否还在跑、超时回调有没有执行过、页面开着没有<b>全都无关</b>。
     所以任何依赖 PENDING_PAYMENT 有效性的入口，进门第一件事都是调它：
     该过期的当场按既有语义过期<b>恰好一次</b>，再谈别的。 */
  function settleIfPastDeadline(o, actor) {
    if (!o || o.status !== "PENDING_PAYMENT") return { expired: false };
    if (!pastDeadline(o)) return { expired: false };
    var res = expireRegistrationOrder(o.id, actor || { who: "system", role: "SYSTEM" }, "ORDER_EXPIRED");
    return { expired: true, result: res };
  }

  function confirmRegistrationPayment(idOrNo, actor, txn) {
    /* ⚖️ D-125 R4 · 闸门放在<b>最前面</b>：没有资格的调用方连读都不该走进来，
       更不该顺带触发任何结算。<b>用户自称 ≠ 银行到账</b>，在截止前后一律成立。 */
    if (!canConfirmReceipt(actor)) {
      return receiptDenial((actor && actor.role) || "", "确认一笔报名付款到账");
    }
    var o = findOrder(idOrNo) || orderByNo(idOrNo);
    if (!o) return { ok: false, msg: "订单不存在：" + idOrNo };
    /* A9 幂等：成功页重渲染 → 同一张 PAID 订单，不做第二次名额 / 配额变更 */
    if (o.status === "PAID") return { ok: true, order: o, idempotent: true };
    /* ⚖️ A2 · 在<b>任何一处状态改动之前</b>先问截止时刻。
       挂起的标签页 / 从没跑过的超时回调都不能让一笔过期预留被当成正常付款吃掉。 */
    var late = settleIfPastDeadline(o, actor);
    if (late.expired) {
      return { ok: false, order: o, expired: true, justExpired: true,
        msg: "付款窗口已于 <b>" + o.deadline + "</b> 截止，这张订单已按既有语义过期：" +
             "名额与配额<b>恰好一次</b>放回公共池，报名 → CANCELLED(ORDER_EXPIRED)。" +
             "正常支付确认<b>不能</b>把已过期的订单变成已付款。" +
             "如果这笔钱确实到账了，它属于既有的<b>报名侧支付异常 / 迟到到账</b>流程，" +
             "由运营按那条既有路径处理，<b>不</b>在这里复活订单。" };
    }
    if (o.status !== "PENDING_PAYMENT") {
      return { ok: false, order: o, expired: o.status === "EXPIRED",
               msg: "只有 PENDING_PAYMENT 的报名订单可以确认支付，当前是 " + o.status +
               (o.status === "EXPIRED" ? "。付款窗口已过期、名额已放回公共池，" +
                "这笔钱走既有的报名侧支付异常 / 迟到到账流程处理。" : "") };
    }
    /* 预留必须仍然是 RESERVED —— 被释放过的预留不许再被消费 */
    if (!o.reservation || o.reservation.state !== "RESERVED") {
      return { ok: false, order: o,
               msg: "这张订单的名额预留当前是 " + ((o.reservation && o.reservation.state) || "无") +
                    "，不是 RESERVED，不能当作正常付款消费。" };
    }
    var mv = consumeOrderReservation(o);
    if (!mv.ok) return { ok: false, order: o, msg: mv.why };
    o.status = "PAID";
    o.paidAt = now();
    o.txn = txn || o.txn || null;
    o.participants.forEach(function (p) {
      if (p.regStatus === "PENDING") { p.regStatus = "CONFIRMED"; p.cancelReason = null; }
    });
    audit(actor || { who: "user:u1", role: "USER" }, "报名支付成功",
      o.id + (o.orderNo ? "（" + o.orderNo + "）" : "") + " · $" + fmt(o.amount) +
      (o.txn ? " · 流水 " + o.txn : "") +
      " · Order <b>PENDING_PAYMENT → PAID</b>（同一张单，不新建）· Registration PENDING → CONFIRMED" +
      " · 名额<b>不再加一次</b>，配额 <b>RESERVED → CONSUMED</b>：" + mv.moves.join("；") +
      " · 财务快照建单时已冻结，本步一个字未改");
    return { ok: true, order: o, moves: mv.moves };
  }

  /* ⚖️ D-098 A3 · 付款窗口超时：名额与配额是<b>真的</b>放回公共池，恰好一次。
     重复的超时回调 / 重渲染不会放第二次。已 CONSUMED 的配额永不恢复。 */
  function expireRegistrationOrder(idOrNo, actor, kind) {
    var o = findOrder(idOrNo) || orderByNo(idOrNo);
    if (!o) return { ok: false, msg: "订单不存在：" + idOrNo };
    if (o.status === "EXPIRED") return { ok: true, order: o, already: true };
    if (o.status !== "PENDING_PAYMENT") {
      return { ok: false, order: o, msg: "只有 PENDING_PAYMENT 的报名订单会因付款超时而过期，当前是 " + o.status };
    }
    var mv = releaseOrderReservation(o, kind || "ORDER_EXPIRED");
    if (!mv.ok) return { ok: false, order: o, msg: mv.why };
    o.status = "EXPIRED";
    o.expiredAt = now();
    o.participants.forEach(function (p) {
      if (p.regStatus === "PENDING") { p.regStatus = "CANCELLED"; p.cancelReason = "ORDER_EXPIRED"; }
    });
    audit(actor || { who: "system", role: "SYSTEM" },
      kind === "USER_CANCEL" ? "用户付款前取消报名订单" : "报名订单付款超时",
      o.id + (o.orderNo ? "（" + o.orderNo + "）" : "") +
      " · Order <b>PENDING_PAYMENT → EXPIRED</b> · Registration PENDING → CANCELLED(ORDER_EXPIRED)" +
      " · 名额与配额<b>恰好一次</b>放回公共池：" + mv.moves.join("；") +
      " · 配额是 RELEASED 不是 CONSUMED · 钱从未到账 · " +
      "若之后才收到钱，走既有的报名侧迟到到账处理，<b>不</b>在这里复活订单");
    return { ok: true, order: o, moves: mv.moves };
  }

  /* ⚖️ D-106 FQA-001 · 付款前取消：与超时过期<b>并列</b>的一条真实业务路径。
     以前后台只把订单状态改掉，却在 Audit 里写「名额与价格档各释放一次」——
     钱没收到、位子却一直被占着，而流水上说已经放回去了。假成功审计比不做更糟。
     现在它和超时走<b>同一套</b>预留释放语义：以订单自己的预留事实为
     exactly-once 锚点，绝不无条件 reserved -= 1。
     ⚠️ 它与超时<b>不是</b>一回事：cancelReason 是 ORDER_CANCELLED，
     而报名侧「迟到到账恢复」那条路只认 ORDER_EXPIRED（D-011），两者不合并。 */
  function cancelRegistrationOrderBeforePayment(idOrNo, actor, reason) {
    var o = findOrder(idOrNo) || orderByNo(idOrNo);
    if (!o) return { ok: false, msg: "订单不存在：" + idOrNo };
    if (o.status === "CANCELLED") {
      return { ok: true, order: o, already: true, moves: (o.reservation && o.reservation.moves) || [] };
    }
    /* 执行那一刻重新问一遍，弹窗可能已经过期 */
    if (o.status !== "PENDING_PAYMENT") {
      return { ok: false, order: o,
               msg: "只有 PENDING_PAYMENT 的报名订单可以走付款前取消，当前是 " + o.status +
                    (o.status === "PAID" ? "。这张单的钱<b>已经收到</b>了，" +
                     "要取消只能走参赛人退款流程，不能当作「没收到钱」处理。" : "") };
    }
    if (o.paidAt) {
      return { ok: false, order: o, msg: "该订单已确认到账（" + o.paidAt + "），不能按未付款取消" };
    }
    /* ⚖️ D-107 · <b>截止时刻先说话，人工取消才轮得到。</b>
       一张早就过了付款窗口、只是没人碰过的 PENDING_PAYMENT 订单，
       如果在这里被当成「付款前取消」处理，它就会拿到 ORDER_CANCELLED ——
       而那是<b>终态</b>，进不了既有的迟到到账处理路径。
       于是「钱其实晚到了」这件事就永远没地方兜底，是这张单被走错了路。
       它本来的归宿是 ORDER_EXPIRED，所以这里直接复用<b>同一个</b>过期原语，
       不另抄一份截止判定 / 预留释放 / 报名取消 / 过期 Audit。 */
    var late = settleIfPastDeadline(o, actor);
    if (late.expired) {
      return { ok: false, order: o, expired: true, justExpired: true,
        msg: "付款窗口已于 <b>" + o.deadline + "</b> 截止，这张订单<b>不是</b>被人工取消的，" +
             "而是按既有语义<b>过期</b>了：名额与配额恰好一次放回公共池，" +
             "报名 → CANCELLED(<b>ORDER_EXPIRED</b>)。" +
             "<br>这个区别很重要：ORDER_EXPIRED 之后如果钱其实晚到了，还能走既有的" +
             "报名侧迟到到账处理；而 ORDER_CANCELLED 是终态，那条路走不了。" +
             "所以过了截止时刻的单<b>不能</b>再按人工取消记账。" };
    }
    if (!o.reservation || o.reservation.state !== "RESERVED") {
      return { ok: false, order: o,
               msg: "这张订单的名额预留当前是 " + ((o.reservation && o.reservation.state) || "无") +
                    "，不是 RESERVED，无法按付款前取消释放" };
    }
    var mv = releaseOrderReservation(o, "ORDER_CANCELLED");
    if (!mv.ok) return { ok: false, order: o, msg: mv.why };
    o.status = "CANCELLED";
    o.cancelledAt = now();
    var n = 0;
    o.participants.forEach(function (p) {
      if (p.regStatus === "PENDING") { p.regStatus = "CANCELLED"; p.cancelReason = "ORDER_CANCELLED"; n++; }
    });
    audit(actor || { who: "admin:ops", role: "OPS" }, "付款前取消订单",
      o.id + (o.orderNo ? "（" + o.orderNo + "）" : "") + " · 原因：" + (reason || "—") +
      " · Order <b>PENDING_PAYMENT → CANCELLED</b> · 连带取消 " + n + " 条待付款报名" +
      "（CANCELLED / ORDER_CANCELLED）· 名额与价格档<b>恰好一次</b>放回公共池：" +
      mv.moves.join("；") +
      " · <b>不产生退款</b>（钱从来没收到过）" +
      " · ORDER_CANCELLED 是终态，<b>不</b>走迟到到账恢复那条路（那条只认 ORDER_EXPIRED）");
    return { ok: true, order: o, cancelledRegs: n, moves: mv.moves };
  }

  /* ⚖️ D-111 根 B · 「钱其实在截止之后才到」必须有一个真实落点。
     ----------------------------------------------------------------
     正常支付确认对过期订单是<b>严格拒绝</b>的（NF-REG-01，保持不变）。
     但拒绝只解决了「不能假装按时付了」，没解决「钱确实收到了怎么办」——
     那笔钱是真实存在的事实，它得有个地方落下来，让财务看得见、能处置。

     以前 Demo 里只有种子 EXC-5 一条死数据：用户在浏览器里跑出来的过期订单，
     后面就算真的到账，也变不成一条财务能处理的异常。于是这条业务链在 Demo 里
     是断的。

     这里补上唯一的落点：登记一笔<b>真实到账</b>，产出报名侧既有的
     LATE_ARRIVAL 支付异常（OPEN）。它<b>不</b>做任何恢复：
     订单仍 EXPIRED、报名仍 CANCELLED(ORDER_EXPIRED)、名额与配额保持已释放。
     接下来是接受还是拒绝，由财务按<b>既有</b>流程决定 —— 不新造第二套。
     ⚠️ 这是报名侧的 LATE_ARRIVAL，与周边侧是两个独立的财务域，不混用。 */
  function registrationExceptions() {
    if (!Array.isArray(state.regExceptions)) state.regExceptions = [];
    return state.regExceptions;
  }
  /* ⚖️ D-112 A1 · 谁有资格说「钱到了」。
     ----------------------------------------------------------------
     上一轮把这条链接通了，但接错了一头：用户点一下「人工核查」，
     共享域就当场生成一条<b>已确认到账</b>的财务事实，流水号还是拿订单号
     现编的。那不是到账，那是<b>用户自称</b>——两者差着一整个银行。

     真实到账只能由<b>能代表钱确实进来了的那一方</b>登记：
     财务（核对过银行流水），或 Demo 里代表支付通道的模拟器。
     用户说自己付过了，是一条<b>待核查的诉求</b>，不是一笔钱。 */
  var RECEIPT_AUTHORITIES = ["FINANCE", "SYSTEM", "PAYMENT_PROVIDER"];
  /* ⚖️ D-125 R4 · <b>「钱到了」这句话谁有资格说</b>——只有这一份名单。
     D-112 已经把它立在「超时后到账」那一条路上，可<b>正常付款确认</b>那条路
     当时根本没有闸门：任何调用方随手传一个 role 就能把 PENDING_PAYMENT 写成
     PAID、把报名写成 CONFIRMED。于是用户点一下「人工核查」＝银行确认到账。
     现在两条路共用同一个判定，<b>绝不另立第二份名单</b>。
     ⚠️ OPS / SUPPORT 能点很多运营按钮，但那不代表他们是支付通道 ——
     没有任何既有冻结规则授权他们确认一笔到账。 */
  function canConfirmReceipt(actor) {
    return RECEIPT_AUTHORITIES.indexOf((actor && actor.role) || "") >= 0;
  }
  function receiptDenial(role, what) {
    return { ok: false, unauthorized: true,
      msg: "<b>不能由「" + (role || "未知身份") + "」" + what + "。</b>" +
           "用户说自己付过款，是一条<b>待核查的诉求</b>，不是一笔已确认的钱；" +
           "运营 / 客服也不是支付通道。只有<b>核对过银行流水的财务</b>、" +
           "或代表支付通道的系统入账事件，才能把「钱确实到了」写成业务事实。" };
  }
  /* ⚖️ D-125 R2 / R3 · <b>「我好像付过了，帮我查一下」</b>是一条诉求，不是一笔钱。
     ----------------------------------------------------------------
     这个入口<b>明确非财务</b>：不改订单状态、不改报名、不碰名额 / 配额 / 预留、
     不建 Refund、不建支付异常、不产生任何流水或到账事实。
     它只留下一条<b>只增不改</b>的核查诉求记录，让后台知道「有人说他付过了」。
     付款窗口该走完还是走完，该过期还是过期（R8）；真到账了走既有的授权入口。
     重复点击不会制造第二条事实：同一张单在同一个状态下只记一次。 */
  function requestPaymentCheck(idOrNo, actor, note) {
    var o = findOrder(idOrNo) || orderByNo(idOrNo);
    if (!o) return { ok: false, msg: "订单不存在：" + idOrNo };
    if (!Array.isArray(o.checkRequests)) o.checkRequests = [];
    var last = o.checkRequests[o.checkRequests.length - 1];
    if (last && last.orderStatus === o.status) {
      return { ok: true, order: o, financial: false, duplicate: true, request: last,
               msg: "你的付款核查请求已经在处理中了，重复提交不会加快，也不会改变订单状态。" };
    }
    var req = { at: now(), by: (actor && actor.who) || "user", role: (actor && actor.role) || "USER",
                orderStatus: o.status, note: note || null, financial: false };
    o.checkRequests.push(req);
    audit(actor || { who: "user:u1", role: "USER" }, "用户提交付款核查请求",
      o.id + (o.orderNo ? "（" + o.orderNo + "）" : "") + " · 订单当前 <b>" + o.status + "</b>" +
      " · <b>这是一条待核查的诉求，不是一笔到账</b>：本次<b>没有</b>改动订单 / 报名 / " +
      "名额 / 配额 / 预留，<b>没有</b>产生任何流水、退款或支付异常。" +
      "付款窗口按原有规则继续走；钱是否真的到了，仍然只能由财务核对流水、" +
      "或由代表支付通道的系统入账事件来认定。");
    return { ok: true, order: o, financial: false, request: req,
             msg: "已收到你的付款核查请求。我们会核对付款记录；在核查完成前，" +
                  "订单状态不会因为这次提交而改变。" };
  }

  function recordRegistrationLateReceipt(idOrNo, actor, amount, txn) {
    if (!canConfirmReceipt(actor)) {
      return receiptDenial((actor && actor.role) || "", "登记一笔真实到账");
    }
    var o = findOrder(idOrNo) || orderByNo(idOrNo);
    if (!o) return { ok: false, msg: "订单不存在：" + idOrNo };
    /* 只有「钱到得太晚」才算迟到到账。订单还在付款窗口里，那是正常付款。 */
    if (o.status !== "EXPIRED") {
      return { ok: false, order: o,
               msg: "只有已过期的报名订单才谈得上「超时后到账」，当前是 " + o.status };
    }
    var amt = (amount != null) ? amount : o.amount;
    if (!(amt > 0)) return { ok: false, order: o, msg: "到账金额必须是有效正数" };
    /* ⚖️ A3 · 流水号是<b>凭证</b>，不是域能凭空编出来的东西。
       没有凭证就没有「这笔钱到了」这个事实，别拿订单号冒充银行流水。 */
    var ref = String(txn == null ? "" : txn).trim();
    if (!ref) {
      return { ok: false, order: o, missingTxn: true,
        msg: "<b>缺少到账凭证。</b>登记一笔真实到账必须带上银行 / 通道的流水号 —— " +
             "那是「这笔钱确实进来了」的唯一证据。系统<b>不会</b>替它编一个，" +
             "更不会拿订单号当流水号：订单存在只能证明有人下过单，证明不了钱到了。" };
    }
    var list = registrationExceptions();
    /* ⚖️ B4 · 幂等锚点是<b>这一笔真实流水</b>，不是「这个订单」也不是「这个赛事」。
       同一笔流水重复登记不产生第二条 OPEN；而真正不同的第二笔到账是<b>另一个</b>
       钱的事实，必须能各自留痕、各自处置。 */
    var dup = list.filter(function (x) {
      return x.type === "LATE_ARRIVAL" && x.orderId === o.id && x.txn === ref;
    })[0];
    if (dup) return { ok: true, exception: dup, idempotent: true, order: o };

    /* ⚖️ 异常单的种子在 Admin 那边（EXC-1..EXC-5），共享域的序号不知道它们的存在，
       直接 nextId 会撞号 —— 两条不同的钱的事实共用一个编号，财务就没法引用了。
       所以按<b>当前表里已有的最大编号</b>往下发。 */
    var maxN = 0;
    list.forEach(function (x) {
      var m = /^EXC-(\d+)$/.exec(String(x && x.id || ""));
      if (m && +m[1] > maxN) maxN = +m[1];
    });
    var exc = {
      id: "EXC-" + (maxN + 1), type: "LATE_ARRIVAL", orderId: o.id,
      amount: amt, status: "OPEN", txn: ref,
      /* note 会被后台以纯文本转义渲染，这里不放 HTML 标签 */
      note: "订单已于 " + (o.expiredAt || o.deadline || "—") + " 过期、报名已 CANCELLED(ORDER_EXPIRED)，" +
            "之后才收到 $" + fmt(amt) + "。名额与价格档在过期时已释放，本条不恢复任何东西。"
    };
    list.unshift(exc);
    audit(actor || { who: "system", role: "SYSTEM" }, "报名超时后到账",
      o.id + (o.orderNo ? "（" + o.orderNo + "）" : "") + " · $" + fmt(amt) + " · 流水 " + ref +
      " · 登记为报名侧支付异常 <b>" + exc.id + " · LATE_ARRIVAL · OPEN</b>" +
      " · 订单<b>保持 EXPIRED</b>、报名保持 CANCELLED(ORDER_EXPIRED)、名额与配额保持已释放" +
      " · <b>不自动恢复、不自动退款</b>：接受还是拒绝由 FINANCE 按既有流程决定");
    return { ok: true, exception: exc, order: o };
  }

  /* ================================================================
     D-096 F-005 · 参赛人退款的执行期业务不变量
     ----------------------------------------------------------------
     渲染时能发起，不等于执行那一刻还能发起。过期弹窗必须失败关闭。
     ================================================================ */
  function canCreateParticipantRefund(opId) {
    var f = findOP(opId);
    if (!f) return { ok: false, msg: "找不到该参赛人（可能已被其它操作改变）。" };
    if (f.o.status === "PENDING_PAYMENT") {
      return { ok: false, msg: "订单尚未付款，没有可退的钱；未付款订单请走「付款前取消」。" };
    }
    var open = openRefundOf(opId);
    if (open) {
      return { ok: false, msg: "该参赛人已有一笔<b>进行中</b>的退款 " + open.id + "（" + open.status +
               "）。同一个参赛人同一时刻只允许一笔进行中的退款。" };
    }
    if (f.p.regStatus !== "CONFIRMED") {
      return { ok: false, msg: "该参赛人的报名当前是 <code>" + f.p.regStatus + "(" + (f.p.cancelReason || "-") +
               ")</code>，已经不是有效参赛资格，不能再发起标准退赛退款。" };
    }
    if (f.p.opStatus === "REFUNDED") {
      return { ok: false, msg: "该参赛人已是已退款终态，不能重复发起标准退款。" };
    }
    return { ok: true, f: f };
  }

  /* ================================================================
     D-097 F-002 补扫 · 超时订单「接受迟到到账并恢复报名」的唯一判定
     ----------------------------------------------------------------
     这是全系统唯一一条 Order: EXPIRED → PAID 的逆向路径。恢复报名 =
     <b>重新占用名额、重新消耗配额</b>，因此它和新报名走的必须是同一套
     不变量：按<b>每一个</b>待恢复参赛人各自命中的那一档判定，而不是
     「随便找一档还有余量的」。弹窗上的校验结论不是权威，执行那一刻要
     用当前状态重新跑一遍。
     ================================================================ */
  function validateExpiredRestore(orderId) {
    var o = findOrder(orderId);
    if (!o) return { ok: false, rows: [], why: "订单不存在" };
    if (o.status !== "EXPIRED") {
      return { ok: false, rows: [], why: "只有 EXPIRED 的订单可以走迟到到账恢复，当前是 " + o.status };
    }
    var targets = o.participants.filter(function (p) {
      return p.regStatus === "CANCELLED" && p.cancelReason === "ORDER_EXPIRED";
    });
    if (!targets.length) {
      return { ok: false, rows: [], why: "这张订单没有因订单过期而取消的报名，无可恢复项" };
    }
    /* 同一张订单里可能有多人落在同一组别 / 同一价格档：必须<b>累计</b>算，
       否则两个人各自看「还剩 1 个」，一起恢复就超卖了。 */
    var capNeed = {}, quotaNeed = {}, rows = [], allOk = true;
    targets.forEach(function (p) {
      var cat = categoryById(o.eventId, p.cat);
      var rule = p.priceRuleId ? priceRuleById(o.eventId, p.priceRuleId) : null;
      capNeed[p.cat] = (capNeed[p.cat] || 0) + 1;
      var capOk = !!cat && (capOccupied(cat) + capNeed[p.cat]) <= cat.cap;
      var quotaOk, why = [];
      if (!rule) { quotaOk = false; why.push("找不到当初命中的价格档，不能拿别的档顶替"); }
      else {
        quotaNeed[rule.id] = (quotaNeed[rule.id] || 0) + 1;
        quotaOk = (rule.quota == null) || (quotaOccupied(rule) + quotaNeed[rule.id]) <= rule.quota;
        if (!quotaOk) why.push("价格档 " + rule.name + " 配额已无余量（已占用 " + quotaOccupied(rule) + "/" + rule.quota + "）");
      }
      if (!cat) why.push("组别不存在");
      else if (!capOk) why.push("组别 " + cat.name + " 名额已无余量（已占用 " + capOccupied(cat) + "/" + cat.cap + "）");
      var rOk = capOk && quotaOk;
      if (!rOk) allOk = false;
      rows.push({ p: p, cat: cat, rule: rule, capOk: capOk, quotaOk: quotaOk, ok: rOk, why: why.join("；") });
    });
    return { ok: allOk, order: o, rows: rows,
             why: allOk ? "" : rows.filter(function (r) { return !r.ok; })
                                   .map(function (r) { return holderOf(r.p) + "：" + r.why; }).join("；") };
  }
  function rollbackRestore(evId, applied) {
    applied.forEach(function (a) {
      if (a.kind === "cap") releaseCapacity(evId, a.id);
      else { var r = priceRuleById(evId, a.id); if (r) r.used = Math.max(0, r.used - 1); }
    });
  }
  /* 唯一的写入口：写之前必再跑一次校验器，任一行不过就整单失败关闭。 */
  function restoreExpiredRegistrations(orderId, actor) {
    var v = validateExpiredRestore(orderId);
    if (!v.ok) return { ok: false, msg: v.why, rows: v.rows };
    /* 写入边界自己也会失败关闭（A6）：先整单预演一遍，任何一格写不进去就
       整单放弃，不留半截改动。恢复的是<b>已确认</b>报名，因此直接进 used，
       不经过 RESERVED。 */
    var moves = [], applied = [];
    for (var i = 0; i < v.rows.length; i++) {
      var r = v.rows[i];
      var cap = occupyCapacity(v.order.eventId, r.p.cat);
      if (!cap.ok) { rollbackRestore(v.order.eventId, applied); return { ok: false, msg: cap.why, rows: v.rows }; }
      applied.push({ kind: "cap", id: r.p.cat });
      var q = consumeQuota(v.order.eventId, r.rule.id);
      if (!q.ok) { rollbackRestore(v.order.eventId, applied); return { ok: false, msg: q.why, rows: v.rows }; }
      applied.push({ kind: "quota", id: r.rule.id });
      r.p.regStatus = "CONFIRMED";
      r.p.cancelReason = null;
      moves.push(r.p.regId + " · " + r.p.cat + " 名额 " + cap.before + "→" + cap.after +
                 " · " + r.rule.id + " 配额 " + q.before + "→" + q.after);
    }
    v.order.status = "PAID";
    v.order.paidAt = now();
    /* 这张单当初过期时预留已经 RELEASED；恢复后它的占用记在 used 上。 */
    if (v.order.reservation) v.order.reservation.state = "CONSUMED";
    return { ok: true, order: v.order, rows: v.rows, moves: moves };
  }

  /* ================================================================
     D-096 F-008 / F-009 · Bib 分配的<b>唯一</b>校验器
     ----------------------------------------------------------------
     手工 / AUTO / CSV 三条路径必须共用同一份业务规则，
     并且都要在<b>真正写入的那一刻</b>用当前状态重新跑一遍。
     ================================================================ */
  function bibConfigOf(evId, catId) {
    return (state.bibConfig || []).filter(function (c) {
      return c.eventId === evId && c.catId === catId;
    })[0] || null;
  }
  function bibRecord(evId, bib) {
    return state.bibs.filter(function (b) { return b.eventId === evId && b.bib === String(bib); })[0] || null;
  }
  /* opts.swap = 现场换号：目标<b>本来就该</b>有一个当前号（旧号），
     其余全部规则——号段 / 预留段 / 历史号永不复用 / 组别 / 赛事归属 / 赛内唯一——
     与手工 / AUTO / CSV <b>完全一致</b>。换号不是第四套规则。 */
  function validateBibAssignment(regId, bib, opts) {
    var errs = [];
    var swap = !!(opts && opts.swap);
    var f = findOPByReg(regId);
    if (!f) return { ok: false, errs: ["目标 Registration 不存在（" + (regId || "空") + "）"] };
    var evId = f.o.eventId;
    var n = parseInt(bib, 10);
    if (!bib || isNaN(n) || String(n) !== String(bib).trim()) {
      errs.push("号码不是合法数字（" + (bib || "空") + "）");
    }
    if (f.p.regStatus !== "CONFIRMED") {
      errs.push("该报名当前是 " + f.p.regStatus + "，不是可分配号码布的有效参赛资格");
    }
    if (swap) {
      if (!currentBib(f.p.regId)) errs.push("该报名当前没有号码布，换号无从换起；请走分配");
    } else if (currentBib(f.p.regId)) {
      errs.push("该报名已有当前号码布 " + currentBib(f.p.regId) + "，不覆盖既有绑定");
    }
    var cfg = bibConfigOf(evId, f.p.cat);
    if (!cfg) {
      errs.push("该赛事 / 组别没有号段配置（" + evId + " / " + f.p.cat + "）");
    } else if (!isNaN(n)) {
      if (n < cfg.from || n > cfg.to) errs.push("号码超出该组别号段（" + cfg.from + "–" + cfg.to + "）");
      else if (cfg.reservedFrom != null && n >= cfg.reservedFrom && n <= cfg.reservedTo) {
        errs.push("落在预留段（" + cfg.reservedFrom + "–" + cfg.reservedTo + "）");
      }
    }
    var exist = bibRecord(evId, bib);
    if (exist) {
      if (exist.status === "ASSIGNED") errs.push("该号已 ASSIGNED（" + (exist.name || "—") + "）");
      else if (exist.status === "SUPERSEDED") errs.push("该号是 SUPERSEDED 历史号，永不复用");
      else if (exist.status === "VOIDED") errs.push("该号已 VOIDED，永不复用");
      else if (exist.status === "RESERVED") errs.push("该号是 RESERVED 预留号");
      else errs.push("该号在本场已存在（" + exist.status + "）");
    }
    return { ok: !errs.length, errs: errs, f: f, eventId: evId, cat: f.p.cat };
  }
  /* 唯一的写入口：写之前必再跑一次校验器 */
  function assignBib(regId, bib, actor, note, opts) {
    var v = validateBibAssignment(regId, bib, opts);
    if (!v.ok) return { ok: false, errs: v.errs, msg: v.errs.join("；") };
    state.bibs.push({ bib: String(bib), eventId: v.eventId, regId: regId,
      name: holderOf(v.f.p), status: "ASSIGNED", at: now(),
      by: (actor && actor.who) || "system", note: note || "" });
    v.f.p.bib = String(bib);
    return { ok: true, bib: String(bib), f: v.f };
  }
  /* 可用池：号段 − 预留段 − 全部历史记录（含 ASSIGNED / SUPERSEDED / VOIDED / RESERVED） */
  function bibPool(evId, catId, limit) {
    var cfg = bibConfigOf(evId, catId);
    if (!cfg) return [];
    var taken = {};
    state.bibs.forEach(function (b) { if (b.eventId === evId) taken[b.bib] = b.status; });
    var out = [];
    for (var n = cfg.from; n <= cfg.to && out.length < (limit || 9999); n++) {
      if (cfg.reservedFrom != null && n >= cfg.reservedFrom && n <= cfg.reservedTo) continue;
      if (taken[String(n)]) continue;
      out.push(String(n));
    }
    return out;
  }

  /* ================================================================
     D-096 F-006 · 参赛人「改拼写」与「换人」是两件事
     ----------------------------------------------------------------
     holderId 是身份，holder 是这个身份当前的显示拼写。
     修改资料只能改拼写；换人只有转让这一条路。
     ================================================================ */
  function normName(s) {
    return String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fa5]+/g, " ").trim();
  }
  function editDistance(a, b) {
    var m = a.length, n = b.length, prev = [], cur = [], i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      for (j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
  }
  /* 只接受「同一个人的拼写更正」：格式化差异 / 词序调换 / 小幅笔误。
     其余一律视为换人，交给转让。这是 Demo 的确定性判定口径。 */
  function isSpellingCorrection(oldName, newName) {
    var a = normName(oldName), b = normName(newName);
    if (!a || !b) return false;
    if (a === b) return true;
    var ta = a.split(" ").slice().sort().join(" ");
    var tb = b.split(" ").slice().sort().join(" ");
    if (ta === tb) return true;                       /* 词序调换 */
    var d = editDistance(a, b);
    return d <= 2 && Math.min(a.length, b.length) >= 3;
  }

  /* ================================================================
     D-098 根 B · Race Pack 名单只有一个权威来源（F-003）
     ----------------------------------------------------------------
     「这个人在不在领物名单里」由<b>共享 Registration</b> 决定，
     「他的号码布是几号」由 BibAssignment 决定，
     「他领没领 / 证件核验过没有」才是 Race Pack 自己的运营事实。

     以前 Admin 另有一张持久化的 DB.racepack 名单在决定「存在与否」：
     新报名进来了、号码布也分了，Admin 领物台却查无此人；而超时恢复那条
     路径又会手工 push 一行进去 —— 名单的存在与否取决于走了哪条代码路径。
     现在名单一律派生，运营事实按 regId 挂靠，不再决定存在性。
     ================================================================ */
  function racePackEligibility(o, p) {
    if (p.regStatus !== "CONFIRMED") {
      return { ok: false, blocked: "REG", why: "该报名当前是 " + p.regStatus +
               "（" + (p.cancelReason || "-") + "），不是有效参赛资格，不能领物" };
    }
    var open = openRefundOf(p.id);
    if (open) {
      return { ok: false, blocked: "REFUND", refund: open,
               why: "存在进行中的退款 " + open.id + "（" + open.status + "）" };
    }
    return { ok: true };
  }
  /* 名单成员 = 钱真的到过账的那些报名（PAID / 部分退款的订单）。
     付款窗口里的 PENDING_PAYMENT 与已过期的订单没有领物这回事。 */
  function racePackRoster(evId) {
    var out = [];
    state.orders.forEach(function (o) {
      if (evId && o.eventId !== evId) return;
      if (o.status !== "PAID" && o.status !== "PARTIALLY_REFUNDED") return;
      o.participants.forEach(function (p) {
        var cat = categoryById(o.eventId, p.cat);
        var el = racePackEligibility(o, p);
        out.push({
          regId: p.regId, opId: p.id, orderId: o.id, eventId: o.eventId,
          name: holderOf(p),                       /* 当前持有人（转让 / 改拼写立刻生效） */
          holderId: p.reg && p.reg.holderId,
          bib: currentBib(p.regId),                /* 当前权威号码布，没有就是 null */
          cat: p.cat, catName: (cat && cat.name) || p.catName || p.cat,
          audience: p.audience || "ALL",
          localPrice: (p.audience || "ALL") === "LOCAL",
          regStatus: p.regStatus, cancelReason: p.cancelReason || null,
          cancelled: p.regStatus !== "CONFIRMED",
          openRefund: el.refund || null,
          eligible: el.ok, blocked: el.blocked || null, why: el.why || ""
        });
      });
    });
    return out;
  }
  /* ================================================================
     D-100 根 B（F-003）· 领物运营事实的<b>唯一</b>权威与唯一写入口
     ----------------------------------------------------------------
     名单归属早已收口（派生自共享 Registration）。这一轮收口的是<b>写</b>：
     工作人员端原本把「已发包 / 已核验」写在自己的 S.packs / S.idChecked 里，
     后台写共享事实，于是同一个人在两端一个显示已领、一个显示未领。

     现在只有一份 state.racePackFacts，按 <b>regId</b> 挂靠：
       · 谁在名单里   → 共享 Registration
       · 号码布是几号 → BibAssignment
       · 领没领 / 核验过没有 → 这里，且只有下面这几个入口能写
     离线只是<b>运输</b>：排队 → 联网后重跑同一个入口 → 当前事实说不行就不写。
     ================================================================ */
  function racePackFact(regId) {
    return (state.racePackFacts || []).filter(function (f) { return f.regId === regId; })[0] || null;
  }
  function racePackFactEnsure(regId) {
    var f = racePackFact(regId);
    if (!f) { f = { regId: regId, picked: false, idVerified: false }; state.racePackFacts.push(f); }
    return f;
  }
  function racePackPicked(regId) {
    var f = racePackFact(regId);
    return !!(f && f.picked);
  }
  function racePackIdVerified(regId) {
    var f = racePackFact(regId);
    return !!(f && f.idVerified);
  }
  /* 发包资格：报名状态 / 进行中退款 / 是否已领 / 本地价是否已核验，
     全部现取当前事实。渲染层与执行层用的是同一个判定。 */
  function canIssueRacePack(regId) {
    var row = racePackRow(regId);
    if (!row) return { ok: false, why: "找不到该报名（名单派生自共享 Registration）" };
    var el = racePackEligibility(null, findOPByReg(regId).p);
    if (!el.ok) return { ok: false, why: el.why, blocked: el.blocked, refund: el.refund, row: row };
    if (racePackPicked(regId)) {
      var f = racePackFact(regId);
      return { ok: false, why: "该参赛者已于 " + (f.pickedAt || "—") + " 由 " + (f.pickedBy || "—") +
               " 领过包，不重复发放", blocked: "PICKED", row: row };
    }
    if (row.localPrice && !racePackIdVerified(regId)) {
      return { ok: false, why: "本地价参赛者必须先核验证件才能发包", blocked: "ID", row: row };
    }
    return { ok: true, row: row };
  }
  /* 唯一发包写入口。两端（后台 / 现场工作台，在线或离线补同步）都走它。 */
  function issueRacePack(regId, actor, opts) {
    var o = opts || {};
    var gate = canIssueRacePack(regId);
    if (!gate.ok) return { ok: false, why: gate.why, blocked: gate.blocked, row: gate.row };
    var f = racePackFactEnsure(regId);
    f.picked = true;
    f.pickedAt = o.at || now();
    f.pickedBy = o.by || (actor && actor.who) || "system";
    f.device = o.device || null;
    f.offlineSynced = !!o.offline;
    audit(actor || { who: "system", role: "SYSTEM" }, "Race Pack 发包",
      regId + " · " + gate.row.name + " · Bib " + (gate.row.bib || "待分配") +
      " · packet_picked_up_at=" + f.pickedAt + " · 操作人 " + f.pickedBy +
      (o.device ? " · Device " + o.device : "") +
      (o.offline ? " · <b>离线补同步</b>（联网后按当前事实重新校验通过才写入）" : "") +
      " · 领物是独立时间戳事实，<b>不进</b> Registration 状态机（D-014）");
    return { ok: true, fact: f, row: gate.row };
  }
  function verifyRacePackId(regId, actor) {
    var row = racePackRow(regId);
    if (!row) return { ok: false, why: "找不到该报名" };
    var f = racePackFactEnsure(regId);
    if (f.idVerified) return { ok: true, fact: f, row: row, already: true };
    f.idVerified = true;
    f.verifiedAt = now();
    f.verifiedBy = (actor && actor.who) || "system";
    audit(actor || { who: "system", role: "SYSTEM" }, "证件核验",
      regId + " · " + row.name + " · Bib " + (row.bib || "待分配") +
      " · 本地价证件核验通过（只核验匹配与否，<b>不留存证件号原值</b>）");
    return { ok: true, fact: f, row: row };
  }
  /* 换人之后证件核验必须重做：这也是领物运营事实的一次变更，走命名入口留痕。 */
  function resetRacePackIdVerification(regId, actor, why) {
    var f = racePackFactEnsure(regId);
    if (!f.idVerified) return { ok: true, fact: f, already: true };
    f.idVerified = false; f.verifiedAt = null; f.verifiedBy = null;
    audit(actor || { who: "system", role: "SYSTEM" }, "证件核验作废",
      regId + " · " + (why || "参赛人已转让，原核验对新持有人无效") +
      " · 新持有人需<b>重新</b>核验证件才能领物");
    return { ok: true, fact: f };
  }
  function undoRacePack(regId, actor, reason) {
    var row = racePackRow(regId);
    var f = racePackFact(regId);
    if (!f || !f.picked) return { ok: false, why: "该参赛者当前没有领物记录可撤销" };
    var was = f.pickedAt;
    f.picked = false; f.pickedAt = null; f.pickedBy = null; f.device = null; f.offlineSynced = false;
    audit(actor || { who: "system", role: "SYSTEM" }, "撤销领物",
      regId + " · " + ((row && row.name) || "—") + " · 原发出时间 " + was + " · 原因：" + (reason || "—") +
      " · <b>只清履约字段</b>，Registration 状态未变");
    return { ok: true, fact: f };
  }
  /* ⚖️ D-102 F-003 兼容收口 · 把<b>历史</b>的领物事实收编进共享表。
     ----------------------------------------------------------------
     升级前的工作人员端把「已发包 / 已核验」存在自己的 S.packs / S.idChecked 里，
     那些是<b>真实发生过的物理事实</b>（包确实交出去了、证件确实核验过）。
     升级后权威搬到了共享表，如果不收编，就会出现
     「工作人员端历史说领过、后台说没领 → 后台还能再发一次」。

     这条路径与 issueRacePack() <b>刻意不同</b>：
       · 它记录的是<b>已经发生的历史</b>，不是此刻要不要发包的决定，
         因此不跑「当前是否有进行中退款」这类<b>准入</b>校验；
       · 它<b>不写 Audit</b>、不产生副作用 —— 否则每次刷新都会多一条流水；
       · 它是<b>单调</b>的：false + 合法历史 true → true；已经 true 就原样不动。
         永远不会因为老缓存缺字段而把 true 打回 false，
         也不会用更老的记录覆盖更新的当前事实。
     无法确定性映射到某个 Registration 的脏数据一律忽略，
     <b>绝不</b>为此凭空给另一个人造出一条领物记录。 */
  function legacyWorkerRacePackAdopted() {
    return !!(state.compat && state.compat.legacyWorkerRacePack);
  }
  function adoptLegacyRacePackFacts(input) {
    if (!state.compat) state.compat = { legacyWorkerRacePack: false };
    /* ⚖️ D-104 Rule 1 / Rule 2 · <b>一次性</b>。
       历史数据只有一次影响当前事实的机会，用完这个权利就永久消失。
       否则会出现这条真实的时序漏洞：
         历史说「领过」→ 收编 → 后台<b>撤销误操作</b>（picked → false，这是更新的真事实）
         → 工作人员端刷新 → 旧存档又被重放 → picked 被打回 true
       检查点存在共享域并与事实同批落盘，所以「已经迁移过」这件事
       不会因为页面本地那个标记没写进磁盘而失效。 */
    if (legacyWorkerRacePackAdopted()) {
      return { ok: true, skipped: true, adoptedPick: 0, adoptedVerify: 0, keptNewer: 0,
               why: "该历史来源此前已经迁移过，不再有权改动当前事实" };
    }

    var picked = (input && input.picked) || [];
    var verified = (input && input.verified) || [];
    var adoptedPick = 0, adoptedVerify = 0, keptNewer = 0;
    /* 出错时要能原样退回去：检查点与事实必须同生共死 */
    var undo = [];
    function snap(f) { undo.push({ f: f, before: JSON.stringify(f) }); }

    picked.forEach(function (row) {
      if (!row || !row.regId) return;
      var f = racePackFactEnsure(row.regId);
      if (f.picked) { keptNewer++; return; }        /* 当前事实更新 → 原样保留 */
      snap(f);
      f.picked = true;
      f.pickedAt = row.at || f.pickedAt || null;
      f.pickedBy = row.by || f.pickedBy || null;
      f.device = row.device || f.device || null;
      if (row.offline) f.offlineSynced = true;
      f.legacyAdopted = true;                       /* 标明这条来自升级前的历史 */
      adoptedPick++;
    });
    verified.forEach(function (regId) {
      if (!regId) return;
      var f = racePackFactEnsure(regId);
      if (f.idVerified) return;
      snap(f);
      f.idVerified = true;
      f.legacyAdopted = true;
      adoptedVerify++;
    });

    /* ⚖️ Rule 4 · 检查点和事实<b>同一次</b>写进磁盘：要么都在，要么都不在。
       落盘失败就整个退回去 —— 不留半截，也不留「已迁移」的假象，
       下一次加载可以安全地重试。 */
    state.compat.legacyWorkerRacePack = true;
    if (!saveDurable()) {
      state.compat.legacyWorkerRacePack = false;
      undo.forEach(function (u) {
        var cur = racePackFact(u.f.regId);
        if (!cur) return;
        var was = JSON.parse(u.before);
        Object.keys(cur).forEach(function (k) { delete cur[k]; });
        Object.keys(was).forEach(function (k) { cur[k] = was[k]; });
      });
      return { ok: false, persisted: false, adoptedPick: 0, adoptedVerify: 0, keptNewer: keptNewer,
               why: "共享状态未能落盘，本次迁移整体作废（事实与检查点都已退回），下次加载可安全重试" };
    }
    return { ok: true, persisted: true,
             adoptedPick: adoptedPick, adoptedVerify: adoptedVerify, keptNewer: keptNewer };
  }

  /* 历史 / 页面本地键 → 当前 Registration 的<b>确定性</b>解析。
     解析不出来就返回 null —— 宁可少收编一条，也不能张冠李戴。 */
  function resolveLegacyRegId(key) {
    var k = String(key == null ? "" : key).trim();
    if (!k) return null;
    if (k.indexOf("LEGACY:") === 0) return k;                 /* 演示底表那批，原样保留 */
    if (findOPByReg(k)) return k;                             /* 本来就是 regId */
    var m = /^reg:(.+)$/.exec(k);                             /* 旧的页面本地键 "reg:OP-21" */
    var opId = m ? m[1] : k;
    var f = findOP(opId);
    if (f && f.p && f.p.regId) return f.p.regId;              /* OP-21 → REG-21 */
    return null;
  }

  /* 离线队列同步：每一条都<b>重跑同一个入口</b>，拿当前事实说话。
     后台先发过包 / 期间出现进行中退款 / 报名被取消 —— 一律失败关闭，
     不produce第二笔领物事实。 */
  function syncRacePackQueue(items, actor) {
    var out = [];
    (items || []).forEach(function (q) {
      var res = issueRacePack(q.regId, actor,
        { at: q.at, by: q.by || ("Staff " + (q.device || "—")), device: q.device, offline: true });
      if (res.ok) out.push({ regId: q.regId, outcome: "SYNCED", why: "" });
      else if (res.blocked === "PICKED") out.push({ regId: q.regId, outcome: "ALREADY", why: res.why });
      else out.push({ regId: q.regId, outcome: "CONFLICT", why: res.why });
    });
    return out;
  }

  function racePackRow(regId) {
    return racePackRoster(null).filter(function (r) { return r.regId === regId; })[0] || null;
  }

  /* ================================================================
     D-096 F-010 · 周边交付资格由<b>完整的当前事实</b>推导
     ----------------------------------------------------------------
     整单退款已经结算 = 这笔生意的钱已经退回去了，
     货就不能再交出去。不新增任何履约状态。
     ================================================================ */
  function handoffEligibility(o) {
    if (!o) return { ok: false, why: "订单不存在" };
    if (o.status !== "PAID") return { ok: false, why: "只有已支付的订单可以交付，当前是 " + o.status };
    if (o.fulfillment !== "PENDING_HANDOFF") {
      return { ok: false, why: "当前履约状态是 " + o.fulfillment + "，不可再次交付" };
    }
    var done = settledMerchRefund(o.id);
    if (done) {
      return { ok: false, refunded: true,
        why: "该订单的<b>整单退款已经结算</b>（" + done.id + " · 实退 $" + fmt(done.settledAmount != null ? done.settledAmount : done.amount) +
             " · 凭证 " + done.proof + "）。钱已经退回给用户，货<b>不能再交出去</b>——" +
             "否则就是钱退了、东西也拿走了。" };
    }
    return { ok: true };
  }



  /* ================================================================
     6) 报名侧：用户退款协助请求（不是 Refund）
     ================================================================ */
  function supportRequestCreate(opId, actor, reason, contact) {
    var f = findOP(opId);
    if (!f) return { ok: false, msg: "参赛人不存在" };
    if (openRefundOf(opId)) return { ok: false, msg: "该参赛人已有进行中的退款，请直接查看退款进度" };
    var exist = openSupportRequest(opId);
    if (exist) return { ok: false, msg: "已经提交过协助请求（" + exist.id + "），客服正在处理" };
    var s = {
      id: nextId("SR-", "SR"), opId: opId, orderId: f.o.id, regId: f.p.regId,
      name: holderOf(f.p), reason: reason, contact: contact, status: "OPEN",
      at: now(), by: (actor && actor.who) || "user", handledBy: null, handledAt: null, refundId: null
    };
    state.supportRequests.unshift(s);
    audit(actor, "用户提交退款协助请求",
      s.id + " · " + f.o.id + " / " + opId + " · " + holderOf(f.p) + " · 诉求：" + reason +
      " · <b>这不是 Refund</b>：报名状态、名额、Bib、领物一律不变，等待 SUPPORT / FINANCE 判断");
    return { ok: true, req: s };
  }
  function supportRequestClose(id, actor, refundId) {
    var s = state.supportRequests.filter(function (x) { return x.id === id; })[0];
    if (!s) return { ok: false, msg: "协助请求不存在" };
    s.status = "HANDLED"; s.handledBy = (actor && actor.who); s.handledAt = now();
    s.refundId = refundId || null;
    return { ok: true, req: s };
  }

  function createEvent(payload, actor) {
    if (!payload.name) return { ok: false, msg: "赛事名称不能为空" };
    var evId = "EV-" + String.fromCharCode(65 + state.events.length);
    var isFree = !!payload.isFree;
    var categories = payload.categories && payload.categories.length ? payload.categories : (
      isFree ? [
        { id: "C-" + evId + "-5K", name: "5K 自由跑", cap: payload.cap || 300, used: 0, start: (payload.date || "2026-11-28") + " 06:00", cutoff: (payload.date || "2026-11-28") + " 08:30", priceRuleIds: ["PR-" + evId + "-FREE"], minAge: 0, feId: "5k", feName: "自由跑", feDist: "5 km" },
        { id: "C-" + evId + "-3K", name: "3K 亲子同行", cap: 200, used: 0, start: (payload.date || "2026-11-28") + " 06:30", cutoff: (payload.date || "2026-11-28") + " 08:00", priceRuleIds: ["PR-" + evId + "-FREE"], minAge: 0, feId: "3k", feName: "亲子跑", feDist: "3 km" }
      ] : [
        { id: "C-" + evId + "-21K", name: "半程 21K", cap: payload.cap21 || 500, used: 0, start: (payload.date || "2026-11-28") + " 06:00", cutoff: (payload.date || "2026-11-28") + " 09:30", priceRuleIds: ["PR-" + evId + "-EB", "PR-" + evId + "-STD", "PR-" + evId + "-LOC"], minAge: 16, feId: "21k", feName: "半程马拉松", feDist: "21.1 km" },
        { id: "C-" + evId + "-10K", name: "欢乐 10K", cap: payload.cap10 || 800, used: 0, start: (payload.date || "2026-11-28") + " 06:30", cutoff: (payload.date || "2026-11-28") + " 09:00", priceRuleIds: ["PR-" + evId + "-EB", "PR-" + evId + "-STD", "PR-" + evId + "-LOC"], minAge: 12, feId: "10k", feName: "健康跑", feDist: "10 km" },
        { id: "C-" + evId + "-5K", name: "亲子 5K", cap: payload.cap5 || 300, used: 0, start: (payload.date || "2026-11-28") + " 07:30", cutoff: (payload.date || "2026-11-28") + " 09:00", priceRuleIds: ["PR-" + evId + "-STD", "PR-" + evId + "-LOC"], minAge: 0, feId: "5k", feName: "欢乐跑", feDist: "5 km" }
      ]
    );

    var priceRules = isFree ? [
      { id: "PR-" + evId + "-FREE", name: "免费报名", audience: "ALL", price: 0, quota: 2000, used: 0, window: "全程" }
    ] : (payload.priceRules && payload.priceRules.length ? payload.priceRules : [
      { id: "PR-" + evId + "-EB", name: "早鸟特惠价", audience: "ALL", price: Number(payload.earlyPrice) || 12, quota: Number(payload.earlyQuota) || 200, used: 0, window: "早鸟期（限前200名）" },
      { id: "PR-" + evId + "-STD", name: "标准常规价", audience: "ALL", price: Number(payload.stdPrice) || 18, quota: 1500, used: 0, window: "常规期" },
      { id: "PR-" + evId + "-LOC", name: "柬籍本地特惠价", audience: "LOCAL", price: Number(payload.localPrice) || 10, quota: 500, used: 0, window: "全程本地优惠" }
    ]);

    var newEv = {
      id: evId,
      name: payload.name,
      date: payload.date || "2026-11-28",
      city: payload.city || "金边",
      status: "DRAFT",
      isFree: isFree,
      registrationOpen: true,
      publicVisible: true,
      racePackConfigured: true,
      categories: categories,
      priceRules: priceRules,
      sponsors: payload.sponsors || [{ name: "BlueWave Sports Drink", watermark: true, freeClaim: true }]
    };
    state.events.push(newEv);
    save();
    return { ok: true, event: newEv };
  }

  function coupons() {
    return (state.coupons || []).slice();
  }

  function createCoupon(payload, actor) {
    var code = (payload.code || "").trim().toUpperCase();
    if (!code) return { ok: false, msg: "优惠码不能为空" };
    if (!state.coupons) state.coupons = [];
    if (state.coupons.some(function(c) { return c.code === code; })) {
      return { ok: false, msg: "优惠码 " + code + " 已存在" };
    }
    var cp = {
      id: payload.id || ("CP-" + Date.now().toString(36).toUpperCase()),
      code: code,
      type: payload.type || "PERCENT",
      value: payload.value != null ? Number(payload.value) : 10,
      quota: payload.quota != null ? Number(payload.quota) : 100,
      used: 0,
      eventId: payload.eventId || null,
      minRunners: payload.minRunners ? Number(payload.minRunners) : null,
      desc: payload.desc || "优惠码",
      validUntil: payload.validUntil || "2026-12-31"
    };
    state.coupons.push(cp);
    save();
    return { ok: true, coupon: cp };
  }

  function verifyCoupon(code, eventId, subtotal, runnerCount) {
    if (!code) return { ok: false, msg: "请输入优惠码" };
    var cd = String(code).trim().toUpperCase();
    var list = (state.coupons || []).concat([
      { id: "CP-VIP100", code: "VIP100", type: "WAIVER", value: 100, quota: 999, used: 0, desc: "100% VIP 特邀优免直通（0元免单）" },
      { id: "CP-RUN2026", code: "RUN2026", type: "PERCENT", value: 10, quota: 999, used: 12, desc: "全场 9 折特惠" },
      { id: "CP-GROUP15", code: "GROUP15", type: "PERCENT", value: 15, quota: 500, used: 5, minRunners: 3, desc: "3人及以上跑团团购 85 折特惠" },
      { id: "CP-EARLY5", code: "EARLY5", type: "AMOUNT", value: 5, quota: 300, used: 28, desc: "早鸟立减 $5" }
    ]);
    var cp = list.filter(function(c) { return c.code === cd; })[0];
    if (!cp) return { ok: false, msg: "优惠码不存在或已失效" };
    if (cp.eventId && cp.eventId !== eventId) return { ok: false, msg: "该优惠码不适用于本赛事" };
    if (cp.used >= cp.quota) return { ok: false, msg: "该优惠码核销次数已达上限" };
    if (cp.minRunners && (Number(runnerCount) || 1) < cp.minRunners) {
      return { ok: false, msg: "该团购优惠码需至少 " + cp.minRunners + " 名参赛者同时报名" };
    }

    var discount = 0;
    if (cp.type === "WAIVER") {
      discount = subtotal;
    } else if (cp.type === "PERCENT") {
      discount = Math.round(subtotal * (cp.value / 100) * 100) / 100;
    } else if (cp.type === "AMOUNT") {
      discount = Math.min(subtotal, cp.value);
    }
    var payable = Math.max(0, Math.round((subtotal - discount) * 100) / 100);
    return {
      ok: true,
      coupon: cp,
      discount: discount,
      payable: payable,
      isWaiver: cp.type === "WAIVER" || payable === 0,
      msg: cp.type === "WAIVER" ? "已应用 100% VIP 特邀优免直通（立减 $" + discount + "，实付 $0.00）"
         : "已应用 " + cp.desc + "（立减 $" + discount + "）"
    };
  }

  /* ================================================================
     7) 导出
     ================================================================ */
  
  /* ================================================================
     14) 跑友留言板 (Event Comments) 与 跑后感想图文社区 (Stories / Moments)
     ================================================================ */
  var DEFAULT_COMMENTS = [
    { id: "CM-1", eventId: "e1", author: "Sok Dara", avatar: "🏃", role: "已报名 21K 选手", text: "请问 15KM 处的补给站有能量胶和电解质水吗？", time: "10分钟前", likes: 8 },
    { id: "CM-2", eventId: "e1", author: "WeRun 官方组委会", avatar: "🏅", role: "官方组委会", text: "您好！每 2.5KM 均设有专业补给站，10K/15K/18K 站点均提供 BlueWave 运动饮料、能量胶与香蕉补给。", time: "5分钟前", likes: 14 },
    { id: "CM-3", eventId: "e1", author: "Chan Sophea", avatar: "⚡", role: "官方配速员 (2:00)", text: "本场 200 兔子已就位，目标完赛净成绩 1:59:00，想破2的跑友起跑区找绿色气球！", time: "1小时前", likes: 23 },
    { id: "CM-4", eventId: "e3", author: "Alice Smith", avatar: "🌸", role: "夜跑选手", text: "湄公河夜跑有存包区吗？现场领物需要带什么证件？", time: "30分钟前", likes: 5 },
    { id: "CM-5", eventId: "e3", author: "WeRun 现场服务台", avatar: "🏅", role: "官方服务台", text: "现场设有免费行李寄存车。领物请出示 WeRun MiniApp 里的电子参赛凭证与护照/身份证即可！", time: "15分钟前", likes: 9 }
  ];

  var DEFAULT_STORIES = [
    {
      id: "ST-101",
      title: "首战洞里萨河半马！清晨5点破风而行，21K顺利破2 🎉",
      author: "Sok Dara",
      avatar: "assets/hero-mobile.webp",
      authorRole: "业余跑者 · PB 1:52:10",
      date: "2026-09-02",
      raceName: "2026 金边滨河半程马拉松",
      raceId: "e1",
      pace: "5:18 / km",
      finishTime: "01:52:10",
      category: "半程马拉松 (21.1 km)",
      cover: "assets/story.webp",
      photos: ["assets/story.webp", "assets/hero-desktop.webp"],
      content: "第一次在清晨的洞里萨河畔奔跑，5:00 鸣枪出发，微风拂面，沿途河滨大道的日出太震撼了！\n\n特别感谢 WeRun 官方 145 配速员一路稳健带跑，最后 3 公里冲刺成功刷新个人最佳！\n\n更惊喜的是赛后不到 10 分钟，在 WeRun MiniApp 输入号码布就找到了 18 张高清照片，人脸抓拍超级清晰，完赛证书还能一键生成分享海报。下一站：吴哥窟越野赛见！🔥",
      tags: ["#首半马PB", "#洞里萨河晨跑", "#WeRun社区", "#跑步日常"],
      likes: 68,
      liked: false,
      comments: [
        { author: "Chan Sophea", text: "恭喜破2！配速超级稳！下次一起跑！👏", time: "2小时前" },
        { author: "WeRun 官方兔子", text: "跟着兔子跑，PB 少不了！祝贺完赛！💪", time: "1小时前" }
      ]
    },
    {
      id: "ST-102",
      title: "湄公河畔荧光夜跑初体验：跑步原来可以这么浪漫又好玩！✨",
      author: "Chan Sophea",
      avatar: "assets/hero-desktop-sm.webp",
      authorRole: "健康跑达人 · 10K 选手",
      date: "2026-09-03",
      raceName: "2026 湄公河荧光夜跑",
      raceId: "e3",
      pace: "6:15 / km",
      finishTime: "01:02:30",
      category: "健康跑 (10 km)",
      cover: "assets/hero-desktop.webp",
      photos: ["assets/hero-desktop.webp", "assets/story.webp"],
      content: "平时工作压力大，这次和跑团朋友一起报名了 10K 荧光夜跑。\n\n夜晚的湄公河微风徐徐，沿途全是荧光手环和音乐站，完赛还领到了超帅的金属完赛奖牌和冰镇运动饮料。\n\n强烈推荐新手尝试，完全没有竞技压力，纯粹享受运动的多巴胺！",
      tags: ["#湄公河夜跑", "#跑团打卡", "#周末去哪儿", "#运动解压"],
      likes: 52,
      liked: false,
      comments: [
        { author: "Alice Smith", text: "夜景太美了！奖牌设计很有高棉特色！", time: "3小时前" }
      ]
    },
    {
      id: "ST-103",
      title: "从 5K 跑渣到全马完赛：WeRun 记录了我三年的蜕变之路",
      author: "David Vance",
      avatar: "assets/story.webp",
      authorRole: "马拉松老将 · 完赛 8 场",
      date: "2026-09-04",
      raceName: "2026 金边滨河半程马拉松",
      raceId: "e1",
      pace: "4:55 / km",
      finishTime: "01:43:45",
      category: "半程马拉松 (21.1 km)",
      cover: "assets/hero-mobile.webp",
      photos: ["assets/hero-mobile.webp", "assets/hero-desktop.webp"],
      content: "翻看 WeRun 个人中心的永久成绩档案，从 2023 年第一场 5 公里晨跑，到今天半马稳稳跑进 1:44。\n\n每一个分段计时、每一张挥洒汗水的照片都在这里被完整保存。跑步不仅是锻炼，更是生活的一种秩序感。每一步都算数！",
      tags: ["#跑步改变生活", "#坚持的力量", "#成绩档案库", "#跑者自律"],
      likes: 95,
      liked: false,
      comments: [
        { author: "Sok Dara", text: "向老将致敬！太励志了！🙌", time: "5小时前" }
      ]
    }
  ];

  function getEventComments(evId) {
    var raw = localStorage.getItem("werun_event_comments");
    var list = raw ? JSON.parse(raw) : DEFAULT_COMMENTS;
    if (!evId) return list;
    return list.filter(function(c) { return c.eventId === evId || evId === "ALL"; });
  }

  function addEventComment(evId, author, text, role) {
    var list = getEventComments();
    var item = {
      id: "CM-" + Date.now().toString(36),
      eventId: evId || "e1",
      author: author || "跑友",
      avatar: "🏃",
      role: role || "参赛跑友",
      text: String(text || "").trim(),
      time: "刚刚",
      likes: 1
    };
    list.unshift(item);
    localStorage.setItem("werun_event_comments", JSON.stringify(list));
    return item;
  }

  function getStories(tag) {
    var raw = localStorage.getItem("werun_stories");
    var list = raw ? JSON.parse(raw) : DEFAULT_STORIES;
    if (!tag || tag === "ALL") return list;
    return list.filter(function(s) {
      if (!s.tags) return false;
      return s.tags.some(function(t) { return t.indexOf(tag) >= 0; });
    });
  }

  function addStory(payload) {
    var list = getStories();
    var item = {
      id: "ST-" + Date.now().toString(36),
      title: payload.title || "我的跑后故事",
      author: payload.author || "WeRun 跑友",
      avatar: payload.cover || "assets/hero-mobile.webp",
      authorRole: payload.authorRole || "完赛跑者",
      date: now().split(" ")[0],
      raceName: payload.raceName || "WeRun 赛事",
      raceId: payload.raceId || "e1",
      pace: payload.pace || "5:30 / km",
      finishTime: payload.finishTime || "--:--:--",
      category: payload.category || "路跑",
      cover: payload.cover || "assets/story.webp",
      photos: payload.photos && payload.photos.length ? payload.photos : ["assets/story.webp"],
      content: payload.content || "",
      tags: payload.tags || ["#WeRun社区", "#跑步打卡"],
      likes: 1,
      liked: false,
      comments: []
    };
    list.unshift(item);
    localStorage.setItem("werun_stories", JSON.stringify(list));
    return item;
  }

  function toggleStoryLike(storyId) {
    var list = getStories();
    var found = null;
    list.forEach(function(s) {
      if (s.id === storyId) {
        s.liked = !s.liked;
        s.likes += s.liked ? 1 : -1;
        found = s;
      }
    });
    localStorage.setItem("werun_stories", JSON.stringify(list));
    return found;
  }

  function addStoryComment(storyId, author, text) {
    var list = getStories();
    var found = null;
    list.forEach(function(s) {
      if (s.id === storyId) {
        if (!s.comments) s.comments = [];
        s.comments.push({
          author: author || "跑友",
          text: String(text || "").trim(),
          time: "刚刚"
        });
        found = s;
      }
    });
    localStorage.setItem("werun_stories", JSON.stringify(list));
    return found;
  }

  var API = {
    getEventComments: getEventComments,
    addEventComment: addEventComment,
    getStories: getStories,
    addStory: addStory,
    toggleStoryLike: toggleStoryLike,
    addStoryComment: addStoryComment,
    KEY: KEY, SCHEMA: SCHEMA,
    EVENT_MAP: EVENT_MAP, EVENT_MAP_R: EVENT_MAP_R,
    adminEventId: function (feId) { return EVENT_MAP[feId] || null; },
    feEventId: function (adminId) { return EVENT_MAP_R[adminId] || null; },
    load: load, save: save, reset: reset, watch: watch, seed: seed,
    now: now, plusMinutes: plusMinutes, ts: ts, nextId: nextId, audit: audit,

    findOrder: findOrder, findOP: findOP, findOPByReg: findOPByReg,
    refundsOf: refundsOf, openRefundOf: openRefundOf, settledRefundsOf: settledRefundsOf,
    currentBib: currentBib, bibHistoryOf: bibHistoryOf,
    holderOf: holderOf, transferred: transferred, myOrders: myOrders,
    createRegistrationOrder: createRegistrationOrder, orderByNo: orderByNo,
    createEvent: createEvent, coupons: coupons, createCoupon: createCoupon, verifyCoupon: verifyCoupon,
    confirmRegistrationPayment: confirmRegistrationPayment,
    canConfirmReceipt: canConfirmReceipt, requestPaymentCheck: requestPaymentCheck,
    settleIfPastDeadline: settleIfPastDeadline,
    deadlineOf: deadlineOf, pastDeadline: pastDeadline, secondsLeft: secondsLeft,
    expireRegistrationOrder: expireRegistrationOrder,
    cancelRegistrationOrderBeforePayment: cancelRegistrationOrderBeforePayment,
    recordRegistrationLateReceipt: recordRegistrationLateReceipt,
    registrationExceptions: registrationExceptions,
    regExceptions: registrationExceptions,
    planReservation: planReservation, reserveOrder: reserveOrder,
    consumeOrderReservation: consumeOrderReservation,
    releaseOrderReservation: releaseOrderReservation,
    capOccupied: capOccupied, quotaOccupied: quotaOccupied, quotaLeft: quotaLeft,
    eventById: eventById, categoryById: categoryById, categoryByFeId: categoryByFeId,
    resultBatchesOf: resultBatchesOf, publishedResultBatch: publishedResultBatch,
    resultPublicationOf: resultPublicationOf, resultBatchStateOf: resultBatchStateOf,
    priceRuleById: priceRuleById, matchPriceRule: matchPriceRule,
    categoryEligibility: categoryEligibility, capacityLeft: capacityLeft,
    allocateAmounts: allocateAmounts, occupyCapacity: occupyCapacity,
    releaseCapacity: releaseCapacity, consumeQuota: consumeQuota,
    canCreateParticipantRefund: canCreateParticipantRefund,
    validateExpiredRestore: validateExpiredRestore,
    restoreExpiredRegistrations: restoreExpiredRegistrations,
    validateBibAssignment: validateBibAssignment, assignBib: assignBib,
    bibConfigOf: bibConfigOf, bibPool: bibPool,
    isSpellingCorrection: isSpellingCorrection, normName: normName,
    handoffEligibility: handoffEligibility,
    racePackRoster: racePackRoster, racePackRow: racePackRow,
    racePackFact: racePackFact, racePackFactEnsure: racePackFactEnsure,
    racePackPicked: racePackPicked, racePackIdVerified: racePackIdVerified,
    canIssueRacePack: canIssueRacePack, issueRacePack: issueRacePack,
    verifyRacePackId: verifyRacePackId, undoRacePack: undoRacePack,
    resetRacePackIdVerification: resetRacePackIdVerification,
    syncRacePackQueue: syncRacePackQueue,
    adoptLegacyRacePackFacts: adoptLegacyRacePackFacts,
    legacyWorkerRacePackAdopted: legacyWorkerRacePackAdopted,
    saveDurable: saveDurable,
    resolveLegacyRegId: resolveLegacyRegId,
    racePackEligibility: racePackEligibility,
    supportRequestCreate: supportRequestCreate, supportRequestClose: supportRequestClose,
    openSupportRequest: openSupportRequest,

    products: products, productById: productById, skuById: skuById,
    available: available, skuSaleable: skuSaleable, productSoldOut: productSoldOut,
    merchOrderById: merchOrderById, myMerchOrders: myMerchOrders,
    merchRefundById: merchRefundById, merchRefundOf: merchRefundOf,
    openMerchException: openMerchException,
    createMerchOrder: createMerchOrder, cancelMerchOrder: cancelMerchOrder,
    expireMerchOrder: expireMerchOrder,
    reconcileExpiredMerchOrders: reconcileExpiredMerchOrders,
    nextMerchDeadlineAt: nextMerchDeadlineAt, payMerchOrder: payMerchOrder,
    handoffMerchOrder: handoffMerchOrder, adjustInventory: adjustInventory,
    lateArrivalMoney: lateArrivalMoney, isLateArrivalRefund: isLateArrivalRefund,
    lateArrivalObligation: lateArrivalObligation, cents: cents, fmtAmount: fmt,
    merchRefundsOf: merchRefundsOf, activeMerchRefund: activeMerchRefund,
    settledMerchRefund: settledMerchRefund,
    merchRefundCreate: merchRefundCreate, merchRefundApprove: merchRefundApprove,
    merchRefundReject: merchRefundReject, merchRefundSettle: merchRefundSettle,
    merchReturnReceived: merchReturnReceived,
    merchExceptionResolve: merchExceptionResolve, merchExceptionCreate: merchExceptionCreate
  };
  Object.defineProperty(API, "state", { get: function () { return state; } });

  load();
  global.RUNDomain = API;
})(window);