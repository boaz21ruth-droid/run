/**
 * 解析测试里录制到的 multipart/form-data 请求体。
 *
 * 在这套 vitest（jsdom）+ Node 环境下，`Request.prototype.formData()` 解码含 File 字段的
 * multipart 请求体时会抛出 `webidl.is.File` 断言失败（vitest 的 jsdom 兼容层构造请求体本身没问题——
 * `Content-Type`/boundary 都正确；问题只出现在事后解码阶段，用 `.clone()` 与否结果一样）。这是这套
 * 工具链的已知限制，不是被测代码的问题：生产环境下浏览器的 fetch/FormData 是同一实现，不存在这个断言。
 * 用读取原始字节、按 boundary 手工切分的方式绕开这条解码路径。
 */
export interface MultipartField {
  type: string;
  size: number;
  filename: string;
}

export type MultipartValue = string | MultipartField;

export function isFileField(value: MultipartValue | undefined): value is MultipartField {
  return typeof value === "object" && value !== null;
}

export async function readMultipartFields(request: Request): Promise<Record<string, MultipartValue>> {
  const contentType = request.headers.get("content-type") ?? "";
  const boundaryMatch = /boundary=([^;]+)/.exec(contentType);
  if (!boundaryMatch) {
    throw new Error(`不是 multipart 请求：${contentType}`);
  }
  const boundary = boundaryMatch[1];
  const buf = Buffer.from(await request.arrayBuffer());
  const delimiter = Buffer.from(`--${boundary}`);
  const crlfcrlf = Buffer.from("\r\n\r\n");
  const fields: Record<string, MultipartValue> = {};

  let start = buf.indexOf(delimiter);
  while (start !== -1) {
    const next = buf.indexOf(delimiter, start + delimiter.length);
    if (next === -1) {
      break;
    }
    let partStart = start + delimiter.length;
    if (buf[partStart] === 0x0d && buf[partStart + 1] === 0x0a) {
      partStart += 2;
    }
    let partEnd = next;
    if (buf[partEnd - 2] === 0x0d && buf[partEnd - 1] === 0x0a) {
      partEnd -= 2;
    }
    const part = buf.subarray(partStart, partEnd);
    const headerEnd = part.indexOf(crlfcrlf);
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString("utf8");
      const body = part.subarray(headerEnd + crlfcrlf.length);
      const nameMatch = /name="([^"]*)"/.exec(headerText);
      const filenameMatch = /filename="([^"]*)"/.exec(headerText);
      const contentTypeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
      const fieldName = nameMatch?.[1] ?? "";
      if (fieldName) {
        fields[fieldName] = filenameMatch
          ? { type: contentTypeMatch?.[1]?.trim() ?? "", size: body.length, filename: filenameMatch[1] ?? "" }
          : body.toString("utf8");
      }
    }
    start = next;
  }
  return fields;
}
