import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface SignableRequest {
  readonly method: string;
  readonly url: URL;
  /** Lower-case names. `host`, `x-amz-date` and `x-amz-content-sha256` are added. */
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: string;
}

export interface SigningScope {
  readonly region: string;
  readonly service: string;
  readonly now: Date;
}

/**
 * AWS Signature Version 4 for a single-chunk request, which is every request
 * the s3 target sends. Returns the headers to send, `authorization` included.
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */
export function signRequest(
  request: SignableRequest,
  credentials: AwsCredentials,
  scope: SigningScope,
): Record<string, string> {
  const amzDate = scope.now.toISOString().replaceAll(/[-:]|\.\d{3}/gu, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...request.headers,
    host: request.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': sha256(request.payload),
  };
  if (credentials.sessionToken !== undefined) {
    headers['x-amz-security-token'] = credentials.sessionToken;
  }

  const names = Object.keys(headers).toSorted();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    request.method,
    canonicalPath(request.url),
    canonicalQuery(request.url),
    ...names.map((name) => `${name}:${headers[name]!.trim().replaceAll(/\s+/gu, ' ')}`),
    '',
    signedHeaders,
    headers['x-amz-content-sha256'],
  ].join('\n');

  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of [scope.region, scope.service, 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** S3 signs the path as sent, each segment URI-encoded once. */
function canonicalPath(url: URL): string {
  return url.pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/');
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
    .toSorted()
    .join('&');
}

/** RFC 3986 unreserved characters stay as they are; everything else is percent-encoded. */
export function uriEncode(text: string): string {
  return encodeURIComponent(text).replaceAll(
    /[!'()*]/gu,
    (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`,
  );
}
