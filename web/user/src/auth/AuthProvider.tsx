import { useQueryClient } from "@tanstack/react-query";
import type { Schemas } from "@werun/api-client";
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { AuthController, AuthState } from "./controller";

const AuthContext = createContext<AuthController | null>(null);

/** 挂载时启动登录：有有效令牌取当前跑者，否则用 initData 登录；取不到 initData 时为未登录。 */
export function AuthProvider({ controller, children }: { controller: AuthController; children: ReactNode }) {
  useEffect(() => {
    void controller.start();
  }, [controller]);
  return <AuthContext.Provider value={controller}>{children}</AuthContext.Provider>;
}

function useAuthController(): AuthController {
  const controller = useContext(AuthContext);
  if (!controller) {
    throw new Error("useAuth 必须在 AuthProvider 内使用");
  }
  return controller;
}

export interface UseAuthResult extends AuthState {
  relogin: () => Promise<boolean>;
  logout: () => Promise<void>;
  /** 浏览器模式：向手机号发送验证码 */
  requestCode: (phone: string) => Promise<Schemas["PhoneCodeSent"]>;
  /** 浏览器模式：校验验证码并登录 */
  loginWithPhone: (phone: string, code: string) => Promise<void>;
  /** 用接口返回的跑者直接更新状态（例如保存「我的」资料后），让顶栏等读取者立即看到新值 */
  setUser: (user: Schemas["AppUser"]) => void;
}

export function useAuth(): UseAuthResult {
  const controller = useAuthController();
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const queryClient = useQueryClient();
  return {
    status: state.status,
    user: state.user,
    relogin: () => controller.relogin(),
    logout: async () => {
      await controller.logout();
      // 清掉上一位跑者的缓存数据
      queryClient.clear();
    },
    requestCode: (phone) => controller.requestCode(phone),
    loginWithPhone: async (phone, code) => {
      await controller.loginWithPhone(phone, code);
      // 和 logout 一样清缓存：401 之后换一位跑者在同一个标签页登录时，
      // 上一位跑者的 /app/orders 等缓存不能继续渲染
      queryClient.clear();
    },
    setUser: (user) => controller.setUser(user),
  };
}
