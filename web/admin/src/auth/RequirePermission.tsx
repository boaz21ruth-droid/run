import type { ReactNode } from "react";
import { ForbiddenPage } from "../pages/ForbiddenPage";
import { can, type Access } from "./can";
import { useMe } from "./useMe";

interface RequirePermissionProps {
  permission: string;
  access: Access;
  children: ReactNode;
}

export function RequirePermission({ permission, access, children }: RequirePermissionProps) {
  const { data: me } = useMe();
  if (!can(me?.permissions, permission, access)) {
    return <ForbiddenPage />;
  }
  return <>{children}</>;
}
