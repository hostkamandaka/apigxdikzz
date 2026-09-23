// ytdl.js — versi baru pakai yt-dlp (via youtube-dl-exec)
// Butuh: npm i youtube-dl-exec   +   python3 & ffmpeg terinstall di server
//
// Endpoint (sama seperti versi lama):
//   GET /download/youtube?url=&format=mp3|mp4|m4a&quality=
//   GET /youtube/info?url=
//   GET /youtube/download?url=&format=&quality=&redirect=true|direct=true
// Endpoint baru (yang benar-benar mengirim file):
//   GET /youtube/file?url=&format=&quality=

const youtubedl = require('youtube-dl-exec')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const CREATOR = 'Gx Dikzz'
const VALID_FORMATS = ['mp3', 'mp4', 'm4a']
const MAX_PARALLEL = 3
const TMP_DIR = path.join(os.tmpdir(), 'ytdl-files')
const BASE_FLAGS = { noWarnings: true, noPlaylist: true, noCheckCertificates: true }

fs.mkdirSync(TMP_DIR, { recursive: true })

let running = 0

// Bersihin file sisa yang umurnya > 30 menit
setInterval(() => {
  fs.readdir(TMP_DIR, (err, files) => {
    if (err) return
    for (const f of files) {
      const p = path.join(TMP_DIR, f)
      fs.stat(p, (e, st) => {
        if (!e && Date.now() - st.mtimeMs > 30 * 60 * 1000) fs.unlink(p, () => {})
      })
    }
  })
}, 10 * 60 * 1000).unref()

function extractVideoId(url) {
  const m =
    /youtu\.be\/([a-zA-Z0-9_-]{11})/.exec(url) ||
    /v=([a-zA-Z0-9_-]{11})/.exec(url) ||
    /\/shorts\/([a-zA-Z0-9_-]{11})/.exec(url) ||
    /\/live\/([a-zA-Z0-9_-]{11})/.exec(url)
  if (!m) throw new Error('URL YouTube tidak valid')
  return m[1]
}

const watchUrl = id => `https://www.youtube.com/watch?v=${id}`

function fail(res, code, error) {
  return res.status(code).json({ status: false, creator: CREATOR, error })
}

function checkParams(req, res) {
  const { url, format } = req.query
  if (!url) return fail(res, 400, 'URL YouTube diperlukan'), null
  if (!format) return fail(res, 400, 'Parameter format diperlukan (mp3/mp4/m4a)'), null
  if (!VALID_FORMATS.includes(format))
    return fail(res, 400, `Format harus salah satu dari: ${VALID_FORMATS.join(', ')}`), null
  try {
    return extractVideoId(url)
  } catch (e) {
    return fail(res, 400, e.message), null
  }
}

async function getInfo(videoId) {
  return youtubedl(watchUrl(videoId), { dumpSingleJson: true, ...BASE_FLAGS })
}

function fmtDuration(sec = 0) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const pad = n => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function fmtSize(bytes) {
  if (!bytes) return null
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

function normalizeQuality(format, quality) {
  if (format === 'mp4') {
    const h = parseInt(quality, 10)
    return h > 0 ? `${h}p` : '480p'
  }
  const m = /^(\d{2,3})k?$/i.exec(quality || '')
  return m ? `${m[1]}K` : '128K'
}

// Download ke file sementara, return path file-nya
async function downloadToFile(videoId, format, quality) {
  const token = `${videoId}_${crypto.randomBytes(6).toString('hex')}`
  const flags = { ...BASE_FLAGS, output: path.join(TMP_DIR, `${token}.%(ext)s`) }

  if (format === 'mp4') {
    const h = parseInt(normalizeQuality(format, quality), 10)
    flags.format =
      `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/b[height<=${h}]/b`
    flags.mergeOutputFormat = 'mp4'
  } else {
    flags.format = 'ba/b'
    flags.extractAudio = true
    flags.audioFormat = format
    flags.audioQuality = normalizeQuality(format, quality)
  }

  await youtubedl(watchUrl(videoId), flags)

  const file = fs.readdirSync(TMP_DIR).find(f => f.startsWith(token + '.'))
  if (!file) throw new Error('File hasil download tidak ditemukan')
  return path.join(TMP_DIR, file)
}

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`
}

function fileLink(req, url, format, quality) {
  const q = new URLSearchParams({ url, format })
  if (quality) q.set('quality', quality)
  return `${baseUrl(req)}/youtube/file?${q.toString()}`
}

module.exports = function (app) {

  // ---------- Kirim file (ini yang beneran download) ----------
  app.get('/youtube/file', async (req, res) => {
    const videoId = checkParams(req, res)
    if (!videoId) return

    if (running >= MAX_PARALLEL)
      return fail(res, 429, 'Server sedang sibuk, coba lagi sebentar')

    running++
    let filePath = null
    try {
      const info = await getInfo(videoId)
      filePath = await downloadToFile(videoId, req.query.format, req.query.quality)

      const safeTitle = (info.title || 'video').replace(/[^a-z0-9]/gi, '_').substring(0, 50)
      const ext = path.extname(filePath)

      res.download(filePath, `${safeTitle}${ext}`, () => {
        fs.unlink(filePath, () => {})
      })
    } catch (error) {
      console.error('File error:', error.message)
      if (filePath) fs.unlink(filePath, () => {})
      if (!res.headersSent) fail(res, 500, error.message || 'Terjadi kesalahan saat mengunduh')
    } finally {
      running--
    }
  })

  // ---------- Info video + daftar kualitas ----------
  app.get('/youtube/info', async (req, res) => {
    const { url } = req.query
    if (!url) return fail(res, 400, 'URL YouTube diperlukan')

    try {
      const videoId = extractVideoId(url)
      const info = await getInfo(videoId)

      const videoMap = new Map()
      const audioMap = new Map()

      for (const f of info.formats || []) {
        const size = f.filesize || f.filesize_approx
        if (f.vcodec !== 'none' && f.height) {
          const prev = videoMap.get(f.height)
          if (!prev || (size || 0) > (prev.bytes || 0)) videoMap.set(f.height, { bytes: size, ext: f.ext })
        } else if (f.acodec !== 'none' && f.vcodec === 'none' && f.abr) {
          const key = Math.round(f.abr)
          if (!audioMap.has(key)) audioMap.set(key, { bytes: size, ext: f.ext })
        }
      }

      const videos = [...videoMap.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([h, v]) => ({
          resolution: `${h}p`,
          quality: `${h}p`,
          size: fmtSize(v.bytes) || '-',
          ext: 'MP4',
          url: fileLink(req, url, 'mp4', String(h))
        }))

      const audios = [...audioMap.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([abr, v]) => ({
          quality: `${abr}K`,
          size: fmtSize(v.bytes) || '-',
          ext: (v.ext || 'm4a').toUpperCase(),
          url: fileLink(req, url, 'mp3', String(abr))
        }))

      res.status(200).json({
        status: true,
        creator: CREATOR,
        message: 'Informasi video berhasil didapatkan',
        result: {
          id: info.id,
          title: info.title,
          thumbnail: info.thumbnail,
          duration: fmtDuration(info.duration),
          channel: info.uploader || info.channel || '',
          videos,
          audios
        }
      })
    } catch (error) {
      console.error('Info error:', error.message)
      fail(res, 500, error.message || 'Terjadi kesalahan saat mengambil informasi')
    }
  })

  // ---------- Download (JSON berisi link, atau langsung redirect) ----------
  app.get('/youtube/download', async (req, res) => {
    const videoId = checkParams(req, res)
    if (!videoId) return

    const { url, format, quality } = req.query
    const link = fileLink(req, url, format, quality)

    if (req.query.redirect === 'true' || req.query.direct === 'true') return res.redirect(link)

    try {
      const info = await getInfo(videoId)
      res.status(200).json({
        status: true,
        creator: CREATOR,
        result: {
          id: info.id,
          title: info.title,
          format,
          quality: normalizeQuality(format, quality),
          fileUrl: link,
          directLink: link
        }
      })
    } catch (error) {
      console.error('Download error:', error.message)
      fail(res, 500, error.message || 'Terjadi kesalahan')
    }
  })

  // ---------- Endpoint lama: metadata + link download ----------
  app.get('/download/youtube', async (req, res) => {
    const videoId = checkParams(req, res)
    if (!videoId) return

    const { url, format, quality } = req.query

    try {
      const info = await getInfo(videoId)
      const q = normalizeQuality(format, quality)

      res.status(200).json({
        status: true,
        creator: CREATOR,
        message: `Media ${format.toUpperCase()} siap diunduh dengan kualitas ${q}`,
        result: {
          metadata: {
            videoId,
            title: info.title || 'Unknown',
            thumbnail: info.thumbnail || '',
            duration: fmtDuration(info.duration),
            channel: info.uploader || info.channel || '',
            views: info.view_count || 0,
            timestamp: fmtDuration(info.duration),
            description: info.description || ''
          },
          download: {
            fileUrl: fileLink(req, url, format, quality),
            viewUrl: null,
            quality: q,
            format,
            originalExt: format.toUpperCase(),
            fileName: `${(info.title || 'video').replace(/[^a-z0-9]/gi, '_').substring(0, 50)}.${format}`
          }
        }
      })
    } catch (error) {
      console.error('Download error:', error.message)
      fail(res, 500, error.message || 'Terjadi kesalahan saat mengunduh')
    }
  })
}
