# WeRun 报名与收款凭证审核设计

- 日期：2026-09-14
- 前置：脚手架（`docs/superpowers/specs/2026-09-13-scaffold-design.md`）已合并；数据库 69 张表已由 `api/db/migrations/0001..0009` 建好，设计说明见 `docs/database/db-design.html`。
- 本文是下一份实施计划的唯一依据；与数据库设计文档冲突时，以本文的「已定决定」为准。

## 1. 目标与不做的事

### 1.1 目标

跑者在 Telegram 小程序里完成「选组别 → 填资料 → 签同意书 → 下单占名额 → 扫固定收款码转账 → 上传截图和交易号」，财务在后台审核通过或驳回，驳回后跑者可重传，超时自动释放名额；运营在后台配置价格档、优惠码，财务配置收款账户。免费活动直接报名。

### 1.2 本迭代包含

- 跑者 Telegram 登录、常用参赛人资料（证件号加密存）、报名同意书签署
- 价格档与早鸟、本地价、优惠码（百分比 / 固定金额 / 免单）、年龄校验、多人同单与优惠分摊、识别分
- 下单占名额、付款前取消、超时释放、付款前 10 分钟提醒
- 截图凭证上传、审核队列、通过（含多付异常登记）、驳回、重传
- Telegram 机器人推送审核结果
- 免费活动报名
- 后台页面：价格档、优惠码、收款账户、开放报名、凭证审核、订单列表与详情

### 1.3 本迭代不做

- 退款、退款纠错、支付异常的处理与关闭（多付异常只登记，不处理）
- 银行流水导入与日对账、迟到到账恢复（`EXPIRED → PAID`）
- 候补、资料修改与转让、号码布分配、领物
- 瑞尔收款、汇率
- 手机验证码登录、游客下单（`reg_orders.buyer_user_id` 本迭代恒不为空）
- 截图感知哈希（`files.phash`）相似检测，只做 sha256 完全重复检测
- 周边订单（`merch_orders`）

## 2. 已定决定

| 事项 | 决定 |
| --- | --- |
| 迭代范围 | 最小闭环 + 商业规则（价格档、优惠码、年龄、多人同单） |
| 跑者身份 | 只用 Telegram 小程序登录；普通浏览器只能浏览赛事 |
| 配置录入 | 价格档、优惠码、收款账户都走后台页面 |
| 凭证内容 | 截图 + 交易号；金额默认带出订单应付，可改 |
| 付款期限 | 上传期 30 分钟、重传期 24 小时（`system_settings`，可改） |
| 币种 | 只收美元 |
| 证件号 | 必填，AES-GCM 加密 + HMAC 哈希 |
| 同意书 | 复用 `disclaimer_versions` / `disclaimer_signatures`，签署记录关联订单 |
| 本地价 | 参赛人国籍为 `KH` 即可享受 |
| 结果通知 | Telegram 机器人私信 |
| 号码布 | 本迭代不分配 |
| 少付 | 不允许通过，只能以「金额不符」驳回 |
| 多付 | 可以通过，同时登记一条 `OVERPAID` 异常（保持 OPEN） |
| 防重复报名 | 同一赛事内同一证件号哈希只能有一条待确认或已确认报名 |
| 每单人数 | 1–10 人 |
| 提醒 | 每个截止时间（上传期、重传期）到期前 10 分钟提醒一次 |
| 整体方案 | 按业务拆五个包，按功能纵向分段交付 |

## 3. 后端模块

五个新包，写法与现有 `internal/event`、`internal/iam` 一致：`service.go` 放业务逻辑，`store/` 放 sqlc 生成的查询。

| 包 | 负责 | 对其他包公开的方法 |
| --- | --- | --- |
| `internal/runner` | Telegram 登录与跑者会话；常用参赛人；同意书版本查询与签署 | `CurrentUser(ctx)`、`SignConsents(ctx, tx, …)` |
| `internal/pricing` | 价格档、优惠码的后台维护；算价 | `Quote(ctx, tx, QuoteInput) (Quote, error)`、`Reserve(ctx, tx, Quote)`、`Consume(ctx, tx, orderID)`、`Release(ctx, tx, orderID)` |
| `internal/registration` | 下单、取消、超时释放、免费活动报名、我的报名、后台订单查询 | `ConfirmPaid(ctx, tx, orderID, paidAt)` |
| `internal/payment` | 收款账户；凭证上传；审核队列；通过与驳回 | —— |
| `internal/notify` | 推送登记、发送任务、模板渲染 | `Enqueue(ctx, tx, Notification)` |

另有两处平台层新增：

- `internal/platform/storage`：`Store` 接口（`Put(ctx, key, r) error`、`Open(ctx, key) (io.ReadCloser, error)`、`Delete(ctx, key) error`），实现为本地磁盘，根目录取 `WERUN_FILES_DIR`。存储键格式 `yyyy/mm/<32 位随机十六进制>.<ext>`。
- `internal/platform/piicrypt`：用 `WERUN_PII_KEY` 做 AES-256-GCM 加解密与 HMAC-SHA256 哈希。证件号先去掉空格和连字符并转大写，再加密和哈希。

跨包事务：`db.InTx` 由发起业务的包开启，`pgx.Tx` 作为参数传给其他包的公开方法；被调用方不自己开事务，也不提交。

## 4. 跑者登录与会话

- 小程序启动时读取 `window.Telegram.WebApp.initData`，调用 `POST /api/app/auth/telegram`，请求体 `{ "initData": "<原样字符串>" }`。
- 服务端按 Telegram 规则校验：以 `"WebAppData"` 为键对机器人 token 做 HMAC-SHA256 得到密钥，再对按键名排序、以换行连接的 `key=value`（去掉 `hash`）做 HMAC-SHA256，与 `hash` 常量时间比较；`auth_date` 距今超过 24 小时视为过期。失败返回 `TELEGRAM_AUTH_INVALID`（401）。
- 校验通过后按 `telegram_user_id` 创建或更新 `users`（`telegram_username`、`display_name`、`last_login_at`；首次创建时 `locale` 取 Telegram `language_code` 映射，`zh*`→`zh`，`km`→`km`，其余→`en`）。
- 会话令牌：32 字节随机数，`sessions` 表 `subject_type = 'USER'`，`token_hash` 与员工会话同样使用 HMAC；有效期固定 24 小时，不做空闲续期。
- **令牌放在请求头，不用 Cookie**：Telegram 网页版把小程序放在跨站 iframe 里，浏览器会拦截第三方 Cookie。响应体返回 `{ "token": "…", "expiresAt": "…", "user": {…} }`，前端存 `sessionStorage`，之后请求带 `Authorization: Bearer <token>`。收到 401 时前端用当前 `initData` 自动重新登录一次。
- 因为令牌不会被浏览器自动携带，`/api/app/*` 不需要 `X-WeRun-Client` 防跨站请求头。
- `POST /api/app/auth/logout` 吊销当前会话；`GET /api/app/me` 返回当前跑者。
- 普通浏览器（URL 不带 `tgWebAppData`）打开报名入口时，显示「请在 Telegram 中打开」和跳转到机器人的按钮。

### 4.1 本地与 CI 模拟登录

- 开发与 CI 使用假的机器人 token。
- 新增命令 `werun dev-initdata --telegram-id <id> --name <显示名> [--lang zh|en|km]`：用配置里的 token 生成签名正确的 `initData` 并打印；`WERUN_ENV=prod` 时拒绝执行并返回非零退出码。
- 跑者端在 `import.meta.env.DEV` 时支持地址参数 `?devInitData=<字符串>` 代替 Telegram SDK 提供的值；生产构建不包含这段代码。
- Playwright 测试在测试代码里用同样算法签名，不调用该命令。

## 5. 算价（`pricing`）

输入：赛事、优惠码（可空）、参赛人列表（每人：组别、国籍、出生日期）、当前时间。

对每个参赛人：

1. **选价格档**：候选为 `category_price_rules` 中该组别关联的价格档，并同时满足：
   - `audience = 'ALL'`，或 `audience = 'LOCAL'` 且国籍为 `KH`；
   - `sale_starts_at` 为空或 ≤ 当前时间，`sale_ends_at` 为空或 > 当前时间；
   - `quota` 为空，或 `used_count + reserved_count + 本单已选该档人数 < quota`。

   取 `price_cents` 最低的一档，同价取 `sort_order` 小的，再同取 `id` 小的。没有候选时返回字段错误 `participants[i].categoryId`（文案「该组别当前不可报名」）。
2. **年龄**：以赛事 `race_date`（赛事时区）计算周岁，小于 `event_categories.min_age` 返回字段错误 `participants[i].birthDate`。2 月 29 日出生者在非闰年按 3 月 1 日满岁。

整单：

3. `list_amount_cents` = 各人 `list_price_cents` 之和。
4. **优惠码**（输入时先转大写）：要求 `status = 'ACTIVE'`；`event_id` 为空或等于本赛事；`valid_from`/`valid_until` 覆盖当前时间；`min_runners` 为空或 ≤ 人数；`used_count + reserved_count < quota`。不满足返回 `COUPON_INVALID`（422，带 `couponCode` 字段），次数用完返回 `COUPON_EXHAUSTED`（409）。
   - `PERCENT`：`floor(list_amount × value / 100)`
   - `AMOUNT`：`min(value, list_amount)`
   - `WAIVER`：`list_amount`
5. **识别分**：若 `list_amount − 优惠码减免 > 0`，在下单事务里对所选收款账户执行 `pg_advisory_xact_lock(<固定命名空间>, payment_account_id)`，然后从 1 到 `min(50, 应付 − 1)` 中选最小的 `n`，使 `应付 − n` 不等于该账户下任何状态为 `PENDING_PAYMENT`、`PROOF_SUBMITTED`、`PROOF_REJECTED` 的订单的 `amount_cents`。找不到或应付 ≤ 1 分时 `n = 0`。上限 50 读取 `system_settings` 的 `payment.ident_offset_max_cents`，但不得超过 50。
6. `discount_cents` = 优惠码减免 + 识别分；`amount_cents` = `list_amount − discount_cents`；`ident_offset_cents` 单独记录识别分。
7. **分摊**：每人 `paid_cents` = `list_price − floor(discount × list_price / list_amount)`；分摊后总额与 `amount_cents` 的差额按各人被舍去的余数从大到小逐分补齐（余数相同按参赛人顺序）。`list_amount = 0` 时每人 `paid_cents = 0`。

算价同时提供只读接口 `POST /api/app/events/{slug}/quote`（不占名额、不选识别分），供确认页展示金额；下单时重新计算，以下单结果为准。

## 6. 事务

所有事务通过 `db.InTx` 执行；审计日志用 `audit.Record` 写在同一事务里；推送用 `notify.Enqueue` 写在同一事务里，并通过 River `InsertTx` 入队发送任务。

编号格式（均为唯一约束，冲突时重新生成最多 3 次）：订单 `WR` + 8 位 Crockford Base32；凭证 `PF` + 8 位；报名 `RG` + 8 位；免费报名 `FS` + 8 位；异常 `EX` + 8 位。参赛凭证码 `ticket_code` 为 20 字节随机数的 Base32。

### 6.1 下单 `POST /api/app/orders`

请求头必须带 `Idempotency-Key`（8–64 位）。`idempotency_keys` 以 `scope = 'reg_order.create'`、`subject = 'user:<id>'` 记录请求体哈希和响应，保留 24 小时；同键同请求体返回首次响应，同键不同请求体返回 422 `IDEMPOTENCY_KEY_REUSED`。

请求体：`eventSlug`、`couponCode`（可空）、`consents`（同意书版本号与勾选项）、`participants[]`（每人 `categoryId`，以及 `profileId` 或完整资料；可带 `saveAsProfile`）。

事务步骤：

1. 锁赛事行，校验 `status = 'PUBLISHED'`、`event_type = 'RACE'`、`registration_open`、当前时间在 `registration_opens_at`/`registration_closes_at` 内（为空表示不限），否则 `REGISTRATION_CLOSED`。
2. 校验人数 1–10、组别属于本赛事、资料必填项（姓名、性别、出生日期、国籍、证件类型、证件号、手机、紧急联系人姓名和电话、T 恤尺码）。同一单内证件号哈希不得重复。
3. 同一赛事下已存在 `status IN ('PENDING','CONFIRMED')` 且 `id_no_hash` 相同的报名时返回 `ALREADY_REGISTERED`（带参赛人字段）。
4. 选收款账户：`active`、`currency = 'USD'`、`scope IN ('REGISTRATION','ALL')`，优先 `event_id` 等于本赛事，其次 `event_id` 为空，同优先级取 `id` 最小。没有则 `PAYMENT_ACCOUNT_UNAVAILABLE`（503）。
5. `pricing.Quote`（含识别分）。
6. `pricing.Reserve`：按组别合并人数执行 `UPDATE event_categories SET reserved_count = reserved_count + $n WHERE id = $id AND used_count + reserved_count + $n <= capacity`；按价格档合并人数对 `price_rules` 做同样的条件更新（`quota` 为空时不加条件）；有优惠码时对 `coupons` 做 `reserved_count + 1` 的条件更新。任何一条影响 0 行即返回对应错误并回滚：`CATEGORY_SOLD_OUT`、`PRICE_TIER_SOLD_OUT`、`COUPON_EXHAUSTED`（均 409）。
7. 写 `reg_orders`：`status = 'PENDING_PAYMENT'`、`reservation_state = 'RESERVED'`、`deadline_at = now() + payment.upload_window_minutes`、`source = 'TELEGRAM'`、买家姓名与手机取第一位参赛人。
8. 写 `order_participants`（价格快照）、`registrations`（`status = 'PENDING'`，资料快照，证件号加密与哈希），`saveAsProfile` 时同时写 `runner_profiles`。
9. 有优惠码时写 `coupon_redemptions`（`state = 'RESERVED'`）。
10. `runner.SignConsents`：为每个同意书写 `disclaimer_signatures`（版本、语言、文本哈希、勾选项、IP、User-Agent），并写 `registration_consents` 关联到订单。
11. 审计 `reg_order.create`。
12. **应付为 0**：同一事务内把订单改为 `PAID`（`paid_at = now()`、`deadline_at = NULL`），调用 `registration.ConfirmPaid`，审计 `reg_order.paid_zero`。

`ConfirmPaid` 依次做三件事：调用 `pricing.Consume`（`event_categories` 与 `price_rules` 从 `reserved_count` 转入 `used_count`，按合并人数条件更新；`coupons` 同样转为已用，`coupon_redemptions` 改为 `CONSUMED`）；订单 `reservation_state = 'CONSUMED'`；报名改为 `CONFIRMED` 并写 `confirmed_at`。组别、价格档、优惠码三类计数只由 `pricing` 的 `Reserve`、`Consume`、`Release` 修改（免费活动报名 6.7 除外）。

### 6.2 上传凭证 `POST /api/app/orders/{orderNo}/proofs`

`multipart/form-data`：`file`、`bankTxnRef`、`declaredAmountCents`、`declaredPaidAt`（可空）、`payerName`（可空）。

1. 事务外：校验文件 ≤ 5 MB，读取前 512 字节按内容判断类型，只接受 `image/jpeg`、`image/png`、`image/webp`，并解码图片头取宽高；计算 sha256；写入存储。失败返回 `FILE_TOO_LARGE`（413）或 `FILE_TYPE_NOT_ALLOWED`（415）。
2. 事务内：
   1. `SELECT … FOR UPDATE` 锁订单，校验订单属于当前跑者。
   2. 状态必须是 `PENDING_PAYMENT` 或 `PROOF_REJECTED`，否则 `ORDER_STATE_CONFLICT`；`deadline_at <= now()` 返回 `ORDER_EXPIRED`。
   3. `bankTxnRef` 去掉所有空白并转大写，长度 4–64；`declaredAmountCents > 0`。
   4. 写 `files`（`purpose = 'PAYMENT_PROOF'`、`visibility = 'PRIVATE'`、`uploaded_by_type = 'USER'`）。
   5. 写 `payment_proofs`（`status = 'SUBMITTED'`、收款账户取订单上的账户、`dup_file_hit` = 是否存在其他凭证的文件 sha256 相同）。唯一约束 `payment_proofs_txn_ref_uniq` 冲突映射为 `PROOF_TXN_REF_USED`（409）。
   6. 订单改为 `PROOF_SUBMITTED`、`deadline_at = NULL`。
   7. 审计 `payment_proof.submit`。
3. 事务失败时尽力删除第 1 步写入的文件；删除失败只记日志。

### 6.3 审核通过 `POST /api/admin/proofs/{id}/approve`

权限 `proof_review`。请求体：`receivedAmountCents`（必填）、`receivedAt`（必填）、`note`（可空）。

1. 锁凭证与订单；凭证须为 `SUBMITTED`、订单须为 `PROOF_SUBMITTED`，否则 `ORDER_STATE_CONFLICT`。
2. `receivedAmountCents < amount_cents` 返回 `RECEIVED_AMOUNT_TOO_LOW`（422）。
3. 凭证改为 `APPROVED`，写 `reviewed_by`、`reviewed_at`。
4. 写 `payment_receipts`：`txn_ref` 取凭证交易号，`amount_cents = receivedAmountCents`，`proof_id`、`reg_order_id`，`recorded_by_type = 'STAFF'`；`match_status` 在金额相等时为 `APPLIED`，多付时为 `EXCEPTION`。唯一约束 `(payment_account_id, txn_ref)` 冲突映射为 `PROOF_TXN_REF_USED`。
5. 多付时写 `payment_exceptions`：`domain = 'REGISTRATION'`、`type = 'OVERPAID'`、`amount_cents` = 多付部分、`status = 'OPEN'`。
6. 订单改为 `PAID`、`paid_at = receivedAt`；调用 `registration.ConfirmPaid`。
7. 审计 `payment_proof.approve`；`notify.Enqueue` 模板 `proof_approved`。

### 6.4 驳回 `POST /api/admin/proofs/{id}/reject`

权限 `proof_review`。请求体：`rejectCode`（`NOT_RECEIVED`、`AMOUNT_MISMATCH`、`DUPLICATE_TXN`、`UNREADABLE`、`WRONG_ACCOUNT`、`FRAUD`、`OTHER`）、`rejectReason`（`OTHER` 时必填，其余可空，最长 500 字）。

1. 锁凭证与订单，状态校验同 6.3。
2. 凭证改为 `REJECTED`，写审核人、时间、原因码和说明。
3. 订单改为 `PROOF_REJECTED`、`deadline_at = now() + payment.reupload_window_hours`。
4. 审计 `payment_proof.reject`；`notify.Enqueue` 模板 `proof_rejected`。

### 6.5 超时释放与提醒（River 周期任务 `order_deadline`，每分钟）

1. 查询 `status IN ('PENDING_PAYMENT','PROOF_REJECTED') AND deadline_at <= now()`，按 `deadline_at` 排序，`LIMIT 100 FOR UPDATE SKIP LOCKED`。
2. 对每张订单：`UPDATE reg_orders SET status = 'EXPIRED', reservation_state = 'RELEASED', reservation_release_kind = 'ORDER_EXPIRED', expired_at = now(), deadline_at = NULL WHERE id = $1 AND reservation_state = 'RESERVED' AND status IN ('PENDING_PAYMENT','PROOF_REJECTED')`。只有影响 1 行时才调用 `pricing.Release`（组别、价格档、优惠码减 `reserved_count`，`coupon_redemptions` 改为 `RELEASED`），把该单报名改为 `CANCELLED`（`cancel_reason = 'ORDER_EXPIRED'`），审计 `reg_order.expire`（`actor_type = 'SYSTEM'`），推送 `order_expired`。
3. 每批一个事务；本批满 100 条时立即处理下一批，直到不足 100 条。
4. 提醒：查询上述两种状态中 `deadline_at` 在 `(now(), now() + 10 分钟]` 内的订单，推送 `payment_deadline_reminder`，`dedupe_key = 'reminder:<orderId>:<deadline_at 的 Unix 秒>'`；已存在同键记录时跳过。
5. 上传凭证事务持有订单行锁时，本任务因 `SKIP LOCKED` 跳过该单；上传提交后订单已不在待释放状态。第 2 步的条件更新保证即使重复执行也只释放一次。

### 6.6 付款前取消 `POST /api/app/orders/{orderNo}/cancel`

订单属于当前跑者且状态为 `PENDING_PAYMENT`，否则 `ORDER_STATE_CONFLICT`。条件更新与释放同 6.5，`status = 'CANCELLED'`、`reservation_release_kind = 'ORDER_CANCELLED'`、`cancelled_at = now()`，报名 `cancel_reason = 'ORDER_CANCELLED'`，审计 `reg_order.cancel`，不推送。

### 6.7 免费活动报名 `POST /api/app/events/{slug}/free-signups`

赛事 `event_type = 'FREE_ACTIVITY'`，开放条件同 6.1 第 1 步。请求体：`categoryId`、`fullName`、`phone`、`emergencyName`、`emergencyPhone`（以上必填）、`gender`、`birthDate`（可空；组别 `min_age > 0` 时 `birthDate` 必填并按 5 节第 2 步校验年龄）、`consents`。`user_id` 取当前跑者，`source = 'TELEGRAM'`，同一跑者可为家人报多人。事务内：签署同意书（`registration_consents` 关联 `free_signup_id`）；`UPDATE event_categories SET used_count = used_count + 1 WHERE id = $id AND used_count + reserved_count + 1 <= capacity`，0 行返回 `CATEGORY_SOLD_OUT`；写 `free_signups`，部分唯一索引冲突映射为 `ALREADY_REGISTERED`；审计 `free_signup.create`。

## 7. 接口清单

`openapi.yaml` 的 `x-auth` 新增取值 `app`：`permgen` 生成的 `OperationAuths` 与 `AuthMiddleware` 据此要求跑者令牌，并把当前跑者放进请求上下文；员工会话 Cookie 对 `x-auth: app` 的接口无效，跑者令牌对 `x-auth: session` 与带 `x-permission` 的接口无效。后台接口沿用每个操作一个 `x-permission` 加 `x-access`（`read` / `write`）。

跑者端（`/api/app`，登录接口为 `x-auth: none`，其余均为 `x-auth: app`）：

| 方法与路径 | 说明 |
| --- | --- |
| `POST /auth/telegram` | 登录 |
| `POST /auth/logout` | 退出 |
| `GET /me` | 当前跑者 |
| `GET /profiles`、`POST /profiles`、`PUT /profiles/{id}`、`DELETE /profiles/{id}` | 常用参赛人；返回的证件号只显示后 4 位 |
| `GET /consents?purpose=REGISTRATION&lang=` | 当前生效的同意书版本 |
| `POST /events/{slug}/quote` | 算价预览 |
| `POST /orders` | 下单 |
| `GET /orders`、`GET /orders/{orderNo}` | 我的订单；详情含收款账户、二维码地址、应付、截止时间、最近一次驳回原因、参赛凭证码（已确认时） |
| `POST /orders/{orderNo}/cancel` | 付款前取消 |
| `POST /orders/{orderNo}/proofs` | 上传凭证 |
| `POST /events/{slug}/free-signups` | 免费活动报名 |

公开文件：`GET /api/files/{id}`，只返回 `visibility = 'PUBLIC'` 的文件（收款二维码），带 `Cache-Control: public, max-age=86400`；私有文件和不存在的文件都返回 404。

后台（`/api/admin`）：

| 方法与路径 | 权限 |
| --- | --- |
| `GET /events/{id}`、`PATCH /events/{id}/registration`（开关、开始与截止时间） | 读写 `event_config` |
| `GET/POST /events/{id}/price-rules`、`PUT /price-rules/{id}` | 读写 `price_config` |
| `GET/POST /coupons`、`PUT /coupons/{id}` | 读写 `coupon_manage` |
| `GET/POST /payment-accounts`、`PUT /payment-accounts/{id}`（`multipart`，可换二维码） | 读写 `payment_account_manage` |
| `GET /proofs?status=`、`GET /proofs/{id}` | 读 `proof_review` |
| `POST /proofs/{id}/approve`、`POST /proofs/{id}/reject` | 写 `proof_review` |
| `GET /files/{id}` | 私有文件；`proof_review` 读权限 |
| `GET /orders?eventId=&status=&q=`、`GET /orders/{id}` | 读 `order_view` |

开放报名（`PATCH /events/{id}/registration` 设为开放）时校验：赛事已发布；`RACE` 赛事每个组别至少关联一个价格档，且存在可用收款账户；不满足返回 `VALIDATION_FAILED` 并指明缺什么。

价格档修改规则：`used_count + reserved_count > 0` 时不可改 `price_cents`、`audience`、关联组别；`quota` 不可改到小于 `used_count + reserved_count`；可随时改名称、销售时间、排序。价格档与优惠码不提供删除，停用价格档用 `sale_ends_at`，停用优惠码用 `status = 'DISABLED'`。

所有后台写操作写审计：`event.registration_update`、`price_rule.create/update`、`coupon.create/update`、`payment_account.create/update`。

## 8. 权限

`internal/iam/matrix.go` 新增 4 项（W = 读写，R = 只读，— = 无）：

| 权限 | ADMIN | OPS | FINANCE | SUPPORT | RACE_SUPERVISOR | RACE_STAFF | PHOTOGRAPHER |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `price_config` | R | W | R | — | — | — | — |
| `coupon_manage` | R | W | R | R | — | — | — |
| `payment_account_manage` | R | R | W | — | — | — | — |
| `proof_review` | R | R | W | R | — | — | — |

现有 `manual_confirm` 保留不动，留给迟到到账恢复迭代使用。

## 9. 数据库变更（迁移 `0010_registration_payment.sql`）

1. `disclaimer_versions` 增加 `purpose text NOT NULL DEFAULT 'COMMUNITY' CHECK (purpose IN ('COMMUNITY','REGISTRATION'))`。
2. 新表 `registration_consents`：`signature_id bigint PRIMARY KEY REFERENCES disclaimer_signatures(id)`、`reg_order_id bigint REFERENCES reg_orders(id)`、`free_signup_id bigint REFERENCES free_signups(id)`、`created_at`，`CHECK (num_nonnulls(reg_order_id, free_signup_id) = 1)`，两列各建索引；只追加（沿用 `forbid_mutation` 触发器）。

识别分唯一性由应用层加锁保证，不加数据库约束。

同意书版本由命令发布：`werun publish-consent --purpose REGISTRATION --version <版本> --lang <zh|en|km> --effective-date <日期> --file <正文.md> --items <勾选项.json>`；版本发布后不可修改。本迭代同意书全平台共用一套，不按赛事区分，赛事规章通过赛事详情页的说明链接展示。

## 10. 配置

| 变量 | 说明 |
| --- | --- |
| `WERUN_TELEGRAM_BOT_TOKEN` | 必填。校验 `initData` 与发送消息 |
| `WERUN_TELEGRAM_BOT_USERNAME` | 必填。生成「在 Telegram 中打开」链接 |
| `WERUN_TELEGRAM_SEND` | `on` / `off`；`prod` 默认 `on`，其余默认 `off`（只写日志） |
| `WERUN_APP_BASE_URL` | 必填。推送消息中的小程序链接前缀 |

`.env.example`、`deploy/compose.yaml`、CI 的 `.env` 同步补充。

## 11. 错误码

沿用 `apperr` 与三语文案文件，新增：

| 错误码 | HTTP | 场景 |
| --- | --- | --- |
| `TELEGRAM_AUTH_INVALID` | 401 | `initData` 签名不对或已过期 |
| `REGISTRATION_CLOSED` | 409 | 报名未开放或不在报名时间 |
| `CATEGORY_SOLD_OUT` | 409 | 组别名额已满 |
| `PRICE_TIER_SOLD_OUT` | 409 | 价格档配额被抢完 |
| `COUPON_INVALID` | 422 | 优惠码不存在、停用、过期、人数不够、不属于本赛事 |
| `COUPON_EXHAUSTED` | 409 | 优惠码次数用完 |
| `ALREADY_REGISTERED` | 409 | 同一证件号已报名本赛事 |
| `PAYMENT_ACCOUNT_UNAVAILABLE` | 503 | 没有可用收款账户 |
| `ORDER_EXPIRED` | 409 | 订单已过截止时间 |
| `ORDER_STATE_CONFLICT` | 409 | 当前状态不允许该操作 |
| `PROOF_TXN_REF_USED` | 409 | 交易号已被其他凭证或到账记录使用 |
| `FILE_TOO_LARGE` | 413 | 超过大小上限 |
| `FILE_TYPE_NOT_ALLOWED` | 415 | 不是允许的图片类型 |
| `RECEIVED_AMOUNT_TOO_LOW` | 422 | 到账金额少于应付 |
| `IDEMPOTENCY_KEY_REUSED` | 422 | 幂等键被用于不同请求 |

请求体大小：`POST /api/app/orders/{orderNo}/proofs` 与后台收款账户上传接口为 6 MiB，其余 `/api/*` 仍为 1 MiB。收款二维码图片上限 2 MB，类型限制同凭证。

前端处理：`CATEGORY_SOLD_OUT` / `PRICE_TIER_SOLD_OUT` 提示后回到选组别步骤并重新算价；`ORDER_EXPIRED` 显示「订单已过期」和「重新报名」按钮；`TELEGRAM_AUTH_INVALID` 自动重新登录一次，仍失败则提示在 Telegram 中重新打开。

## 12. 推送

- 模板：`proof_approved`、`proof_rejected`、`payment_deadline_reminder`、`order_expired`。
- 文案放在 `internal/platform/i18n/messages.{zh,en,km}.json` 的 `notify.*` 下，语言取 `users.locale`；时间按赛事时区格式化；驳回消息包含原因码文案、说明（如有）和重传截止时间。
- 每条消息附一个打开小程序订单页的按钮：`<WERUN_APP_BASE_URL>/orders/<orderNo>`。
- `notify.Enqueue` 写 `notification_logs`（`channel = 'TELEGRAM'`、`status = 'PENDING'`、`dedupe_key`；默认 `<template>:<orderId>:<proofId 或 0>`），唯一冲突视为已登记并跳过，同时 `InsertTx` 入队 River 任务 `notify_send`。
- 发送任务通过 `Sender` 接口调用：`TelegramSender`（Bot API `sendMessage`）或 `LogSender`（`WERUN_TELEGRAM_SEND=off`）。成功写 `SENT`、`sent_at`；失败 `attempts + 1`、写 `last_error`，River 最多重试 5 次；Telegram 返回 403（跑者屏蔽机器人或未开始对话）直接写 `FAILED` 并取消重试。

## 13. 前端

### 13.1 跑者端 `web/user`

- 赛事详情页增加「报名」按钮（非 Telegram 环境显示跳转提示）。
- 报名向导四步：
  1. 选组别与参赛人（从常用参赛人选择或新增，每人选组别）
  2. 参赛资料（每人一张表单，可勾选「保存为常用参赛人」）
  3. 确认订单（算价明细、优惠码输入与校验、同意书逐项勾选后才能提交）
  4. 付款页：收款二维码、收款户名与尾号、应付金额（突出显示，说明「请按此金额转账，尾数用于识别」）、转账备注填订单号、倒计时、「我已付款，上传凭证」
- 上传凭证页：选择截图、交易号、金额（默认应付）、付款时间（可空）；提交后进入订单详情。
- 我的报名：订单列表与详情，按状态显示待付款倒计时、审核中、被驳回（原因与重传截止时间、「重新上传」）、已确认（参赛凭证二维码）、已过期、已取消。
- 免费活动详情页：「报名」→ 资料 → 同意书 → 完成。
- 所有新文案三语齐全，`pnpm i18n:check` 通过。

### 13.2 后台 `web/admin`

- 赛事详情页（新增）：基本信息、报名开关与时间、「价格档」与「优惠码」标签页。
- 收款账户页：列表、新建与编辑（上传二维码、启用停用、适用范围、绑定赛事）。
- 凭证审核：队列页（默认待审，按提交时间升序，显示订单号、应付、申报金额、交易号、重复截图标记、等待时长，超过 `payment.review_sla_hours` 高亮）；详情页左侧截图（可放大），右侧订单与参赛人、申报信息、历史凭证，下方「通过」（填到账金额与时间；金额小于应付时按钮不可用并提示）与「驳回」（选原因码、填说明）。
- 订单页：列表（按赛事、状态、订单号或手机号筛选）与详情（参赛人、金额构成含识别分、凭证历史、到账记录、状态时间线）。
- 菜单与按钮按权限显示，沿用现有 `can()`。

## 14. 测试

### 14.1 后端单元测试（不连数据库）

- 价格档选择：人群、销售时间、配额、同价排序。
- 年龄计算：比赛当天生日、2 月 29 日出生、刚好等于最低年龄。
- 优惠码三种类型与各种不可用情况。
- 分摊：总额恒等于应付；余数补齐顺序；原价为 0。
- 识别分：选最小可用值、全部占用时为 0、应付 ≤ 1 分。
- `initData` 验签：正确、篡改任一字段、`auth_date` 过期、缺少 `hash`。
- 文件类型判断：伪装扩展名、超大文件、非图片。
- 编号生成格式；推送模板三语 key 一致。

### 14.2 后端数据库测试（`dbtest` 容器）

- 状态流转：下单 → 上传 → 驳回 → 重传 → 通过；下单 → 过期；下单 → 取消；免单码下单直接已付款。
- 每个流转结束后断言三类计数（组别、价格档、优惠码的 `used_count`/`reserved_count`）与订单、报名、核销记录状态一致。
- 并发：
  - 组别剩 1 个名额时 20 个协程同时下单，恰好 1 单成功，其余 `CATEGORY_SOLD_OUT`；
  - 同一订单的超时释放与上传凭证并发，只有一边生效，计数正确；
  - 两张订单用同一交易号并发上传，恰好 1 份成功；
  - 同金额的 10 张订单并发下单，识别分两两不同。
- 过期任务对同一批订单执行两次，名额只释放一次。
- 事务中途失败（如写同意书失败）后计数与表数据不变。
- 幂等键：同键同请求返回同一订单；同键不同请求返回 `IDEMPOTENCY_KEY_REUSED`。
- 权限：每个新接口至少一条无权限角色返回 403 的用例；`OperationAuths` 完整性测试覆盖新接口。

### 14.3 前端组件测试（Vitest）

- 报名向导每步的必填校验、年龄不足提示、优惠码校验结果展示。
- 付款页倒计时与到期后状态；应付金额和订单号展示。
- 订单详情各状态的显示与操作按钮。
- 后台审核详情：到账金额小于应付时「通过」不可用；驳回选 `OTHER` 时说明必填。
- 后台价格档表单：已有占用时价格与人群不可编辑。

### 14.4 端到端测试（Playwright，完整 compose 环境）

1. 主流程：OPS 建赛事、配两个价格档（早鸟 + 标准）并开放报名 → FINANCE 建收款账户 → 跑者（测试代码签名 `initData`）两人同单、使用百分比优惠码下单 → 付款页应付金额等于算价预览金额减去识别分（相差 1–50 分）→ 上传截图 → FINANCE 以 `UNREADABLE` 驳回 → 跑者看到驳回原因并重传 → FINANCE 通过 → 跑者订单显示已确认和参赛凭证。
2. 免单码下单直接显示已确认。
3. 免费活动报名成功，重复报名提示已报名。

CI 中 `WERUN_TELEGRAM_SEND=off`；种子数据增加一个 `FINANCE` 员工和一版 `REGISTRATION` 同意书（通过 `werun publish-consent`）。

## 15. 交付顺序

每段都含后端、前端、测试，完成标准为 CI 四个任务全部通过：

1. 平台与后台配置：`storage`、`piicrypt`、迁移 0010、新权限、赛事详情与报名开关、价格档、优惠码、收款账户及其页面。
2. 跑者登录、常用参赛人、同意书发布命令与签署、`dev-initdata`。
3. 算价、下单（含多人同单、优惠码、识别分、免单）、取消、我的报名、报名向导前三步。
4. 付款页、上传凭证、审核队列与详情、通过与驳回、重传、后台订单页。
5. 超时释放与提醒任务、`notify` 与 Telegram 推送。
6. 免费活动报名；端到端测试补齐三条流程。

## 16. 验收标准

- `make test`、`pnpm test`、`pnpm i18n:check`、端到端测试在 CI 全部通过。
- 14.2 中的并发用例稳定通过（连续运行 5 次无失败）。
- 本地 `make dev` 后，用 `werun dev-initdata` 生成的登录参数在浏览器中能走完 14.4 的主流程。
- 所有新接口写入 `openapi.yaml` 并由代码生成，`OperationAuths` 完整性测试通过。
- 没有任何接口在响应中返回完整证件号；私有文件无法通过公开地址访问。
