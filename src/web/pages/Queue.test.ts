import { describe, expect, it } from "vitest";
import {
  FINISHED_HEADING,
  partitionQueueJobs,
  queueNodeLine,
  queueToolbar,
  queueVisibleHeadings,
  WAITING_HEADING,
  WORKING_NOW_HEADING,
} from "./Queue";
import type { JobRow } from "../api";

function job(id: string, status: JobRow["status"]): JobRow {
  return {
    id,
    displayTitle: id,
    status,
    phase: status === "running" ? "transcoding" : status === "queued" || status === "held" ? "queued" : "idle",
    progress: status === "running" ? 0.4 : 0,
    error: null,
    warning: null,
    promoteError: null,
  };
}

describe("Queue sections", () => {
  it("puts running jobs in Working now, held in waiting, and succeeded in finished", () => {
    const groups = partitionQueueJobs([
      job("done", "succeeded"),
      job("run", "running"),
      job("hold", "held"),
      job("pause", "paused"),
      job("fail", "failed"),
    ]);
    expect(groups.working.map((row) => row.id)).toEqual(["run"]);
    expect(groups.waiting.map((row) => row.id)).toEqual(["hold", "pause"]);
    expect(groups.finished.map((row) => row.id)).toEqual(["done", "fail"]);
  });

  it("still offers Clear finished when finished jobs are not on the loaded page", () => {
    expect(queueToolbar({ activeCount: 2, finishedCount: 55 })).toEqual({ cancelAll: true, clearFinished: true });
    expect(queueToolbar({ activeCount: 0, finishedCount: 0 })).toEqual({ cancelAll: false, clearFinished: false });
  });

  it("names Working now when a running job is present and does not call the queue idle", () => {
    expect(queueVisibleHeadings([job("run", "running"), job("done", "succeeded")])).toEqual([
      WORKING_NOW_HEADING,
      FINISHED_HEADING,
    ]);
    expect(queueVisibleHeadings([job("wait", "queued")])).toEqual([WAITING_HEADING]);
    expect(queueVisibleHeadings([])).toEqual([]);
  });

  it("names the encode node without calling it Encode target", () => {
    expect(queueNodeLine({ status: "running", assignedNodeName: "5090" })).toBe("On 5090");
    expect(queueNodeLine({ status: "queued", assignedNodeName: "5090", waitingForNode: true })).toBe("Waiting for 5090");
    expect(queueNodeLine({ status: "queued" })).toBeNull();
  });
});
