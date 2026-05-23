import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import * as schema from '../../server/db/schema.js';
import type { CloudflareProxyResourceOwner } from '../auth.js';
import type { CloudflareD1Db } from '../db/d1.js';

export const R2_PROXY_FILE_CONTENT_PREFIX = 'r2:';
export const R2_PROXY_FILE_OBJECT_PREFIX = 'proxy-files';
export const LOCAL_PROXY_FILE_ID_PREFIX = 'file-metapi-';

export type R2ProxyFileRecord = {
  publicId: string;
  ownerType: CloudflareProxyResourceOwner['ownerType'];
  ownerId: string;
  filename: string;
  mimeType: string;
  purpose: string | null;
  byteSize: number;
  sha256: string;
  contentBase64: string;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
};

export type CreateR2ProxyFileInput = {
  owner: CloudflareProxyResourceOwner;
  filename: string;
  mimeType: string;
  purpose?: string | null;
  content: ArrayBuffer | Uint8Array | Blob;
};

function formatUtcSqlDateTime(value: Date): string {
  const pad2 = (item: number) => String(item).padStart(2, '0');
  return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())} ${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())}:${pad2(value.getUTCSeconds())}`;
}

function buildPublicFileId(): string {
  const timePart = Date.now().toString(36);
  const randomPart = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  return `${LOCAL_PROXY_FILE_ID_PREFIX}${timePart}-${randomPart}`;
}

function normalizeFilename(value: string): string {
  const trimmed = value.trim();
  return trimmed || 'upload.bin';
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildObjectKey(owner: CloudflareProxyResourceOwner, publicId: string, filename: string): string {
  return [
    R2_PROXY_FILE_OBJECT_PREFIX,
    owner.ownerType,
    base64UrlEncode(owner.ownerId),
    publicId,
    base64UrlEncode(filename),
  ].join('/');
}

async function toArrayBuffer(content: ArrayBuffer | Uint8Array | Blob): Promise<ArrayBuffer> {
  if (content instanceof Blob) return await content.arrayBuffer();
  if (content instanceof ArrayBuffer) return content;
  const copy = new Uint8Array(content.byteLength);
  copy.set(content);
  return copy.buffer;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', buffer));
}

function ownerWhere(owner: CloudflareProxyResourceOwner) {
  return and(
    eq(schema.proxyFiles.ownerType, owner.ownerType),
    eq(schema.proxyFiles.ownerId, owner.ownerId),
  );
}

function rowToRecord(row: typeof schema.proxyFiles.$inferSelect): R2ProxyFileRecord {
  return {
    publicId: row.publicId,
    ownerType: row.ownerType as CloudflareProxyResourceOwner['ownerType'],
    ownerId: row.ownerId,
    filename: row.filename,
    mimeType: row.mimeType,
    purpose: row.purpose,
    byteSize: row.byteSize,
    sha256: row.sha256,
    contentBase64: row.contentBase64,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    deletedAt: row.deletedAt ?? null,
  };
}

function parseR2ObjectKey(record: R2ProxyFileRecord): string | null {
  if (!record.contentBase64.startsWith(R2_PROXY_FILE_CONTENT_PREFIX)) return null;
  return record.contentBase64.slice(R2_PROXY_FILE_CONTENT_PREFIX.length);
}

function readD1ChangeCount(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const directChanges = (result as { changes?: unknown }).changes;
  if (typeof directChanges === 'number' && Number.isFinite(directChanges)) {
    return directChanges;
  }

  const meta = (result as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return 0;
  const metaChanges = (meta as { changes?: unknown }).changes;
  if (typeof metaChanges === 'number' && Number.isFinite(metaChanges)) {
    return metaChanges;
  }

  const rowsWritten = (meta as { rows_written?: unknown }).rows_written;
  return typeof rowsWritten === 'number' && Number.isFinite(rowsWritten) ? rowsWritten : 0;
}

export async function createR2ProxyFile(
  db: CloudflareD1Db,
  bucket: R2Bucket,
  input: CreateR2ProxyFileInput,
): Promise<R2ProxyFileRecord> {
  const publicId = buildPublicFileId();
  const now = formatUtcSqlDateTime(new Date());
  const filename = normalizeFilename(input.filename);
  const content = await toArrayBuffer(input.content);
  const objectKey = buildObjectKey(input.owner, publicId, filename);

  await bucket.put(objectKey, content, {
    httpMetadata: { contentType: input.mimeType },
    customMetadata: {
      publicId,
      ownerType: input.owner.ownerType,
      ownerId: input.owner.ownerId,
      filename,
    },
  });

  await db.insert(schema.proxyFiles).values({
    publicId,
    ownerType: input.owner.ownerType,
    ownerId: input.owner.ownerId,
    filename,
    mimeType: input.mimeType,
    purpose: input.purpose?.trim() || null,
    byteSize: content.byteLength,
    sha256: await sha256Hex(content),
    contentBase64: `${R2_PROXY_FILE_CONTENT_PREFIX}${objectKey}`,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }).run();

  return (await getR2ProxyFileByPublicIdForOwner(db, publicId, input.owner))!;
}

export async function listR2ProxyFilesByOwner(
  db: CloudflareD1Db,
  owner: CloudflareProxyResourceOwner,
): Promise<R2ProxyFileRecord[]> {
  const rows = await db.select().from(schema.proxyFiles)
    .where(and(ownerWhere(owner), isNull(schema.proxyFiles.deletedAt)))
    .orderBy(desc(schema.proxyFiles.createdAt))
    .all();
  return rows.map(rowToRecord);
}

export async function getR2ProxyFileByPublicIdForOwner(
  db: CloudflareD1Db,
  publicId: string,
  owner: CloudflareProxyResourceOwner,
): Promise<R2ProxyFileRecord | null> {
  const row = await db.select().from(schema.proxyFiles)
    .where(and(
      eq(schema.proxyFiles.publicId, publicId),
      ownerWhere(owner),
      isNull(schema.proxyFiles.deletedAt),
    ))
    .get();
  return row ? rowToRecord(row) : null;
}

export async function getR2ProxyFileContentByPublicIdForOwner(
  db: CloudflareD1Db,
  bucket: R2Bucket,
  publicId: string,
  owner: CloudflareProxyResourceOwner,
): Promise<{ filename: string; mimeType: string; arrayBuffer: ArrayBuffer } | null> {
  const record = await getR2ProxyFileByPublicIdForOwner(db, publicId, owner);
  if (!record) return null;
  const objectKey = parseR2ObjectKey(record);
  if (!objectKey) return null;
  const object = await bucket.get(objectKey);
  if (!object) return null;
  return {
    filename: record.filename,
    mimeType: record.mimeType,
    arrayBuffer: await object.arrayBuffer(),
  };
}

export async function softDeleteR2ProxyFileByPublicIdForOwner(
  db: CloudflareD1Db,
  publicId: string,
  owner: CloudflareProxyResourceOwner,
): Promise<boolean> {
  const now = formatUtcSqlDateTime(new Date());
  const result = await db.update(schema.proxyFiles)
    .set({
      deletedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(schema.proxyFiles.publicId, publicId),
      ownerWhere(owner),
      or(isNull(schema.proxyFiles.deletedAt), eq(schema.proxyFiles.deletedAt, '')),
    ))
    .run();
  return readD1ChangeCount(result) > 0;
}

export async function purgeExpiredR2ProxyFiles(
  db: CloudflareD1Db,
  bucket: R2Bucket,
  cutoffUtc: string,
): Promise<number> {
  const normalizedCutoff = cutoffUtc.trim();
  if (!normalizedCutoff) return 0;

  const rows = await db.select().from(schema.proxyFiles)
    .where(or(
      lt(schema.proxyFiles.createdAt, normalizedCutoff),
      and(isNull(schema.proxyFiles.createdAt), lt(schema.proxyFiles.updatedAt, normalizedCutoff)),
    ))
    .all();

  const objectKeys = rows.map(rowToRecord).map(parseR2ObjectKey).filter((key): key is string => !!key);
  if (objectKeys.length > 0) {
    await bucket.delete(objectKeys);
  }

  const result = await db.delete(schema.proxyFiles)
    .where(or(
      lt(schema.proxyFiles.createdAt, normalizedCutoff),
      and(isNull(schema.proxyFiles.createdAt), lt(schema.proxyFiles.updatedAt, normalizedCutoff)),
    ))
    .run();

  return readD1ChangeCount(result);
}
