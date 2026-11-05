import type { Schemas } from "@werun/api-client";

type ConsentItem = Schemas["ConsentItem"];

/** 必勾条目是否都勾了；可选条目（如同意公开成绩）不影响提交 */
export function requiredChecked(items: readonly ConsentItem[], isChecked: (key: string) => boolean): boolean {
  return items.length > 0 && items.every((item) => item.optional || isChecked(item.key));
}

/** 提交的 checkedItems：只带勾了的条目，没勾的可选条目就是不同意 */
export function checkedKeys(items: readonly ConsentItem[], isChecked: (key: string) => boolean): string[] {
  return items.filter((item) => isChecked(item.key)).map((item) => item.key);
}
