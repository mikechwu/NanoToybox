/**
 * POST /api/capsules/publish — authenticated capsule publish.
 *
 * Validates capsule in-memory, writes only valid capsules to R2.
 * Single-step proxy upload (no presigned URL, no quarantine).
 */

import type { Env } from '../../env';
import { authenticateRequest } from '../../auth-middleware';
import {
  preparePublishRecord,
  persistRecord,
  PublishValidationError,
} from '../../../src/share/publish-core';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // Require authentication
  const userId = await authenticateRequest(request, env);
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Size enforcement layer 1: fast reject via Content-Length header
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  // Read body
  const body = await request.text();

  // Size enforcement layer 2: authoritative check on actual bytes
  const actualSize = new TextEncoder().encode(body).byteLength;
  if (actualSize > MAX_UPLOAD_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  // Validate and prepare
  let prepared;
  try {
    prepared = await preparePublishRecord({
      capsuleJson: body,
      ownerUserId: userId,
      appVersion: '0.1.0',
    });
  } catch (err) {
    if (err instanceof PublishValidationError) {
      return new Response(err.message, { status: 400 });
    }
    throw err;
  }

  // Write validated blob to R2 (single write, no quarantine)
  await env.R2_BUCKET.put(prepared.objectKey, prepared.blob);

  // Persist D1 record with collision-safe share code
  let persisted;
  try {
    persisted = await persistRecord(env.DB, prepared);
  } catch (err) {
    // Rollback: delete orphaned R2 object
    await env.R2_BUCKET.delete(prepared.objectKey).catch((cleanupErr) => {
      console.error(`[publish] R2 rollback failed for key=${prepared.objectKey}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    });
    throw err;
  }

  const shareUrl = new URL(`/c/${persisted.shareCode}`, request.url).toString();

  return Response.json(
    {
      shareCode: persisted.shareCode,
      shareUrl,
      sizeBytes: persisted.sizeBytes,
    },
    { status: 201 },
  );
};
