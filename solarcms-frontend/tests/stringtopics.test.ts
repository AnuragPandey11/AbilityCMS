/**
 * PV-string topics read exactly as the server reads them, and the move that
 * repairs an Inverter registered on its own string topic (Vardhman Group,
 * 12 Oct 2026). The API is mocked at the endpoint module, so what is asserted
 * is each call the move makes, in order.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/problem";

const devices = vi.hoisted(() => ({
  updateDevice: vi.fn(async () => ({})),
  addDeviceTopic: vi.fn(async () => ({ device_id: 1, topic: "t", created: true })),
  addBinding: vi.fn(async () => ({})),
}));
vi.mock("@/api/endpoints/devices", () => devices);

import {
  describeMove,
  deviceCodeOf,
  moveToOwnTopic,
  onItsOwnStringTopic,
  ownTopicOf,
  stringTopicOwner,
} from "@/admin/stringTopics";

const OWN = "SCMS/V1/VARDHMAN_GROUP/SPINNING_AND_GENERAL_MILLS/MCR/INVERTER_1";
const STRINGS = `${OWN}_STRING`;

beforeEach(() => {
  for (const fn of Object.values(devices)) fn.mockClear();
});

describe("string topics", () => {
  it.each([
    ["INVERTER_1_STRING16", "INVERTER_1"],
    ["INVERTER_10_STRING28", "INVERTER_10"],
    ["INVERTER_1_STRING", "INVERTER_1"],
    ["SMB1_STRING24", "SMB1"],
  ])("%s carries the strings of %s", (code, owner) => {
    expect(stringTopicOwner(code)).toBe(owner);
  });

  it.each(["INVERTER_1", "MFM", "WMS_WEST", "_STRING16", "STRING_BOX_1", "INVERTER_STRINGS"])(
    "%s is a Device of its own",
    (code) => expect(stringTopicOwner(code)).toBeNull(),
  );

  it("finds the owner's own topic beside its strings", () => {
    expect(ownTopicOf(STRINGS)).toBe(OWN);
    expect(ownTopicOf("SCMS/V1/KULAR_GREEN/KULAR_GREEN/MCR/INVERTER_10_STRING28"))
      .toBe("SCMS/V1/KULAR_GREEN/KULAR_GREEN/MCR/INVERTER_10");
    expect(ownTopicOf("SCMS/V1/ISPL/UNIT1/SMB1_STRING16")).toBe("SCMS/V1/ISPL/UNIT1/SMB1");
  });

  it("has no own topic for anything else", () => {
    expect(ownTopicOf(OWN)).toBeNull();
    expect(ownTopicOf("INVERTER_1_STRING16")).toBeNull();
    expect(deviceCodeOf(OWN)).toBe("INVERTER_1");
  });

  it("knows a Device sitting on its own string topic", () => {
    expect(onItsOwnStringTopic("INVERTER_1", STRINGS)).toBe(true);
    expect(onItsOwnStringTopic("INVERTER_1", OWN)).toBe(false);
    // Strings-only equipment on its strings is where it belongs, but is still
    // "on its own string topic": the screens judge it by whether its own topic
    // publishes, never by this alone.
    expect(onItsOwnStringTopic("SMB1", "SCMS/V1/ISPL/UNIT1/SMB1_STRING16")).toBe(true);
    expect(onItsOwnStringTopic("INVERTER_2", STRINGS)).toBe(false);
    expect(onItsOwnStringTopic("INVERTER_1", null)).toBe(false);
  });
});

describe("moving an Inverter to its own topic", () => {
  const bindings = [
    { source_key: "PAC", tag_code: "AC_ACTIVE_POWER" },
    { source_key: "F", tag_code: "FREQUENCY" },
  ];

  it("moves it, attaches the strings back, then maps its readings", async () => {
    const result = await moveToOwnTopic(1, OWN, STRINGS, bindings);
    expect(devices.updateDevice).toHaveBeenCalledWith(1, { source_address: OWN });
    expect(devices.addDeviceTopic).toHaveBeenCalledWith(
      1, STRINGS, "Kept as its string topic when moved to its own topic");
    expect(devices.addBinding).toHaveBeenCalledWith(1, bindings[0]);
    expect(devices.addBinding).toHaveBeenCalledWith(1, bindings[1]);
    // The topic first: the string topic cannot be attached while it is the primary.
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0] ?? 0;
    expect(order(devices.updateDevice)).toBeLessThan(order(devices.addDeviceTopic));
    expect(order(devices.addDeviceTopic)).toBeLessThan(order(devices.addBinding));
    expect(result).toEqual({ mapped: 2, skipped: [] });
  });

  it("leaves a reading the server will not map for the unmapped card", async () => {
    devices.addBinding.mockRejectedValueOnce(
      new ApiError({ type: "about:blank", title: "Conflict", status: 409, detail: "PAC is already mapped" }),
    );
    const result = await moveToOwnTopic(1, OWN, STRINGS, bindings);
    expect(result).toEqual({ mapped: 1, skipped: ["PAC"] });
    expect(describeMove("INVERTER_1", result)).toBe(
      "INVERTER_1 moved to its own topic, with its string topic still attached, and 1 reading(s) " +
        "mapped. Not mapped: PAC — see Data Issues.",
    );
  });

  it("stops on a failure that is not about one reading", async () => {
    devices.updateDevice.mockRejectedValueOnce(
      new ApiError({ type: "about:blank", title: "Server", status: 500, detail: "boom" }),
    );
    await expect(moveToOwnTopic(1, OWN, STRINGS, bindings)).rejects.toBeInstanceOf(ApiError);
    expect(devices.addDeviceTopic).not.toHaveBeenCalled();
  });
});
