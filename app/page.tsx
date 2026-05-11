import { AppHeader } from "@/components/app-header";
import { UploadCard } from "@/components/upload-card";
import { HazelnutNavbar } from "@/components/hazelnut-navbar";
import {
  Sparkles,
  ShieldCheck,
  Users,
  ScanLine,
  Palette,
  Languages,
  Film,
} from "lucide-react";

export default function Home() {
  return (
    <main className="relative min-h-screen pb-16">
      <AppHeader />

      <section className="container mx-auto grid gap-10 px-6 pt-10 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
        <div className="space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-card/60 px-3 py-1 text-xs backdrop-blur">
            <Sparkles className="h-3.5 w-3.5 text-fuchsia-400" />
            <span className="text-muted-foreground">
              On-device · Whisper Gateway · Studio-grade preview
            </span>
          </div>
          <h1 className="text-4xl font-bold leading-tight tracking-tight md:text-5xl">
            影片不用上傳，
            <br />
            <span className="gradient-text">字幕也能自動上好</span>。
          </h1>
          <p className="max-w-xl text-base leading-relaxed text-muted-foreground">
            全程在你的瀏覽器裡處理，<b>只把音訊送上雲</b>。
            多人對話自動分人、逐句校稿、樣式自選，最後字幕燒進影片直接下載。
          </p>

          <div className="grid grid-cols-2 gap-3 pt-2 md:grid-cols-3">
            <Feature
              icon={<ShieldCheck className="h-5 w-5" />}
              title="影片不外流"
              desc="只送音訊上雲，原始檔留在你的裝置"
            />
            <Feature
              icon={<Users className="h-5 w-5" />}
              title="自動辨識講者"
              desc="多人對話自動分組，不用一句句標誰在講"
            />
            <Feature
              icon={<ScanLine className="h-5 w-5" />}
              title="逐句即時校稿"
              desc="影片邊播邊改，錯字漏字立刻修正"
            />
            <Feature
              icon={<Palette className="h-5 w-5" />}
              title="講者各有風格"
              desc="顏色、字體、邊框獨立調，畫面不單調"
            />
            <Feature
              icon={<Languages className="h-5 w-5" />}
              title="多語通吃"
              desc="自動偵測語言，中英日韓都接得住"
            />
            <Feature
              icon={<Film className="h-5 w-5" />}
              title="直接拿成品"
              desc="字幕燒進影片，下載就能上架"
            />
          </div>
        </div>

        <UploadCard />
      </section>

      <section className="container mx-auto px-6 pt-16">
        <div className="grid gap-4 md:grid-cols-4">
          <StatCard num="1" title="選擇影片" desc="拖曳或挑選本機影片" />
          <StatCard num="2" title="本機擷取音訊" desc="ffmpeg.wasm 抽出音軌" />
          <StatCard
            num="3"
            title="Whisper 轉文字"
            desc="榛果繽紛樂提供的 OpenAI-compatible Gateway"
          />
          <StatCard num="4" title="預覽與燒錄" desc="逐句校稿後輸出影片" />
        </div>
      </section>

      <HazelnutNavbar />
    </main>
  );
}

function Feature({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/60 p-4 backdrop-blur-sm">
      <div className="mb-2.5 inline-flex h-9 w-9 items-center justify-center rounded-md bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 text-fuchsia-300">
        {icon}
      </div>
      <div className="text-base font-semibold">{title}</div>
      <div className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {desc}
      </div>
    </div>
  );
}

function StatCard({
  num,
  title,
  desc,
}: {
  num: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border/60 bg-card/60 p-5 backdrop-blur-sm">
      <div className="absolute right-4 top-3 text-6xl font-black text-foreground/5">
        {num}
      </div>
      <div className="relative">
        <div className="text-xs uppercase tracking-widest text-muted-foreground">
          Step {num}
        </div>
        <div className="mt-1 text-base font-semibold">{title}</div>
        <div className="mt-1 text-xs text-muted-foreground">{desc}</div>
      </div>
    </div>
  );
}
