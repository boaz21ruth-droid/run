import type { Schemas } from "@werun/api-client";
import { describe, expect, it, vi } from "vitest";
import { AuthController, type AuthControllerDeps } from "./controller";
import { TOKEN_KEY, saveToken } from "./session";

const runner: Schemas["AppUser"] = {
  id: 1,
  telegramUserId: 10001,
  telegramUsername: "darasok",
  phoneMasked: null,
  displayName: "Sok Dara",
  locale: "en",
};

function session(token: string): Schemas["AppSession"] {
  return { token, expiresAt: "2099-01-01T00:00:00Z", user: runner };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDeps(initData: string | null = "signed-init-data") {
  const deps = {
    resolveInitData: vi.fn<AuthControllerDeps["resolveInitData"]>(async () => initData),
    login: vi.fn<AuthControllerDeps["login"]>(async () => session("tok-1")),
    me: vi.fn<AuthControllerDeps["me"]>(async () => runner),
    logout: vi.fn<AuthControllerDeps["logout"]>(async () => undefined),
    requestCode: vi.fn<AuthControllerDeps["requestCode"]>(async () => ({
      expiresInSeconds: 300,
      resendAfterSeconds: 60,
      channel: "telegram" as const,
    })),
    verifyCode: vi.fn<AuthControllerDeps["verifyCode"]>(async () => session("tok-phone")),
    browserMode: vi.fn<AuthControllerDeps["browserMode"]>(() => false),
  };
  return deps;
}

describe("AuthController", () => {
  it("没有 initData 时变为 unauthenticated，不发登录请求", async () => {
    const deps = makeDeps(null);
    const auth = new AuthController(deps);

    await expect(auth.start()).resolves.toBe(false);

    expect(auth.getState()).toEqual({ status: "unauthenticated", user: null });
    expect(deps.login).not.toHaveBeenCalled();
  });

  it("用 initData 登录，保存令牌并通知订阅者", async () => {
    const deps = makeDeps();
    const auth = new AuthController(deps);
    const listener = vi.fn();
    auth.subscribe(listener);

    const started = auth.start();
    expect(auth.getState().status).toBe("loading");
    await expect(started).resolves.toBe(true);

    expect(deps.login).toHaveBeenCalledWith("signed-init-data");
    expect(auth.getState()).toEqual({ status: "authenticated", user: runner });
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe("tok-1");
    expect(listener).toHaveBeenCalled();
  });

  it("已有有效令牌时只调用 me", async () => {
    saveToken("stored-token", "2099-01-01T00:00:00Z");
    const deps = makeDeps();
    const auth = new AuthController(deps);

    await expect(auth.start()).resolves.toBe(true);

    expect(deps.me).toHaveBeenCalledOnce();
    expect(deps.login).not.toHaveBeenCalled();
    expect(auth.getState().user).toEqual(runner);
  });

  it("已有令牌但 me 失败时改用 initData 登录", async () => {
    saveToken("revoked-token", "2099-01-01T00:00:00Z");
    const deps = makeDeps();
    deps.me.mockRejectedValue(new Error("401"));
    deps.login.mockResolvedValue(session("tok-2"));
    const auth = new AuthController(deps);

    await expect(auth.start()).resolves.toBe(true);

    expect(deps.login).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe("tok-2");
  });

  it("start 与 relogin 并发时只登录一次，重复 start 不再请求", async () => {
    const deps = makeDeps();
    const auth = new AuthController(deps);

    const results = await Promise.all([auth.start(), auth.start(), auth.relogin()]);
    await auth.start();

    expect(results).toEqual([true, true, true]);
    expect(deps.login).toHaveBeenCalledOnce();
  });

  it("handleUnauthorized 清掉令牌并在后台重新登录一次，期间保持已登录状态", async () => {
    const deps = makeDeps();
    const auth = new AuthController(deps);
    await auth.start();
    const second = deferred<Schemas["AppSession"]>();
    deps.login.mockReturnValueOnce(second.promise);

    auth.handleUnauthorized();
    auth.handleUnauthorized();

    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(auth.getState().status).toBe("authenticated");
    second.resolve(session("tok-2"));
    await expect(auth.lastRelogin()).resolves.toBe(true);
    expect(deps.login).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe("tok-2");
  });

  it("重新登录失败时变为 unauthenticated", async () => {
    const deps = makeDeps();
    const auth = new AuthController(deps);
    await auth.start();
    deps.login.mockRejectedValueOnce(new Error("TELEGRAM_AUTH_INVALID"));

    auth.handleUnauthorized();

    await expect(auth.lastRelogin()).resolves.toBe(false);
    expect(auth.getState()).toEqual({ status: "unauthenticated", user: null });
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("还没有收到过 401 时 lastRelogin 为 false", async () => {
    const auth = new AuthController(makeDeps());
    await expect(auth.lastRelogin()).resolves.toBe(false);
  });

  it("logout 吊销令牌，期间的 401 不触发重新登录", async () => {
    const deps = makeDeps();
    const auth = new AuthController(deps);
    await auth.start();
    deps.logout.mockImplementationOnce(async () => {
      auth.handleUnauthorized();
      throw new Error("401");
    });

    await auth.logout();

    expect(deps.logout).toHaveBeenCalledOnce();
    expect(deps.login).toHaveBeenCalledOnce();
    expect(auth.getState()).toEqual({ status: "unauthenticated", user: null });
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("loginWithPhone 成功后保存令牌并进入 authenticated", async () => {
    const deps = makeDeps(null);
    const controller = new AuthController(deps);
    await controller.start();
    expect(controller.getState().status).toBe("unauthenticated");

    await controller.loginWithPhone("+85512345678", "123456");

    expect(deps.verifyCode).toHaveBeenCalledWith("+85512345678", "123456");
    expect(controller.getState().status).toBe("authenticated");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe("tok-phone");
  });

  it("浏览器模式下 401 只清令牌，不重登", async () => {
    const deps = makeDeps(null);
    deps.browserMode.mockReturnValue(true);
    saveToken("tok-old", "2099-01-01T00:00:00Z");
    const controller = new AuthController(deps);
    await controller.start();
    expect(controller.getState().status).toBe("authenticated");

    controller.handleUnauthorized();
    await controller.lastRelogin();

    expect(deps.login).not.toHaveBeenCalled();
    expect(controller.getState().status).toBe("unauthenticated");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("setUser 直接用给定的跑者更新已登录状态并通知订阅者", async () => {
    const deps = makeDeps();
    const auth = new AuthController(deps);
    await auth.start();
    const listener = vi.fn();
    auth.subscribe(listener);
    const updated: Schemas["AppUser"] = { ...runner, displayName: "Dara" };

    auth.setUser(updated);

    expect(auth.getState()).toEqual({ status: "authenticated", user: updated });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("loginWithPhone 排在进行中的 start() 之后，不被随后才落地的 initData 登录冲掉", async () => {
    const deps = makeDeps(null);
    const gate = deferred<string | null>();
    deps.resolveInitData.mockReturnValue(gate.promise);
    const controller = new AuthController(deps);

    const started = controller.start();
    const loggedInWithPhone = controller.loginWithPhone("+85512345678", "123456");

    // start() 的 restore() 还卡在 resolveInitData 上；现在才让它落地（返回 null，
    // 走 loginWithInitData 的 fail() 分支）。若 loginWithPhone 没有排队等待，
    // 这个 fail() 会晚于 loginWithPhone 的 set(authenticated) 执行，把令牌冲掉。
    gate.resolve(null);

    await expect(started).resolves.toBe(false);
    await loggedInWithPhone;

    expect(deps.verifyCode).toHaveBeenCalledWith("+85512345678", "123456");
    expect(controller.getState().status).toBe("authenticated");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe("tok-phone");
  });
});
