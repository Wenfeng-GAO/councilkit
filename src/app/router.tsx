import { HomePage } from "@/app/pages/HomePage";
import { NewRoomPage } from "@/app/pages/NewRoomPage";
import { RoomPage } from "@/app/pages/RoomPage";
import { AppShell } from "@/components/layout/AppShell";
import { EmptyState } from "@/components/shared/EmptyState";
import { createBrowserRouter } from "react-router-dom";

const templatesPage = <EmptyState title="模板 (P1)" hint="Agent 模板管理将在后续版本提供。" />;

const withShell = (node: React.ReactNode) => <AppShell>{node}</AppShell>;

export const router = createBrowserRouter([
  { path: "/", element: withShell(<HomePage />) },
  { path: "/rooms/new", element: withShell(<NewRoomPage />) },
  { path: "/rooms/:roomId", element: withShell(<RoomPage />) },
  { path: "/templates", element: withShell(templatesPage) },
]);
