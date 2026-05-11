"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { VideoPreview, type VideoPreviewHandle } from "@/components/video-preview";
import { CaptionList } from "@/components/caption-list";
import { SpeakerPanel } from "@/components/speaker-panel";
import { ExportBar } from "@/components/export-bar";
import { useProject } from "@/store/project-store";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function EditorPage() {
  const router = useRouter();
  const videoUrl = useProject((s) => s.videoUrl);
  const segments = useProject((s) => s.segments);
  const previewRef = useRef<VideoPreviewHandle>(null);

  useEffect(() => {
    // If user reloads or comes here cold, send them home.
    if (!videoUrl || segments.length === 0) {
      router.replace("/");
    }
  }, [videoUrl, segments.length, router]);

  return (
    <main className="relative min-h-screen pb-10">
      <AppHeader />
      <section className="container mx-auto space-y-4 px-6">
        <ExportBar getVideo={() => previewRef.current?.video() ?? null} />

        <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
          <div className="space-y-3">
            <VideoPreview ref={previewRef} />
          </div>

          <Tabs defaultValue="captions" className="flex flex-col">
            <TabsList className="self-start">
              <TabsTrigger value="captions">字幕</TabsTrigger>
              <TabsTrigger value="speakers">講者樣式</TabsTrigger>
            </TabsList>
            <TabsContent
              value="captions"
              className="mt-2 h-[calc(100vh-280px)] min-h-[420px]"
            >
              <CaptionList
                onSeek={(t) => previewRef.current?.seek(t)}
              />
            </TabsContent>
            <TabsContent
              value="speakers"
              className="mt-2 h-[calc(100vh-280px)] min-h-[420px]"
            >
              <SpeakerPanel />
            </TabsContent>
          </Tabs>
        </div>
      </section>
    </main>
  );
}
