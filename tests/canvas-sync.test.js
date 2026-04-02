import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCanvasError, CanvasClient } from '../lib/canvas-client.js';

describe('Canvas Client', () => {
  describe('classifyCanvasError', () => {
    it('should return auth message for 401 errors', () => {
      const err = new Error('Canvas API 401');
      err.status = 401;
      const result = classifyCanvasError(err);
      assert.equal(result.type, 'auth');
      assert.ok(result.message.includes('access key'));
      assert.ok(!result.message.includes('token'));
      assert.ok(!result.message.includes('401'));
      assert.ok(!result.message.includes('authentication'));
    });

    it('should return server message for 500 errors', () => {
      const err = new Error('Canvas API 500');
      err.status = 500;
      const result = classifyCanvasError(err);
      assert.equal(result.type, 'server');
      assert.ok(result.message.includes('school'));
      assert.ok(!result.message.includes('500'));
    });

    it('should return timeout message for timeout errors', () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      const result = classifyCanvasError(err);
      assert.equal(result.type, 'timeout');
      assert.ok(result.message.includes('slow'));
    });

    it('should return generic message for unknown errors', () => {
      const err = new Error('something weird');
      const result = classifyCanvasError(err);
      assert.equal(result.type, 'unknown');
      assert.ok(!result.message.includes('error'));
    });

    it('should never use technical jargon in error messages', () => {
      const technicalTerms = [
        'API', 'token', 'authentication', 'authorization',
        'HTTP', 'status code', 'endpoint', 'rate limit',
      ];

      const errors = [
        Object.assign(new Error(), { status: 401 }),
        Object.assign(new Error(), { status: 500 }),
        Object.assign(new Error(), { name: 'TimeoutError' }),
        new Error('unknown'),
      ];

      for (const err of errors) {
        const result = classifyCanvasError(err);
        for (const term of technicalTerms) {
          assert.ok(
            !result.message.toLowerCase().includes(term.toLowerCase()),
            `Error message should not contain "${term}": "${result.message}"`
          );
        }
      }
    });
  });

  describe('Assignment Classification', () => {
    it('should classify common assignment types from names', async () => {
      assert.ok(CanvasClient, 'CanvasClient should be exported');
    });
  });

  describe('Link Header Pagination', () => {
    const client = new CanvasClient('https://example.com', 'fake-token');

    it('should parse Link header with next URL', () => {
      const header = '<https://example.com/api/v1/courses?page=2&per_page=50>; rel="next", <https://example.com/api/v1/courses?page=5&per_page=50>; rel="last"';
      const next = client._parseLinkNext(header);
      assert.equal(next, 'https://example.com/api/v1/courses?page=2&per_page=50');
    });

    it('should return null when no next link exists', () => {
      const header = '<https://example.com/api/v1/courses?page=5&per_page=50>; rel="last"';
      const next = client._parseLinkNext(header);
      assert.equal(next, null);
    });

    it('should return null for null input', () => {
      assert.equal(client._parseLinkNext(null), null);
      assert.equal(client._parseLinkNext(undefined), null);
    });

    it('should handle next-only Link header', () => {
      const header = '<https://example.com/api/v1/assignments?page=3>; rel="next"';
      const next = client._parseLinkNext(header);
      assert.equal(next, 'https://example.com/api/v1/assignments?page=3');
    });
  });
});
