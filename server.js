// Free slideshow video render service
// Takes: { images: ["<base64>", ...], captions: ["scene 1 text", ...], title: "..." }
// Saves the finished video to a fixed public URL (/videos/latest.mp4) that never changes,
// so it can just be bookmarked and checked/downloaded manually each day.

const express = require('express');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PUBLIC_DIR = path.join(__dirname, 'public', 'videos');
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use('/videos', express.static(PUBLIC_DIR));

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
    images.forEach((b64, i) => {
      const clean = b64.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(workDir, `img${i}.png`), Buffer.from(clean, 'base64'));
    });

    const concatLines = images
      .map((_, i) => `file 'img${i}.png'\nduration ${SECONDS_PER_IMAGE}`)
      .join('\n');
    const concatFile = `${concatLines}\nfile 'img${images.length - 1}.png'\n`;
    fs.writeFileSync(path.join(workDir, 'list.txt'), concatFile);

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
      '-vf', `scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280${drawtextFilters ? ',' + drawtextFilters : ''}`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-r', '24',
      outputPath
    ];

    execFile('ffmpeg', ffmpegArgs, { cwd: workDir, maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) {
        console.error(stderr);
        fs.rmSync(workDir, { recursive: true, force: true });
        return res.status(500).json({ error: 'ffmpeg failed', details: stderr.slice(-2000) });
      }

      const publicPath = path.join(PUBLIC_DIR, 'latest.mp4');
      fs.copyFileSync(outputPath, publicPath);
      fs.rmSync(workDir, { recursive: true, force: true });

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      res.json({
        status: 'ok',
        title: title || 'Untitled',
        videoUrl: `${baseUrl}/videos/latest.mp4?t=${Date.now()}`,
        generatedAt: new Date().toISOString()
      });
    });
  } catch (e) {
    fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('Render service is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render service listening on ${PORT}`));
