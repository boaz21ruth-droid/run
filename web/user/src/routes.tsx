import type { RouteObject } from "react-router";
import { RequireRunner } from "./auth/RequireRunner";
import { Layout } from "./components/Layout";
import { EventDetailPage } from "./pages/EventDetailPage";
import { EventsPage } from "./pages/EventsPage";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OrderDetailPage } from "./pages/OrderDetailPage";
import { OrdersPage } from "./pages/OrdersPage";
import { PayPage } from "./pages/PayPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { ProofUploadPage } from "./pages/ProofUploadPage";
import { RegisterPage } from "./pages/RegisterPage";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "events", element: <EventsPage /> },
      { path: "events/:slug", element: <EventDetailPage /> },
      {
        // 需要跑者登录的页面；Task 14、18、22 的页面也加在这里
        element: <RequireRunner />,
        children: [
          { path: "profiles", element: <ProfilesPage /> },
          { path: "events/:slug/register", element: <RegisterPage /> },
          { path: "orders", element: <OrdersPage /> },
          { path: "orders/:orderNo", element: <OrderDetailPage /> },
          { path: "orders/:orderNo/pay", element: <PayPage /> },
          { path: "orders/:orderNo/proof", element: <ProofUploadPage /> },
        ],
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
