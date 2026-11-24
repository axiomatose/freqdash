import type { AcksResponse, CreateAcksBody } from '@/shared/types/api';
import { createAcks, listAcks, revokeAck } from '../db';
import type { ViewContext } from './common';

export function buildAcks(ctx: ViewContext): AcksResponse {
  return { acks: listAcks(ctx.now) };
}

export function createAcksFromBody(ctx: ViewContext, body: CreateAcksBody, by: string | null): AcksResponse {
  return {
    acks: createAcks(
      {
        kind: body.kind,
        subjects: body.subjects,
        label: body.label,
        note: body.note ?? null,
        qtyBaseline: body.qtyBaseline ?? null,
        expiresAt: body.expiresAt ?? null,
        createdBy: by,
      },
      ctx.now,
    ),
  };
}

export function revokeAckById(ctx: ViewContext, id: number, by: string | null): boolean {
  return revokeAck(id, by, ctx.now);
}
