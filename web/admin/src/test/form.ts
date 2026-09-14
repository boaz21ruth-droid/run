import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";

export type FormUser = ReturnType<typeof userEvent.setup>;

/**
 * 表单测试专用的 user-event 实例：关闭 pointer-events 检查（原因见 app.test.tsx 的同名函数说明：
 * antd 注入的大量样式让每次 getComputedStyle 很慢，CI 上会超时）。
 */
export function setupFormUser(): FormUser {
  return userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
}

function byId(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`#${id}`);
  if (!element) {
    throw new Error(`找不到 #${id}`);
  }
  return element;
}

/** 按 antd 生成的 id（`<Form name>_<字段>`）聚焦后粘贴字段值 */
export async function fillField(user: FormUser, id: string, value: string): Promise<void> {
  await user.click(byId(id));
  await user.paste(value);
}

/** 先清空再粘贴，用于编辑已有值的输入框 */
export async function replaceField(user: FormUser, id: string, value: string): Promise<void> {
  const element = byId(id);
  await user.clear(element);
  await user.click(element);
  await user.paste(value);
}

/** 日期框粘贴后用 tab 失焦确认，避免在表单内按 Enter 触发原生隐式提交 */
export async function fillDateField(user: FormUser, id: string, value: string): Promise<void> {
  await fillField(user, id, value);
  await user.tab();
}
