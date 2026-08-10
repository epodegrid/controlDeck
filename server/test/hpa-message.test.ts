import { describe, it, expect } from "vitest";
import { summariseHpaMessage } from "../src/scaling/status.js";

/**
 * The HPA's own message is the only thing that names why a metric could not be
 * read, and Kubernetes buries it behind a serialized label selector longer than
 * the rest of the sentence. Truncating from the front — the obvious thing —
 * keeps the boilerplate and throws away the cause.
 */
describe("summarising an HPA failure message", () => {
  const real =
    "the HPA was unable to compute the replica count: unable to get external metric " +
    "cds/s0-metric-api-pending_requests/&LabelSelector{MatchLabels:map[string]string{" +
    "scaledobject.keda.sh/name: ornith-scaledobject,},MatchExpressions:[]LabelSelector" +
    "Requirement{},}: unable to fetch metrics from external metrics API: rpc error: " +
    "code = Unknown desc = error when getting metric values metric:" +
    "s0-metric-api-pending_requests encountered error: dial tcp: lookup nope.cds.svc." +
    "cluster.local: no such host";

  it("keeps the part that names the fault", () => {
    const out = summariseHpaMessage(real);
    expect(out).toContain("no such host");
    expect(out.length).toBeLessThanOrEqual(241);
  });

  it("drops the serialized label selector", () => {
    const out = summariseHpaMessage(real);
    expect(out).not.toContain("LabelSelector");
    expect(out).not.toContain("MatchExpressions");
  });

  it("leaves a short message alone", () => {
    expect(summariseHpaMessage("connection refused")).toBe("connection refused");
    expect(summariseHpaMessage(undefined)).toBe("");
  });
});
