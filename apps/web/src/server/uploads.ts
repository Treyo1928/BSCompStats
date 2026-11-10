import { prisma } from '@bscs/db';

/**
 * Small pictures an organiser uploads: team logos and player avatars. They
 * live in the database (the Upload table) and are served at /api/img/<id>,
 * which is also how they are stored on a team or a tournament's player.
 */

export const UPLOAD_MAX_BYTES = 1024 * 1024;
const PATH = /^\/api\/img\/([a-z0-9]{10,40})$/;

/** What a file really is, by its first bytes: never by its name or the type the browser claimed. */
export function sniffImage(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) {
    return 'image/webp';
  }
  // SVG is text: an <svg> element, after at most an XML declaration, a doctype and comments.
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096)).replace(/^﻿/, '');
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) {
    return 'image/svg+xml';
  }
  return null;
}

export class UploadError extends Error {}

/** The file field of a form, if a file was actually chosen. */
export function chosenFile(value: FormDataEntryValue | null): File | null {
  return value instanceof File && value.size > 0 ? value : null;
}

/** Store a picture; resolves to the path it is served at. */
export async function saveUpload(tournamentId: string, file: File): Promise<string> {
  if (file.size > UPLOAD_MAX_BYTES) throw new UploadError('That picture is over 1 MB. Use a smaller one (a logo rarely needs more than 512 pixels a side).');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffImage(bytes);
  if (!mime) throw new UploadError('That file is not a picture this site takes. Use a PNG, JPEG, WebP, GIF or SVG.');
  if (mime === 'image/svg+xml') {
    // Served with scripts switched off anyway (see /api/img); one that carries any is not a logo.
    const text = new TextDecoder().decode(bytes);
    if (/<script[\s>]|\son[a-z]+\s*=|javascript:|<foreignObject[\s>]/i.test(text)) {
      throw new UploadError('That SVG contains scripts or embedded pages, which a logo has no use for. Export it as a plain SVG, or use a PNG.');
    }
  }
  const upload = await prisma.upload.create({ data: { tournamentId, mime, bytes }, select: { id: true } });
  return `/api/img/${upload.id}`;
}

/** The Upload behind a stored path, or null where the value is something else (a preset, nothing). */
export const uploadIdOf = (stored: string | null | undefined): string | null => (stored ? PATH.exec(stored)?.[1] ?? null : null);

/** Remove a picture nothing points to any more. */
export async function dropUpload(stored: string | null | undefined): Promise<void> {
  const id = uploadIdOf(stored);
  if (id) await prisma.upload.deleteMany({ where: { id } });
}
