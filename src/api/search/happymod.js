const axios = require("axios")
const cheerio = require("cheerio")

async function happymod(query) {
  try {

    const res = await axios.get("https://unduh.happymod.com/search.html?q=" + encodeURIComponent(query))
    const html = res.data
    const $ = cheerio.load(html)

    const data = []

    $("article.flex-item").each((i, el) => {

      const name = $(el)
      .find("h2.has-normal-font-size.no-margin.no-padding.truncate")
      .text()
      .trim()

      const version = $(el)
      .find("div.has-small-font-size.truncate")
      .first()
      .text()
      .trim()

      const url = $(el)
      .find("a.app.clickable")
      .attr("href")

      if (name && version && url) {
        data.push({
          name,
          version,
          url: "https://unduh.happymod.com/" + url
        })
      }

    })

    return {
      status: true,
      data
    }

  } catch (err) {

    return {
      status: false,
      message: "permintaan tidak dapat diproses!!"
    }

  }
}

module.exports = function (app) {

app.get("/search/happymod", async (req, res) => {

const { q } = req.query

if (!q) {
return res.json({
status: false,
message: "Masukkan parameter ?q="
})
}

try {

const results = await happymod(q)

if (!results.status) {
return res.json(results)
}

res.json({
status: true,
creator: "Gx Dikzz",
result: results.data
})

} catch (error) {

res.status(500).json({
status: false,
message: error.message
})

}

})

} 
