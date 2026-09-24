// ytdl.js — versi Vercel (tanpa yt-dlp / ffmpeg), pakai youtubei.js
// Install: npm i youtubei.js
//
// Endpoint (sama seperti versi lama):
//   GET /download/youtube?url=&format=mp3|mp4|m4a&quality=
//   GET /youtube/info?url=
//   GET /youtube/download?url=&format=&quality=&redirect=true
// Endpoint tambahan:
//   GET /youtube/file?url=&format=&quality=   (proxy file lewat server, kalau link langsung ditolak)
//
// Batasan di Vercel:
//   - mp3 tidak bisa (butuh ffmpeg). format=mp3 akan mengembalikan audio M4A.
//   - mp4 memakai stream yang sudah ada suaranya (umumnya max 360p, kadang 720p).

const { Readable } = require('stream')

const CREATOR = 'Gx Dikzz'
const VALID_FORMATS = ['mp3', 'mp4', 'm4a']
const CLIENTS = ['IOS', 'ANDROID', 'TV', 'WEB']
const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'

// youtubei.js itu ESM-only, jadi di-import dinamis dan di-cache antar request
let ytPromise = null
function getYt() {
  if (!ytPromise) {
    ytPromise = import('youtubei.js')
      .then(({ Innertube }) => Innertube.create({ retrieve_player: true }))
      .catch(err => {
        ytPromise = null
        throw err
      })
  }
  return ytPromise
}

function extractVideoId(url) {
  const m =
    /youtu\.be\/([a-zA-Z0-9_-]{11})/.exec(url) ||
    /v=([a-zA-Z0-9_-]{11})/.exec(url) ||
    /\/shorts\/([a-zA-Z0-9_-]{11})/.exec(url) ||
    /\/live\/([a-zA-Z0-9_-]{11})/.exec(url)
  if (!m) throw new Error('URL YouTube tidak valid')
  return m[1]
}

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

// youtubei.js v10 minta client berupa string, versi baru minta objek { client }.
// Coba string dulu, kalau ditolak coba objek.
async function basicInfo(yt, videoId, client) {
  try {
    return await yt.getBasicInfo(videoId, client)
  } catch (e) {
    if (e instanceof TypeError) return await yt.getBasicInfo(videoId, { client })
    throw e
  }
}

// Coba beberapa client sampai dapat data streaming
async function getInfo(videoId) {
  const yt = await getYt()
  let lastErr = null

  for (const client of CLIENTS) {
    try {
      const info = await basicInfo(yt, videoId, client)
      const sd = info.streaming_data
      if (sd && ((sd.formats && sd.formats.length) || (sd.adaptive_formats && sd.adaptive_formats.length))) {
        return { yt, info }
      }
      lastErr = new Error(
        (info.playability_status && info.playability_status.reason) || 'Data streaming tidak tersedia'
      )
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('Gagal mengambil data video')
}

async function resolveUrl(yt, f) {
  try {
    if (typeof f.decipher === 'function') {
      const u = await f.decipher(yt.session.player)
      if (u) return u
    }
  } catch (_) {
    /* fallback ke f.url */
  }
  if (f.url) return f.url
  throw new Error('URL download tidak ditemukan')
}

function fmtDuration(sec = 0) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const pad = n => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function fmtSize(bytes) {
  const n = Number(bytes)
  if (!n) return '-'
  const mb = n / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

const bitrateOf = f => Math.round((f.average_bitrate || f.bitrate || 0) / 1000)
const isM4a = f => (f.mime_type || '').includes('audio/mp4')

function listVideos(info) {
  const map = new Map()
  for (const f of info.streaming_data.formats || []) {
    if (!f.height) continue
    if (!map.has(f.height)) map.set(f.height, f)
  }
  return [...map.values()].sort((a, b) => b.height - a.height)
}

function listAudios(info) {
  return (info.streaming_data.adaptive_formats || [])
    .filter(f => (f.mime_type || '').startsWith('audio/'))
    .sort((a, b) => bitrateOf(b) - bitrateOf(a))
}

function pickVideo(info, quality) {
  const videos = listVideos(info)
  if (!videos.length) throw new Error('Tidak ada opsi video yang tersedia')
  const h = parseInt(quality, 10)
  if (!h) return videos[0]
  return videos.find(v => v.height === h) || videos.find(v => v.height < h) || videos[videos.length - 1]
}

function pickAudio(info, quality) {
  let audios = listAudios(info)
  if (!audios.length) throw new Error('Tidak ada opsi audio yang tersedia')
  const m4a = audios.filter(isM4a)
  if (m4a.length) audios = m4a // m4a paling kompatibel
  const target = parseInt(quality, 10)
  if (!target) return audios[0]
  return audios.reduce((best, a) =>
    Math.abs(bitrateOf(a) - target) < Math.abs(bitrateOf(best) - target) ? a : best
  )
}

function pick(info, format, quality) {
  return format === 'mp4' ? pickVideo(info, quality) : pickAudio(info, quality)
}

function qualityLabel(format, f) {
  return format === 'mp4' ? `${f.height}p` : `${bitrateOf(f)}K`
}

function extOf(format, f) {
  if (format === 'mp4') return 'mp4'
  return isM4a(f) ? 'm4a' : 'webm'
}

function safeName(title) {
  return (title || 'video').replace(/[^a-z0-9]/gi, '_').substring(0, 50)
}

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`
}

function proxyLink(req, url, format, quality) {
  const q = new URLSearchParams({ url, format })
  if (quality) q.set('quality', quality)
  return `${baseUrl(req)}/youtube/file?${q.toString()}`
}

module.exports = function (app) {

  // ---------- Proxy file lewat server ----------
  app.get('/youtube/file', async (req, res) => {
    const videoId = checkParams(req, res)
    if (!videoId) return

    try {
      const { yt, info } = await getInfo(videoId)
      const format = req.query.format
      const f = pick(info, format, req.query.quality)
      const fileUrl = await resolveUrl(yt, f)

      const headers = { 'User-Agent': UA }
      if (req.headers.range) headers.Range = req.headers.range

      const upstream = await fetch(fileUrl, { headers })
      if (!upstream.ok && upstream.status !== 206) {
        throw new Error(`YouTube menolak request (HTTP ${upstream.status})`)
      }

      const ext = extOf(format, f)
      res.status(upstream.status)
      res.setHeader('Content-Type', f.mime_type ? f.mime_type.split(';')[0] : 'application/octet-stream')
      res.setHeader('Content-Disposition', `attachment; filename="${safeName(info.basic_info.title)}.${ext}"`)
      const len = upstream.headers.get('content-length')
      if (len) res.setHeader('Content-Length', len)
      const range = upstream.headers.get('content-range')
      if (range) res.setHeader('Content-Range', range)

      Readable.fromWeb(upstream.body).pipe(res)
    } catch (error) {
      console.error('File error:', error.message)
      if (!res.headersSent) fail(res, 500, error.message || 'Terjadi kesalahan saat mengunduh')
    }
  })

  // ---------- Info video + daftar kualitas ----------
  app.get('/youtube/info', async (req, res) => {
    const { url } = req.query
    if (!url) return fail(res, 400, 'URL YouTube diperlukan')

    try {
      const videoId = extractVideoId(url)
      const { yt, info } = await getInfo(videoId)
      const b = info.basic_info

      const videos = []
      for (const f of listVideos(info)) {
        videos.push({
          resolution: `${f.height}p`,
          quality: f.quality_label || `${f.height}p`,
          size: fmtSize(f.content_length),
          ext: 'MP4',
          url: await resolveUrl(yt, f)
        })
      }

      const audios = []
      for (const f of listAudios(info)) {
        audios.push({
          quality: `${bitrateOf(f)}K`,
          size: fmtSize(f.content_length),
          ext: extOf('m4a', f).toUpperCase(),
          url: await resolveUrl(yt, f)
        })
      }

      res.status(200).json({
        status: true,
        creator: CREATOR,
        message: 'Informasi video berhasil didapatkan',
        result: {
          id: b.id || videoId,
          title: b.title,
          thumbnail: (b.thumbnail && b.thumbnail[0] && b.thumbnail[0].url) || '',
          duration: fmtDuration(b.duration),
          channel: b.author || '',
          videos,
          audios
        }
      })
    } catch (error) {
      console.error('Info error:', error.message)
      fail(res, 500, error.message || 'Terjadi kesalahan saat mengambil informasi')
    }
  })

  // ---------- Download (JSON berisi link, atau redirect) ----------
  app.get('/youtube/download', async (req, res) => {
    const videoId = checkParams(req, res)
    if (!videoId) return

    const { url, format, quality } = req.query

    try {
      const { yt, info } = await getInfo(videoId)
      const f = pick(info, format, quality)
      const fileUrl = await resolveUrl(yt, f)

      if (req.query.redirect === 'true' || req.query.direct === 'true') return res.redirect(fileUrl)

      res.status(200).json({
        status: true,
        creator: CREATOR,
        result: {
          id: info.basic_info.id || videoId,
          title: info.basic_info.title,
          format,
          quality: qualityLabel(format, f),
          size: fmtSize(f.content_length),
          fileUrl,
          directLink: fileUrl,
          proxyUrl: proxyLink(req, url, format, quality)
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
      const { yt, info } = await getInfo(videoId)
      const b = info.basic_info
      const f = pick(info, format, quality)
      const fileUrl = await resolveUrl(yt, f)
      const q = qualityLabel(format, f)
      const ext = extOf(format, f)

      let message = `Media ${format.toUpperCase()} berhasil didapatkan dengan kualitas ${q}`
      if (format === 'mp3') message += ' (format asli M4A, konversi mp3 tidak tersedia di Vercel)'

      res.status(200).json({
        status: true,
        creator: CREATOR,
        message,
        result: {
          metadata: {
            videoId,
            title: b.title || 'Unknown',
            thumbnail: (b.thumbnail && b.thumbnail[0] && b.thumbnail[0].url) || '',
            duration: fmtDuration(b.duration),
            channel: b.author || '',
            views: b.view_count || 0,
            timestamp: fmtDuration(b.duration),
            description: b.short_description || ''
          },
          download: {
            fileUrl,
            proxyUrl: proxyLink(req, url, format, quality),
            viewUrl: null,
            quality: q,
            format,
            originalExt: ext.toUpperCase(),
            size: fmtSize(f.content_length),
            fileName: `${safeName(b.title)}.${ext}`
          }
        }
      })
    } catch (error) {
      console.error('Download error:', error.message)
      fail(res, 500, error.message || 'Terjadi kesalahan saat mengunduh')
    }
  })
}
