import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import type { Mission } from "../packages/host/src/mission-types.js";

type VirtualElement = { type: unknown; props: Record<string, unknown> };

function findElement(node: unknown, target: unknown): VirtualElement | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findElement(item, target);
      if (found) return found;
    }
    return undefined;
  }
  const el = node as VirtualElement;
  if (el.type === target) return el;
  if (el.props && "children" in el.props) return findElement(el.props.children, target);
  return undefined;
}

function loadMissionDetailEnv() {
  if (typeof nodeModule.registerHooks !== "function") return undefined;
  const hooksUrl = new URL("./fixtures/react-hooks.ts", import.meta.url).href;
  const nativeUrl = new URL("./fixtures/mobile-native.ts", import.meta.url).href;
  const stubsUrl = new URL("./fixtures/mobile-mission-steer-stubs.ts", import.meta.url).href;

  nodeModule.registerHooks({
    resolve: (specifier, _context, next) => {
      if (specifier === "react") return { url: hooksUrl, shortCircuit: true };
      if (specifier === "expo-crypto") return { url: nativeUrl, shortCircuit: true };
      if (
        specifier === "react-native" ||
        specifier === "expo-router" ||
        specifier === "../../api/client" ||
        specifier === "../../api/usePoll" ||
        specifier === "../teams/parts" ||
        specifier === "../../components/FloatingNotice" ||
        specifier === "../halt/HaltBanner" ||
        specifier === "../../components/keyboard" ||
        specifier === "../../components/Button" ||
        specifier === "../../components/Glass" ||
        specifier === "../../components/Icon" ||
        specifier === "../teams/Recommendation" ||
        specifier === "./Attempts" ||
        specifier === "./MissionProgressSection"
      ) {
        return { url: stubsUrl, shortCircuit: true };
      }
      return next(specifier, _context);
    },
  });

  const require = nodeModule.createRequire(import.meta.url);
  (globalThis as { React?: unknown }).React = {
    Fragment: Symbol("Fragment"),
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: { ...(props ?? {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) },
    }),
  };
  return {
    ...(require("../apps/mobile/src/features/board/MissionDetail.tsx") as typeof import("../apps/mobile/src/features/board/MissionDetail.tsx")),
    ...(require("../apps/mobile/src/store/requests.ts") as typeof import("../apps/mobile/src/store/requests.ts")),
    ...(require("./fixtures/react-hooks.ts") as typeof import("./fixtures/react-hooks.ts")),
    ...(require("./fixtures/mobile-mission-steer-stubs.ts") as typeof import("./fixtures/mobile-mission-steer-stubs.ts")),
  };
}

const env = loadMissionDetailEnv();
const skip = !env && "module.registerHooks requires Node 22.15+";

test("MissionDetail preserves steer direction on 409/error and clears it only after /steer is accepted", { skip }, async () => {
  const { ApiError, MissionDetail, RequestStatus, SteerBox, renderHook, runRequests, setPollMission, setRunRequestApiHandler } = env!;
  const currentMission: Mission = {
    id: "m1",
    groupId: "g1",
    groupName: "Product",
    repoProjectIds: ["repo-1"],
    title: "Test mission",
    objective: "Steer cleanly",
    maxSubtasks: 4,
    maxMinutes: 120,
    deadlineAt: "2026-11-28T00:00:00.000Z",
    revision: 3,
    status: "working",
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:00:00.000Z",
    lineup: {} as Mission["lineup"],
    subtasks: [],
    decisions: [],
    steering: [],
    events: [],
  };
  setPollMission(currentMission);

  const connection = { id: "test-machine", url: "http://127.0.0.1", token: "tok" };
  const key = "test-machine/mission/m1";
  let mode: "409" | "503" | "200" = "409";

  setRunRequestApiHandler(async () => {
    if (mode === "409") throw new ApiError("Stale revision", 409);
    if (mode === "503") throw new ApiError("Temporary outage", 503);
    return { ...currentMission, revision: currentMission.revision + 1 };
  });

  const view = renderHook(() => MissionDetail({ connection, id: "m1" }));
  try {
    let tree = view.read();
    let steer = findElement(tree, SteerBox)!;
    assert.ok(steer);
    (steer.props.onChange as (text: string) => void)("Hold release");

    tree = view.read();
    steer = findElement(tree, SteerBox)!;
    assert.equal(steer.props.value, "Hold release");

    (steer.props.onSend as () => void)();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    tree = view.read();
    steer = findElement(tree, SteerBox)!;
    assert.equal(steer.props.value, "Hold release");

    mode = "503";
    (steer.props.onSend as () => void)();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    tree = view.read();
    steer = findElement(tree, SteerBox)!;
    assert.equal(steer.props.value, "Hold release");

    mode = "200";
    const status = findElement(tree, RequestStatus)!;
    (status.props.request as { retry: () => void }).retry();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    tree = view.read();
    steer = findElement(tree, SteerBox)!;
    assert.equal(steer.props.value, "");
  } finally {
    view.unmount();
    runRequests.clear(key);
  }
});
