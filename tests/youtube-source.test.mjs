import { test } from "node:test";
import assert from "node:assert/strict";
import { useProject } from "../store/project-store.ts";

test("YouTube source stays independent of edited generated captions and clears on local upload", () => {
  const store = useProject.getState();
  const captions = [{ id: "generated", start: 0, end: 2, text: "Generated", speakerId: null }];
  store.setVideo(new File(["video"], "test.mp4"), null, "https://www.youtube.com/watch?v=jNQXAC9IVRw");
  store.setSegments(captions);
  assert.equal(useProject.getState().youtubeUrl, "https://www.youtube.com/watch?v=jNQXAC9IVRw");
  store.updateSegment("generated", { text: "Edited" });
  assert.equal(useProject.getState().segments[0].text, "Edited");
  store.setVideo(new File(["local"], "local.mp4"), null);
  assert.equal(useProject.getState().youtubeUrl, null);
  assert.equal(useProject.getState().segments[0].text, "Edited");
  store.setVideo(null, null, "https://www.youtube.com/watch?v=jNQXAC9IVRw");
  store.reset();
  assert.equal(useProject.getState().youtubeUrl, null);
  assert.deepEqual(useProject.getState().segments, []);
});
