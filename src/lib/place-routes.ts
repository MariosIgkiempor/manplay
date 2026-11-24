import { z } from "zod";
import { DESTINATION_SERVICES } from "#/lib/places.ts";

/** `/import/$folderId`: the import folder's database id. */
export const folderParamsSchema = z.object({
	folderId: z.coerce.number().int().positive().brand<"ImportFolderId">(),
});

/** `/export/$targetId`: the destination's database id. */
export const targetParamsSchema = z.object({ targetId: z.coerce.number().int().positive() });

/** The direction a sync review starts ticked in. An unknown one falls back to both ways. */
const syncModeSchema = z.enum(["both", "pull", "push"]).optional().catch(undefined);

/** `/export/$targetId?mode=…`: the direction the destination's review starts in. */
export const targetSearchSchema = z.object({ mode: syncModeSchema });

/**
 * `/export/sync?mode=…&ids=…`: one review of several destinations; every destination without
 * `ids`.
 */
export const syncSearchSchema = z.object({
	mode: syncModeSchema,
	ids: z.array(z.coerce.number().int().positive()).optional().catch(undefined),
});

/**
 * `/export/usb?mount=…`: the mount point is a path ("/Volumes/CDJ", "E:\"), so it travels as a
 * search value rather than a path segment.
 */
export const usbSearchSchema = z.object({ mount: z.string().min(1) });

/** `/export/add?service=…`: without one, the step that picks it. An unknown service falls back. */
export const addSearchSchema = z.object({
	service: z.enum(DESTINATION_SERVICES).optional().catch(undefined),
});
