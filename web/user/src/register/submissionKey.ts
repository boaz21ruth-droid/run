/**
 * 一次提交尝试对应一个 Idempotency-Key：同一份请求体（网络失败后重试）沿用同一个键，
 * 请求体变化（改了优惠码、参赛人等）才生成新键。服务端只在成功时保存键，所以失败后复用是安全的。
 */
export class SubmissionKey {
  private payload: string | null = null;
  private key = "";
  private readonly generate: () => string;

  constructor(generate: () => string = () => crypto.randomUUID()) {
    this.generate = generate;
  }

  keyFor(payload: string): string {
    if (payload !== this.payload) {
      this.payload = payload;
      this.key = this.generate();
    }
    return this.key;
  }
}
