import { Navigate, type RouteObject } from "react-router";
import { PERM_EVENT_CONFIG } from "./auth/can";
import { RequireAuth } from "./auth/RequireAuth";
import { RequirePermission } from "./auth/RequirePermission";
import { AppLayout } from "./layout/AppLayout";
import { EventCreatePage } from "./pages/EventCreatePage";
import { EventDetailPage } from "./pages/EventDetailPage";
import { EventsPage } from "./pages/EventsPage";
import { LoginPage } from "./pages/LoginPage";

export const routes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <Navigate to="/events" replace /> },
          {
            path: "events",
            element: (
              <RequirePermission permission={PERM_EVENT_CONFIG} access="read">
                <EventsPage />
              </RequirePermission>
            ),
          },
          {
            path: "events/new",
            element: (
              <RequirePermission permission={PERM_EVENT_CONFIG} access="write">
                <EventCreatePage />
              </RequirePermission>
            ),
          },
          {
            path: "events/:id",
            element: (
              <RequirePermission permission={PERM_EVENT_CONFIG} access="read">
                <EventDetailPage />
              </RequirePermission>
            ),
          },
          { path: "*", element: <Navigate to="/events" replace /> },
        ],
      },
    ],
  },
];
