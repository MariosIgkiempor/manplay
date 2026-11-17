import { z } from "zod";
import { DESTINATION_SERVICES } from "#/lib/places.ts";

/** `/export/$targetId`: the destination's database id. */
export const targetParamsSchema = z.object({ targetId: z.coerce.number().int().positive() });

/**
 * `/export/usb?mount=…`: the mount point is a path ("/Volumes/CDJ", "E:\"), so it travels as a
 * search value rather than a path segment.
 */
export const usbSearchSchema = z.object({ mount: z.string().min(1) });

/** `/export/add?service=…`: without one, the step that picks it. An unknown service falls back. */
export const addSearchSchema = z.object({
	service: z.enum(DESTINATION_SERVICES).optional().catch(undefined),
});
