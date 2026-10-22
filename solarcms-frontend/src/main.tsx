import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import { AuthProvider } from "@/auth/AuthProvider";
import { ThemeProvider } from "@/theme/ThemeProvider";
import { installPointerLight } from "@/theme/pointerLight";
import { LiveSocketProvider } from "@/live/LiveSocket";
import { AppRoutes } from "@/routes";
import { isApiError } from "@/api/problem";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 is handled by the client wrapper (refresh once, then log out) and
      // 403/404/409/422 are answers, not transient failures. Only retry the rest.
      retry: (failureCount, error) => {
        if (isApiError(error) && error.status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

installPointerLight();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* "user": every Framer Motion animation honours the operating system's
        reduce-motion setting — movement is dropped, fades are kept. */}
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthProvider>
              {/* One socket for the whole application (Guardrail 12). */}
              <LiveSocketProvider>
                <AppRoutes />
              </LiveSocketProvider>
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </MotionConfig>
  </React.StrictMode>,
);
