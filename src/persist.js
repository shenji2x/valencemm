// Durable storage for the store. The store works in memory; after every change the API
// calls commit(), which writes a full snapshot and resolves once it is safely saved.
// Requests that arrive while a write is in flight share the next write ("group commit"),
// so a burst of requests costs a few writes, not one each.
//
// Backends:
//   gcs    - one JSON object in a Cloud Storage bucket (production, set STORAGE_BUCKET)
//   file   - a local JSON file (local development, set DATA_FILE)
//   memory - nothing is saved (tests, or when neither is set)
//
// Safety: Cloud Storage writes use ifGenerationMatch, so if anything else wrote the object
// since we last read or wrote it, our write is refused instead of silently overwriting it.
// If a write can't be saved, the process exits so Cloud Run restarts it from the last good
// snapshot, rather than carrying on with balances that were never saved.

const fs = require("fs");
const path = require("path");

class ConflictError extends Error {}

function memoryBackend() {
  return { kind: "memory", async read() { return null; }, async write() {} };
}

function fileBackend(file) {
  return {
    kind: "file",
    async read() {
      try {
        return JSON.parse(await fs.promises.readFile(file, "utf8"));
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },
    async write(text) {
      await fs.promises.mkdir(path.dirname(path.resolve(file)), { recursive: true });
      const tmp = file + ".tmp";
      await fs.promises.writeFile(tmp, text);
      await fs.promises.rename(tmp, file); // atomic replace: never a half-written file
    },
  };
}

// Talks to the Cloud Storage JSON API directly with fetch, using the Cloud Run service
// account's token from the metadata server. No client library needed.
function gcsBackend(bucket, object, { fetchImpl = fetch, tokenProvider } = {}) {
  let generation = "0"; // "0" means "the object must not exist yet"
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

  async function withRetry(fn) {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ConflictError || err.permanent) throw err;
        lastErr = err;
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  function failure(res, what) {
    const err = new Error(`${what} failed: ${res.status}`);
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    return err;
  }

  return {
    kind: "gcs",
    async read() {
      return withRetry(async () => {
        const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
        const res = await fetchImpl(url, { headers: { Authorization: "Bearer " + (await getToken()) } });
        if (res.status === 404) {
          generation = "0";
          return null;
        }
        if (!res.ok) throw failure(res, "Cloud Storage read");
        generation = res.headers.get("x-goog-generation") || generation;
        return JSON.parse(await res.text());
      });
    },
    async write(text) {
      return withRetry(async () => {
        const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
          `?uploadType=media&name=${encodeURIComponent(object)}&ifGenerationMatch=${generation}`;
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { Authorization: "Bearer " + (await getToken()), "Content-Type": "application/json" },
          body: text,
        });
        if (res.status === 412) throw new ConflictError("Snapshot was changed by another instance");
        if (!res.ok) throw failure(res, "Cloud Storage write");
        const meta = await res.json();
        generation = String(meta.generation);
      });
    },
  };
}

function backendFromEnv(env = process.env) {
  if (env.STORAGE_BUCKET) return gcsBackend(env.STORAGE_BUCKET, env.STORAGE_OBJECT || "valence-state.json");
  if (env.DATA_FILE) return fileBackend(env.DATA_FILE);
  return memoryBackend();
}

function createPersistence(store, backend, { onFatal } = {}) {
  let writing = null; // the write currently in flight
  let next = null; // the commit that will snapshot once `writing` finishes
  let failed = null;

  const fatal = onFatal || ((err) => {
    console.error("FATAL: could not save data, restarting from the last saved snapshot.", err);
    process.exit(1);
  });

  async function runCommit() {
    // Always await (even with nothing in flight) so commit() has stored `next` before we clear it.
    await (writing ? writing.catch(() => {}) : null);
    if (failed) throw failed;
    next = null; // anything that changes the store from here on needs the following write
    const text = JSON.stringify(store.exportState());
    const mine = backend.write(text);
    writing = mine;
    try {
      await mine;
    } catch (err) {
      failed = err;
      setImmediate(() => fatal(err));
      throw err;
    } finally {
      if (writing === mine) writing = null; // a later commit may already have started its own write
    }
  }

  return {
    kind: backend.kind,
    async load() {
      const state = await backend.read();
      if (state) store.importState(state);
      return Boolean(state);
    },
    // Resolves once every change made before this call is saved.
    commit() {
      if (backend.kind === "memory") return Promise.resolve();
      if (failed) return Promise.reject(failed);
      if (!next) next = runCommit();
      return next;
    },
  };
}

module.exports = { createPersistence, backendFromEnv, memoryBackend, fileBackend, gcsBackend, ConflictError };
