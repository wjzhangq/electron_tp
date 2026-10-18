import { describe, expect, it } from 'vitest';
import { ApiError, Codes, fail, isApiError, ok } from '../../src/shared/api';
import { ORIGIN } from '../../src/shared/ipc';
import { parseFrame } from '../../src/renderer/api';

describe('shared api', () => {
  it('builds success and failure results', () => {
    expect(ok({ a: 1 })).toEqual({ code: 0, msg: 'success', data: { a: 1 } });
    expect(fail(Codes.PARAM_INVALID, 'name is required')).toEqual({ code: 3006, msg: 'name is required', data: '' });
  });

  it('recognizes ApiError by shape, not by class', () => {
    expect(isApiError(new ApiError(3006, 'x'))).toBe(true);
    expect(isApiError({ name: 'ApiError', code: 40001, message: 'x' })).toBe(true);
    expect(isApiError(new Error('x'))).toBe(false);
    expect(isApiError({ name: 'ApiError', code: '1' })).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError('ApiError')).toBe(false);
  });

  it('defines the documented error codes', () => {
    expect(Codes).toEqual({
      OK: 0,
      BUSINESS: 10001,
      PARAM_INVALID: 3006,
      NOT_FOUND: 3007,
      METHOD_NOT_ALLOWED: 3008,
      PAYLOAD_TOO_LARGE: 3009,
      INTERNAL: 30004,
      JSON_PARSE: 30005,
    });
  });

  it('keeps ORIGIN equal to SCHEME://HOST', () => {
    expect(ORIGIN).toBe('chttp://localhost');
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
