import type { RouteObject } from "react-router";
import { RequireRunner } from "./auth/RequireRunner";
import { Layout, type RouteHandle } from "./components/Layout";
import { EventDetailPage } from "./pages/EventDetailPage";
import { EventsPage } from "./pages/EventsPage";
import { FreeSignupPage } from "./pages/FreeSignupPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { MePage } from "./pages/MePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OrderDetailPage } from "./pages/OrderDetailPage";
import { OrdersPage } from "./pages/OrdersPage";
import { PayPage } from "./pages/PayPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { CommunityActivityPage } from "./pages/CommunityActivityPage";
import { CommunityMinePage } from "./pages/CommunityMinePage";
import { CommunityNewPage } from "./pages/CommunityNewPage";
import { CommunityPage } from "./pages/CommunityPage";
import { CompRequestPage } from "./pages/CompRequestPage";
import { ProofUploadPage } from "./pages/ProofUploadPage";
import { ReferralPage } from "./pages/ReferralPage";
import { RegisterPage } from "./pages/RegisterPage";
import { RouteErrorPage } from "./pages/RouteErrorPage";
import { VolunteerPage } from "./pages/VolunteerPage";

/** document.title 用的 i18n key，由 Layout 读取 */
const title = (key: string): RouteHandle => ({ title: key });

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    // 任何子路由渲染出错都落到这里，而不是白屏
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "events", element: <EventsPage />, handle: title("user:events.title") },
      { path: "events/:slug", element: <EventDetailPage />, handle: title("user:titles.eventDetail") },
      { path: "login", element: <LoginPage />, handle: title("user:auth.login") },
      { path: "r/:slug", element: <ReferralPage />, handle: title("user:referral.title") },
      { path: "community", element: <CommunityPage />, handle: title("user:community.title") },
      {
        // 需要跑者登录的页面；Task 14、18、22 的页面也加在这里
        element: <RequireRunner />,
        children: [
          { path: "me", element: <MePage />, handle: title("user:me.title") },
          { path: "profiles", element: <ProfilesPage />, handle: title("user:profiles.title") },
          { path: "events/:slug/register", element: <RegisterPage />, handle: title("user:titles.register") },
          { path: "events/:slug/free-signup", element: <FreeSignupPage />, handle: title("user:free.title") },
          { path: "events/:slug/comp", element: <CompRequestPage />, handle: title("user:comp.title") },
          { path: "events/:slug/volunteer", element: <VolunteerPage />, handle: title("user:volunteer.title") },
          { path: "community/new", element: <CommunityNewPage />, handle: title("user:community.new.title") },
          { path: "community/mine", element: <CommunityMinePage />, handle: title("user:community.mine.title") },
          { path: "community/:id", element: <CommunityActivityPage />, handle: title("user:community.detailTitle") },
          { path: "orders", element: <OrdersPage />, handle: title("user:orders.title") },
          { path: "orders/:orderNo", element: <OrderDetailPage />, handle: title("user:titles.orderDetail") },
          { path: "orders/:orderNo/pay", element: <PayPage />, handle: title("user:pay.title") },
          { path: "orders/:orderNo/proof", element: <ProofUploadPage />, handle: title("user:proof.title") },
        ],
      },
      { path: "*", element: <NotFoundPage />, handle: title("user:notFound.title") },
    ],
  },
];
