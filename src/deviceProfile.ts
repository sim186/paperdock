import type { DeviceProfile } from "./api";

/** A missed discovery response does not prove a previously found scanner disappeared. */
export function retainKnownScanner(previous: DeviceProfile | null, current: DeviceProfile): DeviceProfile {
  if (current.scanProtocol || !previous?.scanProtocol) return current;
  return {
    ...current,
    features: {
      ...current.features,
      escl: previous.features.escl,
      wsscan: previous.features.wsscan,
    },
    scanProtocol: previous.scanProtocol,
    wsscanUrl: previous.wsscanUrl,
  };
}
