import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "VLM Playground",
  description: "Live vision-language playground for the local VLM gateway",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      className={cn(geistSans.variable, geistMono.variable, "h-full overflow-hidden font-sans")}
      lang="en"
      suppressHydrationWarning
    >
      <body className="h-full overflow-hidden antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" disableTransitionOnChange enableSystem>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
