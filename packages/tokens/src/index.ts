/** 供 JS 使用的品牌值（Ant Design 主题等）。必须与 tokens.css 保持一致，由单元测试校验。 */
export const brand = {
  primary: "#0F66AE",
  primaryDeep: "#0A4D85",
  ink: "#101820",
  paper: "#F6F8FA",
  radius: 14,
} as const;

export type Brand = typeof brand;
