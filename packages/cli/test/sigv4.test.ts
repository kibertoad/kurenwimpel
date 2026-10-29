import { describe, expect, it } from 'vitest';

import { signRequest } from '../src/targets/sigv4.js';

// The worked examples from the S3 SigV4 reference:
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const scope = { region: 'us-east-1', service: 's3', now: new Date('2013-05-24T00:00:00Z') };

describe('signRequest', () => {
  it('matches the AWS GET Object example', () => {
    const headers = signRequest(
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
        headers: { range: 'bytes=0-9' },
        payload: '',
      },
      credentials,
      scope,
    );

    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('matches the AWS PUT Object example, with a key that needs encoding', () => {
    const headers = signRequest(
      {
        method: 'PUT',
        url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
        headers: {
          date: 'Fri, 24 May 2013 00:00:00 GMT',
          'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        },
        payload: 'Welcome to Amazon S3.',
      },
      credentials,
      scope,
    );

    expect(headers['x-amz-content-sha256']).toBe(
      '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    );
    expect(headers['authorization']).toContain(
      'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('signs the session token when there is one', () => {
    const headers = signRequest(
      { method: 'HEAD', url: new URL('https://b.s3.amazonaws.com/k'), headers: {}, payload: '' },
      { ...credentials, sessionToken: 'session' },
      scope,
    );

    expect(headers['x-amz-security-token']).toBe('session');
    expect(headers['authorization']).toContain('x-amz-security-token');
  });
});
