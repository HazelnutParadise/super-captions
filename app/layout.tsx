import type { Metadata } from "next";
import Script from "next/script";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Super Captions · 影片字幕工作室 - 榛果繽紛樂",
  description:
    "在瀏覽器內擷取音訊、由 Whisper Gateway 生成字幕，並即時預覽、燒錄輸出。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning on <html> and <body>: the Pistachio CF
    // Worker (HazelnutParadise/Pistachio-Global-Announcement-System) sets
    // style/class on both elements via DOMContentLoaded, before React
    // hydrates. Without the suppression React sees the attribute diff and
    // falls back to a full client re-render (flash-and-disappear #418).
    <html lang="zh-Hant" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased" suppressHydrationWarning>
        {/* Pistachio anchor — the Worker looks for this id and injects the
         *  banner inside it. dangerouslySetInnerHTML makes the inner node
         *  opaque to React's reconciler so the Worker's DOM mutations
         *  don't cause hydration issues. */}
        <div
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: '<div id="Pistachio-Announcement"></div>',
          }}
        />

        <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
          <div
            className="blur-orb h-[40rem] w-[40rem]"
            style={{ background: "#7c3aed", top: "-12rem", left: "-12rem" }}
          />
          <div
            className="blur-orb h-[40rem] w-[40rem]"
            style={{
              background: "#06b6d4",
              top: "10rem",
              right: "-14rem",
            }}
          />
          <div
            className="blur-orb h-[30rem] w-[30rem]"
            style={{ background: "#ec4899", bottom: "-10rem", left: "20%" }}
          />
          <div className="absolute inset-0 grid-bg opacity-30" />
        </div>

        {children}

        <Toaster
          position="bottom-right"
          theme="dark"
          richColors
          closeButton
        />

        {/* OneAD slot — required ad placement */}
        <div className="container mx-auto px-6 pb-12 pt-4">
          <div id="div-onead-draft" />
        </div>

        <Script id="onead-config" strategy="afterInteractive">
          {`
            var custom_call = function (params) {
              if (params.hasAd) {
                console.log('TD has AD')
              } else {
                console.log('TD AD Empty')
              }
            };
            ONEAD_TEXT = {};
            ONEAD_TEXT.pub = {};
            ONEAD_TEXT.pub.uid = "2000181";
            ONEAD_TEXT.pub.slotobj = document.getElementById("div-onead-draft");
            ONEAD_TEXT.pub.player_mode = "text-drive";
            ONEAD_TEXT.pub.queryAdCallback = custom_call;
            window.ONEAD_text_pubs = window.ONEAD_text_pubs || [];
            ONEAD_text_pubs.push(ONEAD_TEXT);
          `}
        </Script>
        <Script
          src="https://ad-specs.guoshipartners.com/static/js/ad-serv.min.js"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
