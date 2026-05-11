"use client";

import { create } from "zustand";
import { makeDefaultSpeaker, type CaptionSegment, type SpeakerStyle } from "@/lib/types";

interface ProjectState {
  videoFile: File | null;
  videoUrl: string | null;
  videoDuration: number;
  videoSize: { width: number; height: number };

  segments: CaptionSegment[];
  speakers: SpeakerStyle[];
  diarizationEnabled: boolean;
  activeSegmentId: string | null;
  language: string;

  setVideo: (file: File | null, url: string | null) => void;
  setVideoMeta: (duration: number, width: number, height: number) => void;
  setSegments: (segments: CaptionSegment[]) => void;
  updateSegment: (id: string, patch: Partial<CaptionSegment>) => void;
  deleteSegment: (id: string) => void;
  insertSegmentAfter: (id: string) => void;
  setActiveSegment: (id: string | null) => void;

  setLanguage: (language: string) => void;
  setDiarizationEnabled: (enabled: boolean) => void;
  addSpeaker: () => string;
  removeSpeaker: (id: string) => void;
  updateSpeaker: (id: string, patch: Partial<SpeakerStyle>) => void;

  reset: () => void;
}

function freshSpeakers(): SpeakerStyle[] {
  return [
    makeDefaultSpeaker("spk-1", 0, "講者 1"),
    makeDefaultSpeaker("spk-2", 1, "講者 2"),
  ];
}

export const useProject = create<ProjectState>((set, get) => ({
  videoFile: null,
  videoUrl: null,
  videoDuration: 0,
  videoSize: { width: 1280, height: 720 },

  segments: [],
  speakers: freshSpeakers(),
  diarizationEnabled: false,
  activeSegmentId: null,
  language: "auto",

  setVideo: (file, url) =>
    set((s) => {
      if (s.videoUrl && s.videoUrl !== url) URL.revokeObjectURL(s.videoUrl);
      return { videoFile: file, videoUrl: url };
    }),
  setVideoMeta: (duration, width, height) =>
    set({ videoDuration: duration, videoSize: { width, height } }),

  setSegments: (segments) => set({ segments }),
  updateSegment: (id, patch) =>
    set((s) => ({
      segments: s.segments.map((seg) =>
        seg.id === id ? { ...seg, ...patch } : seg
      ),
    })),
  deleteSegment: (id) =>
    set((s) => ({
      segments: s.segments.filter((seg) => seg.id !== id),
      activeSegmentId: s.activeSegmentId === id ? null : s.activeSegmentId,
    })),
  insertSegmentAfter: (id) =>
    set((s) => {
      const idx = s.segments.findIndex((seg) => seg.id === id);
      if (idx < 0) return {};
      const cur = s.segments[idx];
      const next = s.segments[idx + 1];
      const newStart = cur.end;
      const newEnd = Math.min(
        next ? next.start : cur.end + 2,
        cur.end + 3
      );
      const newSeg: CaptionSegment = {
        id: `seg-new-${Date.now()}`,
        start: newStart,
        end: Math.max(newEnd, newStart + 0.5),
        text: "",
        speakerId: cur.speakerId,
      };
      const segments = [...s.segments];
      segments.splice(idx + 1, 0, newSeg);
      return { segments, activeSegmentId: newSeg.id };
    }),
  setActiveSegment: (id) => set({ activeSegmentId: id }),

  setLanguage: (language) => set({ language }),
  setDiarizationEnabled: (enabled) => set({ diarizationEnabled: enabled }),

  addSpeaker: () => {
    const id = `spk-${Date.now()}`;
    const nextIndex = get().speakers.length;
    set((s) => ({
      speakers: [...s.speakers, makeDefaultSpeaker(id, nextIndex)],
    }));
    return id;
  },
  removeSpeaker: (id) =>
    set((s) => ({
      speakers: s.speakers.filter((sp) => sp.id !== id),
      segments: s.segments.map((seg) =>
        seg.speakerId === id ? { ...seg, speakerId: null } : seg
      ),
    })),
  updateSpeaker: (id, patch) =>
    set((s) => ({
      speakers: s.speakers.map((sp) => (sp.id === id ? { ...sp, ...patch } : sp)),
    })),

  reset: () =>
    set({
      videoFile: null,
      videoUrl: null,
      videoDuration: 0,
      segments: [],
      speakers: freshSpeakers(),
      diarizationEnabled: false,
      activeSegmentId: null,
      language: "auto",
    }),
}));
