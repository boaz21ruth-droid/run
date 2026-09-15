import { useQueryClient } from "@tanstack/react-query";
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
  };
}
