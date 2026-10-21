const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const run = promisify(require('child_process').execFile);
const { verifyMedia } = require('../src/profile-media');

test('real media probe enforces duration, dimensions, image type and MP4 structure', { skip: !process.env.FFMPEG_TEST_PATH ? 'Set FFMPEG_TEST_PATH and FFPROBE_PATH for real binary validation' : false }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'valence-probe-test-'));
  const ffmpeg = process.env.FFMPEG_TEST_PATH;
  try {
    const image = path.join(dir,'image.png'), short = path.join(dir,'short.mp4'), long = path.join(dir,'long.mp4');
    const encode = async (file, length) => run(ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=32x32:r=1','-t',String(length),'-c:v','libx264','-pix_fmt','yuv420p','-y',file],{windowsHide:true,timeout:20000});
    await run(ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=32x32','-frames:v','1','-y',image],{windowsHide:true,timeout:20000});
    await encode(short,2); await encode(long,301);
    assert.deepEqual(await verifyMedia(await fs.readFile(image),'avatar','image/png'),{});
    assert.equal((await verifyMedia(await fs.readFile(short),'video','video/mp4')).duration,2);
    await assert.rejects(verifyMedia(await fs.readFile(long),'video','video/mp4'),e=>e.code==='invalid_video');
    await assert.rejects(verifyMedia(await fs.readFile(image),'avatar','image/jpeg'),e=>e.code==='invalid_image');
    await assert.rejects(verifyMedia(Buffer.from('not an mp4 video'),'video','video/mp4'),e=>e.code==='invalid_video');
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
