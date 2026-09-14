import type { Schemas } from "@werun/api-client";
import type { Lang } from "@werun/i18n";

/** 后台列表显示当前语言的名称；缺失时按 en → zh → km 回退，避免出现空白行 */
export function pickText(text: Schemas["LocalizedText"], lang: Lang): string {
  return text[lang] || text.en || text.zh || text.km || "";
}
