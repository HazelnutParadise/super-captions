import { AppHeader } from "@/components/app-header";
import { UploadCard } from "@/components/upload-card";
import { HazelnutNavbar } from "@/components/hazelnut-navbar";
import { Sparkles, AudioWaveform, ScanLine, Film } from "lucide-react";

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
            把影片
            <span className="gradient-text"> 自動加字幕 </span>
            <br />
            又快、又安全、又好看。
          </h1>
          <p className="max-w-xl text-base leading-relaxed text-muted-foreground">
            影片完全留在你的瀏覽器，<b>只有音訊</b>會被擷取並送往 Whisper
            Gateway。轉錄完成後在我們的工作室裡逐句校稿、自訂講者樣式，
            最後再把字幕燒錄回影片下載。
          </p>

          <div className="grid grid-cols-3 gap-3 pt-2">
            <Feature
              icon={<AudioWaveform className="h-4 w-4" />}
              title="本機分離音訊"
              desc="ffmpeg.wasm 在瀏覽器中擷取單聲道 MP3"
            />
            <Feature
              icon={<ScanLine className="h-4 w-4" />}
              title="即時預覽"
              desc="左影片右逐句字幕，進度條同步高亮"
            />
            <Feature
              icon={<Film className="h-4 w-4" />}
              title="燒錄輸出"
              desc="多講者樣式 · Canvas 合成 · 一鍵下載"
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
    <div className="rounded-lg border border-border/60 bg-card/60 p-3 backdrop-blur-sm">
      <div className="mb-2 inline-flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 text-fuchsia-300">
        {icon}
      </div>
      <div className="text-xs font-semibold">{title}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
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
