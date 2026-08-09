import { MockSupervisor } from "./mock.js";
import { RealSupervisor } from "./real.js";

export function createSupervisor(hub) {
  const mode = process.env.PI_WEB_MODE || "real";
  return mode === "mock" ? new MockSupervisor(hub) : new RealSupervisor(hub);
}
