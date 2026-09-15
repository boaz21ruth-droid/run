#!/usr/bin/env bash
# 在已启动的 deploy/compose.yaml 环境里发布端到端测试用的报名同意书 REG-E2E-v1（zh/en/km）。
# 已发布的语言跳过（同意书版本发布后不可修改）。可重复执行。
set -euo pipefail

cd "$(dirname "$0")/../.."

COMPOSE=(docker compose -f deploy/compose.yaml --env-file .env)
VERSION="REG-E2E-v1"
EFFECTIVE_DATE="2026-01-01"

consent_exists() {
  local lang="$1"
  "${COMPOSE[@]}" exec -T postgres \
    psql -U werun -d werun -tAc "SELECT 1 FROM disclaimer_versions WHERE purpose = 'REGISTRATION' AND version = '${VERSION}' AND lang = '${lang}'" | grep -q '^1$'
}

publish_consent() {
  local lang="$1" text="$2" items="$3"
  if consent_exists "$lang"; then
    echo "skip ${VERSION} (${lang}): already published"
    return
  fi
  printf '%s\n' "$text" | "${COMPOSE[@]}" exec -T api /werun publish-consent \
    --purpose REGISTRATION --version "$VERSION" --lang "$lang" \
    --effective-date "$EFFECTIVE_DATE" --file - --items "$items"
  echo "published ${VERSION} (${lang})"
}

ZH_TEXT='# 报名同意书（端到端测试）

1. 参赛者须遵守赛事规则，包括关门时间与赛道安全要求。
2. 参赛者确认自身健康状况适合参加本次活动。
3. 报名信息仅用于赛事组织。'
ZH_ITEMS='[{"k":"rules","t":"我已阅读并遵守赛事规则","d":"包括关门时间与赛道安全要求"},{"k":"health","t":"我的身体状况适合参加本次活动","d":"如有心脏病等疾病请先咨询医生"},{"k":"terms","t":"我同意报名条款与个人信息处理规则","d":"报名信息仅用于赛事组织"}]'

EN_TEXT='# Registration consent (end-to-end test)

1. Participants must follow the event rules, including cut-off times and course safety requirements.
2. Participants confirm they are fit to take part in this event.
3. Registration data is used only to organise the event.'
EN_ITEMS='[{"k":"rules","t":"I have read and will follow the event rules","d":"Including cut-off times and course safety requirements"},{"k":"health","t":"I am fit to take part in this event","d":"Consult a doctor first if you have a heart condition or a similar illness"},{"k":"terms","t":"I agree to the registration terms and personal data policy","d":"Registration data is used only to organise the event"}]'

KM_TEXT='# លិខិតយល់ព្រមចុះឈ្មោះ (ការធ្វើតេស្តពីដើមដល់ចប់)

1. អ្នកចូលរួមត្រូវគោរពតាមវិន័យនៃព្រឹត្តិការណ៍ រួមទាំងពេលវេលាបិទ និងតម្រូវការសុវត្ថិភាពលើផ្លូវរត់។
2. អ្នកចូលរួមបញ្ជាក់ថា សុខភាពរបស់ខ្លួនសមរម្យសម្រាប់ចូលរួមព្រឹត្តិការណ៍នេះ។
3. ព័ត៌មានចុះឈ្មោះប្រើសម្រាប់តែការរៀបចំព្រឹត្តិការណ៍ប៉ុណ្ណោះ។'
KM_ITEMS='[{"k":"rules","t":"ខ្ញុំបានអាន ហើយនឹងគោរពតាមវិន័យនៃព្រឹត្តិការណ៍","d":"រួមទាំងពេលវេលាបិទ និងតម្រូវការសុវត្ថិភាពលើផ្លូវរត់"},{"k":"health","t":"សុខភាពរបស់ខ្ញុំសមរម្យសម្រាប់ចូលរួមព្រឹត្តិការណ៍នេះ","d":"ប្រសិនបើមានជំងឺបេះដូង ឬជំងឺស្រដៀងគ្នា សូមពិគ្រោះជាមួយវេជ្ជបណ្ឌិតជាមុន"},{"k":"terms","t":"ខ្ញុំយល់ព្រមលើលក្ខខណ្ឌចុះឈ្មោះ និងគោលការណ៍ទិន្នន័យផ្ទាល់ខ្លួន","d":"ព័ត៌មានចុះឈ្មោះប្រើសម្រាប់តែការរៀបចំព្រឹត្តិការណ៍ប៉ុណ្ណោះ"}]'

publish_consent zh "$ZH_TEXT" "$ZH_ITEMS"
publish_consent en "$EN_TEXT" "$EN_ITEMS"
publish_consent km "$KM_TEXT" "$KM_ITEMS"
