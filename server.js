// Free slideshow video render service
// Takes: { images: ["<base64>", ...], captions: ["scene 1 text", ...], title: "..." }
// Returns: an MP4 video (vertical 1080x1920) with each image shown for a few seconds
// with the matching caption burned in as text, ready to upload straight to YouTube.

const express = require('express');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const app = express();
app.use(express.json({ limit: '50mb' }));

const SECONDS_PER_IMAGE = 4;

function escapeForDrawtext(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019")
    .replace(/%/g, '\\%');
}

app.post('/render', (req, res) => {
  const { images, captions, title } = req.body || {};

  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'images (array of base64 strings) is required' });
  }

  const jobId = uuid();
  const workDir = path.join('/tmp', jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1. Write each base64 image to disk
    images.forEach((b64, i) => {
      const clean = b64.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(workDir, `img${i}.png`), Buffer.from(clean, 'base64'));
    });

    // 2. Build an ffmpeg concat file (each image shown for SECONDS_PER_IMAGE seconds)
    const concatLines = images
      .map((_, i) => `file 'img${i}.png'\nduration ${SECONDS_PER_IMAGE}`)
      .join('\n');
    // ffmpeg concat demuxer needs the last file repeated without a duration line
    const concatFile = `${concatLines}\nfile 'img${images.length - 1}.png'\n`;
    fs.writeFileSync(path.join(workDir, 'list.txt'), concatFile);

    // 3. Build drawtext filters, one caption per image, timed to that image's window
    const capArray = Array.isArray(captions) ? captions : [];
    const drawtextFilters = images.map((_, i) => {
      const text = escapeForDrawtext(capArray[i] || '');
      if (!text) return null;
      const start = i * SECONDS_PER_IMAGE;
      const end = start + SECONDS_PER_IMAGE;
      return `drawtext=text='${text}':fontcolor=white:fontsize=64:box=1:boxcolor=black@0.55:boxborderw=20:x=(w-text_w)/2:y=h-350:enable='between(t,${start},${end})'`;
    }).filter(Boolean).join(',');

    const outputPath = path.join(workDir, 'output.mp4');

    const ffmpegArgs = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', path.join(workDir, 'list.txt'),
      '-vf', `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920${drawtextFilters ? ',' + drawtextFilters : ''}`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      outputPath
    ];

    execFile('ffmpeg', ffmpegArgs, { cwd: workDir, maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) {
        console.error(stderr);
        fs.rmSync(workDir, { recursive: true, force: true });
        return res.status(500).json({ error: 'ffmpeg failed', details: stderr.slice(-2000) });
      }

      res.set('Content-Type', 'video/mp4');
      res.set('Content-Disposition', `attachment; filename="${jobId}.mp4"`);
      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);
      stream.on('close', () => fs.rmSync(workDir, { recursive: true, force: true }));
    });
  } catch (e) {
    fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('Render service is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render service listening on ${PORT}`));
