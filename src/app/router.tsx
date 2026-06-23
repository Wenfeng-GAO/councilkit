import type { ReactNode } from "react";
import { createBrowserRouter } from "react-router-dom";

function Placeholder({ title }: { title: string }): ReactNode {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 bg-bg text-fg">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-sm text-muted">CouncilKit placeholder route</p>
    </main>
  );
}

export const router = createBrowserRouter([
  { path: "/", element: <Placeholder title="CouncilKit" /> },
  { path: "/rooms/new", element: <Placeholder title="New Room" /> },
  { path: "/rooms/:roomId", element: <Placeholder title="Room" /> },
  { path: "/templates", element: <Placeholder title="Templates" /> },
]);
