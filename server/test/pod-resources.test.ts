import { describe, it, expect } from "vitest";
import { parseCpuToMillicores, parseMemoryToBytes } from "../src/replicas/kubernetes.js";

/**
 * Kubernetes quantities are strings with unit suffixes, and metrics-server
 * reports CPU in nanocores while everything else in the cluster writes
 * millicores or whole cores. Getting the conversion wrong yields a number that
 * looks entirely plausible and is off by a factor of a thousand — which is
 * worse than showing nothing, because nobody checks a number that looks fine.
 */
describe("Kubernetes quantity parsing", () => {
  it("reads CPU in every unit the API uses", () => {
    // What metrics-server actually returns.
    expect(parseCpuToMillicores("123456789n")).toBeCloseTo(123.456789, 5);
    expect(parseCpuToMillicores("1000000000n")).toBe(1000); // one full core
    expect(parseCpuToMillicores("500u")).toBe(0.5);
    // What a pod spec is written in.
    expect(parseCpuToMillicores("250m")).toBe(250);
    expect(parseCpuToMillicores("2")).toBe(2000);
    expect(parseCpuToMillicores(undefined)).toBe(0);
  });

  it("reads memory in binary and decimal units", () => {
    expect(parseMemoryToBytes("1Ki")).toBe(1024);
    expect(parseMemoryToBytes("64Mi")).toBe(64 * 1024 ** 2);
    expect(parseMemoryToBytes("2Gi")).toBe(2 * 1024 ** 3);
    // Decimal suffixes are legal too, and are not the same number.
    expect(parseMemoryToBytes("1M")).toBe(1_000_000);
    expect(parseMemoryToBytes("1Mi")).not.toBe(parseMemoryToBytes("1M"));
    // Bare bytes.
    expect(parseMemoryToBytes("512")).toBe(512);
    expect(parseMemoryToBytes(undefined)).toBe(0);
  });
});
