export interface ErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
}

export const UNEXPECTED_RESPONSE = "UNEXPECTED_RESPONSE";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string>;

  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }
  const error: unknown = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

export function toApiError(status: number, body: unknown): ApiError {
  if (isErrorBody(body)) {
    return new ApiError(status, body.error.code, body.error.message, body.error.fields ?? {});
  }
  return new ApiError(status, UNEXPECTED_RESPONSE, `Request failed with status ${status}`);
}

/** 2xx 返回数据；其它状态抛出 ApiError，调用方用 try/catch 或 TanStack Query 的 error 处理 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.response.ok) {
    return result.data as T;
  }
  throw toApiError(result.response.status, result.error);
}
