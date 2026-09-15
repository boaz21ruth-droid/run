import { Navigate, type RouteObject } from "react-router";
import { PERM_EVENT_CONFIG, PERM_ORDER_VIEW, PERM_PAYMENT_ACCOUNT_MANAGE, PERM_PROOF_REVIEW } from "./auth/can";
import { RequireAuth } from "./auth/RequireAuth";
import { RequirePermission } from "./auth/RequirePermission";
import { AppLayout } from "./layout/AppLayout";
import { EventCreatePage } from "./pages/EventCreatePage";
import { EventDetailPage } from "./pages/EventDetailPage";
import { EventsPage } from "./pages/EventsPage";
import { LoginPage } from "./pages/LoginPage";
import { OrderDetailPage } from "./pages/OrderDetailPage";
import { OrdersPage } from "./pages/OrdersPage";
import { PaymentAccountsPage } from "./pages/PaymentAccountsPage";
import { ProofDetailPage } from "./pages/ProofDetailPage";
import { ProofsPage } from "./pages/ProofsPage";

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
          {
            path: "payment-accounts",
            element: (
              <RequirePermission permission={PERM_PAYMENT_ACCOUNT_MANAGE} access="read">
                <PaymentAccountsPage />
              </RequirePermission>
            ),
          },
          {
            path: "proofs",
            element: (
              <RequirePermission permission={PERM_PROOF_REVIEW} access="read">
                <ProofsPage />
              </RequirePermission>
            ),
          },
          {
            path: "proofs/:id",
            element: (
              <RequirePermission permission={PERM_PROOF_REVIEW} access="read">
                <ProofDetailPage />
              </RequirePermission>
            ),
          },
          {
            path: "orders",
            element: (
              <RequirePermission permission={PERM_ORDER_VIEW} access="read">
                <OrdersPage />
              </RequirePermission>
            ),
          },
          {
            path: "orders/:id",
            element: (
              <RequirePermission permission={PERM_ORDER_VIEW} access="read">
                <OrderDetailPage />
              </RequirePermission>
            ),
          },
          { path: "*", element: <Navigate to="/events" replace /> },
        ],
      },
    ],
  },
];
