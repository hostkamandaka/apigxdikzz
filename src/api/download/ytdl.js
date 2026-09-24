// ytdl.js — versi Vercel
// Urutan: coba youtubei.js dulu; kalau gagal (misal "Sign in to confirm you're not a bot"),
// otomatis pindah ke @vreden/youtube_scraper (minta lewat server pihak ketiga, jadi IP Vercel tidak kena blok).
//
// Butuh di package.json: "youtubei.js" dan "@vreden/youtube_scraper" (dua-duanya sudah ada di proyek lu)
//
// Endpoint:
//   GET /download/youtube?url=&format=mp3|mp4|m4a&quality=
//   GET /youtube/info?url=
//   GET /youtube/download?url=&format=&quality=&redirect=true
//   GET /youtube/file?url=&format=&quality=

const { Readable } = require('stream')

const CREATOR = 'Gx Dikzz'
const VALID_FORMATS = ['mp3', 'mp4', 'm4a']
const CLIENTS = ['IOS', 'ANDROID', 'TV', 'WEB']
const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'

/* ============================ Helper umum ============================ */

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

function fmtDuration(sec = 0) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const pad = n => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function durationText(d) {
  if (!d) return ''
  if (typeof d === 'number') return fmtDuration(d)
  if (typeof d === 'string') return d
  return d.timestamp || (d.seconds ? fmtDuration(d.seconds) : '')
}

function fmtSize(bytes) {
  const n = Number(bytes)
  if (!n) return '-'
  const mb = n / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

function safeName(title) {
  return (title || 'video').replace(/[^a-z0-9]/gi, '_').substring(0, 50)
}

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`
}

function nearest(list, target) {
  return list.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best))
}

function apiLink(req, path, url, format, quality, extra = {}) {
  const q = new URLSearchParams({ url, format, ...extra })
  if (quality) q.set('quality', quality)
  return `${baseUrl(req)}${path}?${q.toString()}`
}

/* ============================ Jalur 1: youtubei.js ============================ */

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

// v10 minta client berupa string, versi baru minta objek { client }.
async function basicInfo(yt, videoId, client) {
  try {
    return await yt.getBasicInfo(videoId, client)
  } catch (e) {
    if (e instanceof TypeError) return await yt.getBasicInfo(videoId, { client })
    throw e
  }
}

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
      if (/sign in to confirm/i.test(e.message || '')) break
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
  if (m4a.length) audios = m4a
  const target = parseInt(quality, 10)
  if (!target) return audios[0]
  return audios.reduce((best, a) =>
    Math.abs(bitrateOf(a) - target) < Math.abs(bitrateOf(best) - target) ? a : best
  )
}

const pick = (info, format, quality) =>
  format === 'mp4' ? pickVideo(info, quality) : pickAudio(info, quality)

async function mediaViaYoutubei(videoId, format, quality) {
  const { yt, info } = await getInfo(videoId)
  const b = info.basic_info
  const f = pick(info, format, quality)
  const fileUrl = await resolveUrl(yt, f)
  const ext = format === 'mp4' ? 'mp4' : isM4a(f) ? 'm4a' : 'webm'

  return {
    source: 'youtubei',
    videoId,
    title: b.title || 'Unknown',
    thumbnail: (b.thumbnail && b.thumbnail[0] && b.thumbnail[0].url) || '',
    duration: fmtDuration(b.duration),
    channel: b.author || '',
    views: b.view_count || 0,
    description: b.short_description || '',
    fileUrl,
    quality: format === 'mp4' ? `${f.height}p` : `${bitrateOf(f)}K`,
    ext,
    size: fmtSize(f.content_length),
    mime: f.mime_type ? f.mime_type.split(';')[0] : 'application/octet-stream'
  }
}

/* ============================ Jalur 2: @vreden/youtube_scraper ============================ */

async function loadScraper() {
  try {
    return require('@vreden/youtube_scraper')
  } catch (e) {
    const m = await import('@vreden/youtube_scraper')
    return m.default || m
  }
}

function pickLink(r) {
  const candidates = [
    r && r.download && r.download.url,
    r && r.result && r.result.download && r.result.download.url,
    r && r.result && r.result.url,
    r && r.url,
    r && r.link,
    r && r.downloadUrl
  ]
  return candidates.find(x => typeof x === 'string' && /^https?:/.test(x))
}

function normalizeScraperMeta(meta) {
  meta = meta || {}
  return {
    title: meta.title || 'Unknown',
    thumbnail: meta.thumbnail || meta.image || '',
    duration: durationText(meta.duration || meta.timestamp),
    channel: (meta.author && (meta.author.name || meta.author)) || meta.channel || '',
    views: meta.views || 0,
    description: meta.description || ''
  }
}

// Cadangan A: @vreden/youtube_scraper
async function vredenAttempt(url, videoId, format, q) {
  const sc = await loadScraper()
  const isVideo = format === 'mp4'
  const r = isVideo ? await sc.ytmp4(url, q) : await sc.ytmp3(url, q)
  const fileUrl = pickLink(r)
  if (!fileUrl) {
    const reason = (r && (r.message || r.error || (r.download && r.download.message))) || 'link download tidak ditemukan'
    throw new Error(`vreden(${q}): ${reason}`)
  }
  const meta = (r && (r.metadata || (r.result && r.result.metadata))) || {}
  return {
    source: 'vreden',
    videoId,
    ...normalizeScraperMeta(meta),
    fileUrl,
    quality: isVideo ? `${q}p` : `${q}K`,
    ext: isVideo ? 'mp4' : 'mp3',
    size: '-',
    mime: isVideo ? 'video/mp4' : 'audio/mpeg'
  }
}

// Cadangan B: ruhend-scraper (opsional, hanya dipakai kalau paketnya terpasang)
async function ruhendAttempt(url, videoId, format) {
  let mod
  try {
    mod = require('ruhend-scraper')
  } catch (e) {
    try {
      mod = await import('ruhend-scraper')
    } catch (e2) {
      throw new Error('ruhend: paket belum terpasang')
    }
  }
  const isVideo = format === 'mp4'
  const fn = isVideo ? mod.ytmp4 || (mod.default && mod.default.ytmp4) : mod.ytmp3 || (mod.default && mod.default.ytmp3)
  if (typeof fn !== 'function') throw new Error('ruhend: fungsi tidak ditemukan')

  const r = await fn(url)
  const fileUrl = [r && r.video, r && r.audio, r && r.url, r && r.download, pickLink(r)].find(
    x => typeof x === 'string' && /^https?:/.test(x)
  )
  if (!fileUrl) throw new Error('ruhend: link download tidak ditemukan')

  return {
    source: 'ruhend',
    videoId,
    ...normalizeScraperMeta({ ...r, author: r && r.author }),
    fileUrl,
    quality: isVideo ? 'auto' : 'auto',
    ext: isVideo ? 'mp4' : 'mp3',
    size: '-',
    mime: isVideo ? 'video/mp4' : 'audio/mpeg'
  }
}

// Jalankan semua cadangan bersamaan, ambil yang pertama berhasil (hemat waktu di Vercel)
async function mediaViaScraper(url, videoId, format, quality) {
  const isVideo = format === 'mp4'
  const qs = isVideo ? [144, 360, 480, 720, 1080] : [92, 128, 256, 320]
  const q1 = nearest(qs, parseInt(quality, 10) || (isVideo ? 360 : 128))
  const q2 = isVideo ? (q1 === 360 ? 480 : 360) : q1 === 128 ? 256 : 128

  try {
    return await Promise.any([
      vredenAttempt(url, videoId, format, q1),
      vredenAttempt(url, videoId, format, q2),
      ruhendAttempt(url, videoId, format)
    ])
  } catch (agg) {
    const msgs = [...new Set((agg.errors || [agg]).map(e => e.message))]
    throw new Error(`Scraper cadangan gagal: ${msgs.join('; ')}`)
  }
}

/* ============================ Gabungan: utama lalu cadangan ============================ */

async function getMedia(url, videoId, format, quality) {
  try {
    return await mediaViaYoutubei(videoId, format, quality)
  } catch (e1) {
    console.error('youtubei gagal:', e1.message)
    try {
      return await mediaViaScraper(url, videoId, format, quality)
    } catch (e2) {
      console.error('scraper gagal:', e2.message)
      throw new Error(`${e1.message} | Cadangan: ${e2.message}`)
    }
  }
}

/* ============================ Endpoint ============================ */

module.exports = function (app) {

  // ---------- Proxy file lewat server ----------
  app.get('/youtube/file', async (req, res) => {
    const videoId = checkParams(req, res)
    if (!videoId) return

    const { url, format, quality } = req.query

    try {
      const m = await mediaViaYoutubei(videoId, format, quality)

      const headers = { 'User-Agent': UA }
      if (req.headers.range) headers.Range = req.headers.range

      const upstream = await fetch(m.fileUrl, { headers })
      if (!upstream.ok && upstream.status !== 206) {
        throw new Error(`YouTube menolak request (HTTP ${upstream.status})`)
      }

      res.status(upstream.status)
      res.setHeader('Content-Type', m.mime)
      res.setHeader('Content-Disposition', `attachment; filename="${safeName(m.title)}.${m.ext}"`)
      const len = upstream.headers.get('content-length')
      if (len) res.setHeader('Content-Length', len)
      const range = upstream.headers.get('content-range')
      if (range) res.setHeader('Content-Range', range)

      Readable.fromWeb(upstream.body).pipe(res)
    } catch (error) {
      console.error('File error:', error.message)
      if (res.headersSent) return
      // Cadangan: arahkan langsung ke link dari scraper
      try {
        const m = await mediaViaScraper(url, videoId, format, quality)
        return res.redirect(m.fileUrl)
      } catch (e2) {
        fail(res, 500, `${error.message} | Cadangan: ${e2.message}`)
      }
    }
  })

  // ---------- Info video + daftar kualitas ----------
  app.get('/youtube/info', async (req, res) => {
    const { url } = req.query
    if (!url) return fail(res, 400, 'URL YouTube diperlukan')

    let videoId
    try {
      videoId = extractVideoId(url)
    } catch (e) {
      return fail(res, 400, e.message)
    }

    try {
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
          ext: (isM4a(f) ? 'm4a' : 'webm').toUpperCase(),
          url: await resolveUrl(yt, f)
        })
      }

      return res.status(200).json({
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
      console.error('Info error (youtubei):', error.message)
    }

    // Cadangan: metadata dari scraper + daftar kualitas standar
    try {
      const sc = await loadScraper()
      const r = await sc.metadata(url)
      const meta = (r && (r.metadata || r.result || r)) || {}

      const videos = [1080, 720, 480, 360, 144].map(h => ({
        resolution: `${h}p`,
        quality: `${h}p`,
        size: '-',
        ext: 'MP4',
        url: apiLink(req, '/youtube/download', url, 'mp4', String(h), { redirect: 'true' })
      }))
      const audios = [320, 256, 128, 92].map(k => ({
        quality: `${k}K`,
        size: '-',
        ext: 'MP3',
        url: apiLink(req, '/youtube/download', url, 'mp3', String(k), { redirect: 'true' })
      }))

      res.status(200).json({
        status: true,
        creator: CREATOR,
        message: 'Informasi video berhasil didapatkan',
        result: {
          id: meta.videoId || meta.id || videoId,
          title: meta.title || 'Unknown',
          thumbnail: meta.thumbnail || meta.image || '',
          duration: durationText(meta.duration || meta.timestamp),
          channel: (meta.author && (meta.author.name || meta.author)) || meta.channel || '',
          videos,
          audios
        }
      })
    } catch (e2) {
      console.error('Info error (scraper):', e2.message)
      fail(res, 500, `Gagal mengambil informasi video: ${e2.message}`)
    }
  })

  // ---------- Download (JSON berisi link, atau redirect) ----------
  app.get('/youtube/download', async (req, res) => {
    const videoId = checkParams(req, res)
    if (!videoId) return

    const { url, format, quality } = req.query

    try {
      const m = await getMedia(url, videoId, format, quality)

      if (req.query.redirect === 'true' || req.query.direct === 'true') return res.redirect(m.fileUrl)

      res.status(200).json({
        status: true,
        creator: CREATOR,
        result: {
          id: videoId,
          title: m.title,
          format,
          quality: m.quality,
          size: m.size,
          fileUrl: m.fileUrl,
          directLink: m.fileUrl,
          proxyUrl: apiLink(req, '/youtube/file', url, format, quality)
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
      const m = await getMedia(url, videoId, format, quality)

      let message = `Media ${format.toUpperCase()} berhasil didapatkan dengan kualitas ${m.quality}`
      if (format === 'mp3' && m.ext !== 'mp3') message += ` (format asli ${m.ext.toUpperCase()})`

      res.status(200).json({
        status: true,
        creator: CREATOR,
        message,
        result: {
          metadata: {
            videoId,
            title: m.title,
            thumbnail: m.thumbnail,
            duration: m.duration,
            channel: m.channel,
            views: m.views,
            timestamp: m.duration,
            description: m.description
          },
          download: {
            fileUrl: m.fileUrl,
            proxyUrl: apiLink(req, '/youtube/file', url, format, quality),
            viewUrl: null,
            quality: m.quality,
            format,
            originalExt: m.ext.toUpperCase(),
            size: m.size,
            fileName: `${safeName(m.title)}.${m.ext}`
          }
        }
      })
    } catch (error) {
      console.error('Download error:', error.message)
      fail(res, 500, error.message || 'Terjadi kesalahan saat mengunduh')
    }
  })
}
