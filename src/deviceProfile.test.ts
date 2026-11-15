import { describe, expect, it } from "vitest";
import { retainKnownScanner } from "./deviceProfile";
import type { DeviceProfile } from "./api";

const known: DeviceProfile = {
  model: "HP LaserJet", features: { ipp: true, escl: false, wsscan: true, ledm: true, emailProfiles: true },
  scanProtocol: "wsscan", wsscanUrl: "http://printer:53048/",
};
const missed: DeviceProfile = {
  ...known, features: { ...known.features, wsscan: false }, scanProtocol: null, wsscanUrl: null,
};

describe("scanner discovery", () => {
  it("keeps a known scanner available when a subsequent probe misses it", () => {
    expect(retainKnownScanner(known, missed)).toEqual(known);
  });
  it("uses a newly discovered address when the printer responds", () => {
    const updated = { ...known, wsscanUrl: "http://printer:12345/" };
    expect(retainKnownScanner(known, updated)).toEqual(updated);
  });
  it("does not invent a scanner on a first unsuccessful probe", () => {
    expect(retainKnownScanner(null, missed)).toEqual(missed);
  });
});
