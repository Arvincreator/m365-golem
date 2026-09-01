import type { Metadata } from "next";
import { ThemeProvider } from "../components/ThemeProvider";
import { I18nProvider } from "../components/I18nProvider";
import { OpsStyleProvider } from "../components/OpsStyleProvider";
import { ToastProvider } from "../components/ui/toast-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "M365 Copilot 工作台",
  description: "以可見 Edge 操作 Microsoft 365 Copilot Web 的加密專案工作台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-TW" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider>
          <I18nProvider>
            <OpsStyleProvider>
              <ToastProvider>{children}</ToastProvider>
            </OpsStyleProvider>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
