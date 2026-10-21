// Private R2 storage, accessed from the existing Google Cloud backend. No Workers.
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { sniffImage } = require('./files');
const { ApiError } = require('./errors');
const run = promisify(execFile);
const VIDEO_BYTES = 100000000;
const IMAGE_BYTES = 5000000;
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function r2FromEnv(env = process.env) {
  const { R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: access, R2_SECRET_ACCESS_KEY: secret, R2_BUCKET: bucket } = env;
  const configured = Boolean(account && access && secret && bucket);
  if (configured && (!/^[a-f0-9]{32}$/.test(account) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))) throw new Error('Invalid R2 account or bucket');
  const origin = configured ? `https://${account}.r2.cloudflarestorage.com` : '';
  function signed(method, key, { type, size, expires = 600, now = new Date() } = {}) {
    if (!configured) throw new ApiError(503, 'media_unavailable', 'Media uploads are not connected yet');
    const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = stamp.slice(0, 8), scope = `${day}/auto/s3/aws4_request`;
    const headers = { host: new URL(origin).host };
    if (type) headers['content-type'] = type;
    if (size != null) headers['content-length'] = String(size);
    const names = Object.keys(headers).sort();
    const query = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${access}/${scope}`, 'X-Amz-Date': stamp, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': names.join(';') };
    const qs = Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k])}`).join('&');
    const uri = '/' + [bucket, ...key.split('/')].map(enc).join('/');
    const canonical = [method, uri, qs, names.map(k => `${k}:${headers[k]}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
    const signingKey = hmac(hmac(hmac(hmac('AWS4' + secret, day), 'auto'), 's3'), 'aws4_request');
    const sig = crypto.createHmac('sha256', signingKey).update(`AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${hash(canonical)}`).digest('hex');
    return `${origin}${uri}?${qs}&X-Amz-Signature=${sig}`;
  }
  return { configured, origin, signed,
    async head(key) {
      const r = await fetch(signed('HEAD', key), { signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!r.ok) throw new ApiError(400, 'upload_missing', 'Upload not found. Upload the file before confirming.');
      return { size: Number(r.headers.get('content-length')), type: r.headers.get('content-type') };
    },
    async bytes(key, limit) {
      const r = await fetch(signed('GET', key), { signal: AbortSignal.timeout(60000), redirect: 'error' });
      if (!r.ok) throw new Error('Could not read uploaded media');
      const chunks = []; let size = 0;
      for await (const chunk of r.body) {
        size += chunk.length;
        if (size > limit) throw new ApiError(413, 'too_large', 'File exceeds the upload limit');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
    async put(key, buf, type) {
      const r = await fetch(signed('PUT', key, { type, size: buf.length }), { method: 'PUT', body: buf, headers: { 'Content-Type': type }, signal: AbortSignal.timeout(60000), redirect: 'error' });
      if (!r.ok) throw new Error('Could not store validated media');
    },
    async remove(key) {
      const r = await fetch(signed('DELETE', key), { signal: AbortSignal.timeout(15000) });
      if (!r.ok && r.status !== 404) throw new Error('Media cleanup failed');
    },
  };
}

async function verifyMedia(buf, slot, expectedType) {
  const image = sniffImage(buf);
  if (slot !== 'video' && (!image || image.contentType !== expectedType)) throw new ApiError(400, 'invalid_image', 'Upload a valid PNG, JPEG or WebP image');
  if (slot === 'video' && (buf.length < 16 || buf.toString('ascii', 4, 8) !== 'ftyp')) throw new ApiError(400, 'invalid_video', 'Upload an MP4 video');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'valence-media-'));
  try {
    const file = path.join(dir, slot === 'video' ? 'upload.mp4' : 'upload.' + image.ext);
    await fs.writeFile(file, buf);
    const { stdout } = await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', file], { timeout: 20000, maxBuffer: 128 * 1024, windowsHide: true });
    const info = JSON.parse(stdout), streams = info.streams || [];
    const videos = streams.filter(s => s.codec_type === 'video');
    if (videos.length !== 1 || videos[0].width < 1 || videos[0].height < 1 || videos[0].width * videos[0].height > (slot === 'video' ? 3840 * 2160 : 20000000)) throw new Error('Invalid dimensions');
    if (slot === 'video') {
      const duration = Math.max(Number(info.format?.duration) || 0, ...streams.map(s => Number(s.duration) || 0));
      if (!(duration > 0 && duration <= 300) || !['h264', 'hevc', 'av1'].includes(videos[0].codec_name) || streams.some(s => !['video', 'audio'].includes(s.codec_type))) throw new ApiError(400, 'invalid_video', 'MP4 must be at most five minutes, with supported video and audio tracks');
      return { duration };
    }
    if (streams.length !== 1 || Number(info.format?.duration) > 0 || videos[0].nb_frames && Number(videos[0].nb_frames) > 1) throw new Error('Animated images are not supported');
    return {};
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.code === 'ENOENT') throw new ApiError(503, 'verifier_unavailable', 'Media verification is not installed on this server');
    throw new ApiError(400, 'invalid_media', 'This file could not be validated. Use a static image or a standard MP4 video.');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

module.exports = { r2FromEnv, verifyMedia, VIDEO_BYTES, IMAGE_BYTES };
