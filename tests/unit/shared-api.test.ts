import { describe, expect, it } from 'vitest';
import { ApiError, codeForStatus, ErrorCodes, isApiError } from '../../src/shared/api';
import { ORIGIN } from '../../src/shared/ipc';
import { parseFrame, toApiError } from '../../src/renderer/api';

describe('shared api', () => {
  it('derives the code from the HTTP status unless given', () => {
    expect(new ApiError(400, 'x')).toMatchObject({ status: 400, code: 'BAD_REQUEST', message: 'x' });
    expect(new ApiError(404, 'x').code).toBe('NOT_FOUND');
    expect(new ApiError(422, 'x', 'TEXT_INVALID').code).toBe('TEXT_INVALID');
    expect(codeForStatus(418)).toBe(ErrorCodes.BAD_REQUEST);
    expect(codeForStatus(502)).toBe(ErrorCodes.INTERNAL);
    expect(codeForStatus(503)).toBe(ErrorCodes.UNAVAILABLE);
  });

  it('recognizes ApiError by shape, not by class', () => {
    expect(isApiError(new ApiError(400, 'x'))).toBe(true);
    expect(isApiError({ name: 'ApiError', status: 409, code: 'CONFLICT', message: 'x' })).toBe(true);
    expect(isApiError(new Error('x'))).toBe(false);
    expect(isApiError({ name: 'ApiError', status: 200, code: 'OK' })).toBe(false);
    expect(isApiError({ name: 'ApiError', status: 400, code: 1 })).toBe(false);
    expect(isApiError({ name: 'ApiError', status: '400', code: 'X' })).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError('ApiError')).toBe(false);
  });

  it('uses one namespace of string codes', () => {
    for (const [k, v] of Object.entries(ErrorCodes)) expect(k).toBe(v);
  });

  it('keeps ORIGIN equal to SCHEME://HOST', () => {
    expect(ORIGIN).toBe('chttp://localhost');
  });
});

describe('renderer client errors', () => {
  it('builds ApiError from status and { code, message }', async () => {
    const res = new Response(JSON.stringify({ code: 'TEXT_INVALID', message: 'bad text' }), { status: 422 });
    expect(await toApiError(res)).toMatchObject({ status: 422, code: 'TEXT_INVALID', message: 'bad text' });
  });

  it('falls back to the status when the body is not an error body', async () => {
    const res = new Response('oops', { status: 502, statusText: 'Bad Gateway' });
    expect(await toApiError(res)).toMatchObject({ status: 502, code: 'INTERNAL', message: 'Bad Gateway' });
    expect((await toApiError(new Response(null, { status: 404 }))).message).toBe('HTTP 404');
  });
});

describe('renderer SSE frame parser', () => {
  it('parses event, id and JSON data', () => {
    expect(parseFrame('event: progress\nid: 1\ndata: {"i":1}')).toEqual({ event: 'progress', id: '1', data: { i: 1 } });
  });

  it('defaults to message, joins multi-line data and keeps non-JSON text', () => {
    expect(parseFrame('data: a\ndata: b')).toEqual({ event: 'message', data: 'a\nb', id: undefined });
  });

  it('ignores heartbeats and comments', () => {
    expect(parseFrame(': ping')).toBeNull();
    expect(parseFrame('retry: 10')).toBeNull();
  });
});
