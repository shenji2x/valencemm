// Storage for ticket attachments (images). Kept separate from the state snapshot in
// persist.js, because that snapshot is one JSON object and image bytes don't belong in it.
//
//   STORAGE_BUCKET  -> Cloud Storage objects under "attachments/"
//   DATA_FILE       -> files in an "attachments" folder next to the state file
//   neither         -> memory (tests, and local runs with no storage set up)
//
// Only images are accepted, and the type is read from the file's own first bytes rather
// than trusted from the browser, so a renamed script can't be stored as a picture.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_BYTES = 8 * 1024 * 1024; // per file
const MAX_FILES_PER_MESSAGE = 4;

// [type, extension, magic bytes, offset]
const SIGNATURES = [
  ["image/png", "png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 0],
  ["image/jpeg", "jpg", Buffer.from([0xff, 0xd8, 0xff]), 0],
  ["image/gif", "gif", Buffer.from("GIF87a"), 0],
  ["image/gif", "gif", Buffer.from("GIF89a"), 0],
  ["image/webp", "webp", Buffer.from("WEBP"), 8],
];

// Returns { contentType, ext } for a real image, or null.
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  for (const [contentType, ext, magic, offset] of SIGNATURES) {
    if (buf.subarray(offset, offset + magic.length).equals(magic)) {
      if (contentType === "image/webp" && !buf.subarray(0, 4).equals(Buffer.from("RIFF"))) continue;
      return { contentType, ext };
    }
  }
  return null;
}

function cleanName(name, ext) {
  const base = String(name || "").split(/[\\/]/).pop().replace(/[^A-Za-z0-9._ -]/g, "").trim().slice(0, 60);
  if (!base || base === "." || base === "..") return `image.${ext}`;
  return /\.[A-Za-z0-9]{1,5}$/.test(base) ? base : `${base}.${ext}`;
}

const newId = () => crypto.randomBytes(16).toString("hex");

function memoryBlobs() {
  const blobs = new Map();
  return {
    kind: "memory",
    async put(id, buf, contentType) { blobs.set(id, { buf, contentType }); },
    async get(id) { return blobs.get(id) || null; },
    async remove(id) { blobs.delete(id); },
  };
}

function fileBlobs(dir) {
  const full = (id) => path.join(dir, id);
  return {
    kind: "file",
    async put(id, buf, contentType) {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(full(id) + ".bin", buf);
      await fs.promises.writeFile(full(id) + ".type", contentType);
    },
    async get(id) {
      try {
        const [buf, contentType] = await Promise.all([fs.promises.readFile(full(id) + ".bin"), fs.promises.readFile(full(id) + ".type", "utf8")]);
        return { buf, contentType };
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },
    async remove(id) {
      await Promise.all([fs.promises.rm(full(id) + ".bin", { force: true }), fs.promises.rm(full(id) + ".type", { force: true })]);
    },
  };
}

// Cloud Storage, using the Cloud Run service account token from the metadata server.
function gcsBlobs(bucket, prefix = "attachments/", { fetchImpl = fetch, tokenProvider } = {}) {
  let cached = null;
  async function metadataToken() {
    if (cached && cached.expiresAt > Date.now() + 60 * 1000) return cached.token;
    const res = await fetchImpl("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "Metadata-Flavor": "Google" },
    });
    if (!res.ok) throw new Error(`metadata token request failed: ${res.status}`);
    const body = await res.json();
    cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return cached.token;
  }
  const getToken = tokenProvider || metadataToken;
  const object = (id) => encodeURIComponent(prefix + id);

  return {
    kind: "gcs",
    async put(id, buf, contentType) {
      const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${object(id)}`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + (await getToken()), "Content-Type": contentType },
        body: buf,
      });
      if (!res.ok) throw new Error(`Attachment upload failed: ${res.status}`);
    },
    async get(id) {
      const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${object(id)}?alt=media`;
      const res = await fetchImpl(url, { headers: { Authorization: "Bearer " + (await getToken()) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Attachment read failed: ${res.status}`);
      return { buf: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "application/octet-stream" };
    },
    async remove(id) {
      const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${object(id)}`;
      await fetchImpl(url, { method: "DELETE", headers: { Authorization: "Bearer " + (await getToken()) } }).catch(() => {});
    },
  };
}

function blobsFromEnv(env = process.env) {
  if (env.STORAGE_BUCKET) return gcsBlobs(env.STORAGE_BUCKET, env.ATTACHMENT_PREFIX || "attachments/");
  if (env.DATA_FILE) return fileBlobs(path.join(path.dirname(path.resolve(env.DATA_FILE)), "attachments"));
  return memoryBlobs();
}

// Stores one image and returns the record kept on the ticket message.
async function storeImage(blobs, { buf, name }) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error("empty file");
  if (buf.length > MAX_BYTES) throw new Error(`each image must be ${MAX_BYTES / 1024 / 1024} MB or smaller`);
  const kind = sniffImage(buf);
  if (!kind) throw new Error("only PNG, JPEG, GIF and WebP images can be attached");
  const id = newId();
  await blobs.put(id, buf, kind.contentType);
  return { id, name: cleanName(name, kind.ext), contentType: kind.contentType, size: buf.length };
}

module.exports = { memoryBlobs, fileBlobs, gcsBlobs, blobsFromEnv, storeImage, sniffImage, cleanName, MAX_BYTES, MAX_FILES_PER_MESSAGE };
