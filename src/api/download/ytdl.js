const axios = require('axios')
const yts = require('yt-search')

async function ytdownDownloader(videoUrl, format = 'mp3', quality = '') {
  try {
    const validFormats = ['mp3', 'mp4', 'm4a']

    if (!validFormats.includes(format)) {
      throw new Error(`Format harus salah satu dari: ${validFormats.join(', ')}`)
    }

    const response = await axios.post(
      'https://app.ytdown.to/proxy.php',
      new URLSearchParams({ url: videoUrl }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
          'Origin': 'https://app.ytdown.to',
          'Referer': 'https://app.ytdown.to/'
        },
        timeout: 60000
      }
    )

    if (!response.data || response.data.api?.status !== 'ok') {
      throw new Error('Gagal mengambil data dari ytdown')
    }

    const apiData = response.data.api
    let selectedItem = null
    let selectedQuality = quality

    // =========================
    // MP4
    // =========================
    if (format === 'mp4') {

      const videos =
        apiData.mediaItems?.filter(
          item => item.type === 'Video'
        ) || []

      if (!videos.length) {
        throw new Error('Tidak ada opsi video yang tersedia')
      }

      const resolutionOrder = [
        '2160p',
        '1440p',
        '1080p',
        '720p',
        '480p',
        '360p',
        '240p',
        '144p'
      ]

      const sortedVideos = [...videos].sort((a, b) => {

        const aIdx = resolutionOrder.findIndex(
          r => a.mediaQuality?.toUpperCase() === r
        )

        const bIdx = resolutionOrder.findIndex(
          r => b.mediaQuality?.toUpperCase() === r
        )

        return (
          (aIdx === -1 ? 999 : aIdx) -
          (bIdx === -1 ? 999 : bIdx)
        )
      })

      if (quality) {

        selectedItem = videos.find(v =>
          v.mediaQuality?.toUpperCase() === quality.toUpperCase() ||
          v.mediaRes?.includes(quality)
        )

        if (!selectedItem) {
          selectedItem = sortedVideos[0]
          selectedQuality =
            selectedItem?.mediaQuality ||
            selectedItem?.mediaRes ||
            'unknown'
        } else {
          selectedQuality =
            selectedItem.mediaQuality ||
            selectedItem?.mediaRes ||
            quality
        }

      } else {

        selectedItem =
          videos.find(v => v.mediaRes?.includes('480')) ||
          videos.find(v => v.mediaRes?.includes('360')) ||
          sortedVideos[Math.floor(sortedVideos.length / 2)] ||
          sortedVideos[0]

        selectedQuality =
          selectedItem?.mediaQuality ||
          selectedItem?.mediaRes ||
          '480p'
      }
    }

    // =========================
    // MP3 / M4A
    // =========================
    else if (format === 'mp3' || format === 'm4a') {

      const audios =
        apiData.mediaItems?.filter(
          item => item.type === 'Audio'
        ) || []

      if (!audios.length) {
        throw new Error('Tidak ada opsi audio yang tersedia')
      }

      let targetAudios = audios

      if (format === 'mp3') {

        targetAudios = audios.filter(
          a =>
            a.mediaExtension?.toLowerCase() === 'mp3'
        )

        if (!targetAudios.length) {
          targetAudios = audios
        }

      } else if (format === 'm4a') {

        targetAudios = audios.filter(
          a =>
            a.mediaExtension?.toLowerCase() === 'm4a'
        )

        if (!targetAudios.length) {
          targetAudios = audios
        }
      }

      const bitrateOrder = [
        '320K',
        '256K',
        '192K',
        '128K',
        '96K',
        '64K',
        '48K'
      ]

      const sortedAudios = [...targetAudios].sort((a, b) => {

        const aIdx = bitrateOrder.findIndex(
          r => a.mediaQuality?.toUpperCase() === r
        )

        const bIdx = bitrateOrder.findIndex(
          r => b.mediaQuality?.toUpperCase() === r
        )

        return (
          (aIdx === -1 ? 999 : aIdx) -
          (bIdx === -1 ? 999 : bIdx)
        )
      })

      if (quality) {

        selectedItem = targetAudios.find(a =>
          a.mediaQuality?.toUpperCase() === quality.toUpperCase() ||
          a.mediaQuality === quality
        )

        if (!selectedItem) {

          selectedItem = sortedAudios[0]

          selectedQuality =
            selectedItem?.mediaQuality || '128K'

        } else {

          selectedQuality =
            selectedItem.mediaQuality
        }

      } else {

        selectedItem =
          targetAudios.find(
            a => a.mediaQuality === '128K'
          ) ||
          sortedAudios[
            Math.floor(sortedAudios.length / 2)
          ] ||
          sortedAudios[0]

        selectedQuality =
          selectedItem?.mediaQuality || '128K'
      }
    }

    if (!selectedItem || !selectedItem.mediaUrl) {
      throw new Error(
        'Tidak dapat menemukan URL download yang sesuai'
      )
    }

    // =========================
    // FIX DOWNLOAD
    // =========================

    let fileUrl = null
    let viewUrl = null
    let fileSize =
      selectedItem.mediaFileSize || null

    let fileSizeBytes = null

    try {

      const mediaUrl = selectedItem.mediaUrl

      // polling convert
      for (let i = 0; i < 15; i++) {

        await new Promise(r =>
          setTimeout(r, 2000)
        )

        try {

          const detailResponse =
            await axios.get(mediaUrl, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
                'Accept':
                  'application/json,text/plain,*/*',
                'Referer':
                  'https://app.ytdown.to/',
                'Origin':
                  'https://app.ytdown.to'
              },
              timeout: 30000
            })

          const data = detailResponse.data

          console.log(
            `Polling ${i + 1}:`,
            data
          )

          // sukses
          if (
            data &&
            (
              data.status === 'completed' ||
              data.fileUrl
            )
          ) {

            fileUrl =
              data.fileUrl ||
              data.downloadUrl ||
              null

            viewUrl =
              data.viewUrl || null

            fileSize =
              data.fileSize ||
              selectedItem.mediaFileSize

            fileSizeBytes =
              data.fileSizeBytes || null

            break
          }

          // gagal
          if (data.status === 'error') {
            throw new Error(
              data.message || 'Convert gagal'
            )
          }

        } catch (e) {

          console.log(
            'Polling error:',
            e.message
          )
        }
      }

    } catch (e) {

      console.log(
        'Gagal mengambil detail URL:',
        e.message
      )
    }

    // fallback terakhir
    if (!fileUrl) {

      try {

        const fallback =
          await axios.get(selectedItem.mediaUrl, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
              'Referer':
                'https://app.ytdown.to/'
            },
            timeout: 20000
          })

        fileUrl =
          fallback.data?.fileUrl ||
          fallback.data?.downloadUrl ||
          selectedItem.mediaUrl

      } catch {

        fileUrl = selectedItem.mediaUrl
      }
    }

    return {
      id: apiData.id,
      title: apiData.title || 'Unknown',
      thumbnail: apiData.imagePreviewUrl || '',
      duration:
        apiData.mediaItems?.[0]?.mediaDuration ||
        '0:00',
      channel: apiData.userInfo?.name || '',
      format: format,
      quality: selectedQuality,
      size:
        fileSize ||
        selectedItem.mediaFileSize ||
        'Unknown',
      sizeBytes: fileSizeBytes,
      fileUrl: fileUrl,
      viewUrl: viewUrl,
      originalExt:
        selectedItem.mediaExtension ||
        (
          format === 'mp3'
            ? 'MP3'
            : format === 'm4a'
            ? 'M4A'
            : 'MP4'
        )
    }

  } catch (error) {

    throw new Error(
      `Download failed: ${error.message}`
    )
  }
}

async function getVideoMetadata(videoUrl) {

  try {

    const searchResult = await yts(videoUrl)

    const videoData =
      searchResult.videos.length > 0
        ? searchResult.videos[0]
        : null

    if (!videoData) {
      throw new Error('Video not found')
    }

    return {
      videoId: videoData.videoId,
      url: videoData.url,
      title: videoData.title,
      description:
        videoData.description || '',
      image:
        videoData.image ||
        `https://i.ytimg.com/vi/${videoData.videoId}/hq720.jpg`,
      thumbnail:
        videoData.thumbnail ||
        `https://i.ytimg.com/vi/${videoData.videoId}/hq720.jpg`,
      seconds:
        videoData.seconds || 0,
      timestamp:
        videoData.timestamp || '0:00',
      duration: {
        seconds:
          videoData.seconds || 0,
        timestamp:
          videoData.timestamp || '0:00'
      },
      ago:
        videoData.ago || '',
      views:
        videoData.views || 0,
      author: {
        name:
          videoData.author
            ? videoData.author.name
            : '',
        url:
          videoData.author
            ? videoData.author.url
            : ''
      }
    }

  } catch (error) {

    throw new Error(
      `Failed to get metadata: ${error.message}`
    )
  }
}

function extractVideoId(url) {

  const m =
    /youtu\.be\/([a-zA-Z0-9_-]{11})/.exec(url) ||
    /v=([a-zA-Z0-9_-]{11})/.exec(url) ||
    /\/shorts\/([a-zA-Z0-9_-]{11})/.exec(url) ||
    /\/live\/([a-zA-Z0-9_-]{11})/.exec(url)

  if (!m) throw new Error('Invalid YouTube URL')

  return m[1]
}

module.exports = function (app) {

  app.get('/download/youtube', async (req, res) => {

    let { url, format, quality } = req.query

    if (!url) {
      return res.status(400).json({
        status: false,
        creator: "Gx Dikzz",
        error: 'URL YouTube diperlukan'
      })
    }

    if (!format) {
      return res.status(400).json({
        status: false,
        creator: "Gx Dikzz",
        error:
          'Parameter format diperlukan (mp3/mp4/m4a)'
      })
    }

    const validFormats = ['mp3', 'mp4', 'm4a']

    if (!validFormats.includes(format)) {
      return res.status(400).json({
        status: false,
        creator: "Gx Dikzz",
        error:
          `Format harus salah satu dari: ${validFormats.join(', ')}`
      })
    }

    try {

      const videoId = extractVideoId(url)

      const youtubeUrl =
        `https://www.youtube.com/watch?v=${videoId}`

      const ytsMetadata =
        await yts(youtubeUrl)

      const videoMetadata =
        ytsMetadata.videos.length > 0
          ? ytsMetadata.videos[0]
          : null

      const downloadResult =
        await ytdownDownloader(
          url,
          format,
          quality
        )

      let message =
        `Media ${format.toUpperCase()} berhasil diunduh`

      if (quality) {
        message += ` dengan kualitas ${quality}`
      } else {
        message +=
          ` dengan kualitas ${downloadResult.quality}`
      }

      const response = {
        status: true,
        creator: "Gx Dikzz",
        message: message,
        result: {
          metadata: {
            videoId: videoId,
            title:
              downloadResult.title ||
              (
                videoMetadata
                  ? videoMetadata.title
                  : 'Unknown'
              ),
            thumbnail:
              downloadResult.thumbnail ||
              (
                videoMetadata
                  ? videoMetadata.thumbnail
                  : ''
              ),
            duration:
              downloadResult.duration,
            channel:
              downloadResult.channel,
            views:
              videoMetadata
                ? videoMetadata.views
                : 0,
            timestamp:
              videoMetadata
                ? videoMetadata.timestamp
                : '0:00',
            description:
              videoMetadata
                ? videoMetadata.description
                : ''
          },

          download: {
            fileUrl:
              downloadResult.fileUrl,
            viewUrl:
              downloadResult.viewUrl,
            quality:
              downloadResult.quality,
            format:
              downloadResult.format,
            originalExt:
              downloadResult.originalExt,
            size:
              downloadResult.size,
            sizeBytes:
              downloadResult.sizeBytes,

            fileName:
              `${(downloadResult.title || 'video')
                .replace(/[^a-z0-9]/gi, '_')
                .substring(0, 50)}.${
                  format === 'mp4'
                    ? 'mp4'
                    : (
                      format === 'mp3'
                        ? 'mp3'
                        : 'm4a'
                    )
                }`
          }
        }
      }

      res.status(200).json(response)

    } catch (error) {

      console.error(
        'Download error:',
        error.message
      )

      res.status(500).json({
        status: false,
        creator: "Gx Dikzz",
        error:
          error.message ||
          'Terjadi kesalahan saat mengunduh'
      })
    }
  })

  app.get('/youtube/info', async (req, res) => {

    const { url } = req.query

    if (!url) {
      return res.status(400).json({
        status: false,
        creator: "Gx Dikzz",
        error: 'URL YouTube diperlukan'
      })
    }

    try {

      const videoId = extractVideoId(url)

      const youtubeUrl =
        `https://www.youtube.com/watch?v=${videoId}`

      const response = await axios.post(
        'https://app.ytdown.to/proxy.php',
        new URLSearchParams({
          url: youtubeUrl
        }),
        {
          headers: {
            'Content-Type':
              'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With':
              'XMLHttpRequest',
            'User-Agent':
              'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36'
          }
        }
      )

      if (
        !response.data ||
        response.data.api?.status !== 'ok'
      ) {
        throw new Error(
          'Gagal mengambil data dari ytdown'
        )
      }

      const apiData = response.data.api

      const videos = []
      const audios = []

      if (Array.isArray(apiData.mediaItems)) {

        apiData.mediaItems.forEach(item => {

          if (item.type === 'Video') {

            videos.push({
              resolution:
                item.mediaRes || 'unknown',
              quality:
                item.mediaQuality || '-',
              size:
                item.mediaFileSize || '-',
              ext:
                item.mediaExtension || 'MP4',
              url:
                item.mediaUrl
            })

          } else if (item.type === 'Audio') {

            audios.push({
              quality:
                item.mediaQuality || '-',
              size:
                item.mediaFileSize || '-',
              ext:
                item.mediaExtension || 'M4A',
              url:
                item.mediaUrl
            })
          }
        })
      }

      res.status(200).json({
        status: true,
        creator: "Gx Dikzz",
        message:
          "Informasi video berhasil didapatkan",

        result: {
          id: apiData.id,
          title: apiData.title,
          thumbnail:
            apiData.imagePreviewUrl,
          duration:
            apiData.mediaItems?.[0]
              ?.mediaDuration,
          channel:
            apiData.userInfo?.name,
          videos,
          audios
        }
      })

    } catch (error) {

      console.error(
        'Info error:',
        error.message
      )

      res.status(500).json({
        status: false,
        creator: "Gx Dikzz",
        error:
          error.message ||
          'Terjadi kesalahan saat mengambil informasi'
      })
    }
  })

  app.get('/youtube/download', async (req, res) => {

    const {
      url,
      format,
      quality,
      type
    } = req.query

    if (!url) {
      return res.status(400).json({
        status: false,
        creator: "Gx Dikzz",
        error: 'URL YouTube diperlukan'
      })
    }

    if (!format) {
      return res.status(400).json({
        status: false,
        creator: "Gx Dikzz",
        error:
          'Format diperlukan (mp3/mp4/m4a)'
      })
    }

    try {

      const downloadResult =
        await ytdownDownloader(
          url,
          format,
          quality
        )

      let targetUrl =
        downloadResult.fileUrl

      if (
        type === 'view' &&
        downloadResult.viewUrl
      ) {
        targetUrl =
          downloadResult.viewUrl
      }

      if (
        req.query.redirect === 'true'
      ) {
        return res.redirect(targetUrl)
      }

      if (
        req.query.direct === 'true'
      ) {

        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${downloadResult.title
            .substring(0, 50)
            .replace(/[^a-z0-9]/gi, '_')}.${
              format === 'mp4'
                ? 'mp4'
                : (
                  format === 'mp3'
                    ? 'mp3'
                    : 'm4a'
                )
            }"`
        )

        res.setHeader(
          'Content-Type',
          format === 'mp3'
            ? 'audio/mpeg'
            : (
              format === 'm4a'
                ? 'audio/mp4'
                : 'video/mp4'
            )
        )

        return res.redirect(targetUrl)
      }

      res.status(200).json({
        status: true,
        creator: "Gx Dikzz",

        result: {
          id:
            downloadResult.id,
          title:
            downloadResult.title,
          format:
            downloadResult.format,
          quality:
            downloadResult.quality,
          size:
            downloadResult.size,
          sizeBytes:
            downloadResult.sizeBytes,
          fileUrl:
            downloadResult.fileUrl,
          viewUrl:
            downloadResult.viewUrl,
          directLink:
            downloadResult.fileUrl
        }
      })

    } catch (error) {

      console.error(
        'Download error:',
        error.message
      )

      res.status(500).json({
        status: false,
        creator: "Gx Dikzz",
        error:
          error.message ||
          'Terjadi kesalahan'
      })
    }
  })
}

async function test() {

  try {

    console.log(
      'Testing ytdown.to downloader...'
    )

    const testUrl =
      'https://youtu.be/t5muHIO3dKU?si=X-2asRIYGxUDcas3'

    console.log(
      '\n=== Test MP3 (default quality) ==='
    )

    const mp3Result =
      await ytdownDownloader(
        testUrl,
        'mp3'
      )

    console.log(
      JSON.stringify(mp3Result, null, 2)
    )

    console.log(
      '\n=== Test MP4 (default quality) ==='
    )

    const mp4Result =
      await ytdownDownloader(
        testUrl,
        'mp4'
      )

    console.log(
      JSON.stringify(mp4Result, null, 2)
    )

    console.log(
      '\n=== Test MP3 (quality 320K) ==='
    )

    const mp3HighResult =
      await ytdownDownloader(
        testUrl,
        'mp3',
        '320K'
      )

    console.log(
      JSON.stringify(mp3HighResult, null, 2)
    )

    console.log(
      '\n=== Test M4A ==='
    )

    const m4aResult =
      await ytdownDownloader(
        testUrl,
        'm4a'
      )

    console.log(
      JSON.stringify(m4aResult, null, 2)
    )

  } catch (error) {

    console.error(
      'Test error:',
      error.message
    )
  }
}

if (require.main === module) {
  test()
}