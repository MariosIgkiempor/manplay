import { describe, expect, it } from "vitest";
import {
	addSearchSchema,
	folderParamsSchema,
	targetParamsSchema,
	usbSearchSchema,
} from "#/lib/place-routes.ts";

describe("folderParamsSchema", () => {
	it.each([
		{ raw: "1", folderId: 1 },
		{ raw: "42", folderId: 42 },
	])("reads $raw", ({ raw, folderId }) => {
		expect(folderParamsSchema.parse({ folderId: raw })).toEqual({ folderId });
	});

	it.each(["0", "-1", "2.5", "downloads", ""])("refuses %j", (raw) => {
		expect(folderParamsSchema.safeParse({ folderId: raw }).success).toBe(false);
	});
});

describe("targetParamsSchema", () => {
	it.each([
		{ raw: "7", targetId: 7 },
		{ raw: "12345", targetId: 12345 },
	])("reads $raw", ({ raw, targetId }) => {
		expect(targetParamsSchema.parse({ targetId: raw })).toEqual({ targetId });
	});

	it.each(["0", "-3", "1.5", "abc", ""])("refuses %j", (raw) => {
		expect(targetParamsSchema.safeParse({ targetId: raw }).success).toBe(false);
	});
});

describe("usbSearchSchema", () => {
	it.each(["/Volumes/CDJ", "E:\\", "/Volumes/With Space/x"])("keeps the mount %j", (mount) => {
		expect(usbSearchSchema.parse({ mount })).toEqual({ mount });
	});

	it.each([{}, { mount: "" }, { mount: 3 }])("refuses %j", (raw) => {
		expect(usbSearchSchema.safeParse(raw).success).toBe(false);
	});
});

describe("addSearchSchema", () => {
	it.each([
		{ raw: {}, service: undefined },
		{ raw: { service: "r2" }, service: "r2" },
		{ raw: { service: "usb" }, service: "usb" },
		{ raw: { service: "dropbox" }, service: undefined },
		{ raw: { service: 4 }, service: undefined },
	])("reads $raw as $service", ({ raw, service }) => {
		expect(addSearchSchema.parse(raw).service).toBe(service);
	});
});
