/*
 * Copyright (c) 2023-2025, NeKz
 *
 * SPDX-License-Identifier: MIT
 *
 * This provides a small and simple client for S3-compatible object storage
 * using AWS Signature Version 4, e.g. Hetzner Object Storage.
 *
 * Features:
 *   - Readable
 *   - Use of async & await
 *   - Bring-Your-Own-User-Agent
 *   - Free of dependencies
 *   - Pure TypeScript
 *
 * Hetzner Object Storage documentation:
 *    https://docs.hetzner.com/storage/object-storage/
 */

/**
 * Options for constructing a new S3 client.
 *
 * @see S3Client
 */
export interface S3ClientOptions {
  /** Required User-Agent e.g. 'My-App-v1' */
  userAgent: string;
  /** Endpoint without the bucket e.g. 'https://fsn1.your-objectstorage.com'. */
  endpoint: string;
  /** Region used for request signing e.g. 'fsn1'. */
  region: string;
  /** Name of the bucket. */
  bucket: string;
  /** Access key ID. */
  accessKey: string;
  /** Secret access key. */
  secretKey: string;
}

/**
 * Options for uploading an object.
 *
 * @see S3Client.putObject
 */
export interface PutObjectOptions {
  /** Key of object e.g. 'video.mp4'. */
  key: string;
  /** Contents of object. */
  contents: Uint8Array<ArrayBuffer>;
  /** Content-Type header value. Defaults to 'application/octet-stream'. */
  contentType?: string;
  /** Content-Disposition header value which is stored with the object. */
  contentDisposition?: string;
}

/**
 * Response object of an object upload.
 *
 * @see S3Client.putObject
 */
export interface PutObjectResponse {
  etag: string | null;
}

const encoder = new TextEncoder();

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const sha256 = async (data: BufferSource) => toHex(await crypto.subtle.digest('SHA-256', data));

const hmac = async (key: BufferSource, data: string) => {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
};

/** Encodes an object key per RFC 3986 while keeping path separators. */
const encodeKey = (key: string) =>
  key
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      )
    )
    .join('/');

/**
 * API client for S3-compatible object storage.
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
 */
export class S3Client {
  readonly #userAgent: string;
  readonly #region: string;
  readonly #accessKey: string;
  readonly #secretKey: string;
  /** Protocol of the endpoint e.g. 'https:'. */
  readonly #protocol: string;
  /** Virtual-hosted-style host e.g. 'bucket.fsn1.your-objectstorage.com'. */
  readonly #host: string;

  /**
   * Constructs a new S3 client.
   *
   * @param options - Client options. All options are required.
   */
  constructor(options: S3ClientOptions) {
    this.#userAgent = options.userAgent;
    this.#region = options.region;
    this.#accessKey = options.accessKey;
    this.#secretKey = options.secretKey;

    const endpoint = new URL(options.endpoint);
    this.#protocol = endpoint.protocol;
    this.#host = `${options.bucket}.${endpoint.host}`;
  }

  protected async request(
    method: 'PUT' | 'DELETE',
    key: string,
    body?: Uint8Array<ArrayBuffer>,
    headers?: Record<string, string>,
  ): Promise<Response> {
    // Format: YYYYMMDDTHHMMSSZ
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);

    const canonicalUri = `/${encodeKey(key)}`;
    const payloadHash = await sha256(body ?? new Uint8Array());

    const headersToSign = Object.entries({
      host: this.#host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(
        Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
      ),
    }).sort(([a], [b]) => a.localeCompare(b));

    const canonicalHeaders = headersToSign.map(([name, value]) => `${name}:${value.trim()}\n`).join('');
    const signedHeaders = headersToSign.map(([name]) => name).join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      '', // Canonical query string
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.#region}/s3/aws4_request`;

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      await sha256(encoder.encode(canonicalRequest)),
    ].join('\n');

    let signingKey = await hmac(encoder.encode(`AWS4${this.#secretKey}`), dateStamp);
    for (const data of [this.#region, 's3', 'aws4_request']) {
      signingKey = await hmac(signingKey, data);
    }

    const signature = toHex(await hmac(signingKey, stringToSign));

    const url = `${this.#protocol}//${this.#host}${canonicalUri}`;

    const res = await fetch(url, {
      method,
      headers: {
        ...headers,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.#accessKey}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
        'User-Agent': this.#userAgent,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[${method}] ${url} : ${res.status}\n${text}`);
    }

    return res;
  }

  /**
   * Uploads an object to the bucket.
   *
   * @param options - Object upload options.
   * @returns Response object of uploaded object.
   * @see https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
   */
  public async putObject(options: PutObjectOptions): Promise<PutObjectResponse> {
    const res = await this.request('PUT', options.key, options.contents, {
      'content-type': options.contentType ?? 'application/octet-stream',
      ...(options.contentDisposition ? { 'content-disposition': options.contentDisposition } : {}),
    });

    await res.body?.cancel();

    return { etag: res.headers.get('etag') };
  }

  /**
   * Deletes an object from the bucket.
   *
   * @param key - Key of object.
   * @see https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html
   */
  public async deleteObject(key: string): Promise<void> {
    const res = await this.request('DELETE', key);
    await res.body?.cancel();
  }

  /**
   * Util which constructs the public URL of an object.
   * This method does not make any API call.
   *
   * NOTE: Requires the bucket to be publicly accessible.
   *
   * @param key - Key of object.
   * @returns Constructed object URL.
   */
  public getObjectUrl(key: string): string {
    return `${this.#protocol}//${this.#host}/${encodeKey(key)}`;
  }
}
