import { randomUUID } from 'node:crypto'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { ApiError } from './errors.js'

/**
 * D5 file storage. One implementation behind a tiny interface: presigned S3
 * URLs (@aws-sdk/client-s3 + s3-request-presigner), env-configured so local
 * dev is MinIO with path-style addressing and prod is any S3-compatible store.
 *
 * Two endpoints, two clients. The api's own network calls (deleteObject) go
 * through S3_ENDPOINT, which inside compose is the internal http://minio:9000.
 * Presigned URLs land in browsers, which cannot resolve that hostname, so
 * signing embeds S3_PUBLIC_ENDPOINT instead (falling back to S3_ENDPOINT).
 *
 * The clients are lazy and nothing here throws at import time: a missing
 * config must never crash boot. Signing itself is local (SigV4), so
 * presigning works even when the store is unreachable; only the signed
 * request would fail.
 */

const DEFAULT_TTL_SECONDS = 300

/**
 * Strips everything that could break out of the quoted-string in a
 * Content-Disposition header: quotes and backslashes (the classic escape), and
 * C0 control characters plus DEL (\r and \n included — a crafted filename must
 * not be able to forge extra response headers).
 */
const UNSAFE_FILENAME_CHARS = /["\\\x00-\x1f\x7f]/g
const sanitizeFileName = (fileName) => fileName.replace(UNSAFE_FILENAME_CHARS, '')

function s3Settings() {
  return {
    endpoint: process.env.S3_ENDPOINT || undefined,
    // What presigned URLs are signed against: browsers must be able to
    // resolve it, unlike the api-internal S3_ENDPOINT above.
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  }
}

/** True when the env carries enough to sign against a real bucket. */
export const isStorageConfigured = () => {
  const s = s3Settings()
  return Boolean(s.bucket && s.credentials.accessKeyId && s.credentials.secretAccessKey)
}

// One S3Client per purpose, cached and rebuilt only when the env changes
// under us (tests swap configs per process). The clients are cheap and hold
// no connections, so one per endpoint costs nothing.
const clientCache = new Map()

function s3ClientFor(purpose, settings, endpoint) {
  if (!isStorageConfigured()) {
    throw new ApiError(
      503,
      'STORAGE_UNAVAILABLE',
      'File storage is not configured. Set the S3_* environment variables.',
    )
  }
  const fingerprint = [
    endpoint,
    settings.region,
    settings.forcePathStyle,
    settings.credentials.accessKeyId,
    settings.credentials.secretAccessKey,
  ].join(' ')
  let cached = clientCache.get(purpose)
  if (!cached || cached.fingerprint !== fingerprint) {
    cached = {
      fingerprint,
      s3: new S3Client({
        endpoint,
        region: settings.region,
        forcePathStyle: settings.forcePathStyle,
        credentials: {
          accessKeyId: settings.credentials.accessKeyId,
          secretAccessKey: settings.credentials.secretAccessKey,
        },
      }),
    }
    clientCache.set(purpose, cached)
  }
  return cached.s3
}

/** Carries the api-internal S3_ENDPOINT: real network calls go through it. */
const networkClient = () => s3ClientFor('network', s3Settings(), s3Settings().endpoint)

/** Embeds the public endpoint in every URL it signs; never connects. */
const presignClient = () => s3ClientFor('presign', s3Settings(), s3Settings().publicEndpoint)

export const fileStore = {
  /**
   * A short-lived upload URL. The ContentType travels with the PUT as advisory
   * metadata (the current presigner signs only the host header, so the store
   * cannot reject a mismatched type); the Attachment row's mimeType is the
   * authoritative record of what the file claims to be.
   */
  async presignPut(key, contentType, ttlSeconds = DEFAULT_TTL_SECONDS) {
    const command = new PutObjectCommand({
      Bucket: s3Settings().bucket,
      Key: key,
      ContentType: contentType,
    })
    return getSignedUrl(presignClient(), command, { expiresIn: ttlSeconds })
  },

  /**
   * A short-lived download URL. `fileName` (optional) makes browsers save the
   * file under its original name instead of the storage key.
   */
  async presignGet(key, ttlSeconds = DEFAULT_TTL_SECONDS, { fileName } = {}) {
    const command = new GetObjectCommand({
      Bucket: s3Settings().bucket,
      Key: key,
      ...(fileName
        ? {
            ResponseContentDisposition: `attachment; filename="${sanitizeFileName(fileName)}"`,
          }
        : {}),
    })
    return getSignedUrl(presignClient(), command, { expiresIn: ttlSeconds })
  },

  /** Removes the stored object. Callers treat failures as best-effort. */
  async deleteObject(key) {
    const command = new DeleteObjectCommand({ Bucket: s3Settings().bucket, Key: key })
    await networkClient().send(command)
  },
}

/** `attachments/<uuid>.<ext>` — the extension comes from the allowed mime type. */
export const storageKeyFor = (extension) => `attachments/${randomUUID()}.${extension}`
