import type { UserEvent } from "@testing-library/user-event";

/**
 * 点击文本框后一次性粘贴 text（与 web/admin 表单测试的 fillField 同一做法）。
 *
 * user.type 逐字符派发 keydown/keypress/beforeinput/input/keyup，每个字符都让受控表单整页重渲染一次，
 * 并在字符之间让出一次宏任务。实测 RegisterPage 第 2 步 34 个字符 type 约 110 ms、粘贴约 12 ms；
 * 一个用例要填 70–140 个字符，`pnpm test` 多个工作区并行跑时 CPU 争用把单个用例拖到 3 秒以上，
 * 在较慢的 CI 机器上会超过超时。粘贴得到同样的最终值并触发同样的 onChange，断言不变。
 * 只用于空输入框（先 clear 再填）；需要验证逐键行为的地方仍用 user.type。
 */
export async function pasteInto(user: UserEvent, element: HTMLElement, text: string): Promise<void> {
  await user.click(element);
  await user.paste(text);
}
