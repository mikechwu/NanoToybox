/**
 * POST /api/admin/seed — local dev only, never publicly usable.
 *
 * Receives a capsule JSON body and writes it through the same
 * publish-core path as the production publish endpoint.
 *
 * Protection: requires both DEV_ADMIN_ENABLED env var AND localhost origin.
 * Returns 404 (not 403) on rejection to avoid leaking the route's existence.
 */

import type { Env } from '../../env';
import {
  preparePublishRecord,
  persistRecord,
  PublishValidationError,
} from '../../../src/share/publish-core';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // Hard gate: reject unless both conditions are true
  if (env.DEV_ADMIN_ENABLED !== 'true') {
    return new Response('Not found', { status: 404 });
  }
  const url = new URL(request.url);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return new Response('Not found', { status: 404 });
  }

  const body = await request.text();

  let prepared;
  try {
    prepared = await preparePublishRecord({
      capsuleJson: body,
      ownerUserId: 'seed-admin',
      appVersion: '0.1.0',
    });
  } catch (err) {
    if (err instanceof PublishValidationError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  await env.R2_BUCKET.put(prepared.objectKey, prepared.blob);

  let persisted;
  try {
    persisted = await persistRecord(env.DB, prepared);
  } catch (err) {
    await env.R2_BUCKET.delete(prepared.objectKey).catch((cleanupErr) => {
      console.error(`[seed] R2 rollback failed for key=${prepared.objectKey}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    });
    throw err;
  }

  return Response.json({
    shareCode: persisted.shareCode,
    objectKey: persisted.objectKey,
  });
};
