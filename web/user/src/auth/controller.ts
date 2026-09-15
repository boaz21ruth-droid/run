import type { Schemas } from "@werun/api-client";
import { clearToken, readToken, saveToken } from "./session";

export type AuthStatus = "idle" | "loading" | "authenticated" | "unauthenticated";

export interface AuthState {
  status: AuthStatus;
  user: Schemas["AppUser"] | null;
}

export interface AuthControllerDeps {
  resolveInitData: () => Promise<string | null>;
  login: (initData: string) => Promise<Schemas["AppSession"]>;
  me: () => Promise<Schemas["AppUser"]>;
  logout: () => Promise<void>;
}

/**
 * 跑者登录状态。不依赖 React，api-client 的 onUnauthorized 与 QueryCache 都直接调用它；
 * React 组件通过 useSyncExternalStore(subscribe, getState) 读取。
 */
export class AuthController {
  private state: AuthState = { status: "idle", user: null };
  private readonly listeners = new Set<() => void>();
  private readonly deps: AuthControllerDeps;
  private pending: Promise<boolean> | null = null;
  private last: Promise<boolean> | null = null;
  private loggingOut = false;

  constructor(deps: AuthControllerDeps) {
    this.deps = deps;
  }

  readonly getState = (): AuthState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 应用启动时调用：有有效令牌就取当前跑者，否则用 initData 登录。重复调用不会重复请求。 */
  start(): Promise<boolean> {
    if (this.pending) {
      return this.pending;
    }
    if (this.state.status !== "idle") {
      return Promise.resolve(this.state.status === "authenticated");
    }
    this.set({ status: "loading", user: null });
    return this.track(this.restore());
  }

  /** 用 initData 重新登录；已有进行中的登录时返回同一个 Promise。 */
  relogin(): Promise<boolean> {
    if (this.pending) {
      return this.pending;
    }
    return this.track(this.loginWithInitData());
  }

  /** api-client 收到 401 时调用：清掉令牌并重新登录一次。 */
  handleUnauthorized(): void {
    if (this.loggingOut) {
      return;
    }
    clearToken();
    this.last = this.relogin();
  }

  /** 最近一次由 401 触发的重新登录；QueryCache 等它结束后决定是否重试查询。 */
  lastRelogin(): Promise<boolean> {
    return this.last ?? Promise.resolve(false);
  }

  async logout(): Promise<void> {
    this.loggingOut = true;
    try {
      if (readToken()) {
        await this.deps.logout();
      }
    } catch {
      // 令牌已经失效时服务端返回 401，本地照样视为已退出
    } finally {
      this.loggingOut = false;
      clearToken();
      this.set({ status: "unauthenticated", user: null });
    }
  }

  private track(work: Promise<boolean>): Promise<boolean> {
    const tracked: Promise<boolean> = work.finally(() => {
      if (this.pending === tracked) {
        this.pending = null;
      }
    });
    this.pending = tracked;
    return tracked;
  }

  private async restore(): Promise<boolean> {
    if (readToken()) {
      try {
        const user = await this.deps.me();
        this.set({ status: "authenticated", user });
        return true;
      } catch {
        // 令牌被吊销或已过期：继续用 initData 登录
      }
    }
    return this.loginWithInitData();
  }

  private async loginWithInitData(): Promise<boolean> {
    const initData = await this.deps.resolveInitData().catch(() => null);
    if (!initData) {
      this.fail();
      return false;
    }
    try {
      const session = await this.deps.login(initData);
      saveToken(session.token, session.expiresAt);
      this.set({ status: "authenticated", user: session.user });
      return true;
    } catch {
      this.fail();
      return false;
    }
  }

  private fail(): void {
    clearToken();
    this.set({ status: "unauthenticated", user: null });
  }

  private set(next: AuthState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
